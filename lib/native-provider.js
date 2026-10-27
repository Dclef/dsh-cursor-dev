/** Native DSH provider and the cursor_code adapter. The Cursor pool owns idle
 * processes; each published run owns its cancellation and mirrored child lease. */
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { renderCursorReport } from './tool.js';
import { resolveChildDepth } from './mirror.js';
import { quotaBlockedMessage } from './quota-guard.js';

export const CURSOR_PROVIDER = 'cursor';

export function cursorStopReason(reason, aborted = false) {
    if (aborted) return 'aborted';
    switch (reason) {
        case 'end_turn': return 'completed';
        case 'cancelled': return 'aborted';
        case 'max_tokens': return 'max-tokens';
        case 'refusal': return 'refusal';
        default: return 'error';
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function failure(error, cancelled = false) {
    return { ok: false, sessionKey: 'native-start', stopReason: cancelled ? 'cancelled' : 'error',
        durationMs: 0, error: error instanceof Error ? error.message : String(error), steps: [], changes: [] };
}

/**
 * Readable text for an arbitrary thrown value.
 * @param error - anything a promise rejected with.
 */
function describeFailure(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Credential-shaped tokens that must never reach the parent Session.
 *
 * A failed ACP run reports whatever the CLI and the SDK said, and that text can
 * carry a Bearer token, an API key, or an absolute path into the user's home —
 * exactly the material the official product backends keep out of their
 * diagnostics on purpose. The plugin still needs an operational reason for the
 * failure, so the shape is preserved and only the secret is cut out.
 */
const CREDENTIAL_PATTERNS = [
    // `Authorization: Bearer <token>`, `Bearer <token>`, `Basic <base64>`.
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]{6,}/gi,
    // `sk-…`, `csk-…`, `ghp_…`, `glpat-…`, `xoxb-…`, and Cursor's own keys.
    /\b(?:sk|csk|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi,
    // `api_key=…`, `token: …`, `password=…` in any casing and quoting.
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|authorization)\b\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
    // A `CURSOR_API_KEY=…` / `DEEPSEEK_API_KEY=…` style environment assignment.
    /\b[A-Z0-9_]*?(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s]{4,}/gi,
];

/** Absolute paths are operational detail, not something the parent needs. */
const PATH_PATTERN = /(?:[A-Za-z]:\\[^\s"']+|\/(?:Users|home|root)\/[^\s"']+)/g;

/**
 * Strip credentials and absolute paths from text that is about to be copied
 * into a parent Session.
 *
 * @param text - candidate diagnostic or answer text.
 * @returns the same text with secrets replaced by a fixed marker.
 */
export function redactDiagnostic(text) {
    if (typeof text !== 'string' || text === '') return text;
    let out = text;
    for (const pattern of CREDENTIAL_PATTERNS)
        out = out.replace(pattern, '[redacted]');
    out = out.replace(PATH_PATTERN, '[path]');
    return out;
}

/** Generic native calls use the panel settings and get their own conversation.
 * The cursor_code adapter supplies provider-private arguments for rich controls. */
export function createCursorProvider({ execute, mirrors, quotaGuard, maxChildDepth }) {
    const active = new Set();
    let closed = false;
    return {
        name: CURSOR_PROVIDER,
        inheritsParentContext: false,
        capabilities: Object.freeze({ agentOptions: false, outputSchema: false, depthLimit: false }),
        async start(request) {
            if (closed) throw new Error('cursor: provider is unloading');
            request.signal?.throwIfAborted();
            for (const key of ['agentOptions', 'outputSchema', 'maxDepth', 'toolFilter', 'persona']) {
                if (request[key] !== undefined)
                    throw new Error(`cursor: unsupported native capability ${key}`);
            }
            if (!Array.isArray(request.prompt) || request.prompt.length === 0
                || request.prompt.some(block => block?.type !== 'text' || typeof block.text !== 'string'))
                throw new Error('cursor: native prompts must contain text blocks only');
            const task = request.prompt.map(block => block.text).join('\n\n').trim();
            if (!task) throw new Error('cursor: native prompt must not be empty');
            const quotaStatus = await quotaGuard?.check?.();
            if (quotaStatus?.blocked === true)
                throw new Error(quotaBlockedMessage(quotaStatus));
            const originalParent = request.parent;
            // The recursion budget is the plugin's own now that the host leaves it
            // to the provider (`maxDepth: provider-managed`); refuse before any
            // process, child row, or lifecycle event exists.
            const depthCap = typeof maxChildDepth === 'function' ? maxChildDepth() : maxChildDepth;
            if (typeof depthCap === 'number') resolveChildDepth(originalParent, depthCap);
            // Keep the service's external lifecycle id separate from the local
            // transcript child. The mirror is opened explicitly by the panel
            // and does not publish another catalog row.
            const viaService = request.cursor === undefined;
            const args = request.cursor?.args ?? { task, sessionLabel: `native-${randomUUID()}` };
            const requestedCwd = typeof request.cwd === 'string' && request.cwd !== ''
                ? request.cwd : args.workspaceRoot;
            const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() !== ''
                ? requestedCwd.trim() : originalParent?.session?.header?.cwd;
            if (typeof cwd !== 'string' || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
                throw new Error('cursor: an accessible absolute parent workspace is required');
            request.signal?.throwIfAborted();
            if (closed) throw new Error('cursor: provider is unloading');

            const abort = new AbortController();
            const onAbort = () => abort.abort(request.signal?.reason);
            request.signal?.addEventListener('abort', onAbort, { once: true });
            if (request.signal?.aborted) onAbort();
            const ready = deferred();
            let opened;
            let leasedSession;
            let settled = false;
            let abandoned = false;
            let disposal;
            const cursorLifecycle = {
                // The service descriptor belongs to its external row.
                descriptor: viaService ? undefined : request.descriptor,
                label: request.label,
                acquired(session) { leasedSession = session; },
                opened(entry, key) {
                    opened = { entry, key };
                    ready.resolve();
                },
            };
            const execution = Promise.resolve().then(() => execute({ ...args, workspaceRoot: cwd }, {
                agent: originalParent,
                signal: abort.signal,
                cursorLifecycle,
            })).catch(error => failure(error, abort.signal.aborted));
            const cursorReport = execution.then(report => {
                settled = true;
                request.signal?.removeEventListener('abort', onAbort);
                if (!viaService && opened === undefined)
                    ready.reject(new Error(report.error ?? 'cursor: no child agent was created'));
                return report;
            });
            const result = cursorReport.then(report => {
                const stopReason = cursorStopReason(report.stopReason, abort.signal.aborted);
                return {
                    output: renderCursorReport({ ...report, error: redactDiagnostic(report.error),
                        text: redactDiagnostic(report.text) }),
                    stopReason,
                    ...(stopReason === 'error' || (report.error && stopReason !== 'aborted')
                        ? { diagnostic: redactDiagnostic(
                            String(report.error ?? `Cursor stopped: ${report.stopReason ?? 'unknown'}`)).slice(0, 1000) } : {}),
                };
            });
            const dispose = () => disposal ??= (async () => {
                // A caller that abandons the run before it settles must not leave a
                // process behind either: the abort below is what the CursorSession
                // sees, and the lease teardown below reaps whatever the run managed
                // to acquire before it noticed.
                if (!settled) abort.abort();
                await cursorReport;
                try {
                    if (abort.signal.aborted || abandoned === true) await leasedSession?.disposeAndWait();
                }
                finally {
                    if (opened !== undefined)
                        await mirrors.release(opened.key, { entry: opened.entry, strict: true });
                }
            })().finally(() => active.delete(dispose));
            active.add(dispose);
            // Publish the external lifecycle immediately, including while queued.
            // Its id stays distinct from the panel's real transcript child.
            if (viaService)
                return { id: `cursor-${randomUUID()}`, result, cursorReport, dispose };
            try {
                await ready.promise;
                // A run that was cancelled while it was still acquiring must not
                // publish a catalog row: the panel would then list a conversation
                // the caller never received, and unloading would leave it behind.
                // The cleanup path below reaps the lease and the mirror either way.
                if (abort.signal.aborted || closed)
                    throw new Error('cursor: the run was aborted before it was published');
                announceMirror(originalParent, opened.entry.child, request.label);
            }
            catch (error) {
                // The announcement failure is the reason the call must fail, so it
                // is reported verbatim; `dispose()` aborts a still-running turn and
                // reaps the lease, and its own failure is attached rather than
                // replacing the cause. Nothing here may swallow the first error.
                abandoned = true;
                let cleanupError;
                try { await dispose(); }
                catch (failure) { cleanupError = failure; }
                if (cleanupError !== undefined)
                    throw new AggregateError([error, cleanupError], `${describeFailure(error)}; Cursor cleanup failed: ${describeFailure(cleanupError)}`);
                throw error instanceof Error ? error : new Error(String(error));
            }
            return { id: opened.entry.child.id ?? opened.entry.child.session.header.id,
                localAgent: undefined, result, cursorReport, dispose };
        },
        async dispose() {
            closed = true;
            const outcomes = await Promise.allSettled([...active].map(dispose => dispose()));
            const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
            if (errors.length) throw new AggregateError(errors, 'cursor: native run disposal failed');
        },
    };
}

/** Cursor executes out of process; the local child is its transcript mirror.
 * The provider owns mirror discovery so continuation has one catalog row. Never
 * proxy the parent: DSH scopeTarget routes events by exact object identity. */
function announceMirror(parent, child, label) {
    const session = parent.session;
    const header = child.session.header;
    const exists = session.snapshotEvents?.().some(event => event.type === 'subagent/catalog'
        && event.data?.childId === header.id && event.data?.mode === 'one-shot');
    if (exists) return;
    session.append('subagent/catalog', {
        version: 0, childId: header.id, childCreatedAt: header.createdAt, mode: 'one-shot',
        ...(label === undefined ? {} : { label }),
    });
}

/** Late-bound native service; absence preserves the existing standalone tool. */
export function createNativeCursorBridge({ execute, mirrors, quotaGuard, maxChildDepth }) {
    let binding;
    return {
        bind(ctx) {
            const runtime = ctx.get?.('subagents');
            if (typeof runtime?.registerProvider !== 'function') return;
            const provider = createCursorProvider({ execute, mirrors, quotaGuard, maxChildDepth });
            const unregister = runtime.registerProvider(provider);
            const current = { runtime, provider };
            binding = current;
            ctx.effect(() => async () => {
                if (binding === current) binding = undefined;
                unregister?.();
                await provider.dispose();
            });
        },
        async execute(args, exec) {
            const current = binding;
            if (current === undefined) return execute(args, exec);
            let run;
            let report;
            try {
                // dsh >= 0.2.1 moved creation to `startActivation` on the service,
                // which only models external children; the bridge owns its mirrored
                // child instead, so it starts the provider directly.
                run = await current.provider.start({
                    parent: exec.agent,
                    prompt: [{ type: 'text', text: typeof args?.task === 'string' ? args.task : '' }],
                    label: args?.sessionLabel || 'Cursor',
                    signal: exec.signal,
                    cursor: { args },
                });
                await run.result;
                report = await run.cursorReport;
            }
            catch (error) {
                report = failure(error, exec.signal?.aborted);
            }
            try {
                await run?.dispose();
            }
            catch (error) {
                report = { ...report, ok: false, stopReason: 'error',
                    error: `${report.error ? `${report.error}; ` : ''}Cursor cleanup failed: ${String(error)}` };
            }
            return report;
        },
        async dispose() {
            const current = binding;
            binding = undefined;
            await current?.provider.dispose();
        },
    };
}
