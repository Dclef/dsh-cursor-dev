/**
 * Pool of live Cursor sessions + the global turn lock.
 *
 * This is what makes "接着上次继续改" real, on two levels:
 *
 * 1. LIVE — a pooled session keeps its Cursor process (and therefore its
 *    conversation context) alive between tool calls, so a follow-up call is a
 *    genuine continuation rather than a fresh, amnesiac run.
 * 2. DURABLE — if the process is gone (DSH restarted, the pool evicted it, the
 *    OS reaped it), the Cursor session id is rehydrated with `session/load`, so
 *    the child still remembers what it did. Only a session that never completed
 *    a prompt is unresumable, because the CLI has not flushed it to disk yet.
 *
 * THE GLOBAL MODEL LOCK (important, non-obvious):
 * the Cursor CLI applies `session/set_model` GLOBALLY — switching the model for
 * one conversation changes what every session in every process reports, and the
 * choice survives restarts. Two conversations running concurrently with
 * different models would therefore corrupt each other. `run()` takes an
 * exclusive turn lock, so exactly one Cursor turn is ever in flight inside this
 * plugin, and the model is set immediately before the prompt that needs it.
 * A *conversation* (`parent::label`) can have several *generations*
 * (`parent::label#N`). A turn that continues the conversation reuses the current
 * generation; a turn that must start fresh bumps the generation, so the fresh
 * run cannot accidentally inherit the old conversation's context.
 *
 * Trade-offs are explicit:
 * - each live session costs one `cursor-agent` process, so the pool is capped
 *   and evicts least-recently-used entries (evicting is now cheap: the next
 *   turn reloads the conversation instead of losing it);
 * - idle sessions are reaped after `idleMs`;
 * - a session bound to a different working directory is replaced.
 */
import { CursorSession, CursorAcpError } from './cursor-session.js';
import { CliSession } from './cli-runner.js';
import { listRosterModels, resolveModel, rosterFromSession, sameModel, splitTier } from './models.js';

/** How many live Cursor processes the pool keeps at once. */
const DEFAULT_MAX_LIVE = 3;
/** How long an unused session is kept alive before it is reaped. */
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
/** Budget for the throwaway roster probe, which must not block the panel. */
const PROBE_TIMEOUT_MS = 30 * 1000;

/**
 * Owns every live {@link CursorSession}, the global turn lock, and the durable
 * session-id map that lets a dead conversation come back.
 */
export class SessionPool {
    #config;
    #sessions = new Map();
    #generations = new Map();
    #persisted = new Map();
    #maxLive;
    #idleMs;
    #reaper;
    #onEvent;
    #disposed = false;
    /**
     * Which transport builds sessions: `acp` (default) or `cli`.
     *
     * `acp` keeps a live process and can switch models inside it, but Cursor
     * takes its model from `~/.cursor/acp-config.json` and IGNORES `--model`
     * there — measured by editing that file, which changes the model at once.
     * Its roster holds one fixed parameter set per model, and the config file
     * accepts only that spelling, so a tier the CLI lists is unreachable.
     *
     * `cli` runs one `agent -p --output-format stream-json` process per turn and
     * takes the CLI alias, which is the only spelling that really selects a
     * tier (the usage log bills it). It feeds the same event vocabulary, so its
     * runs appear in the panel as child conversations like any ACP run.
     */
    #transport;
    /** Tail of the FIFO queue that serializes every Cursor turn. */
    #gate = Promise.resolve();
    #lockDepth = 0;
    #activeKey;

    /**
     * @param config - plugin config (maxLiveSessions, sessionIdleMinutes, spawn/env).
     * @param onEvent - event sink shared by every session.
     */
    constructor(config, onEvent) {
        this.#config = config;
        this.#onEvent = onEvent;
        this.#maxLive = config.maxLiveSessions ?? DEFAULT_MAX_LIVE;
        this.#idleMs = (config.sessionIdleMinutes ?? DEFAULT_IDLE_MS / 60000) * 60000;
        this.#transport = config.transport === 'cli' ? 'cli' : 'acp';
    }

