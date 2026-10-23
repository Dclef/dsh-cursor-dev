/**
 * dsh-cursor-dev — mirror a Cursor run into a real DSH child conversation.
 *
 * WHY THIS EXISTS
 * The parent session header lists *child conversations* (子智能体), and clicking
 * one opens that child's own transcript. The DSH runtime only publishes such a
 * row when the provider hands back a live `localAgent` whose session really
 * exists (`SubagentRuntime.start`: `const child = run.localAgent?.session; if
 * (child !== void 0) establishCatalogChild(...)`). The stock ACP backend returns
 * `localAgent: undefined`, which is exactly why a Cursor run has always been
 * invisible here.
 *
 * So this module does two things:
 *
 * 1. `openCursorChild()` creates a REAL child session + agent through
 *    `ctx.agents.create` — persisted, lineage-tagged (`origin: 'subagent'`,
 *    `parentSession`, `delegationDepth`), carrying a `subagent/descriptor` so the
 *    client labels the row instead of falling back to the raw id.
 * 2. `CursorMirror` writes what Cursor actually did into that child's log —
 *    `turn/start`, `step/start`, the task as a `user/message`, one
 *    `tool/call` + `tool/result` pair per Cursor tool step, and finally the
 *    `assistant/message` with its reasoning and answer, then `turn/end`.
 *
 * Everything is built locally rather than imported from `@deepseek-ai/*`: a
 * profile-installed plugin resolves those packages only inside the app's own
 * tree, so importing them would break the repo's test run. The shapes are pinned
 * by `Session.append`'s validator, and the smoke tests exercise them against a
 * fake session.
 *
 * SURFACE RULES (getting these wrong throws inside `Session.append`):
 * `user/message`, `assistant/message` and `tool/result` are surface-eligible and
 * MUST carry `{surfaceOp: 'append'}`; every other type here must carry NO
 * surface metadata at all. `tool/result` also cites the `tool/call` seq it
 * answers through `sourceEventSeqs`, which is how the UI pairs a result with its
 * call card.
 *
 * @module dsh-cursor-dev/mirror
 */
import { randomUUID } from 'node:crypto';

/** Descriptor version the client folds; a mismatch makes the row fall back to the id. */
export const DESCRIPTOR_VERSION = 3;

/** Provider name this plugin registers with the DSH subagent runtime. */
export const PROVIDER_NAME = 'cursor';

/**
 * The delegation-scope statement every in-process DSH child carries.
 *
 * A runtime-context contribution rather than a system-prompt section, so the
 * deployment's own system prompt stays uniform across parents and children.
 */
export const SUBAGENT_DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were '
    + 'started and cannot be widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.';

/** Longest tool-result body written into a child conversation. */
const MAX_TOOL_TEXT = 1200;

/**
 * How many child conversations stay live at once.
 *
 * A child is a real DSH agent, and the parent's header keeps listing every one
 * that was ever opened (their logs are durable), so the live set is capped and
 * the least recently used are closed — the next run on that conversation simply
 * reopens it.
 */
const MAX_CHILDREN = 8;

/** Freeze a message the way the session log expects to receive it. */
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
    }
    return value;
}

/**
 * One identified, immutable user message.
 *
 * `createUserMessage` lives in a first-party package this plugin cannot resolve
 * from a profile install, and all it does is stamp an id, a role, and a freeze
 * onto the input — so the shape is built here instead.
 *
 * @param content - message content blocks.
 * @param source - producer source; defaults to the human user.
 * @returns a frozen user message.
 */
export function userMessage(content, source = { kind: 'user' }) {
    return deepFreeze({ id: randomUUID(), role: 'user', content, source });
}

/**
 * One identified, immutable assistant message.
 *
 * @param options - `content`, `provider`, `model`.
 * @returns a frozen assistant message.
 */
export function assistantMessage(options) {
    return deepFreeze({
        id: randomUUID(),
        role: 'assistant',
        content: options.content,
        source: {
            kind: 'model',
            provider: options.provider ?? PROVIDER_NAME,
            model: options.model ?? PROVIDER_NAME,
        },
    });
}

/**
 * One identified, immutable tool-role message answering a tool call.
 *
 * @param options - `callId`, `content`, `isError`.
 * @returns a frozen tool result message.
 */
export function toolResultMessage(options) {
    return deepFreeze({
        id: randomUUID(),
        role: 'tool',
        content: options.content,
        source: { kind: 'tool', callId: options.callId },
        toolCallId: options.callId,
        isError: options.isError === true,
    });
}

/**
 * The child's delegation depth.
 *
 * Mirrors the runtime helper: the durable header wins over the runtime option,
 * and the larger of the two is the truth.
 *
 * @param agent - the parent agent.
 * @returns its delegation depth.
 */
export function delegationDepthOf(agent) {
    const runtime = agent?.options?.subagentDepth;
    const header = agent?.session?.header?.delegationDepth;
    const left = Number.isSafeInteger(header) && header > 0 ? header : 0;
    const right = Number.isSafeInteger(runtime) && runtime > 0 ? runtime : 0;
    return Math.max(left, right);
}

/**
 * Refuse a child depth that an explicit cap forbids.
 *
 * The cap is the recursion budget the operator allows: `1` means only a
 * top-level agent (depth 0) may create a child, `0` forbids children entirely.
 * `undefined` leaves the budget to whoever configured the call.
 *
 * @param childDepth - the resolved depth the child would get.
 * @param maxDepth - optional cap.
 * @returns `childDepth` when it fits, so callers can use it inline.
 */
