/**
 * The `cursor_code` tool: hand a coding job to the Cursor CLI as a child agent.
 *
 * Design intent (the five gaps this plugin exists to close):
 *
 * 1. VISIBILITY — every `session/update` is journaled: reasoning chunks, each
 *    tool call with its outcome, and the real `{oldText,newText}` diffs Cursor
 *    applies. The result carries the change list and step timeline, and the UI
 *    renders a diff card, so the parent can verify instead of trusting a summary.
 * 2. PER-CALL MODEL — `model` selects the Cursor model for this job only, so a
 *    cheap model can do boilerplate while a strong one does architecture.
 * 3. CONTINUITY — `continueSession` keeps the same Cursor conversation; the pool
 *    holds the live process so a follow-up is a real continuation.
 * 4. CONTEXT — `contextFiles` + `acceptance` let the parent point the child at the
 *    right code without hand-writing the entire prompt.
 * 5. VERIFIABLE EVIDENCE — a filesystem fingerprint before/after the turn catches
 *    changes the ACP stream never mentioned (shell writes, moves, deletes).
 */
import { join } from 'node:path';
import { fingerprint, compareFingerprints, mergeChanges } from './changes.js';
import { delegationDepthOf, resolveChildDepth } from './mirror.js';
import { sameModel } from './models.js';
import { buildPrompt } from './prompt.js';
import { storeKeyOf } from './session-pool.js';

/** Default wall-clock budget for one Cursor turn. */
const DEFAULT_TIMEOUT_SECONDS = 1800;
/** Hard ceiling, regardless of what the model asks for. */
const MAX_TIMEOUT_SECONDS = 7200;

/**
 * The host refuses a tool result that a JSON round-trip would not reproduce
 * ("value is not lossless JSON"): an `undefined` value disappears, so a result
 * carrying one — an absent `reasoning`, a diff without line counts, a session
 * whose model the CLI never reported — is rejected and the whole turn's work is
 * lost to the caller. Strip those values instead of returning them.
 *
 * Arrays keep their order and drop empty slots; objects drop the whole key;
 * non-finite numbers become `null` (visible) rather than vanishing (silent).
 */
export function toLosslessJson(value) {
    return clean(value, new WeakSet());
}

/** `seen` holds the current ancestors, so a cycle is dropped without hanging. */
function clean(value, seen) {
    if (Array.isArray(value)) {
        if (seen.has(value))
            return undefined;
        seen.add(value);
        const items = [];
        for (const item of value) {
            const inner = clean(item, seen);
            if (inner !== undefined)
                items.push(inner);
        }
        seen.delete(value);
        return items;
    }
    if (value !== null && typeof value === 'object') {
        if (value instanceof Date)
            return value.toISOString();
        if (value instanceof Map)
            return clean(Object.fromEntries(value), seen);
        if (value instanceof Set)
            return clean([...value], seen);
        if (seen.has(value))
            return undefined;
        seen.add(value);
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            const inner = clean(item, seen);
            if (inner !== undefined)
                out[key] = inner;
        }
        seen.delete(value);
        return out;
    }
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
        return undefined;
    return value;
}

/**
 * The tool definition, registered through `ctx.tools.register`.
 *
 * @param deps - plugin services and shared state.
 */
