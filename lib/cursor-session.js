/**
 * One live Cursor ACP session: process + protocol connection + prompt turns.
 *
 * This is the piece the stock `@deepseek-ai/dsh-subagent-acp` provider does not
 * offer. Its provider is one-shot: `start()` spawns, prompts once, discards the
 * child. Here a session is a first-class handle that can carry MANY turns and
 * reports every `session/update` the Cursor agent emits — reasoning chunks,
 * tool calls, and the real file diffs it applies.
 *
 * Wire notes proven by probe (see `docs/PROBE-FINDINGS.md`):
 * - spawn `[node.exe, index.js, (--model <id>), acp]`; cwd = target workspace.
 * - `session/update` notifications MUST be subscribed with the SDK's RAW parser
 *   form `onNotification('session/update', p => p, handler)`: the typed form
 *   throws `Cannot read properties of undefined (reading 'sessionUpdate')` for
 *   update kinds this SDK build does not model (`session_info_update`,
 *   `available_commands_update`, …).
 * - `session/new` returns `sessionId`, `modes{currentModeId,availableModes}` and
 *   `models{currentModelId,availableModels[{modelId,name}]}`.
 * - edit tool calls report `{type:'diff', path, oldText, newText}` in
 *   `tool_call_update.content`, plus `locations:[{path}]` and `rawInput.path`.
 *
 * Cross-process continuation (probed, see `.test/acp-probe/ws2/REPORT.md`):
 * - `session/load {sessionId, cwd, mcpServers}` rehydrates a conversation in a
 *   brand-new process and DOES recall prior turns.
 * - It returns `{modes, models, configOptions}` — **no `sessionId`** — so the id
 *   the caller supplied must be kept.
 * - It REPLAYS the whole transcript as `session/update` notifications before the
 *   response settles. Replay is idempotent, so it is suppressed here: a resumed
 *   session starts with empty turn/diff accumulators on purpose.
 * - `cwd` is not validated against the stored one; the caller decides the cwd.
 * - `session/resume` and `session/close` are BOTH `-32601 Method not found`.
 * - A session is not loadable until at least one prompt has flushed it to disk;
 *   before that `load` fails `-32602 Session "<id>" not found`.
 *
 * Model switching is GLOBAL to the CLI, not per session: setting the model on
 * one session changes it for every session in every process (probed twice,
 * including across a process restart). The pool therefore serializes turns and
 * {@link CursorSession.setModel} is only ever called while that lock is held.
 */
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { acpArgv } from './resolve-agent.js';

/** Grace period for a cancelled turn to settle before the process is killed. */
const CANCEL_GRACE_MS = 4000;

/**
 * Error carrying an ACP-level failure code for tool-facing diagnostics.
 */
export class CursorAcpError extends Error {
    code;
    constructor(message, code = 'cursor/acp-failed') {
        super(message);
        this.name = 'CursorAcpError';
        this.code = code;
    }
}

/** The `/dev/null` marker Cursor sends as `oldText` when a file did not exist. */
const DEV_NULL = /^\s*(?:[-+]+\s*)?\/dev\/null\s*$/;
/** A git-style file header line, e.g. `++ b/C:\work\new.txt` or `--- a/x.js`. */
const DIFF_HEADER = /^(?:[-+]{2,3}|\+\+\+?|--+) (?:[ab]\/|\/dev\/null)/;

/**
 * Strip a git-style file header Cursor prepends to the content of a NEW file.
 *
 * Only the first line is considered, and only when it really is a header, so a
 * file whose own first line looks like `--- something` is left alone.
 *
 * @param text - candidate content.
 */
function stripDiffHeader(text) {
    const lines = text.split('\n');
    if (lines.length > 1 && DIFF_HEADER.test(lines[0]))
        lines.shift();
    return lines.join('\n');
}

/**
 * Normalize one ACP `diff` part into real file contents.
 *
 * Cursor reports an edit as the true old/new file text, but reports a CREATED
 * file as a git-style pseudo-diff:
 *
 *   oldText: "-- /dev/null"
 *   newText: "++ b/C:\\work\\new.txt\nDIFFPROBE"
 *
 * Passing that through verbatim makes a created file look modified and renders
 * `-- /dev/null` in the UI diff card, so it is converted into `{oldText: null}`
 * plus the bare content. Exported for direct testing.
 *
 * @param part - one `content` entry of a `tool_call_update`.
 */
