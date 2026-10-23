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
                    output: renderCursorReport(report),
                    stopReason,
                    ...(stopReason === 'error' || (report.error && stopReason !== 'aborted')
                        ? { diagnostic: String(report.error ?? `Cursor stopped: ${report.stopReason ?? 'unknown'}`).slice(0, 1000) } : {}),
                };
            });
            const dispose = () => disposal ??= (async () => {
                if (!settled) abort.abort();
                await cursorReport;
                try {
                    if (abort.signal.aborted) await leasedSession?.disposeAndWait();
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
                announceMirror(originalParent, opened.entry.child, request.label);
            }
            catch (error) {
                try { await dispose(); }
                catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], `${String(error)}; Cursor cleanup failed: ${String(cleanupError)}`);
                }
                throw error;
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