export function assertChildDepth(childDepth, maxDepth) {
    if (!Number.isSafeInteger(childDepth))
        throw new RangeError('dsh-cursor-dev: subagent child depth exceeds the safe-integer range');
    if (typeof maxDepth === 'number' && childDepth > maxDepth)
        throw new RangeError(`dsh-cursor-dev: subagent depth ${childDepth} exceeds maxDepth ${maxDepth}`);
    return childDepth;
}

/**
 * Resolve the child depth, refusing to exceed an explicit cap.
 *
 * @param parent - the delegating agent.
 * @param maxDepth - optional recursion cap.
 * @returns the child's delegation depth.
 */
export function resolveChildDepth(parent, maxDepth) {
    return assertChildDepth(delegationDepthOf(parent) + 1, maxDepth);
}

/**
 * The parent's provider/model/reasoning effort as the child should inherit it.
 *
 * The latest request header owns the route after request-time selection;
 * creation options are the fallback before the first request.
 *
 * @param parent - the delegating agent.
 * @returns detached agent options to merge from.
 */
export function parentAgentOptionsForDelegation(parent) {
    const requestConfig = parent?.session?.requestHeader?.()?.config;
    const created = parent?.options ?? {};
    if (requestConfig === undefined)
        return { ...created };
    const { provider: _p, model: _m, reasoningEffort: _r, ...rest } = created;
    return {
        ...rest,
        provider: requestConfig.provider,
        model: requestConfig.model,
        ...requestConfig.reasoningEffort === undefined ? {} : { reasoningEffort: requestConfig.reasoningEffort },
    };
}

/**
 * Resolve the child's `AgentOptions`.
 *
 * The child never runs the DSH agent loop — Cursor is the loop — so these
 * values only describe the child's lineage and give a future reader a sane
 * route. They are inherited rather than invented so the route stays one the LLM
 * runtime can actually resolve.
 *
 * @param parent - the delegating agent.
 * @param requested - per-child overrides, if any.
 * @param childDepth - the resolved delegation depth to stamp.
 * @returns options for `ctx.agents.create()`.
 */
export function resolveChildAgentOptions(parent, requested, childDepth) {
    const parentOptions = parentAgentOptionsForDelegation(parent);
    const resolved = {
        ...parentOptions.provider === undefined ? {} : { provider: parentOptions.provider },
        ...parentOptions.model === undefined ? {} : { model: parentOptions.model },
        ...parentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: parentOptions.reasoningEffort },
        ...parentOptions.maxTokens === undefined ? {} : { maxTokens: parentOptions.maxTokens },
        ...requested,
        subagentDepth: childDepth,
    };
    const routeChanged = resolved.provider !== parentOptions.provider || resolved.model !== parentOptions.model;
    if (routeChanged && requested?.reasoningEffort === undefined)
        delete resolved.reasoningEffort;
    return resolved;
}

/**
 * Build the child session's durable creation metadata.
 *
 * @param parent - the delegating agent.
 * @param childDepth - the resolved delegation depth.
 * @param isSeeded - whether the child log starts from inherited events.
 * @returns the `meta` object for `ctx.agents.create()`.
 */
export function childSessionMeta(parent, childDepth, isSeeded) {
    const parentHeader = parent?.session?.header ?? {};
    const preset = parent?.ctx?.get?.('agentPresets')?.composedPreset?.(parent.ctx);
    return {
        ...parentHeader.cwd === undefined ? {} : { cwd: parentHeader.cwd },
        ...preset === undefined ? {} : { agentPreset: preset },
        parentSession: parentHeader.id,
        isSeeded: isSeeded === true,
        // Navigation classification only; the descriptor stays the authority
        // for mode and continuation capability.
        origin: 'subagent',
        // Durable: the recursion budget must survive persistence and resume.
        delegationDepth: childDepth,
    };
}

/**
 * Capture the parent's effective policy so the child's log can be read alone.
 *
 * @param parent - the delegating agent.
 * @returns `{permissionPreset?, sandboxMode?, approvalPolicy?}`.
 */
export function captureDelegatedPolicyOverrides(parent) {
    const ctx = parent?.ctx;
    const preset = ctx?.get?.('permissionPresets')?.current?.(parent.session);
    const sandboxMode = ctx?.get?.('sandboxPolicy')?.overrideOf?.(parent.session);
    const approval = ctx?.get?.('approval');
    return {
        permissionPreset: preset === 'auto' || preset === 'danger-full-access' ? preset : undefined,
        sandboxMode,
        approvalPolicy: approval === undefined ? undefined : 'never',
    };
}

/**
 * Append the captured policy to the child's own log.
 *
 * `permission/preset` deliberately carries no `source` field — the event's
 * schema has no such key, and an extra key is what makes a later reload fail.
 *
 * @param session - the unpublished child session.
 * @param overrides - the policy captured at delegation.
 */
export function appendDelegatedPolicyOverrides(session, overrides) {
    if (overrides?.sandboxMode !== undefined)
        session.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' });
    if (overrides?.approvalPolicy !== undefined)
        session.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' });
    if (overrides?.permissionPreset !== undefined)
        session.append('permission/preset', { preset: overrides.permissionPreset });
}

/**
 * Compose the child inside its creation window.
 *
 * Every step is optional and guarded: the child is driven by Cursor, not by the
 * DSH agent loop, so a composition that cannot be applied must not cost the
 * user the run itself.
 *
 * @param childCtx - the unpublished child's scoped context.
 * @param parent - the delegating agent.
 * @param composition - `persona` and `toolFilter` requested by the caller.
 * @param logger - optional warning sink.
 */