export function normalizeAcpDiff(part) {
    const path = part.path;
    const rawOld = typeof part.oldText === 'string' ? part.oldText : '';
    const rawNew = typeof part.newText === 'string' ? part.newText : '';
    const isNew = rawOld === '' || DEV_NULL.test(rawOld);
    if (isNew) {
        return {
            path,
            oldText: null,
            newText: DIFF_HEADER.test(rawNew.split('\n')[0]) ? stripDiffHeader(rawNew) : rawNew,
        };
    }
    return {
        path,
        oldText: rawOld,
        newText: DEV_NULL.test(rawNew) ? '' : rawNew,
    };
}

/**
 * Normalize the several shapes one `tool_call_update` may carry into a diff list.
 * @param update - a `tool_call` or `tool_call_update` payload.
 */
function extractDiffs(update) {
    const content = update.content;
    if (!Array.isArray(content))
        return [];
    const diffs = [];
    for (const part of content) {
        if (part !== null && typeof part === 'object' && part.type === 'diff' && typeof part.path === 'string')
            diffs.push(normalizeAcpDiff(part));
    }
    return diffs;
}

/**
 * Best-effort file path for a tool call part, from `locations` or `rawInput`.
 * @param update - a `tool_call` or `tool_call_update` payload.
 */
function extractPath(update) {
    const locations = update.locations;
    if (Array.isArray(locations)) {
        for (const location of locations) {
            if (location !== null && typeof location === 'object' && typeof location.path === 'string')
                return location.path;
        }
    }
    const raw = update.rawInput;
    if (raw !== null && typeof raw === 'object' && typeof raw.path === 'string')
        return raw.path;
    return undefined;
}

/**
 * Strip the tool-call-id wrapping Cursor adds (`call-<uuid>-<n>` plus newline noise).
 * @param id - raw ACP tool call id.
 */
function normalizeCallId(id) {
    if (typeof id !== 'string')
        return 'unknown';
    const collapsed = id.replace(/\s+/g, '');
    return collapsed.length > 64 ? collapsed.slice(0, 64) : collapsed;
}

/**
 * One live Cursor ACP conversation.
 */
export class CursorSession {
    #config;
    #handle;
    #child;
    #connection;
    #agent;
    #sessionId;
    #capabilities;
    #models;
    #modes;
    #cwd;
    #sequence = 0;
    #activeTurn;
    #closed = false;
    #stderr = [];
    #onEvent;
    #hasContent = false;
    #replaying = false;

    /**
     * @param config - resolved spawn config (command, entry, model, env, cwd).
     * @param onEvent - sink for every normalized event (already redacted upstream).
     */
    constructor(config, onEvent) {
        this.#config = config;
        this.#onEvent = onEvent;
    }

    /** Durable Cursor session id, available after {@link start}. */
    get sessionId() {
        return this.#sessionId;
    }

    /** Working directory the child was bound to. */
    get cwd() {
        return this.#cwd;
    }

    /** Whether the underlying process is still usable. */
    get alive() {
        return !this.#closed && this.#child !== undefined && this.#child.exitCode === null;
    }

    /** Agent capability block from `initialize` (loadSession, promptCapabilities, …). */
    get capabilities() {
        return this.#capabilities;
    }

    /** Session model roster (`{currentModelId, availableModels[]}`). */
    get models() {
        return this.#models;
    }

    /** Session mode roster (`{currentModeId, availableModes[]}`). */
    get modes() {
        return this.#modes;
    }

    /** Recent stderr text, for diagnostics when the child misbehaves. */
    get stderrTail() {
        return this.#stderr.join('');
    }

    /**
     * Whether this session already holds conversation content.
     *
     * A `session/new` session with no completed prompt has NOT been flushed to
     * the CLI's store yet and is therefore not loadable by any process — the
     * pool uses this to decide whether resuming is even worth attempting.
     */
    get resumable() {
        return this.#hasContent;
    }

    /**
     * Spawn the Cursor process, initialize ACP, and open a session.
     * @param signal - caller cancellation; aborts the whole session.
     */
    async start(signal) {
        await this.#spawn(signal);
        await this.#openSession({ signal });
        return this;
    }

    /**
     * Start a process and REHYDRATE an existing Cursor session in it.
     *
     * This is what makes continuity survive the parent ending its turn, DSH
     * restarting, or the OS reaping the child: the conversation lives in the
     * CLI's own store keyed by `sessionId`, so any later process can load it.
     *
     * @param sessionId - a session id previously returned by `session/new`.
     * @param options - `signal` for cancellation, plus a `beforeReplay` hook
     *   invoked with the number of replayed updates once the load settles.
     */
    async load(sessionId, options = {}) {
        if (typeof sessionId !== 'string' || sessionId === '')
            throw new CursorAcpError('cursor-acp: session/load requires a session id', 'cursor/load-invalid');
        await this.#spawn(options.signal);
        try {
            await this.#openSession({ sessionId, signal: options.signal });
        }
        catch (error) {
            this.dispose();
            throw error;
        }
        return this;
    }

