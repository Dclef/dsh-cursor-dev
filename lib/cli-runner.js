/**
 * CLI 传输：一轮一个 `agent -p --output-format stream-json` 进程。
 *
 * 为什么需要它：Cursor 的 `acp` 子命令每模型只发布一个固定串，且
 * `session/set_config_option` 逐字校验，档位（如 grok 去掉 fast）在 ACP 下
 * 不可调；而 `-p` 入口接受 CLI 别名（grok-4.7-high），账单已证实真实生效。
 *
 * 它刻意实现与 CursorSession 相同的对外接口，这样会话池、工具、journal
 * 和镜像无需任何分支即可复用——CLI 的会话同样能在面板里点开看到。
 */
import { createInterface } from 'node:readline';
import { CursorAcpError } from './cursor-session.js';
import { cliModelArg } from './models.js';

/** 取消后等待进程结束的宽限。 */
const CANCEL_GRACE_MS = 4000;

function message(error) {
    return error instanceof Error ? error.message : String(error);
}

/** 把一个 CLI 的 unified diff 转成插件的 {path, oldText, newText}。 */
export function diffFromUnified(text, path) {
    if (typeof text !== 'string' || text === '') return undefined;
    const oldLines = [];
    const newLines = [];
    let sawHunk = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('@@')) { sawHunk = true; continue; }
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')) continue;
        if (line.startsWith('+')) { newLines.push(line.slice(1)); continue; }
        if (line.startsWith('-')) { oldLines.push(line.slice(1)); continue; }
        const context = line.startsWith(' ') ? line.slice(1) : line;
        if (!sawHunk && line === '') continue;
        oldLines.push(context);
        newLines.push(context);
    }
    return { path, oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/** 一个 CLI 进程承载的对话。 */
export class CliSession {
    #config;
    #handle;
    #cwd;
    #sessionId;
    #models;
    #modes;
    #closed = false;
    #stderr = [];
    #onEvent;
    #activeTurn;
    #hasContent = false;
    #sequence = 0;
    #turns = [];

    constructor(config, onEvent) {
        this.#config = config;
        this.#onEvent = onEvent;
        this.#cwd = config.cwd;
        this.#models = { currentModelId: config.model ?? '' };
        this.#modes = { currentModeId: 'agent', availableModes: [
            { id: 'agent', name: 'agent' }, { id: 'plan', name: 'plan' }, { id: 'ask', name: 'ask' },
        ] };
    }

    get alive() { return this.#closed === false; }

    get sessionId() { return this.#sessionId; }

    get cwd() { return this.#cwd; }

    get stderrTail() { return this.#stderr.join(''); }

    get resumable() {
        return this.#hasContent && typeof this.#sessionId === 'string' && this.#sessionId !== '';
    }

    get modes() { return this.#modes; }

    get models() { return this.#models; }

    /** CLI 不发布 ACP 式名册；面板的列表来自 `--list-models`。 */
    get modelRoster() { return undefined; }

    get turns() { return this.#turns; }

    async start(signal) {
        signal?.throwIfAborted();
        return this;
    }

    async load(sessionId, options = {}) {
        options.signal?.throwIfAborted();
        if (typeof sessionId !== 'string' || sessionId === '')
            throw new CursorAcpError('cursor-cli: --resume requires a session id', 'cursor/load-invalid');
        this.#sessionId = sessionId;
        this.#hasContent = true;
        this.#emit({ kind: 'session-loaded', sessionId, history: false });
        return this;
    }

    async setMode(modeId) {
        if (!this.#modes.availableModes.some(mode => mode.id === modeId))
            throw new CursorAcpError(`cursor-cli: unknown mode "${modeId}"`, 'cursor/mode-unknown');
        this.#modes = { ...this.#modes, currentModeId: modeId };
        this.#emit({ kind: 'mode', modeId });
    }

    async setModel(modelId) {
        const id = String(modelId ?? '').trim();
        if (id === '') return;
        this.#models = { currentModelId: id };
        this.#emit({ kind: 'model', modelId: id });
    }

    async prompt(text, signal) {
        signal?.throwIfAborted();
        if (this.#activeTurn !== undefined)
            throw new CursorAcpError('cursor-cli: a turn is already running', 'cursor/turn-in-flight');

        const turn = {
            index: ++this.#sequence, text: '', reasoning: '', calls: new Map(),
            diffs: [], usage: undefined, stopReason: undefined,
            startedAt: Date.now(), endedAt: undefined,
        };
        this.#activeTurn = turn;
        this.#emit({ kind: 'turn-start', index: turn.index });
        this.#emit({ kind: 'prompt', text });

        const abort = new AbortController();
        const onAbort = () => abort.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();

        try {
            await this.#runProcess(text, turn, abort.signal);
        }
        catch (error) {
            turn.stopReason = 'error';
            turn.error = message(error);
            const failure = new CursorAcpError(`cursor-cli: run failed: ${message(error)}`, 'cursor/prompt-failed');
            failure.partialTurn = { text: turn.text.trim(), reasoning: turn.reasoning.trim(),
                diffs: turn.diffs, stopReason: abort.signal.aborted ? 'cancelled' : 'error' };
            throw failure;
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            turn.endedAt = Date.now();
            this.#activeTurn = undefined;
            this.#hasContent = true;
            const summary = this.#summary(turn, abort.signal.aborted);
            this.#turns.push(summary);
            if (this.#turns.length > 50) this.#turns.shift();
            this.#emit({ kind: 'turn-end', index: turn.index, stopReason: summary.stopReason });
        }
        return this.#summary(turn, false);
    }

    async #runProcess(text, turn, signal) {
        const config = this.#config;
        const argv = [];
        if (config.resolved.entry !== undefined) argv.push(config.resolved.entry);
        argv.push('-p', '--trust', '--output-format', 'stream-json');
        const mode = this.#modes?.currentModeId;
        if (mode !== undefined && mode !== 'agent') argv.push('--mode', mode);
        // 关键：用 CLI 别名（grok-4.7-high）而不是括号 id。`-p` 认别名，
        // 这才是唯一能真正改变档位的入口（账单已验证 fast 被去掉）。
        const model = cliModelArg(this.#models?.currentModelId ?? '');
        if (model !== '') argv.push('--model', model);
        if (this.#sessionId !== undefined && this.#sessionId !== '')
            argv.push('--resume', this.#sessionId);
        argv.push(text);

        const handle = config.spawn({
            argv: [config.resolved.command, ...argv],
            cwd: this.#cwd,
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
            graceMs: CANCEL_GRACE_MS,
            env: config.env,
            signal,
        });
        this.#handle = handle;
        if (handle.stdout === undefined)
            throw new CursorAcpError('cursor-cli: subprocess exposed no stdout', 'cursor/spawn-failed');

        handle.stderr?.on('data', (chunk) => {
            this.#stderr.push(String(chunk));
            if (this.#stderr.length > 40) this.#stderr.shift();
        });

        let terminal;
        const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity });
        for await (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            let event;
            try { event = JSON.parse(trimmed); } catch { continue; }
            if (event?.type === 'result') terminal = event;
            this.#ingest(event, turn);
        }
        await handle.done?.catch?.(() => {});
        if (terminal === undefined) {
            const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ');
            throw new Error(tail === '' ? 'the CLI produced no result event' : tail);
        }
        if (terminal.subtype !== 'success')
            throw new Error(`the CLI reported ${terminal.subtype ?? 'a failed run'}`);
    }

    #ingest(event, turn) {
        if (event === null || typeof event !== 'object') return;
        const type = event.type;
        if (type === 'system') {
            if (typeof event.session_id === 'string' && event.session_id !== '') {
                this.#sessionId = event.session_id;
                this.#emit({ kind: 'session-id', sessionId: event.session_id });
            }
            if (typeof event.model === 'string' && event.model !== '')
                this.#models = { currentModelId: event.model };
            return;
        }
        if (type === 'thinking') {
            if (event.subtype === 'delta' && typeof event.text === 'string') {
                turn.reasoning += event.text;
                this.#emit({ kind: 'thought', text: event.text });
            }
            return;
        }
        if (type === 'tool_call') { this.#ingestToolCall(event, turn); return; }
        if (type === 'assistant') {
            const content = event.message?.content;
            const text = Array.isArray(content)
                ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('')
                : '';
            if (text !== '') { turn.text += text; this.#emit({ kind: 'text', text }); }
            return;
        }
        if (type === 'result') {
            turn.stopReason = event.subtype === 'success' ? 'end_turn' : 'error';
            if (event.usage !== undefined) turn.usage = event.usage;
        }
    }

    #ingestToolCall(event, turn) {
        const call = event.tool_call;
        if (call === null || typeof call !== 'object') return;
        const kind = Object.keys(call).find(key => key.endsWith('ToolCall'));
        if (kind === undefined) return;
        const payload = call[kind] ?? {};
        const callId = typeof payload.toolCallId === 'string' && payload.toolCallId !== ''
            ? payload.toolCallId : (event.call_id ?? 'unknown');
        const path = typeof payload.args?.path === 'string' ? payload.args.path : undefined;
        const short = kind.replace(/ToolCall$/, '');

        if (event.subtype === 'started') {
            const entry = { id: callId, title: short, kind: short, status: 'running', path, emitted: true };
            turn.calls.set(callId, entry);
            this.#emit({ kind: 'tool-call', call: entry });
            return;
        }
        if (event.subtype === 'completed') {
            const existing = turn.calls.get(callId);
            const ok = payload.result?.success !== undefined;
            const entry = { id: callId, title: existing?.title ?? short, kind: existing?.kind ?? short,
                status: ok ? 'completed' : 'failed', path,
                added: payload.result?.success?.linesAdded, removed: payload.result?.success?.linesRemoved };
            turn.calls.set(callId, entry);
            this.#emit({ kind: 'tool-update', call: entry, diffCount: 0 });
            const diffText = payload.result?.success?.diffString;
            if (typeof diffText === 'string' && diffText !== '' && path !== undefined) {
                const diff = diffFromUnified(diffText, path);
                if (diff !== undefined) {
                    turn.diffs.push(diff);
                    this.#emit({ kind: 'diff', diff, callId });
                }
            }
        }
    }

    #summary(turn, aborted) {
        return {
            index: turn.index, text: turn.text.trim(), reasoning: turn.reasoning.trim(),
            calls: [...turn.calls.values()], diffs: turn.diffs, usage: turn.usage,
            stopReason: aborted ? 'cancelled' : (turn.stopReason ?? 'error'),
            durationMs: (turn.endedAt ?? Date.now()) - turn.startedAt,
        };
    }

    dispose() {
        this.#closed = true;
        try { this.#handle?.terminate?.(); } catch {}
    }

    async disposeAndWait() {
        this.dispose();
        try { await this.#handle?.done; } catch {}
    }

    #emit(event) {
        try { this.#onEvent?.(event); } catch {}
    }
}