export function applyChildComposition(childCtx, parent, composition = {}, logger) {
    const warn = (step, error) => {
        logger?.warn?.(`dsh-cursor-dev: child ${step} was not applied: ${error instanceof Error ? error.message : String(error)}`);
    };
    try {
        childCtx?.get?.('agentPresets')?.composeFrom?.(childCtx, parent?.ctx);
    }
    catch (error) {
        warn('preset', error);
    }
    const prompt = childCtx?.get?.('systemPrompt');
    if (prompt !== undefined && typeof prompt.context === 'function') {
        try {
            prompt.context({
                name: 'subagent:delegation',
                order: prompt.getContextOrder?.('SUBAGENT_DELEGATION'),
                text: SUBAGENT_DELEGATION_CONTEXT,
            });
        }
        catch (error) {
            warn('delegation context', error);
        }
    }
    if (composition.persona !== undefined && typeof prompt?.section === 'function') {
        try {
            prompt.section({
                name: 'deployment:persona-prefix',
                order: prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX'),
                text: composition.persona,
            });
        }
        catch (error) {
            warn('persona', error);
        }
    }
    if (composition.toolFilter !== undefined) {
        try {
            childCtx?.tools?.restrict?.(composition.toolFilter);
        }
        catch (error) {
            warn('tool filter', error);
        }
    }
}

/**
 * The descriptor that tells the client what kind of child this is.
 *
 * Without it the catalog row shows the raw session id and a generic activity
 * state instead of the label and a completed/failed result.
 *
 * @param options - `label` for the row.
 * @returns a frozen descriptor payload.
 */
export function cursorDescriptor(options = {}) {
    const label = typeof options.label === 'string' && options.label !== '' ? options.label : undefined;
    return deepFreeze({
        version: DESCRIPTOR_VERSION,
        mode: 'one-shot',
        provider: PROVIDER_NAME,
        ...label === undefined ? {} : { label },
    });
}

/**
 * The parent-owned catalog entry that makes the child navigable.
 *
 * The subagent runtime appends this itself when a provider goes through
 * `ctx.subagents.start`; a run started straight from the tool has to append it
 * here, because nothing else tells the parent's header that the child exists.
 *
 * @param options - `childId`, `childCreatedAt`, `label`.
 * @returns the `subagent/catalog` payload.
 */
export function catalogPayload(options) {
    const label = typeof options.label === 'string' && options.label !== '' ? options.label : undefined;
    return {
        version: 0,
        childId: options.childId,
        childCreatedAt: options.childCreatedAt,
        mode: 'one-shot',
        ...label === undefined ? {} : { label },
    };
}

/** Clamp one tool-result body so a huge write cannot bloat the child log. */
function clamp(text) {
    const value = String(text ?? '');
    if (value.length <= MAX_TOOL_TEXT)
        return value;
    return `${value.slice(0, MAX_TOOL_TEXT)}\n… (${value.length - MAX_TOOL_TEXT} more characters)`;
}

/** Count the lines one diff side adds or removes, for the result caption. */
function diffCounts(diffs) {
    let added = 0;
    let removed = 0;
    for (const diff of diffs) {
        const before = typeof diff.oldText === 'string' ? diff.oldText.split('\n') : [];
        const after = typeof diff.newText === 'string' ? diff.newText.split('\n') : [];
        const beforeSet = new Set(before);
        const afterSet = new Set(after);
        added += after.filter(line => !beforeSet.has(line)).length;
        removed += before.filter(line => !afterSet.has(line)).length;
    }
    return { added, removed };
}

/**
 * Write one Cursor run into a child session as a complete DSH turn.
 *
 * Cursor's own loop is the producer, so the mirror stays a faithful *record*:
 * one turn, one step, the task, one tool card per Cursor tool step, then the
 * reasoning and the final answer. Nothing here is model-visible inside the child
 * (a one-shot child opens read-only), which is what keeps the transcript honest
 * without inventing a second agent loop.
 */
export class CursorMirror {
    #session;

    #turn = 0;

    #step = 1;

    #calls = new Map();

    #open = false;

    #text = '';

    #reasoning = '';

    #model;

    /**
     * @param session - the child session to write into.
     * @param model - model name stamped on this mirror's assistant messages.
     */
    constructor(session, model) {
        this.#session = session;
        this.#model = typeof model === 'string' && model !== '' ? model : PROVIDER_NAME;
        // A resumed child already owns turns; continuing at 1 would publish a
        // second "turn 1" into the same conversation and make the transcript
        // read as if the earlier work had been undone.
        this.#turn = highestTurn(session);
    }

    /** Whether a turn is currently open. */
    get open() {
        return this.#open;
    }

    /**
     * Name the model this mirror's assistant rows carry.
     *
     * A mirror is built before the run resolves its model, so the name can only
     * be supplied here. Every row the mirror writes — the tool-call
     * announcements as well as the closing answer — is stamped with it, so a
     * transcript read later names the model it actually ran with.
     *
     * @param model - the model id, ignored when empty.
     */
    useModel(model) {
        if (typeof model === 'string' && model !== '')
            this.#model = model;
    }

    /** How many tool cards this mirror has written. */
    get calls() {
        return this.#calls.size;
    }

    /** The turn number this mirror is writing (the last one when idle). */
    get turn() {
        return this.#turn;
    }