    /**
     * Spawn the child process and wire the ACP client to its stdio.
     * @param signal - caller cancellation.
     */
    async #spawn(signal) {
        const config = this.#config;
        const argv = acpArgv(config.resolved, config.model);
        const handle = config.spawn({
            argv: [config.resolved.command, ...argv],
            cwd: config.cwd,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
            graceMs: 3000,
            env: config.env,
            signal,
        });
        this.#handle = handle;
        this.#cwd = config.cwd;

        const stdin = handle.stdin;
        const stdout = handle.stdout;
        if (stdin === undefined || stdout === undefined) {
            handle.terminate();
            throw new CursorAcpError('cursor-acp: subprocess handle exposed no stdio pipes', 'cursor/spawn-failed');
        }

        handle.stderr?.on('data', (chunk) => {
            this.#stderr.push(String(chunk));
            if (this.#stderr.length > 40)
                this.#stderr.shift();
        });

        const child = { exitCode: null, stderr: handle.stderr };
        handle.done.then(() => {
            child.exitCode = 0;
        }, () => {
            child.exitCode = 1;
        });
        this.#child = child;

        const stream = ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout));

        const app = client({ name: 'dsh-cursor-dev' })
            .onNotification('session/update', (params) => params, (ctx) => {
                const update = ctx.notification?.update ?? ctx.params?.update;
                if (update === undefined)
                    return;
                // A `session/load` replays the entire prior transcript before it
                // settles. That history is already known to the caller (it owns
                // the conversation), so replay is counted, not surfaced.
                if (this.#replaying)
                    return;
                this.#ingest(update);
            })
            .onRequest(methods.client.session.requestPermission, (ctx) => {
                // The child runs autonomously as a coding subagent; the provider
                // boundary (and the parent's own approval policy) already decided
                // this delegation is permitted, so select the broadest grant.
                const options = ctx.params.options ?? [];
                const choice = options.find(option => option.kind === 'allow_always')
                    ?? options.find(option => option.kind === 'allow_once')
                    ?? options[0];
                this.#emit({ kind: 'permission', optionId: choice?.optionId, kindOf: choice?.kind });
                return { outcome: { outcome: 'selected', optionId: choice?.optionId } };
            });

        this.#connection = app.connect(stream);
        this.#agent = this.#connection.agent;
    }

    /**
     * Initialize ACP and either create or load the session.
     * @param options - `sessionId` to rehydrate; omitted creates a new session.
     */
    async #openSession(options) {
        const { sessionId, signal } = options;
        const config = this.#config;
        const agent = this.#agent;

        try {
            const init = await agent.request(methods.agent.initialize, {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
                clientInfo: { name: 'dsh-cursor-dev', version: '0.1.0' },
            });
            this.#capabilities = init?.agentCapabilities;
        }
        catch (error) {
            this.dispose();
            throw new CursorAcpError(`cursor-acp: initialize failed: ${message(error)}`, 'cursor/initialize-failed');
        }

        if (sessionId !== undefined) {
            this.#replaying = true;
            try {
                const loaded = await agent.request(methods.agent.session.load, {
                    sessionId,
                    cwd: config.cwd,
                    mcpServers: [],
                });
                // `session/load` does NOT echo the session id back.
                this.#sessionId = sessionId;
                this.#models = loaded?.models;
                this.#modes = loaded?.modes;
                this.#hasContent = true;
                this.#emit({ kind: 'session-loaded', sessionId, history: true });
            }
            catch (error) {
                this.dispose();
                throw new CursorAcpError(`cursor-acp: session/load failed: ${message(error)}`, 'cursor/load-failed');
            }
            finally {
                this.#replaying = false;
            }
            return;
        }

        try {
            const session = await agent.request(methods.agent.session.new, {
                cwd: config.cwd,
                mcpServers: [],
            });
            this.#sessionId = session.sessionId;
            this.#models = session.models;
            this.#modes = session.modes;
        }
        catch (error) {
            this.dispose();
            throw new CursorAcpError(`cursor-acp: session/new failed: ${message(error)}`, 'cursor/session-failed');
        }
    }

    /**
     * Switch the session model in place (keeps conversation context).
     *
     * NOTE: the CLI applies the choice GLOBALLY — every session in every process
     * starts reporting the new model. Callers must hold the pool's turn lock so
     * two conversations cannot interleave different models.
     *
     * @param modelId - an id from {@link models}.availableModels.
     */
    async setModel(modelId) {
        if (this.#agent === undefined)
            throw new CursorAcpError('cursor-acp: session is not started', 'cursor/not-started');
        const agent = this.#agent;
        let confirmed = modelId;
        const setConfigOption = methods.agent.session?.setConfigOption;
        if (setConfigOption !== undefined) {
            try {
                const response = await agent.request(setConfigOption, { sessionId: this.#sessionId, configId: 'model', value: modelId });
                for (const option of response?.configOptions ?? []) {
                    if (option?.id === 'model' && typeof option.currentValue === 'string')
                        confirmed = option.currentValue;
                }
            }
            catch (error) {
                throw new CursorAcpError(`cursor-acp: set model "${modelId}" rejected: ${message(error)}`, 'cursor/model-rejected');
            }
        }
        else {
            // Older SDK table: the raw alias is still accepted by the CLI.
            try {
                await agent.request('session/set_model', { sessionId: this.#sessionId, modelId });
            }
            catch (error) {
                throw new CursorAcpError(`cursor-acp: set model "${modelId}" rejected: ${message(error)}`, 'cursor/model-rejected');
            }
        }
        this.#models = { ...this.#models, currentModelId: confirmed };
        this.#emit({ kind: 'model', modelId: confirmed });
    }

    /**
     * Switch the session mode (`agent` | `plan` | `ask`).
     * @param modeId - an id from {@link modes}.availableModes.
     */
    async setMode(modeId) {
        if (this.#agent === undefined)
            throw new CursorAcpError('cursor-acp: session is not started', 'cursor/not-started');
        await this.#agent.request(methods.agent.session.setMode, { sessionId: this.#sessionId, modeId });
        this.#emit({ kind: 'mode', modeId });
    }

    /**
     * Send one prompt and resolve when the turn ends.
     * @param text - prompt text.
     * @param signal - cancellation for THIS turn.
     */
    async prompt(text, signal) {
        if (this.#agent === undefined)
            throw new CursorAcpError('cursor-acp: session is not started', 'cursor/not-started');
        if (this.#activeTurn !== undefined)
            throw new CursorAcpError('cursor-acp: a turn is already running', 'cursor/turn-in-flight');

        const turn = {
            index: ++this.#sequence,
            text: '',
            reasoning: '',
            calls: new Map(),
            diffs: [],
            usage: undefined,
            stopReason: undefined,
            startedAt: Date.now(),
            endedAt: undefined,
        };
        this.#activeTurn = turn;
        this.#emit({ kind: 'turn-start', index: turn.index });

        const onAbort = () => {
            void this.#cancel();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
            const response = await this.#agent.request(methods.agent.session.prompt, {
                sessionId: this.#sessionId,
                prompt: [{ type: 'text', text }],
            });
            turn.stopReason = response?.stopReason ?? 'end_turn';
            turn.usage = response?.usage;
        }
        catch (error) {
            turn.stopReason = 'error';
            turn.error = message(error);
            throw new CursorAcpError(`cursor-acp: prompt failed: ${message(error)}`, 'cursor/prompt-failed');
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            turn.endedAt = Date.now();
            this.#activeTurn = undefined;
            // The prompt flushed the transcript to the CLI's store, so this
            // session can now be rehydrated by a later process.
            this.#hasContent = true;
            this.#emit({ kind: 'turn-end', index: turn.index, stopReason: turn.stopReason });
        }

        return {
            index: turn.index,
            text: turn.text.trim(),
            reasoning: turn.reasoning.trim(),
            calls: [...turn.calls.values()],
            diffs: turn.diffs,
            usage: turn.usage,
            stopReason: turn.stopReason ?? 'end_turn',
            durationMs: (turn.endedAt ?? Date.now()) - turn.startedAt,
        };
    }

    async #cancel() {
        const agent = this.#agent;
        if (agent === undefined)
            return;
        try {
            await agent.request(methods.agent.session.cancel, { sessionId: this.#sessionId });
        }
        catch {
            // Cancellation is best-effort; the turn's own promise settles either way.
        }
    }

    /**
     * Translate one raw `session/update` into a normalized event.
     * @param update - raw ACP update payload.
     */
    #ingest(update) {
        const turn = this.#activeTurn;
        switch (update.sessionUpdate) {
            case 'user_message_chunk':
                // Only ever seen during a suppressed `session/load` replay.
                break;
            case 'agent_message_chunk': {
                const text = textOf(update.content);
                if (text === '')
                    break;
                if (turn !== undefined)
                    turn.text += text;
                this.#emit({ kind: 'text', text });
                break;
            }
            case 'agent_thought_chunk': {
                const text = textOf(update.content);
                if (text === '')
                    break;
                if (turn !== undefined)
                    turn.reasoning += text;
                this.#emit({ kind: 'thought', text });
                break;
            }
            case 'tool_call': {
                const id = normalizeCallId(update.toolCallId);
                const call = {
                    id,
                    name: typeof update.title === 'string' ? update.title : 'tool',
                    kind: typeof update.kind === 'string' ? update.kind : 'other',
                    status: typeof update.status === 'string' ? update.status : 'pending',
                    path: extractPath(update),
                    input: update.rawInput,
                    diffs: [],
                };
                turn?.calls.set(id, call);
                this.#emit({ kind: 'tool-call', call });
                break;
            }
            case 'tool_call_update': {
                const id = normalizeCallId(update.toolCallId);
                const existing = turn?.calls.get(id) ?? {
                    id,
                    name: 'tool',
                    kind: 'other',
                    status: 'pending',
                    path: undefined,
                    input: undefined,
                    diffs: [],
                };
                if (typeof update.title === 'string' && update.title !== '')
                    existing.name = update.title;
                if (typeof update.status === 'string' && update.status !== '')
                    existing.status = update.status;
                const path = extractPath(update);
                if (path !== undefined)
                    existing.path = path;
                if (update.rawInput !== undefined && update.rawInput !== null)
                    existing.input = update.rawInput;
                const diffs = extractDiffs(update);
                for (const diff of diffs) {
                    existing.diffs.push(diff);
                    if (turn !== undefined && !turn.diffs.some(seen => seen.path === diff.path && seen.newText === diff.newText))
                        turn.diffs.push(diff);
                    this.#emit({ kind: 'diff', diff, callId: id });
                }
                turn?.calls.set(id, existing);
                this.#emit({ kind: 'tool-update', call: existing, diffCount: diffs.length });
                break;
            }
            case 'plan': {
                this.#emit({ kind: 'plan', entries: update.entries });
                break;
            }
            case 'session_info_update': {
                this.#emit({ kind: 'session-info', title: update.title });
                break;
            }
            case 'current_mode_update': {
                if (typeof update.currentModeId === 'string')
                    this.#modes = { ...this.#modes, currentModeId: update.currentModeId };
                this.#emit({ kind: 'mode', modeId: update.currentModeId });
                break;
            }
            case 'available_commands_update': {
                this.#emit({ kind: 'commands', count: update.availableCommands?.length ?? 0 });
                break;
            }
            case 'config_option_update': {
                // Never emitted for model changes by this CLI build, but the
                // protocol allows it, so keep the roster honest if it appears.
                const options = update.configOptions;
                if (Array.isArray(options)) {
                    for (const option of options) {
                        if (option?.id === 'model' && typeof option.currentValue === 'string') {
                            this.#models = { ...this.#models, currentModelId: option.currentValue };
                            this.#emit({ kind: 'model', modelId: option.currentValue });
                        }
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * Publish one normalized event to the host sink.
     * @param event - normalized event.
     */
    #emit(event) {
        try {
            this.#onEvent(event);
        }
        catch {
            // A failing observer must never break the ACP stream.
        }
    }

    /** Terminate the turn, then the process. Idempotent. */
    dispose() {
        if (this.#closed)
            return;
        this.#closed = true;
        const agent = this.#agent;
        if (agent !== undefined && this.#activeTurn !== undefined) {
            void agent.request(methods.agent.session.cancel, { sessionId: this.#sessionId }).catch(() => { });
        }
        const handle = this.#handle;
        if (handle !== undefined) {
            const timer = setTimeout(() => {
                handle.terminate();
            }, CANCEL_GRACE_MS);
            handle.done.then(() => {
                clearTimeout(timer);
            }, () => {
                clearTimeout(timer);
            });
        }
    }

    /** Terminate immediately, skipping the cancel grace period. */
    kill() {
        this.#closed = true;
        this.#handle?.terminate();
    }
}

/**
 * Extract text from an ACP content part.
 * @param content - `{type:'text', text}` or other part.
 */
function textOf(content) {
    if (content === null || typeof content !== 'object')
        return '';
    return typeof content.text === 'string' ? content.text : '';
}

/**
 * Render an unknown thrown value as a message string.
 * @param error - thrown value.
 */
function message(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