    /**
     * Switch the transport for subsequent runs.
     *
     * Live entries belong to the old transport — an ACP process cannot serve a
     * CLI turn — so they are dropped. The durable session id behind each
     * conversation survives, and the next run rehydrates through the new
     * transport's own continuation.
     *
     * @param transport - `acp` or `cli`; anything else is ignored.
     */
    setTransport(transport) {
        if (transport !== 'cli' && transport !== 'acp') return;
        if (this.#transport === transport) return;
        this.#transport = transport;
        for (const key of [...this.#sessions.keys()]) this.#evict(key);
    }

    /**
     * Build a session object for the active transport.
     *
     * Both classes satisfy the surface the pool, tool, journal and mirror
     * consume, which is what lets a CLI run appear in the panel as a real child
     * conversation instead of only returning text.
     *
     * @param spawnConfig - resolved agent + spawn + env (+ the requested model).
     * @param key - pool key the events belong to.
     */
    #createSession(spawnConfig, key) {
        const onEvent = (event) => {
            this.#onEvent(key, event);
        };
        if (this.#transport === 'cli') {
            return new CliSession({
                resolved: spawnConfig.resolved,
                cwd: spawnConfig.cwd,
                env: spawnConfig.env,
                spawn: spawnConfig.spawn,
                model: spawnConfig.model,
            }, onEvent);
        }
        return new CursorSession(spawnConfig, onEvent);
    }

    /** Start the idle reaper. */
    start() {
        if (this.#reaper !== undefined)
            return;
        const interval = Math.max(30_000, Math.min(this.#idleMs, 120_000));
        this.#reaper = setInterval(() => {
            this.reapIdle();
        }, interval);
        this.#reaper?.unref?.();
    }

    /** Keys of every currently live session. */
    liveKeys() {
        return [...this.#sessions.keys()];
    }

    /** Snapshot metadata for every live session (used by the status route). */
    snapshot() {
        return [...this.#sessions.values()].map(entry => ({
            key: entry.key,
            cursorSessionId: entry.session.sessionId,
            cwd: entry.session.cwd,
            model: entry.session.reportedModel ?? entry.session.models?.currentModelId,
            // What this pool last APPLIED, in the caller's own name space
            // (`default[]`, `auto`, …) — not the roster's spelling. The status
            // route and the tool's change detection both need the request that
            // is in effect, which the id alone does not say.
            modelChoice: entry.modelChoice,
            mode: entry.session.modes?.currentModeId,
            turns: entry.turns.length,
            running: entry.key === this.#activeKey,
            reloaded: entry.reloaded,
            idleMs: Date.now() - entry.lastUsed,
            alive: entry.session.alive,
        }));
    }

    /** Every Cursor session id this plugin knows about, live or dormant. */
    persistedSessions() {
        return [...this.#persisted.entries()].map(([storeKey, record]) => ({
            storeKey,
            sessionId: record.sessionId,
            cwd: record.cwd,
            model: record.model,
            modelChoice: record.modelChoice,
        }));
    }