    /**
     * Open the mirrored turn and record the task as the child's user message.
     *
     * @param prompt - the prompt Cursor was given.
     */
    begin(prompt) {
        if (this.#open)
            this.finish({});
        this.#turn += 1;
        this.#step = 1;
        this.#calls.clear();
        this.#text = '';
        this.#reasoning = '';
        const session = this.#session;
        session.append('turn/start', { turn: this.#turn });
        session.append('step/start', { turn: this.#turn, step: this.#step });
        session.append('user/message', userMessage([{ type: 'text', text: String(prompt ?? '') }]), { surfaceOp: 'append' });
        this.#open = true;
    }

    /**
     * Fold one normalized Cursor event into the child conversation.
     *
     * @param event - event emitted by `CursorSession`.
     */
    observe(event) {
        if (!this.#open || event === null || typeof event !== 'object')
            return;
        switch (event.kind) {
            case 'tool-call':
                this.#openCall(event.call);
                break;
            case 'tool-update':
                this.#updateCall(event.call);
                break;
            case 'diff':
                this.#addDiff(event.callId, event.diff);
                break;
            case 'text':
                this.#text += typeof event.text === 'string' ? event.text : '';
                break;
            case 'thought':
                this.#reasoning += typeof event.text === 'string' ? event.text : '';
                break;
            default:
                break;
        }
    }

    /**
     * Close the mirrored turn with the final answer and its outcome.
     *
     * @param outcome - `text`, `reasoning`, `ok`, `stopReason`, `error`, `model`.
     */
    finish(outcome = {}) {
        if (!this.#open)
            return;
        const session = this.#session;
        for (const [callId, entry] of this.#calls) {
            if (!entry.done)
                this.#writeResult(callId, '（Cursor 没有报告这一步的结果 · no result reported）', true);
        }
        const text = typeof outcome.text === 'string' && outcome.text !== '' ? outcome.text : this.#text.trim();
        const reasoning = typeof outcome.reasoning === 'string' && outcome.reasoning !== ''
            ? outcome.reasoning
            : this.#reasoning.trim();
        const content = [];
        if (reasoning !== '')
            content.push({ type: 'reasoning', text: reasoning });
        if (text !== '')
            content.push({ type: 'text', text });
        if (content.length === 0) {
            content.push({
                type: 'text',
                text: outcome.ok === true
                    ? '（Cursor 没有留下文字说明 · no written summary）'
                    : `（运行失败 · run failed: ${outcome.error ?? outcome.stopReason ?? 'unknown'}）`,
            });
        }
        session.append('assistant/message', {
            turn: this.#turn,
            step: this.#step,
            message: assistantMessage({
                content,
                provider: PROVIDER_NAME,
                model: typeof outcome.model === 'string' && outcome.model !== '' ? outcome.model : PROVIDER_NAME,
            }),
            stream: [],
        }, { surfaceOp: 'append' });
        session.append('step/end', { turn: this.#turn, step: this.#step });
        session.append('turn/end', { turn: this.#turn, reason: turnEndReason(outcome) });
        this.#open = false;
    }

    /**
     * Advertise one tool call before its `tool/call` row.
     *
     * A v4 log only accepts a `tool/call` that an earlier `assistant/message`
     * announced with a `tool-call` content block, and the two must agree on the
     * name and the arguments string exactly — otherwise loading the conversation
     * fails with `tool/call <id> has no advertised tool lifecycle`. The real agent
     * loop writes this row, so the mirror writes it too.
     *
     * @param callId - the call's id.
     * @param name - the tool name the `tool/call` row will carry.
     * @param args - the exact arguments string the `tool/call` row will carry.
     */
    #announce(callId, name, args) {
        this.#session.append('assistant/message', {
            turn: this.#turn,
            step: this.#step,
            message: assistantMessage({
                content: [{ type: 'tool-call', id: callId, name, arguments: args }],
                provider: PROVIDER_NAME,
                model: this.#model,
            }),
            stream: [],
        }, { surfaceOp: 'append' });
    }

    /** Append a tool card for a Cursor tool step, once per call id. */
    #openCall(call) {
        if (call === null || typeof call !== 'object')
            return;
        const callId = typeof call.id === 'string' && call.id !== '' ? call.id : `call-${this.#calls.size + 1}`;
        if (this.#calls.has(callId)) {
            this.#updateCall(call);
            return;
        }
        const name = typeof call.name === 'string' && call.name !== '' ? call.name : 'cursor tool';
        const args = JSON.stringify(call.input ?? {});
        const entry = { seq: undefined, done: false, diffs: [], status: call.status, path: call.path, name };
        // Advertise first: the `tool/call` row below is only admissible against an
        // already-announced call, and both rows must carry the same two strings.
        this.#announce(callId, name, args);
        entry.seq = this.#session.append('tool/call', {
            turn: this.#turn,
            step: this.#step,
            callId,
            name,
            arguments: args,
        }).seq;
        this.#calls.set(callId, entry);
        if (isTerminal(call.status))
            this.#writeResult(callId, this.#resultText(entry), call.status === 'failed');
    }

    /** Fold a `tool_call_update` into the open card. */
    #updateCall(call) {
        if (call === null || typeof call !== 'object' || typeof call.id !== 'string')
            return;
        const entry = this.#calls.get(call.id);
        if (entry === undefined) {
            this.#openCall(call);
            return;
        }
        if (typeof call.status === 'string' && call.status !== '')
            entry.status = call.status;
        if (typeof call.path === 'string' && call.path !== '')
            entry.path = call.path;
        if (isTerminal(entry.status) && !entry.done)
            this.#writeResult(call.id, this.#resultText(entry), entry.status === 'failed');
    }

    /** Attach one observed file diff to its call card. */
    #addDiff(callId, diff) {
        if (diff === null || typeof diff !== 'object')
            return;
        const entry = this.#calls.get(callId);
        if (entry === undefined || entry.done)
            return;
        entry.diffs.push(diff);
    }

    /** The text one tool card shows as its result. */
    #resultText(entry) {
        const counts = diffCounts(entry.diffs);
        const delta = counts.added === 0 && counts.removed === 0 ? '' : ` (+${counts.added}/-${counts.removed})`;
        const where = entry.path === undefined ? '' : ` ${entry.path}`;
        const lines = [`${entry.status ?? 'completed'}${where}${delta}`];
        for (const diff of entry.diffs) {
            const body = typeof diff.newText === 'string' ? diff.newText : '';
            if (body !== '')
                lines.push('', clamp(body));
        }
        return lines.join('\n');
    }

    /** Append the result that answers one tool call. */
    #writeResult(callId, text, isError) {
        const entry = this.#calls.get(callId);
        if (entry === undefined || entry.done)
            return;
        entry.done = true;
        this.#session.append('tool/result', {
            turn: this.#turn,
            step: this.#step,
            message: toolResultMessage({ callId, content: [{ type: 'text', text: clamp(text) }], isError }),
        }, { surfaceOp: 'append', sourceEventSeqs: [entry.seq] });
    }
}