export function cursorCodeTool(deps) {
    const { pool, journal, index, logger, unavailable, mirrors } = deps;
    // The recursion budget this tool enforces: the child it starts is a real
    // DSH child session, so a subagent calling this tool would create a
    // GRANDCHILD. `1` is the platform's own default (only a top-level agent
    // delegates) and `0` forbids Cursor children entirely.
    const maxChildDepth = deps.maxChildDepth;

    return {
        name: 'cursor_code',
        description:
            'Delegate a coding job in this workspace to the Cursor CLI child agent, which edits files on disk using its own tools. '
            + 'Use it for real implementation work: writing or refactoring code, fixing bugs, adding tests, mechanical multi-file changes. '
            + 'Do NOT use it for questions you can answer yourself, or for reading files — use your own tools for that.\n'
            + 'The child does not see this conversation: put everything it needs in `task`, and list files it should read in `contextFiles`.\n'
            + 'It reports back its final message, every file it changed (with diffs), and a step timeline of the tools it ran.\n'
            + 'To iterate on the same work, call again with continueSession:true — the child keeps its conversation and remembers what it did, '
            + 'even after DSH restarts. Runs are serialized (one Cursor turn at a time). Pick a cheaper or stronger model per call with `model`.',
        parameters: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description:
                        'The coding job, in full. State the goal, the concrete changes wanted, the relevant file paths, and what "done" looks like. '
                        + 'The child sees this text and nothing else from this conversation.',
                },
                contextFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Workspace-relative (or absolute) paths the child should read before starting. A cheap way to give it the right context.',
                },
                acceptance: {
                    type: 'string',
                    description: 'Optional acceptance criteria or constraints the child must satisfy (e.g. "must keep the public API", "run pytest before finishing").',
                },
                model: {
                    type: 'string',
                    description:
                        'Cursor model for this job. Examples: composer-2.5 (fast, cheap edits), grok-4.7 (strong reasoning), kimi-k3, glm-5.2. '
                        + 'Suffixes like [reasoning_effort=high,fast=true] are accepted. Omit to use the model the operator picked in the '
                        + 'Cursor panel (which falls back to the CLI default). If the operator locks the panel model, that selection overrides this argument. '
                        + 'The Cursor CLI applies the model globally, so runs are serialized; changing it starts a new Cursor session '
                        + 'that still carries the conversation transcript (the child keeps its memory of what it did).',
                },
                mode: {
                    type: 'string',
                    enum: ['agent', 'plan', 'ask'],
                    description: 'Cursor mode: agent (edits files, default), plan (read-only planning), ask (read-only Q&A).',
                },
                continueSession: {
                    type: 'boolean',
                    description:
                        'Continue the Cursor conversation this tool already started for this session, so the child remembers prior turns. '
                        + 'Default false. Use true for follow-up fixes to the same work. Continuity survives DSH restarts: the conversation is '
                        + 'reloaded from Cursor\'s own store when its process is gone.',
                },
                sessionLabel: {
                    type: 'string',
                    description:
                        'Optional name for this conversation, to keep several independent Cursor conversations apart within one session. '
                        + 'Reuse the same label to continue the same work line; combine with continueSession. Defaults to "default".',
                },
                resetSession: {
                    type: 'boolean',
                    description:
                        'Start over for this session label: this plugin forgets the Cursor session id, so the next run cannot reload the old '
                        + 'conversation. Nothing is deleted inside Cursor\'s own store. Default false.',
                },
                workspaceRoot: {
                    type: 'string',
                    description: 'Absolute directory the child works in. Omit to use this session\'s working directory.',
                },
                report: {
                    type: 'string',
                    enum: ['summary', 'detailed'],
                    description:
                        'summary (default) returns the final message, changed files and a step list; detailed additionally includes the reasoning summary and per-step detail.',
                },
                timeoutSeconds: {
                    type: 'number',
                    description: `Wall-clock budget for this turn. Default ${DEFAULT_TIMEOUT_SECONDS}, capped at ${MAX_TIMEOUT_SECONDS}.`,
                },
            },
            required: ['task'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    sessionKey: { type: 'string' },
                    cursorSessionId: { type: 'string' },
                    childSessionId: {
                        type: 'string',
                        description: 'Child DSH conversation holding the mirrored transcript, when the host provides one.',
                    },
                    reused: { type: 'boolean' },
                    reloaded: { type: 'boolean' },
                    model: { type: 'string' },
                    modelSource: { type: 'string' },
                    requestedModel: { type: 'string' },
                    mode: { type: 'string' },
                    stopReason: { type: 'string' },
                    durationMs: { type: 'number' },
                    text: { type: 'string' },
                    steps: { type: 'array', items: { type: 'object' } },
                    changes: { type: 'array', items: { type: 'object' } },
                    preview: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                // The host accepts a JSON Schema subset that has no
                                // type arrays, so "string or null" is a oneOf.
                                oldText: {
                                    oneOf: [{ type: 'string' }, { type: 'null' }],
                                    description: 'Previous file text, or null for a new file.',
                                },
                                newText: { type: 'string' },
                            },
                            required: ['path', 'newText'],
                        },
                    },
                    reasoning: { type: 'string' },
                    scannedBefore: { type: 'number' },
                    error: { type: 'string' },
                },
                required: ['ok', 'sessionKey'],
            },
            render: (_args, value) => renderCursorReport(value),
        },

        /**
         * Run one Cursor turn.
         *
         * @param args - parsed tool arguments.
         * @param exec - tool run context (agent, signal).
         */
        async execute(args, exec) {
            // The plugin mounts even when no CLI was found; say so plainly
            // instead of failing the fiber and hiding every other surface.
            if (unavailable !== undefined) {
                return {
                    ok: false,
                    sessionKey: 'unavailable',
                    stopReason: 'error',
                    durationMs: 0,
                    error: unavailable,
                    steps: [],
                    changes: [],
                };
            }
            const raw = args !== null && typeof args === 'object' ? args : {};
            const workspaceRootRaw = typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim() !== ''
                ? raw.workspaceRoot.trim()
                : resolveCwd(exec) ?? process.cwd();

            let input;
            try {
                input = normalizeArgs(args, workspaceRootRaw);
            }
            catch (error) {
                return {
                    ok: false,
                    sessionKey: 'invalid',
                    stopReason: 'error',
                    durationMs: 0,
                    error: error instanceof Error ? error.message : String(error),
                    steps: [],
                    changes: [],
                };
            }

            const parentId = String(exec.agent?.id ?? 'unknown');
            const workspaceRoot = input.workspaceRoot ?? workspaceRootRaw;
            const conversationKey = `${parentId}::${input.label}`;
            const storeKey = storeKeyOf(conversationKey);

            // The depth cap is checked BEFORE anything is created or spawned, so
            // a refused call costs nothing: no child session, no CLI process, no
            // Cursor conversation left half-started.
            if (typeof maxChildDepth === 'number') {
                try {
                    resolveChildDepth(exec.agent, maxChildDepth);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger?.warn?.(`cursor_code refused: ${message}`);
                    return toLosslessJson({
                        ok: false, sessionKey: 'depth-refused', conversationKey,
                        stopReason: 'error', durationMs: 0,
                        error: `${message}. The calling agent is at delegation depth `
                            + `${delegationDepthOf(exec.agent)} and this host caps Cursor children at ${maxChildDepth}. `
                            + 'Raise `maxChildDepth` in the plugin config to let a subagent start a Cursor run.',
                        steps: [], changes: [],
                    });
                }
            }

            if (input.resetSession) {
                pool.dropConversation(conversationKey);
                journal.clear(conversationKey);
                await index.delete(conversationKey);
                // The reset is a NEW generation of this work: the old child log
                // is closed here so it cannot be reopened as this run's view.
                await mirrors?.dropConversation(conversationKey);
            }

            // A conversation's durable transcript survives the death of its
            // process, so any generation can reload it. The record is consulted
            // here (rather than inside the pool) because the model chosen for
            // this turn decides whether the continuation is even valid.
            // A call may name a model, otherwise the operator's choice from the
            // panel applies, otherwise the profile config, otherwise the CLI
            // default. Resolved once per call so the whole turn uses one model.
            const selection = deps.resolveModelSelection?.(input.model) ?? {
                model: input.model ?? nonEmpty(deps.resolveDefaultModel?.()),
                source: input.model !== undefined ? 'request' : 'default',
                requestedModel: input.model,
            };
            const pickedModel = selection.model;
            const pickedMode = input.mode ?? nonEmpty(deps.resolveDefaultMode?.());
            const durable = await index.get(conversationKey);
            const remembered = pool.persistedFor(storeKey) ?? durable;
            const rememberedSessionId = remembered?.cursorSessionId ?? remembered?.sessionId;
            // The child conversation mirrors the Cursor conversation, so it is
            // remembered by the same durable record and reopened instead of
            // duplicated when a later run resumes this work.
            const rememberedChildId = durable?.childSessionId ?? remembered?.childSessionId;
            // The model in effect is asked of the POOL, never read off the
            // durable record: the record holds the id the CLI reported (a
            // roster spelling like `composer-2.5[fast=true]`) while a caller
            // writes an alias (`composer-2.5-fast`, `auto`), so a raw `!==`
            // fired on the very same model and silently started a new
            // generation — losing the live conversation on every follow-up.
            // `sameModel` compares through both name spaces, so only a genuine
            // switch counts: `auto` → `default[]` and an alias → its variant are
            // the same model. `pickedModel` still reaches `pool.run` unchanged,
            // because the pool owns the resolution against the live roster.
            const currentModel = typeof pool.currentModelChoice === 'function'
                ? pool.currentModelChoice(storeKey)
                : remembered?.modelChoice ?? remembered?.model;
            // The pool resolves the model IN EFFECT through the roster it has
            // already scoped to THIS conversation. This is the "what would a
            // switch be compared against" answer, and it is deliberately the
            // CURRENT model, not the incoming one: resolving the request and
            // then comparing it with itself collapses to "not changed" and
            // reuses the live generation across a genuine model switch. The
            // request is resolved in the SAME call so both sides share one
            // roster — the alias the CLI publishes (`composer-2.5-fast`) and
            // the id that alias stands for (`composer-2.5[fast=true]`) are one
            // model, and without that third term the gate abandoned the live
            // generation on a turn the pool itself switched nothing for.
            const current = typeof pool.modelContext === 'function' ? pool.modelContext(storeKey, pickedModel) : {};
            const currentModelId = current.id
                ?? (currentModel === undefined || currentModel === '' ? undefined : currentModel);
            // Only a roster LISTING can bridge two spellings: when no roster
            // answered, `resolveModel` hands the requested name straight back
            // (`listed: false`), and treating that as an id would compare a
            // request with itself and call a genuine switch a continuation.
            const requestModelId = current.request?.listed === true ? current.request.id : undefined;
            const modelChanged = pickedModel !== undefined
                && !sameModel(currentModel, pickedModel)
                && !sameModel(currentModelId, pickedModel)
                && !sameModel(currentModelId, requestModelId);

            // `continueSession:true` reuses the live generation; anything else
            // starts a new one, so a fresh run can never inherit live context.
            const wantsContinue = input.continueSession && !modelChanged;
            const picked = pool.pickKey(conversationKey, wantsContinue ? 'continue' : 'fresh');
            const sessionKey = picked.key;

            const timeoutSeconds = Math.min(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
            const abort = new AbortController();
            const onOuterAbort = () => abort.abort(exec.signal?.reason);
            exec.signal?.addEventListener('abort', onOuterAbort, { once: true });
            if (exec.signal?.aborted) onOuterAbort();
            const timer = setTimeout(() => abort.abort(), timeoutSeconds * 1000);
            const startedAt = Date.now();
            let session;
            let child;
            let childId;
            let reused = false;
            let reloaded = false;
            const lifecycle = exec.cursorLifecycle;
            // External native runs live in the subagents service as a row without a
            // local transcript; only a lifecycle that asks for the mirror creates one.
            const mirrorEnabled = lifecycle?.mirror !== false;
            const openChild = async () => {
                const entry = await mirrors?.open({
                    key: sessionKey,
                    parent: exec.agent,
                    label: lifecycle?.label ?? input.label,
                    childSessionId: rememberedChildId,
                    model: session?.models?.currentModelId ?? pickedModel,
                    ...(lifecycle === undefined ? {} : {
                        descriptor: lifecycle.descriptor, announce: false, strict: true, retain: true,
                    }),
                });
                childId = entry?.child?.session?.header?.id;
                return entry;
            };
            try {
                abort.signal.throwIfAborted();
                // Native jobs publish the actual child before joining the CLI's
                // FIFO. The host can now cancel a queued job as well as a prompt.
                if (mirrorEnabled && lifecycle !== undefined) {
                    child = await openChild();
                    if (child === undefined) throw new Error('cursor: native child agent is unavailable');
                    lifecycle.opened(child, sessionKey);
                }
                return await pool.run({
                    key: sessionKey,
                    storeKey,
                    cwd: workspaceRoot,
                    model: pickedModel,
                    persistedSessionId: rememberedSessionId,
                    signal: abort.signal,
                }, async (lease) => {
                    session = lease.session;
                    lifecycle?.acquired?.(session);
                    reused = lease.reused;
                    reloaded = lease.reloaded === true;
                    // A reused process was spawned with a different turn's
                    // signal. Cancel this lease explicitly and wait for exit
                    // before releasing the global CLI model lock.
                    const cancelLease = () => session.dispose();
                    abort.signal.addEventListener('abort', cancelLease, { once: true });
                    let turn;
                    try {
                        abort.signal.throwIfAborted();
                        journal.annotate(sessionKey, {
                            task: input.task, cursorSessionId: session.sessionId,
                            workspaceRoot, model: session.models?.currentModelId,
                            modelSource: selection.source, requestedModel: selection.requestedModel, reloaded,
                        });
                        if (mirrorEnabled) child ??= await openChild();
                        child?.mirror.useModel?.(session.models?.currentModelId);
                        child?.mirror.begin(input.prompt);
                        const before = await fingerprint(workspaceRoot, deps.maxScanFiles);
                        abort.signal.throwIfAborted();
                        if (pickedMode !== undefined && session.modes?.currentModeId !== pickedMode)
                            await session.setMode(pickedMode);
                        turn = await session.prompt(input.prompt, abort.signal);
                        pool.recordTurn(sessionKey, turn);
                        const after = await fingerprint(workspaceRoot, deps.maxScanFiles);
                        const changes = mergeChanges(turn.diffs, compareFingerprints(before, after), workspaceRoot);
                        // Persist and close the mirror while this turn still owns
                        // the FIFO, so a continued turn cannot overtake its log.
                        await index.set(conversationKey, {
                            cursorSessionId: session.sessionId, sessionKey, workspaceRoot,
                            model: session.models?.currentModelId, updatedAt: Date.now(),
                            turns: (durable?.turns ?? 0) + 1,
                            ...childId === undefined ? {} : { childSessionId: childId },
                        });
                        return toLosslessJson({
                            ok: turn.stopReason === 'end_turn' && !abort.signal.aborted,
                            sessionKey, conversationKey, generation: picked.generation,
                            cursorSessionId: session.sessionId, childSessionId: childId,
                            reused, reloaded, model: session.models?.currentModelId,
                            modelSource: selection.source, requestedModel: selection.requestedModel,
                            mode: session.modes?.currentModeId,
                            stopReason: abort.signal.aborted ? 'cancelled' : turn.stopReason,
                            durationMs: turn.durationMs, text: turn.text,
                            steps: journal.timeline(sessionKey, input.report === 'detailed' ? 80 : 40),
                            changes: changes.map(change => ({ path: change.path, operation: change.operation,
                                added: change.added, removed: change.removed, source: change.source })),
                            preview: previewDiffs(changes),
                            reasoning: input.report === 'detailed' ? turn.reasoning : undefined,
                            scannedBefore: before.files.size,
                            truncatedScan: before.truncated || after.truncated || undefined,
                            usage: turn.usage,
                        });
                    }
                    catch (error) {
                        turn = error?.partialTurn ?? turn;
                        throw error;
                    }
                    finally {
                        abort.signal.removeEventListener('abort', cancelLease);
                        mirrors?.close(sessionKey, {
                            text: turn?.text, reasoning: turn?.reasoning,
                            ok: turn?.stopReason === 'end_turn' && !abort.signal.aborted,
                            stopReason: abort.signal.aborted ? 'cancelled' : turn?.stopReason ?? 'error',
                            model: session.models?.currentModelId,
                        });
                        if (abort.signal.aborted)
                            await session.disposeAndWait?.();
                    }
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger?.warn?.(`cursor_code failed: ${message}`);
                return toLosslessJson({
                    ok: false, sessionKey, conversationKey, generation: picked.generation,
                    cursorSessionId: session?.sessionId, childSessionId: childId,
                    reused, reloaded, model: session?.models?.currentModelId,
                    modelSource: selection.source, requestedModel: selection.requestedModel,
                    stopReason: abort.signal.aborted ? 'cancelled' : 'error',
                    durationMs: Date.now() - startedAt, error: message,
                    text: error?.partialTurn?.text,
                    steps: journal.timeline(sessionKey, 40), changes: [],
                });
            }
            finally {
                clearTimeout(timer);
                exec.signal?.removeEventListener('abort', onOuterAbort);
            }
        },

        /** Deny concurrent runs of this tool; each turn owns a process. */
        isConcurrencySafe() {
            return false;
        },

        /** Show the user what was asked, before it runs. */
        presentCall(args) {
            const raw = args !== null && typeof args === 'object' ? args : {};
            return {
                card: 'generic',
                title: `Cursor → ${summarize(raw.task)}`,
                kind: 'execute',
                rawInput: {
                    model: typeof raw.model === 'string' ? raw.model : 'default',
                    mode: typeof raw.mode === 'string' ? raw.mode : 'agent',
                    continue: raw.continueSession === true,
                    cwd: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '(session cwd)',
                },
            };
        },

        /** Render the real diffs in the UI, independently of what the model sees. */
        presentResult(_args, result) {
            if (result?.isError === true)
                return undefined;
            const value = result?.value;
            if (value === undefined || value === null || typeof value !== 'object')
                return undefined;
            const preview = Array.isArray(value.preview) ? value.preview : [];
            if (preview.length === 0)
                return undefined;
            const changed = Array.isArray(value.changes) ? value.changes : [];
            return {
                card: 'diff',
                title: `${preview.length} file${preview.length === 1 ? '' : 's'} changed by Cursor`,
                diffs: preview.map(entry => ({
                    path: entry.path,
                    oldText: entry.oldText,
                    newText: entry.newText,
                })),
                meta: {
                    model: value.model,
                    durationMs: value.durationMs,
                    continued: value.reused === true,
                    reloaded: value.reloaded === true,
                    operations: Object.fromEntries(changed.map(change => [change.path, change.operation])),
                },
            };
        },
    };
}

/** Longest diff side handed to the UI card, per file. */
const MAX_PREVIEW_CHARS = 20000;

/**
 * Build the diff payload for the UI card.
 *
 * The ACP stream carries real `{oldText,newText}` pairs for edits Cursor applied
 * itself; a change only seen by the filesystem fingerprint has no text, and is
 * reported as a whole-file addition so the card still shows something true.
 *
 * @param changes - the merged change list from {@link mergeChanges}.
 */
function previewDiffs(changes) {
    const preview = [];
    for (const change of changes) {
        if (change.operation === 'deleted' && change.diff === undefined) {
            preview.push({ path: change.path, oldText: '(deleted; content not captured)', newText: '' });
            continue;
        }
        if (change.diff !== undefined && typeof change.diff.newText === 'string') {
            preview.push({
                path: change.path,
                oldText: clip(change.diff.oldText),
                newText: clip(change.diff.newText),
            });
            continue;
        }
        // Fingerprint-only evidence: no text was observed, so say so rather
        // than fabricating a diff the user would misread as the real edit.
        preview.push({
            path: change.path,
            oldText: change.operation === 'created' ? null : '(changed outside the ACP diff stream)',
            newText: `(${change.operation}; +${change.added ?? 0}/-${change.removed ?? 0} lines — full text not reported by Cursor)`,
        });
    }
    return preview;
}

/**
 * Bound one diff side so a huge write cannot bloat the tool result.
 * @param text - diff text or null.
 */
function clip(text) {
    if (typeof text !== 'string')
        return text ?? null;
    if (text.length <= MAX_PREVIEW_CHARS)
        return text;
    return `${text.slice(0, MAX_PREVIEW_CHARS)}\n… (${text.length - MAX_PREVIEW_CHARS} more characters omitted)`;
}

/**
 * Render the compact model-facing text for a tool result.
 *
 * @param value - the tool's return value.
 */
export function renderCursorReport(value) {
    const lines = [];
    if (value.ok === false) {
        lines.push(`cursor_code FAILED: ${value.error ?? 'unknown error'}`);
    }
    else {
        lines.push(`cursor_code finished (${value.stopReason}, ${Math.round((value.durationMs ?? 0) / 1000)}s, model=${value.model ?? '?'}${value.reused ? ', continued session' : ''}).`);
    }
    lines.push(`sessionKey: ${value.sessionKey}`);
    if (value.childSessionId !== undefined && value.childSessionId !== '')
        lines.push(`childSessionId: ${value.childSessionId}`);
    if (value.text !== undefined && value.text !== '')
        lines.push('', '--- child report ---', value.text);
    if (Array.isArray(value.changes) && value.changes.length > 0) {
        lines.push('', `--- files changed (${value.changes.length}) ---`);
        for (const change of value.changes) {
            const delta = change.added !== undefined || change.removed !== undefined
                ? ` (+${change.added ?? 0}/-${change.removed ?? 0})`
                : '';
            lines.push(`${change.operation} ${change.path}${delta}`);
        }
    }
    else {
        lines.push('', '--- files changed: NONE ---');
    }
    if (Array.isArray(value.steps) && value.steps.length > 0) {
        lines.push('', `--- steps (${value.steps.length}) ---`);
        for (const step of value.steps) {
            const target = step.path !== undefined ? ` ${step.path}` : '';
            lines.push(`${step.status ?? '?'} ${step.kind ?? 'tool'}: ${step.name ?? ''}${target}`);
        }
    }
    if (value.reasoning !== undefined && value.reasoning !== '')
        lines.push('', '--- reasoning ---', value.reasoning);
    if (value.truncatedScan === true)
        lines.push('', 'note: workspace scan was truncated; the change list may be incomplete.');
    return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Truncate a task string for display.
 *
 * @param task - task text.
 */
function summarize(task) {
    const flat = String(task ?? '').replace(/\s+/g, ' ').trim();
    return flat.length <= 52 ? flat : `${flat.slice(0, 51)}…`;
}

/**
 * Coerce and validate tool arguments.
 *
 * @param args - raw parsed arguments.
 */
function normalizeArgs(args, cwd) {
    const input = args !== null && typeof args === 'object' ? args : {};
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (task === '')
        throw new Error('cursor_code: `task` is required and must be a non-empty string');
    return {
        task,
        prompt: buildPrompt(task, {
            cwd: input.workspaceRoot ?? cwd ?? '(session working directory)',
            contextFiles: Array.isArray(input.contextFiles)
                ? input.contextFiles.filter(entry => typeof entry === 'string')
                : undefined,
            acceptance: typeof input.acceptance === 'string' ? input.acceptance : undefined,
        }),
        label: typeof input.sessionLabel === 'string' && input.sessionLabel.trim() !== ''
            ? input.sessionLabel.trim()
            : 'default',
        model: typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : undefined,
        mode: input.mode === 'plan' || input.mode === 'ask' || input.mode === 'agent' ? input.mode : undefined,
        continueSession: input.continueSession === true,
        resetSession: input.resetSession === true,
        workspaceRoot: typeof input.workspaceRoot === 'string' && input.workspaceRoot.trim() !== ''
            ? input.workspaceRoot.trim()
            : undefined,
        contextFiles: Array.isArray(input.contextFiles)
            ? input.contextFiles.filter(entry => typeof entry === 'string')
            : undefined,
        acceptance: typeof input.acceptance === 'string' ? input.acceptance : undefined,
        report: input.report === 'detailed' ? 'detailed' : 'summary',
        timeoutSeconds: typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds)
            ? input.timeoutSeconds
            : undefined,
    };
}

/**
 * Resolve the delegating session's working directory.
 *
 * The `Agent` contract exposes `id`; the live runtime additionally carries a
 * session whose header holds the workspace cwd. Read it defensively — falling
 * back to the process cwd keeps the tool usable rather than failing outright.
 *
 * @param exec - tool run context.
 */
function resolveCwd(exec) {
    const agent = exec.agent;
    const fromAgent = agent?.session?.header?.cwd;
    if (typeof fromAgent === 'string' && fromAgent !== '')
        return fromAgent;
    const fromContext = exec.session?.header?.cwd;
    if (typeof fromContext === 'string' && fromContext !== '')
        return fromContext;
    return undefined;
}

/**
 * Read a settings value as a usable string.
 *
 * The default-model providers return `''` for "not configured", which must be
 * indistinguishable from "no provider at all": both mean the CLI decides.
 *
 * @param value - candidate string.
 */
function nonEmpty(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Data directory for the conversation index.
 *
 * @param baseDir - plugin directory reported by Cordis.
 */
export function resolveDataDir(baseDir) {
    const explicit = process.env.DSH_CURSOR_DEV_DATA;
    if (explicit !== undefined && explicit !== '')
        return explicit;
    const local = process.env.LOCALAPPDATA;
    if (local !== undefined && local !== '')
        return join(local, 'dsh-cursor-dev');
    return join(baseDir ?? process.cwd(), '.data');
}