    /**
     * Resolve a model choice for `key` without acquiring the turn lock.
     *
     * Resolution itself needs no live process when the pool already knows a
     * roster: a session switched earlier in this run publishes its roster, and
     * the CLI's model state is global, so that roster lists every id the next
     * `set_config_option` will accept. A caller needs this BEFORE `run()`
     * because the outcome decides whether the turn may continue the current
     * conversation generation at all (a real model change must not inherit live
     * context, an alias-to-variant switch must not start a new conversation).
     * With nothing known the normalized choice comes back unchanged and the
     * pool decides again under the lock, where a fresh session publishes its
     * own roster.
     *
     * The roster consulted is scoped to THIS key when the pool has one. Model
     * state is process-global, so any roster is usable for the resolution
     * itself — but the model in effect belongs to the conversation, and grading
     * a request against another conversation's choice would make a genuine
     * switch look like a continuation (or the reverse).
     *
     * @param key - pool key whose known roster should be consulted.
     * @param choice - the requested model (`'auto'`, an alias, or a full id), or
     *   `undefined` to ask what the conversation is running instead.
     * @returns the pool's resolution result (`{id, ok, exact, aliased, error?}`).
     */
    resolveModelChoice(key, choice) {
        // Two call styles reach here and both are meaningful. With a `choice`,
        // grade that request against the roster this pool has scoped to `key`.
        // Without one — the argument is a conversation key and the question is
        // "what does it run?" — answer with the model in effect, never the
        // empty-string pseudo-answer `resolveModel(undefined, …)` returns, which
        // reads as "unspecified" and hides a genuine mismatch.
        if (choice === undefined)
            return this.resolveCurrentModel(storeKeyOf(String(key))) ?? resolveModel('', this.#knownRoster(key));
        return resolveModel(choice, this.#knownRoster(key));
    }

    /**
     * What the pool knows about the model in effect for one conversation.
     *
     * Two questions have to be answered separately and both live here, because
     * the pool holds two name spaces for one model: the request a caller wrote
     * (`'auto'`, `'composer-2.5-fast'`) and the id the CLI reports
     * (`'default[]'`, `'composer-2.5[fast=true]'`). Either spelling alone makes
     * a continuation look like a switch.
     *
     * - `choice` is the APPLIED choice, in the caller's own name space.
     * - `id` is that model resolved against the roster — i.e. the id the
     *   conversation is actually running — or `undefined` when the roster (and
     *   therefore any id) is unknown, which is exactly the `undefined` the
     *   resolution must return rather than a made-up match.
     *
     * Only this conversation's own records are consulted — never another
     * conversation's roster, which is reachable through the global CLI state
     * but says nothing about what this conversation runs.
     *
     * `request` is the incoming model choice resolved against that SAME roster
     * with `resolveModel` — a second name space a raw string comparison cannot
     * bridge. The CLI publishes aliases such as `composer-2.5-fast` while the
     * roster ids are parameterised (`composer-2.5[fast=true]`), so
     * `sameModel(currentModel, pickedModel)` is false for a request that names
     * the running model, while the pool itself sends no `set_config_option` for
     * it. Comparing `id` with `request.id` is what recognises that pair; this is
     * deliberately NOT folded into `sameModel`, which keeps its meaning as "same
     * model said two ways" only for spellings it can already compare.
     *
     * @param storeKey - conversation-scoped durable key.
     * @param request - optional incoming model choice to resolve alongside.
     * @returns `{choice?, id?, request?, record?}`, all-empty when the pool knows
     *   nothing.
     */
    modelContext(storeKey, request) {
        const live = [...this.#sessions.values()]
            .find(entry => storeKeyOf(entry.key) === storeKey);
        const record = live ?? this.#persisted.get(storeKey);
        if (record === undefined)
            return {};
        const roster = rosterOf(record);
        const choice = record.modelChoice ?? record.model;
        const id = choice === undefined || choice === '' ? undefined : resolveModel(choice, roster).id;
        return {
            ...(choice === undefined ? {} : { choice }),
            ...(id === undefined ? {} : { id }),
            ...(request === undefined ? {} : { request: resolveModel(request, roster) }),
            record,
        };
    }

    /**
     * The model choice currently in effect for a conversation.
     *
     * The live session wins (its roster is the truth for what a switch would
     * accept right now); otherwise the durable record of the last run answers.
     * `undefined` means no model was ever applied, i.e. the CLI default.
     *
     * @param storeKey - conversation-scoped durable key.
     */
    currentModelChoice(storeKey) {
        for (const entry of this.#sessions.values()) {
            if (storeKeyOf(entry.key) === storeKey && entry.modelChoice !== undefined)
                return entry.modelChoice;
        }
        return this.#persisted.get(storeKey)?.modelChoice;
    }

    /**
     * The pool's own view of the model in effect for one conversation, resolved
     * through the roster rather than compared as a raw string.
     *
     * The result's `id` is the CURRENT model — never the incoming request —
     * because the caller's job is to compare its own request against the model
     * the conversation runs with `sameModel`. Resolving the request instead
     * would make it always equal itself, so a genuine switch would look like a
     * continuation and inherit live context. The optional second argument
     * resolves a candidate request against the same roster and returns it as
     * `choice`, for a caller that wants both sides in one roster.
     *
     * Only this conversation's own records are consulted — never another
     * conversation's roster, which is reachable through the global CLI state but
     * says nothing about what this conversation runs.
     *
     * @param storeKey - conversation-scoped durable key.
     * @param choice - optional candidate request to resolve alongside.
     * @returns `{id, ok, exact, aliased, choice?}`, or `undefined` when the pool
     *   knows nothing yet.
     */
    resolveCurrentModel(storeKey, choice) {
        const record = this.#sessions.values().find(entry => storeKeyOf(entry.key) === storeKey)
            ?? this.#persisted.get(storeKey);
        if (record?.modelChoice === undefined)
            return undefined;
        const roster = rosterOf(record);
        // The resolution of the CURRENT model is the load-bearing part: it is
        // what the caller compares its own request against with `sameModel`.
        const resolved = resolveModel(record.modelChoice, roster);
        return {
            id: resolved.id,
            ok: resolved.ok,
            exact: resolved.exact,
            aliased: resolved.aliased,
            ...(choice === undefined ? {} : { choice: resolveModel(choice, roster) }),
        };
    }

    /**
     * Any roster this pool has already seen, newest usage first.
     *
     * Used only to answer a question BEFORE a session exists; the authoritative
     * roster of a turn always comes from the session that turn just acquired.
     *
     * @param key - pool key to prefer.
     */
    #knownRoster(key) {
        const preferred = this.#sessions.get(key);
        for (const entry of [preferred, ...this.#sessions.values()]) {
            if (entry === undefined)
                continue;
            const roster = rosterOf(entry);
            if (roster !== undefined)
                return roster;
        }
        for (const record of this.#persisted.values()) {
            const roster = rosterOf(record);
            if (roster !== undefined)
                return roster;
        }
        return undefined;
    }

    /**
     * Apply a model choice to a session, unless the session already runs it.
     *
     * Two properties matter and neither is obvious:
     *
     * 1. The choice is always resolved through the SESSION's own roster. That
     *    roster is the only list `session/set_config_option` accepts — the CLI's
     *    `--list-models` listing publishes aliases, and sending one fails the
     *    whole turn (`-32602 Invalid params: Invalid model value: auto`).
     * 2. A request that names a model the account does not offer fails HERE,
     *    with the list of ids that would have worked, instead of reaching the
     *    CLI and coming back as an opaque protocol rejection.
     *
     * @param session - the session about to run.
     * @param choice - the requested model, or `undefined` for "leave it alone".
     * @returns the choice applied, or `undefined` when none was named.
     */
    /**
     * Whether the requested model is a different tier than the running process
     * was started with.
     *
     * The tier is fixed at launch (`--model`), so a process started for
     * `grok-4.7-high` cannot answer a request for `grok-4.7-medium`. Only the
     * tier word is compared: the family has to match too, or every switch
     * between two models of one family would count as a tier change.
     *
     * @param entry - the pooled entry holding the live session.
     * @param choice - the model this turn asked for.
     */
    #tierChanged(entry, choice) {
        if (choice === undefined || choice === '')
            return false;
        const running = entry.modelChoice ?? entry.model;
        if (typeof running !== 'string' || running === '')
            return false;
        const wanted = splitTier(choice);
        const current = splitTier(running);
        if (wanted.family !== current.family)
            return false;
        return wanted.tier !== current.tier || wanted.fast !== current.fast;
    }

    async #setModelIfNeeded(session, choice) {
        if (choice === undefined || choice === '')
            return undefined;
        // The CLI transport has no roster: the alias IS the model, and the tier
        // rides in the argv of the next process. There is nothing to resolve it
        // against, and resolving it against the ACP roster would fold every tier
        // of a family onto the one id that roster publishes.
        if (this.#transport === 'cli') {
            await session.setModel(choice);
            return choice;
        }
        const roster = rosterOf(session);
        const resolved = resolveModel(choice, roster);
        if (!resolved.ok) {
            throw new CursorAcpError(
                `cursor-dev: ${resolved.error}`,
                'cursor/model-unknown',
            );
        }
        // A no-op switch is skipped rather than sent: the CLI applies its model
        // globally, so re-setting the model it already reports would churn every
        // other session's state for nothing. `sameModel` is what makes
        // `auto`/`default[]` and an alias/its variant count as one model — the
        // same comparison the panel and the tool make. The "already running"
        // side is the FOLDED roster's current id, so the no-op test and the
        // resolution above grade against one and the same list (a build that
        // reports the current model only in `configOptions` must not look like a
        // switch); the legacy block is kept as a fallback.
        if (!sameModel(roster?.currentModelId ?? session.models?.currentModelId, resolved.id))
            await session.setModel(resolved.id);
        // The CHOICE is recorded, not the roster's spelling of it. The tier lives
        // in the choice (`grok-4.7-medium`) and in the `--model` flag the process
        // was started with; the roster id has already lost it by folding every
        // tier onto one published parameter set. Keeping the choice is what lets
        // a later turn tell "same tier" from "different tier" — and that is what
        // decides whether the process has to be replaced.
        return choice;
    }

    /**
     * Pick the pool key for this turn.
     *
     * @param conversationKey - stable identity of the conversation.
     * @param mode - `'continue'` reuses the current generation,
     *   `'fresh'` starts a new one (after a reset or an explicit non-continue).
     * @returns the pool key and the generation number.
     */
    pickKey(conversationKey, mode) {
        const current = this.#generations.get(conversationKey);
        if (mode === 'continue' && current !== undefined)
            return { key: generationKey(conversationKey, current), generation: current };
        const next = (current ?? 0) + 1;
        this.#generations.set(conversationKey, next);
        return { key: generationKey(conversationKey, next), generation: next };
    }

    /**
     * Run one Cursor turn under the global lock.
     *
     * The callback receives a lease: the resolved session plus its pool
     * metadata. Everything the callback does — model switch, mode switch,
     * prompt — happens with no other Cursor turn in flight anywhere in this
     * process, which is what the CLI's global model state requires.
     *
     * @param options - `key`, `cwd`, `model`, `persistedSessionId`, `signal`.
     * @param body - the turn itself; called with the acquired lease.
     */
    async run(options, body) {
        const release = await this.#enter(options.signal);
        this.#activeKey = options.key;
        try {
            options.signal?.throwIfAborted();
            const lease = await this.#acquire(options, options.signal);
            try {
                return await body(lease);
            }
            finally {
                if (options.signal?.aborted) {
                    await lease.session.disposeAndWait();
                    if (this.#sessions.get(lease.key)?.session === lease.session)
                        this.#sessions.delete(lease.key);
                }
                this.#touch(lease.key);
            }
        }
        finally {
            this.#activeKey = undefined;
            release();
        }
    }

    /**
     * Record a finished turn on a pooled entry so the status route can show it.
     * @param key - pool key.
     * @param turn - the turn summary returned by `CursorSession.prompt`.
     */
    recordTurn(key, turn) {
        const entry = this.#sessions.get(key);
        if (entry === undefined)
            return;
        entry.turns.push(turn);
        if (entry.turns.length > 50)
            entry.turns.shift();
        entry.lastUsed = Date.now();
    }

    /** Mark a pooled entry as used now, so the reaper leaves it alone. */
    #touch(key) {
        const entry = this.#sessions.get(key);
        if (entry !== undefined)
            entry.lastUsed = Date.now();
    }

    /**
     * Resolve a usable session for `options.key`, reusing, resuming, or spawning.
     *
     * Order of preference:
     * 1. the live pooled session, when its cwd still matches;
     * 2. `session/load` of the persisted id for this key — the durable path;
     * 3. a brand-new `session/new`.
     *
     * @param options - `key`, `cwd`, `model`, `persistedSessionId`, `signal`.
     */
    async #acquire(options, signal) {
        const { key, cwd, model, persistedSessionId, storeKey } = options;
        signal?.throwIfAborted();
        if (this.#disposed)
            throw new Error('cursor-dev: plugin is unloading');

        const spawnConfig = {
            resolved: this.#config.resolved,
            cwd,
            env: await spawnEnv(this.#config),
            spawn: this.#config.spawn,
            // The CLI transport takes its model per invocation, so the requested
            // choice has to reach the object that builds the argv.
            model,
        };

        const existing = this.#sessions.get(key);
        // A CLI run is one process per turn and carries its model in the argv,
        // so a pooled handle would pin the tier of an earlier turn. Its
        // continuity lives in the durable session id behind `--resume`.
        if (existing !== undefined && this.#transport === 'cli') {
            this.#evict(key);
        }
        else if (existing !== undefined) {
            if (existing.session.alive && existing.session.cwd === cwd) {
                existing.lastUsed = Date.now();
                const onAbort = () => existing.session.dispose();
                signal?.addEventListener('abort', onAbort, { once: true });
                try {
                    signal?.throwIfAborted();
                    // A tier change needs a NEW PROCESS, not a session switch.
                    //
                    // The ACP roster publishes one fixed parameter set per model
                    // (`grok-4.7[context=256k,reasoning_effort=high,fast=true]`)
                    // and `session/set_config_option` accepts nothing else, so
                    // grok-4.7-medium and grok-4.7-low both resolve to that one
                    // id and a switch would be a no-op. The tier that really runs
                    // is the one the CLI was STARTED with, so when the requested
                    // tier differs from the one this process was launched with,
                    // the process is replaced instead of switched.
                    if (this.#tierChanged(existing, model)) {
                        this.#evict(key);
                        return this.#spawnFresh(key, cwd, model, spawnConfig, signal, storeKey);
                    }
                    existing.modelChoice = await this.#setModelIfNeeded(existing.session, model) ?? existing.modelChoice;
                    signal?.throwIfAborted();
                    return { key, session: existing.session, reused: true, reloaded: existing.reloaded, turns: existing.turns };
                }
                finally {
                    signal?.removeEventListener('abort', onAbort);
                    if (signal?.aborted) await existing.session.disposeAndWait();
                }
            }
            // A different cwd (or a dead process) means this pooled entry is
            // useless — drop it. `session/load` is the fallback that keeps the
            // conversation itself alive.
            this.#evict(key);
        }

        await this.#enforceLimit();

        if (typeof persistedSessionId === 'string' && persistedSessionId !== '') {
            const resumed = await this.#tryLoad(key, persistedSessionId, cwd, model, spawnConfig, signal, storeKey);
            if (resumed !== undefined)
                return resumed;
        }

        return this.#spawnFresh(key, cwd, model, spawnConfig, signal, storeKey);
    }

    /**
     * Attempt `session/load`; a failure is not fatal (the caller falls back to a
     * fresh session), but it is reported so a real regression stays visible.
     *
     * @param key - generation-scoped pool key.
     * @param sessionId - the durable Cursor session id to resume.
     * @param cwd - working directory the session must be bound to.
     * @param model - this turn's requested model (same contract as `#spawnFresh`).
     * @param spawnConfig - resolved agent + spawn + env.
     * @param signal - the turn's abort signal.
     * @param storeKey - conversation-scoped durable key for `#remember`.
     */
    async #tryLoad(key, sessionId, cwd, model, spawnConfig, signal, storeKey) {
        const session = this.#createSession(spawnConfig, key);
        try {
            await session.load(sessionId, { signal });
        }
        catch (error) {
            this.#onEvent(key, {
                kind: 'load-failed',
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            session.kill();
            await session.disposeAndWait();
            signal?.throwIfAborted();
            return undefined;
        }
        // The loaded session republishes the CLI's roster, and the CLI's model
        // state is global — so the resumed conversation may be running whatever
        // the LAST turn anywhere left behind. Reapplying this turn's choice here
        // is what keeps a durable conversation on the model its caller asked for.
        let applied;
        try {
            signal?.throwIfAborted();
            applied = await this.#setModelIfNeeded(session, model);
            signal?.throwIfAborted();
        }
        catch (error) {
            await session.disposeAndWait();
            throw error;
        }
        const entry = {
            key,
            session,
            turns: [],
            lastUsed: Date.now(),
            reloaded: true,
            modelChoice: applied,
        };
        this.#sessions.set(key, entry);
        this.#remember(storeKey, sessionId, session, applied);
        return { key, session, reused: true, reloaded: true, turns: entry.turns };
    }

    /** Spawn a brand-new Cursor session (nothing to resume, or resume failed). */
    async #spawnFresh(key, cwd, model, spawnConfig, signal, storeKey) {
        const session = this.#createSession(spawnConfig, key);
        let applied;
        try {
            await session.start(signal);
            signal?.throwIfAborted();
            applied = await this.#setModelIfNeeded(session, model);
            signal?.throwIfAborted();
        }
        catch (error) {
            // A fresh session that cannot take the requested model is worthless:
            // dropping it keeps the pool free of a process pinned to the wrong
            // model, and the caller still sees why the switch failed.
            await session.disposeAndWait();
            throw error;
        }
        const entry = {
            key,
            session,
            turns: [],
            lastUsed: Date.now(),
            reloaded: false,
            modelChoice: applied,
        };
        this.#sessions.set(key, entry);
        this.#remember(storeKey, session.sessionId, session, applied);
        return { key, session, reused: false, reloaded: false, turns: entry.turns };
    }