/** ACP statuses that mean the call will not change again. */
function isTerminal(status) {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * The last turn number already present in a session log.
 *
 * `ctx.agents.resume` reopens an existing log, and the mirror has to continue
 * that numbering rather than restart it.
 *
 * @param session - the child session.
 * @returns the highest `turn/start` turn, or 0.
 */
export function highestTurn(session) {
    try {
        const events = session?.snapshotEvents?.() ?? session?.ownEvents?.() ?? [];
        let highest = 0;
        for (const event of events) {
            const turn = event?.data?.turn;
            if (event?.type === 'turn/start' && Number.isSafeInteger(turn) && turn > highest)
                highest = turn;
        }
        return highest;
    }
    catch {
        return 0;
    }
}

/**
 * Translate a Cursor outcome into the session's turn-end reason.
 *
 * @param outcome - the mirror outcome.
 * @returns a `TurnEndReason`.
 */
export function turnEndReason(outcome = {}) {
    if (outcome.ok === true)
        return { kind: 'completed' };
    const stopReason = typeof outcome.stopReason === 'string' ? outcome.stopReason : '';
    if (stopReason === 'cancelled' || outcome.cancelled === true)
        return { kind: 'aborted', reason: { kind: 'parent' } };
    if (stopReason === 'max_tokens')
        return { kind: 'max-tokens' };
    return {
        kind: 'error',
        error: {
            message: typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : `cursor run ended with ${stopReason || 'no result'}`,
            code: 'cursor/run-failed',
        },
    };
}

/**
 * Split a replayed transcript into the turns the user actually asked for.
 *
 * A `session/load` replay has no turn events at all: the only structure in it is
 * the `user_message_chunk` the CLI emits before each turn's work. That chunk is
 * therefore the boundary — but the CLI may also split ONE prompt across several
 * chunks, so a chunk only opens a new turn once the current one has produced
 * something. Events that arrive before the first prompt still get a turn, so
 * nothing can be silently dropped from the record.
 *
 * @param events - normalized events collected by `SessionPool.replay()`.
 * @returns `{prompt, events}` per turn, in replay order.
 */
export function foldTranscript(events) {
    const turns = [];
    let current;
    for (const event of events) {
        if (event?.kind === 'prompt') {
            if (current === undefined || current.events.length > 0) {
                current = { prompt: '', events: [] };
                turns.push(current);
            }
            current.prompt += typeof event.text === 'string' ? event.text : '';
            continue;
        }
        if (current === undefined) {
            current = { prompt: '', events: [] };
            turns.push(current);
        }
        current.events.push(event);
    }
    return turns;
}

/**
 * Write a replayed transcript into a child conversation.
 *
 * Each replayed turn becomes a complete mirrored turn — the prompt as the user
 * message, one tool card per Cursor step, the reasoning and the answer — which
 * is exactly the shape a live run produces. Reading history back therefore
 * yields a transcript the client renders with no special cases.
 *
 * @param mirror - the child's `CursorMirror`.
 * @param events - normalized events collected by `SessionPool.replay()`.
 * @param options - `model` recorded on the assistant messages.
 * @returns how many turns were written.
 */
export function mirrorTranscript(mirror, events, options = {}) {
    // The announcements written while replaying carry this name too, so the
    // whole transcript agrees on the model rather than naming the provider in
    // some rows and the real model in others.
    mirror.useModel(options.model);
    const turns = foldTranscript(events);
    for (const turn of turns) {
        mirror.begin(turn.prompt);
        for (const event of turn.events)
            mirror.observe(event);
        mirror.finish({ ok: true, model: options.model });
    }
    return turns.length;
}

/**
 * Create a real, navigable DSH child conversation for one Cursor run.
 *
 * Returns `undefined` when the host cannot provide one (no `agents` service, or
 * a parent with no session): mirroring is a visibility feature, never a
 * precondition for the coding work itself.
 *
 * @param options - `agents`, `parent`, `label`, `announce`, `descriptor`, `logger`, `maxChildDepth`.
 * @returns `{child, handle, mirror, dispose}` or undefined.
 */
export async function openCursorChild(options) {
    const { agents, parent, logger } = options;
    if (agents === undefined || typeof agents.create !== 'function')
        return undefined;
    const parentSession = parent?.session;
    if (parentSession === undefined || typeof parentSession.append !== 'function')
        return undefined;

    const label = typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : undefined;
    const childDepth = resolveChildDepth(parent, options.maxChildDepth);
    const childId = `session-${randomUUID()}`;
    const handle = await agents.create({
        sessionId: childId,
        parentAgent: parent,
        meta: childSessionMeta(parent, childDepth, false),
        agentOptions: resolveChildAgentOptions(parent, undefined, childDepth),
        setup: (childCtx, child) => {
            composeChild(childCtx, child, parent, { logger });
            child.session.append('subagent/descriptor', options.descriptor ?? cursorDescriptor({ label }));
        },
    });
    const child = handle.agent;
    if (options.announce !== false)
        announceChild(parentSession, child, label, logger);
    return {
        child,
        handle,
        mirror: new CursorMirror(child.session, options.model),
        dispose: async () => {
            await handle.dispose();
        },
    };
}

/**
 * Reopen the child conversation a previous run created.
 *
 * A Cursor conversation survives its process: the durable record remembers both
 * ids, so a later run must continue the SAME child log. Creating a second child
 * would split one piece of work across two rows in the parent's header and hide
 * everything the first run did.
 *
 * @param options - `agents`, `parent`, `childSessionId`, `logger`.
 * @returns `{child, handle, mirror, dispose}` or undefined when it cannot reopen.
 */
export async function resumeCursorChild(options) {
    const { agents, parent, childSessionId, logger } = options;
    if (agents === undefined || typeof agents.resume !== 'function')
        return undefined;
    if (typeof childSessionId !== 'string' || childSessionId === '')
        return undefined;
    const childDepth = resolveChildDepth(parent, options.maxChildDepth);
    const handle = await agents.resume({
        resumeSessionId: childSessionId,
        parentAgent: parent,
        agentOptions: resolveChildAgentOptions(parent, undefined, childDepth),
        setup: (childCtx, child) => {
            composeChild(childCtx, child, parent, { logger });
        },
    });
    const child = handle.agent;
    // The row already exists in the parent's log from the first run; a second
    // `subagent/catalog` entry would list the same conversation twice.
    return {
        child,
        handle,
        mirror: new CursorMirror(child.session, options.model),
        dispose: async () => {
            await handle.dispose();
        },
    };
}

/**
 * Open a child conversation for a Cursor session that ran before this child
 * existed.
 *
 * The parent agent is optional here. A durable conversation row outlives the
 * session that produced it — and one of them (`probe-parent`) never was a DSH
 * session at all — so the lineage is rebuilt from what the durable record knows
 * instead of from a live parent. Without a live parent there is no session to
 * announce the catalog row into, and the dashboard's explicit
 * `{parentSessionId, childSessionId, mode}` address is what opens the child.
 *
 * @param options - `agents`, `parent`, `parentSessionId`, `cwd`, `label`, `logger`.
 * @returns `{child, handle, mirror, dispose}` or undefined.
 */
export async function openRestoredChild(options) {
    const { agents, parent, logger } = options;
    if (agents === undefined || typeof agents.create !== 'function')
        return undefined;
    const live = parent?.session !== undefined && typeof parent.session.append === 'function';
    // A restored child never runs a turn, so it can never delegate: it is a
    // navigable RECORD of work Cursor already did, not a new delegation. The
    // depth cap deliberately does not apply, because refusing here would only
    // hide history the panel is trying to show.
    const childDepth = live ? resolveChildDepth(parent, undefined) : 1;
    const childId = `session-${randomUUID()}`;
    const label = typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : undefined;
    const handle = await agents.create({
        sessionId: childId,
        ...live ? { parentAgent: parent } : {},
        meta: live
            ? childSessionMeta(parent, childDepth, false)
            : {
                ...typeof options.cwd === 'string' && options.cwd !== '' ? { cwd: options.cwd } : {},
                ...typeof options.parentSessionId === 'string' && options.parentSessionId !== ''
                    ? { parentSession: options.parentSessionId }
                    : {},
                isSeeded: false,
                origin: 'subagent',
                delegationDepth: childDepth,
            },
        agentOptions: live
            ? resolveChildAgentOptions(parent, undefined, childDepth)
            // A restored child is a record, not a runner: it never executes a
            // turn, so it needs no model route — only its own depth stamp.
            : { subagentDepth: childDepth },
        setup: (childCtx, child) => {
            composeChild(childCtx, child, parent, { logger });
            child.session.append('subagent/descriptor', options.descriptor ?? cursorDescriptor({ label }));
        },
    });
    const child = handle.agent;
    if (live)
        announceChild(parent.session, child, label, logger);
    return {
        child,
        handle,
        mirror: new CursorMirror(child.session, options.model),
        dispose: async () => {
            await handle.dispose();
        },
    };
}

/**
 * Apply the delegation policy and composition every child carries.
 *
 * `subagent/descriptor` is deliberately NOT part of this: it is written once, on
 * creation, and a second copy would reset the client's timing origin.
 *
 * @param childCtx - the child's scoped context.
 * @param child - the child agent.
 * @param parent - the delegating agent.
 * @param options - `logger`.
 */
function composeChild(childCtx, child, parent, options = {}) {
    try {
        appendDelegatedPolicyOverrides(child.session, captureDelegatedPolicyOverrides(parent));
    }
    catch (error) {
        options.logger?.warn?.(`dsh-cursor-dev: child policy was not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    applyChildComposition(childCtx, parent, {}, options.logger);
}

/**
 * Tell the parent's header that this child exists.
 *
 * The subagent runtime appends this itself when a provider goes through
 * `ctx.subagents.start`; a run started straight from the tool has to append it
 * here, because nothing else tells the parent that the child is navigable.
 *
 * @param parentSession - the parent's session.
 * @param child - the child agent.
 * @param label - the catalog row's label.
 * @param logger - optional warning sink.
 */
function announceChild(parentSession, child, label, logger) {
    try {
        parentSession.append('subagent/catalog', catalogPayload({
            childId: child.session.header.id,
            childCreatedAt: child.session.header.createdAt,
            label,
        }));
    }
    catch (error) {
        // The child exists and works; only its entry in the parent's header is
        // missing, so say so rather than failing the whole run.
        logger?.warn?.(`dsh-cursor-dev: child catalog entry failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * One child conversation per Cursor conversation.
 *
 * A Cursor conversation (`parent::label`) outlives a single turn, so its child
 * conversation must too: the second turn of the same work appends a second turn
 * to the SAME child log instead of opening a second, nearly empty row in the
 * parent's header. Entries are keyed by the pool key, which is what the event
 * stream is already keyed by.
 *
 * A child is a live DSH agent, so the hub is bounded: the least recently used
 * conversation is closed once `MAX_CHILDREN` are open. Closing removes the agent
 * from the runtime, never the log — the durable history is what the client opens,
 * and a later run rejoins it through `resumeCursorChild`.
 *
 * The hub holds no timer and starts nothing: `open` is called by a run that is
 * about to happen, and `observe` is a no-op for any other conversation.
 *
 * @param options - `logger`, `maxChildren`, `maxChildDepth`.
 * @returns the hub used by the tool and by the subagent provider.
 */
export function createMirrorHub(options = {}) {
    const logger = options.logger;
    const maxChildren = Number.isSafeInteger(options.maxChildren) && options.maxChildren > 0
        ? options.maxChildren
        : MAX_CHILDREN;
    // The recursion budget this hub enforces on every child it opens. `undefined`
    // keeps the previous behaviour (no cap); a number refuses a parent that is
    // already at that depth, which is how "only a top-level agent delegates"
    // (1) or "nobody delegates" (0) is configured. A function is resolved per
    // call, so the settings panel can lift the cap without a reload — otherwise
    // the tool would allow a run that the mirror then refuses to record.
    const maxChildDepthNow = () => (typeof options.maxChildDepth === 'function'
        ? options.maxChildDepth()
        : options.maxChildDepth);
    const entries = new Map();
    let agents;
    let reportedMissing = false;

    /** Close the least recently used conversations until the hub fits. */
    const reap = async () => {
        if (entries.size <= maxChildren)
            return;
        const doomed = [...entries.values()]
            .filter(entry => !(entry.references > 0) && !entry.mirror.open)
            .sort((left, right) => left.lastUsed - right.lastUsed)
            .slice(0, entries.size - maxChildren);
        for (const entry of doomed) {
            entries.delete(entry.key);
            entry.disposed = true;
        }
        await Promise.allSettled(doomed.map(entry => entry.dispose()));
    };

    return {
        /**
         * Learn the `agents` service once its own fiber is ACTIVE.
         *
         * Reading it at mount time is what makes a service silently `undefined`
         * here (see the HTTP mount in `lib/index.js`), so the service is taken
         * from the injected context instead.
         *
         * @param ctx - a context that has declared the `agents` dependency.
         */
        bind(ctx) {
            const found = ctx?.get?.('agents');
            if (found !== undefined)
                agents = found;
        },

        /** Whether a child conversation can be created at all. */
        get available() {
            return agents !== undefined;
        },

        /**
         * What the status route shows: one row per open child conversation.
         *
         * @returns `{key, childSessionId, parentSessionId, turn, calls, open, resumed}` rows.
         */
        snapshot() {
            return [...entries.values()].map(entry => ({
                key: entry.key,
                childSessionId: entry.child?.session?.header?.id,
                parentSessionId: entry.child?.session?.header?.parentSession,
                turn: entry.mirror.turn,
                calls: entry.mirror.calls,
                open: entry.mirror.open,
                resumed: entry.resumed === true,
                restored: entry.restored === true,
            }));
        },

        /**
         * Fold one Cursor event into whichever child conversation owns the key.
         *
         * @param key - pool key of the running conversation.
         * @param event - normalized event from `CursorSession`.
         */
        observe(key, event) {
            const entry = entries.get(key);
            if (entry === undefined)
                return;
            entry.lastUsed = Date.now();
            entry.mirror.observe(event);
        },

        /**
         * Get or create the child conversation for one pool key.
         *
         * @param options - `key`, `parent`, `label`, `announce`, `childSessionId`.
         * @returns the entry, or undefined when no child conversation is possible.
         */
        async open(options) {
            const key = String(options.key);
            const existing = entries.get(key);
            if (existing !== undefined && existing.disposed !== true) {
                existing.lastUsed = Date.now();
                if (options.retain) existing.references = (existing.references ?? 0) + 1;
                return existing;
            }
            if (agents === undefined) {
                if (options.strict) throw new Error("cursor: agents service is unavailable");
                if (!reportedMissing) {
                    reportedMissing = true;
                    logger?.info?.('dsh-cursor-dev: child conversations are unavailable on this host (no `agents` service); runs still work');
                }
                return undefined;
            }
            // Rejoin the child a previous run opened for this conversation before
            // opening a new one: one Cursor conversation is one child log.
            const remembered = options.childSessionId;
            if (typeof remembered === 'string' && remembered !== '') {
                try {
                    const resumed = await resumeCursorChild({
                        agents,
                        parent: options.parent,
                        childSessionId: remembered,
                        model: options.model,
                        maxChildDepth: maxChildDepthNow(),
                        logger,
                    });
                    if (resumed !== undefined) {
                        const entry = { ...resumed, key, disposed: false, resumed: true, references: options.retain ? 1 : 0, lastUsed: Date.now() };
                        entries.set(key, entry);
                        await reap();
                        return entry;
                    }
                }
                catch (error) {
                    // The remembered child is gone (pruned log, another host, a
                    // cleared store): open a fresh one rather than losing the view.
                    logger?.warn?.(`dsh-cursor-dev: could not reopen child ${remembered}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            try {
                const opened = await openCursorChild({
                    agents,
                    parent: options.parent,
                    label: options.label,
                    model: options.model,
                    descriptor: options.descriptor,
                    announce: options.announce,
                    maxChildDepth: maxChildDepthNow(),
                    logger,
                });
                if (opened === undefined) {
                    if (options.strict) throw new Error("cursor: a native child could not be created");
                    return undefined;
                }
                const entry = { ...opened, key, disposed: false, resumed: false, references: options.retain ? 1 : 0, lastUsed: Date.now() };
                entries.set(key, entry);
                await reap();
                return entry;
            }
            catch (error) {
                if (options.strict) throw error;
                // Standalone hosts can still run without a child transcript.
                logger?.warn?.(`dsh-cursor-dev: could not open a child conversation: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        },

        /**
         * Publish a replayed Cursor transcript as a child conversation.
         *
         * The child is created here rather than in `open()` because the caller
         * already has the transcript: a restore reads the CLI's store first and
         * only then has something to publish. The live parent is looked up by
         * id and may be gone — a durable row outlives its session, and one of
         * them was never a DSH session at all.
         *
         * @param options - `key`, `parentSessionId`, `cwd`, `label`, `events`, `model`.
         * @returns the hub entry, or undefined when no child could be published.
         */
        async restore(options) {
            if (agents === undefined)
                return undefined;
            const key = String(options.key);
            const existing = entries.get(key);
            if (existing !== undefined && existing.disposed !== true) {
                existing.lastUsed = Date.now();
                return existing;
            }
            const parent = typeof agents.get === 'function' ? agents.get(options.parentSessionId) : undefined;
            let opened;
            try {
                opened = await openRestoredChild({
                    agents,
                    parent,
                    parentSessionId: options.parentSessionId,
                    cwd: options.cwd,
                    label: options.label,
                    logger,
                });
            }
            catch (error) {
                logger?.warn?.(`dsh-cursor-dev: could not publish the restored conversation: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
            if (opened === undefined)
                return undefined;
            try {
                mirrorTranscript(opened.mirror, options.events ?? [], { model: options.model });
            }
            catch (error) {
                // The child exists but its log is incomplete: hand back nothing
                // so the caller does not record an id that reads as a broken
                // conversation, and let disposal clean the half-written log up.
                logger?.warn?.(`dsh-cursor-dev: could not write the restored transcript: ${error instanceof Error ? error.message : String(error)}`);
                try {
                    await opened.dispose();
                }
                catch {
                    // Best effort; the persisted log is the record.
                }
                return undefined;
            }
            const entry = { ...opened, key, disposed: false, resumed: false, restored: true, lastUsed: Date.now() };
            entries.set(key, entry);
            await reap();
            return entry;
        },

        /**
         * Dispose every child conversation belonging to one conversation line.
         *
         * `resetSession` starts a new generation of the same work, so the old
         * child log must be closed rather than left open behind a key nothing
         * will ever ask for again.
         *
         * @param conversationKey - `parent::label`.
         */
        async dropConversation(conversationKey) {
            const prefix = `${conversationKey}#`;
            const doomed = [...entries.entries()].filter(([key]) => key.startsWith(prefix));
            for (const [key] of doomed)
                entries.delete(key);
            await Promise.allSettled(doomed.map(([, entry]) => entry.dispose()));
        },

        /**
         * Close the mirrored turn for one key, keeping the conversation open.
         *
         * @param key - pool key.
         * @param outcome - `{text, reasoning, ok, stopReason, error, model, cancelled}`.
         */
        close(key, outcome) {
            const entry = entries.get(String(key));
            if (entry === undefined)
                return;
            try {
                entry.mirror.finish(outcome);
            }
            catch (error) {
                logger?.warn?.(`dsh-cursor-dev: could not close the mirrored turn: ${error instanceof Error ? error.message : String(error)}`);
            }
        },

        /**
         * Dispose one child agent and forget its conversation.
         *
         * @param key - pool key.
         */
        async release(key, options = {}) {
            const entry = entries.get(String(key));
            if (entry === undefined || (options.entry !== undefined && options.entry !== entry))
                return;
            if (entry.references > 0) entry.references -= 1;
            if (entry.references > 0) return;
            entries.delete(String(key));
            entry.disposed = true;
            try {
                await entry.dispose();
            }
            catch (error) {
                if (options.strict) throw error;
            }
        },

        /** Dispose every child agent (plugin unload). */
        async dispose() {
            const all = [...entries.values()];
            entries.clear();
            await Promise.allSettled(all.map(entry => entry.dispose()));
        },
    };
}