    /**
     * Record a durable session id for a conversation line.
     *
     * `storeKey` is the conversation-scoped durable key (`parent::label#0`),
     * deliberately NOT the generation-scoped pool key (`…#2`): a fresh run —
     * `continueSession:false`, a model switch, a reset — gets its own
     * generation so it cannot inherit live context, yet it still wants to load
     * the conversation's latest transcript rather than start from nothing.
     *
     * @param storeKey - conversation-scoped durable key.
     * @param sessionId - the Cursor session id to remember.
     * @param session - the session it belongs to.
     * @param modelChoice - the model choice this turn applied, not the roster's spelling.
     */
    #remember(storeKey, sessionId, session, modelChoice) {
        const durable = storeKey ?? session.cwd;
        if (typeof sessionId !== 'string' || sessionId === '')
            return;
        this.#persisted.set(durable, {
            sessionId,
            cwd: session.cwd,
            // The RESOLVED id is the canonical model: it is what the CLI
            // actually speaks, and what a later turn must compare against.
            model: session.models?.currentModelId,
            modelChoice,
            // The roster the CLI published, kept so a later process can answer
            // "is this model usable at all?" without spawning a probe first.
            // Stored in the same folded shape the live session exposes, so a
            // resuming session is not left with an empty list simply because
            // this build reports its models through `configOptions` only.
            models: rosterOf(session),
        });
    }

    /**
     * Ask a throwaway session which model ids this account can use.
     *
     * The CLI's own `--list-models` listing is not a usable source for switching
     * (`set_config_option` rejects its aliases), so the panel needs the ACP
     * session roster. Reading it means spawning a process, which must not
     * disturb the pooled entries: this probe runs on its own session with no
     * key, is never stored, and is always disposed — successful or not.
     *
     * @param options - `timeoutMs` (default 30s) and an optional `cwd`.
     * @returns `{ok: true, list}` with `listRosterModels`-shaped entries, or
     *   `{ok: false, list: [], error}` with the reason the probe could not answer.
     */
    async probeModelRoster(options = {}) {
        const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
            ? options.timeoutMs
            : PROBE_TIMEOUT_MS;
        const abort = new AbortController();
        // A hung CLI must not wedge the panel's model list; the abort only ends
        // this probe, never a pooled turn.
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        timer.unref?.();
        const session = new CursorSession({
            resolved: this.#config.resolved,
            cwd: options.cwd ?? process.cwd(),
            env: await spawnEnv(this.#config),
            spawn: this.#config.spawn,
        }, () => {
            // The probe has no journal and no pool entry to report to.
        });
        try {
            await session.start(abort.signal);
            const roster = rosterOf(session);
            const list = listRosterModels(roster);
            if (list.length === 0)
                return { ok: false, list: [], error: 'the Cursor session reported no models' };
            return { ok: true, list };
        }
        catch (error) {
            return { ok: false, list: [], error: errorText(error) };
        }
        finally {
            clearTimeout(timer);
            try {
                session.dispose();
            }
            catch {
                // The probe's process is already gone; nothing else to release.
            }
        }
    }

    /**
     * The durable Cursor session id recorded for a conversation key, if any.
     * @param storeKey - conversation-scoped durable key.
     */
    persistedFor(storeKey) {
        return this.#persisted.get(storeKey);
    }

    /**
     * Read an OLD Cursor conversation back out of the CLI's own store.
     *
     * This is the one path that only reads: it takes the same global turn lock
     * as a real run (the CLI's model choice is process-global, so a replay must
     * not interleave with a turn), spawns a THROWAWAY session, loads `sessionId`
     * with transcript capture armed, and hands the collected events to `body`.
     * The session is never pooled — a durable row's key is `parent::label` while
     * pool keys carry a generation suffix — and it is always disposed, so a
     * replay can never steal or disturb the live entry of a conversation.
     *
     * The replay deliberately does NOT switch the model: reading history must
     * not be able to fail on a roster that no longer lists the id the
     * conversation ran with, and the next real turn sets its own model anyway.
     *
     * @param options - `sessionId`, `cwd`, `signal`.
     * @param body - receives `{session, events}`.
     * @returns whatever `body` returns.
     */
    async replay(options, body) {
        const { sessionId, cwd, signal } = options;
        const release = await this.#enter();
        let session;
        try {
            // The same Cursor session must not be open twice at once: the CLI's
            // store is single-writer, so a live entry holding this very session
            // is closed first. Nothing is lost — the durable record survives, so
            // the next real turn loads it again exactly as it does after an idle
            // reap.
            for (const [key, entry] of [...this.#sessions]) {
                if (entry.session.sessionId === sessionId)
                    this.#evict(key);
            }
            session = new CursorSession({
                resolved: this.#config.resolved,
                cwd,
                env: await spawnEnv(this.#config),
                spawn: this.#config.spawn,
            }, () => {
                // The replay is collected through `onTranscript`, which is armed
                // only while the load runs; the live sink has nothing to add.
            });
            const events = [];
            await session.load(sessionId, {
                signal,
                onTranscript: (event) => {
                    events.push(event);
                },
            });
            return await body({ session, events });
        }
        finally {
            try {
                session?.dispose();
            }
            catch {
                // The replay process is already gone; nothing else to release.
            }
            release();
        }
    }

    /**
     * Enter the global turn lock, returning the release function.
     *
     * A plain promise chain would let a long run starve later callers only if
     * they were ordered unfairly — a FIFO gate is fair by construction, and the
     * depth counter lets the status route report what is queued.
     */
    async #enter(signal) {
        signal?.throwIfAborted();
        this.#lockDepth += 1;
        let releaseGate;
        const previous = this.#gate;
        this.#gate = new Promise(resolve => { releaseGate = resolve; });
        let rejectAbort;
        const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(signal.reason ?? new Error('cursor: queued run cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            if (signal?.aborted) onAbort();
            await Promise.race([previous, cancelled]);
            signal?.throwIfAborted();
        }
        catch (error) {
            this.#lockDepth -= 1;
            // Preserve FIFO order even though this waiter has already left.
            void previous.then(releaseGate);
            throw error;
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#lockDepth -= 1;
            releaseGate();
        };
    }

    /** How many turns are in flight or queued behind the lock. */
    get queued() {
        return Math.max(0, this.#lockDepth - 1);
    }

    /**
     * Drop a session, terminating its process. The durable id is kept unless
     * `forget` is set, so the conversation can still be resumed later.
     * @param key - pool key (generation-scoped).
     * @param forget - also drop the durable conversation record for this key.
     */
    #evict(key, forget = false) {
        const entry = this.#sessions.get(key);
        if (entry !== undefined) {
            this.#sessions.delete(key);
            entry.session.dispose();
        }
        if (forget)
            this.#persisted.delete(storeKeyOf(key));
    }

    /**
     * Public eviction, used by the tool's `resetSession` switch. This is the one
     * path that deliberately FORGETS the Cursor session id.
     * @param key - pool key.
     */
    drop(key) {
        this.#evict(key, true);
    }

    /**
     * Terminate every live generation of one conversation.
     * @param conversationKey - `parent::label`.
     */
    dropConversation(conversationKey) {
        for (const key of [...this.#sessions.keys()]) {
            if (key.startsWith(`${conversationKey}#`))
                this.#evict(key, true);
        }
        this.#persisted.delete(conversationKey);
        this.#generations.delete(conversationKey);
    }

    /** Reap every session idle longer than the configured window. */
    reapIdle() {
        const now = Date.now();
        for (const [key, entry] of [...this.#sessions]) {
            if (now - entry.lastUsed > this.#idleMs)
                this.#evict(key);
        }
    }

    /** Keep the live-process count under the configured cap. */
    async #enforceLimit() {
        while (this.#sessions.size >= this.#maxLive) {
            let oldestKey;
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [key, entry] of this.#sessions) {
                if (entry.lastUsed < oldestAt) {
                    oldestAt = entry.lastUsed;
                    oldestKey = key;
                }
            }
            if (oldestKey === undefined)
                return;
            this.#evict(oldestKey);
        }
    }

    /** Terminate every live session (plugin unload / HMR). */
    dispose() {
        this.#disposed = true;
        if (this.#reaper !== undefined) {
            clearInterval(this.#reaper);
            this.#reaper = undefined;
        }
        for (const key of [...this.#sessions.keys()])
            this.#evict(key);
        this.#generations.clear();
    }
}

/**
 * The environment a child is spawned with.
 *
 * The pool takes either a plain object or a function, and the indirection earns
 * its keep: the proxy a child needs is discovered asynchronously (on Windows the
 * registry has to be asked), and reading it per spawn means a proxy saved in the
 * panel a second ago already applies to the next run instead of the next restart.
 *
 * The getter may answer a promise, and awaiting it is the point rather than a
 * convenience: the very first spawn can beat the first registry lookup, and a
 * child that starts in that window silently lists a fraction of the models.
 *
 * @param config - the pool config.
 */
async function spawnEnv(config) {
    const env = config?.env;
    return typeof env === 'function' ? await env() : env;
}

/**
 * Compose a generation-scoped pool key.
 *
 * @param conversationKey - `parent::label`.
 * @param generation - generation number.
 */
function generationKey(conversationKey, generation) {
    return `${conversationKey}#${generation}`;
}

/**
 * Map a generation-scoped pool key back to its conversation-scoped durable key.
 * `parent::label#3` → `parent::label#0`.
 *
 * @param poolKey - generation-scoped key.
 */
export function storeKeyOf(poolKey) {
    const hash = poolKey.lastIndexOf('#');
    return hash === -1 ? poolKey : `${poolKey.slice(0, hash)}#0`;
}

/**
 * Strip the generation suffix from a pool key: `parent::label#3` → `parent::label`.
 *
 * This is *not* `storeKeyOf`, which normalises to generation `#0` for the pool's
 * own bookkeeping. The durable conversation index is written under the bare
 * conversation-scoped key (`lib/tool.js` stores `${parentId}::${label}`), while
 * every key the panel shows for a live row is generation-scoped. Looking such a
 * row up in the index verbatim therefore always misses, which is what made
 * "reading back" a live conversation answer `no durable conversation for that key`.
 *
 * @param poolKey - generation-scoped or conversation-scoped key.
 */
export function conversationKeyOf(poolKey) {
    const hash = poolKey.lastIndexOf('#');
    return hash === -1 ? poolKey : poolKey.slice(0, hash);
}

/**
 * Folded model roster for a pool entry, or `undefined` when none is known yet.
 *
 * A live entry is asked through `session.modelRoster`, the ACP-shaped view that
 * folds `configOptions` (authoritative, holds the parameterised ids) with the
 * legacy `models` block — the same list `session.setModel()` grades against, so
 * resolution and the no-op comparison can never disagree about what "this
 * session's models" means. A resumed conversation has no live session and falls
 * back to the legacy-shaped roster kept in the durable record, which is
 * `undefined` for a record that carries only `modelChoice`/`model` — that must
 * stay `undefined` rather than become a made-up match.
 *
 * @param entry - a live pool entry (`{session, ...}`) or a durable record.
 */
function rosterOf(entry) {
    if (entry === null || entry === undefined)
        return undefined;
    // Two object shapes reach here and they must not be confused: a pool ENTRY
    // (`{session, …}`, what this pool holds) and a bare live SESSION (what
    // `probeModelRoster` builds). An entry is recognized by holding one of the
    // pool's own fields; anything else IS the session. A live session is always
    // asked through the ACP-shaped getter — never through its legacy `models`
    // block, which is not a roster argument and would make
    // `rosterFromSession()` answer `undefined`.
    const isEntry = 'session' in entry || 'lastUsed' in entry || 'reloaded' in entry || 'timesUsed' in entry;
    const session = isEntry ? entry.session : entry;
    const live = session?.modelRoster;
    if (live !== undefined)
        return live;
    const record = entry.models;
    if (record === undefined)
        return undefined;
    const fallbackCurrent = record.currentModelId ?? entry.modelChoice ?? entry.model;
    // `rosterFromSession` reads a SESSION-shaped object and reaches a legacy
    // block through `session.models`, so the block has to be handed over inside
    // that wrapper. Passing the block itself made the reader look for
    // `block.models`, find nothing, and answer `undefined` — which silently
    // turned every durable record into "no roster at all".
    return rosterFromSession({ models: record }, fallbackCurrent);
}

/** Render an unknown thrown value as text (probe results never throw out). */
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
