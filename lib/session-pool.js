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
import { CursorSession } from './cursor-session.js';

/** How many live Cursor processes the pool keeps at once. */
const DEFAULT_MAX_LIVE = 3;
/** How long an unused session is kept alive before it is reaped. */
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

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
    /** Tail of the FIFO queue that serializes every Cursor turn. */
    #gate = Promise.resolve();
    #lockDepth = 0;

    /**
     * @param config - plugin config (maxLiveSessions, sessionIdleMinutes, spawn/env).
     * @param onEvent - event sink shared by every session.
     */
    constructor(config, onEvent) {
        this.#config = config;
        this.#onEvent = onEvent;
        this.#maxLive = config.maxLiveSessions ?? DEFAULT_MAX_LIVE;
        this.#idleMs = (config.sessionIdleMinutes ?? DEFAULT_IDLE_MS / 60000) * 60000;
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
            model: entry.session.models?.currentModelId,
            mode: entry.session.modes?.currentModeId,
            turns: entry.turns.length,
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
        }));
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
        const release = await this.#enter();
        try {
            const lease = await this.#acquire(options, options.signal);
            try {
                return await body(lease);
            }
            finally {
                this.#touch(lease.key);
            }
        }
        finally {
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
        if (this.#disposed)
            throw new Error('cursor-dev: plugin is unloading');

        const spawnConfig = {
            resolved: this.#config.resolved,
            cwd,
            env: this.#config.env,
            spawn: this.#config.spawn,
        };

        const existing = this.#sessions.get(key);
        if (existing !== undefined) {
            if (existing.session.alive && existing.session.cwd === cwd) {
                existing.lastUsed = Date.now();
                if (model !== undefined && model !== '' && existing.session.models?.currentModelId !== model)
                    await existing.session.setModel(model);
                return { key, session: existing.session, reused: true, reloaded: existing.reloaded, turns: existing.turns };
            }
            // A different cwd (or a dead process) means this pooled entry is
            // useless — drop it. `session/load` is the fallback that keeps the
            // conversation itself alive.
            this.#evict(key);
        }

        await this.#enforceLimit();

        if (typeof persistedSessionId === 'string' && persistedSessionId !== '') {
            const resumed = await this.#tryLoad(key, persistedSessionId, cwd, spawnConfig, signal, storeKey);
            if (resumed !== undefined)
                return resumed;
        }

        return this.#spawnFresh(key, cwd, model, spawnConfig, signal, storeKey);
    }

    /**
     * Attempt `session/load`; a failure is not fatal (the caller falls back to a
     * fresh session), but it is reported so a real regression stays visible.
     */
    async #tryLoad(key, sessionId, cwd, spawnConfig, signal, storeKey) {
        const session = new CursorSession(spawnConfig, (event) => {
            this.#onEvent(key, event);
        });
        try {
            await session.load(sessionId, { signal });
        }
        catch (error) {
            this.#onEvent(key, {
                kind: 'load-failed',
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            try {
                session.kill();
            }
            catch {
                // best effort
            }
            return undefined;
        }
        const entry = {
            key,
            session,
            turns: [],
            lastUsed: Date.now(),
            reloaded: true,
        };
        this.#sessions.set(key, entry);
        this.#remember(storeKey, sessionId, session);
        return { key, session, reused: true, reloaded: true, turns: entry.turns };
    }

    /** Spawn a brand-new Cursor session (nothing to resume, or resume failed). */
    async #spawnFresh(key, cwd, model, spawnConfig, signal, storeKey) {
        const session = new CursorSession(spawnConfig, (event) => {
            this.#onEvent(key, event);
        });
        await session.start(signal);
        if (model !== undefined && model !== '') {
            try {
                await session.setModel(model);
            }
            catch (error) {
                session.dispose();
                throw error;
            }
        }
        const entry = {
            key,
            session,
            turns: [],
            lastUsed: Date.now(),
            reloaded: false,
        };
        this.#sessions.set(key, entry);
        this.#remember(storeKey, session.sessionId, session);
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
     */
    #remember(storeKey, sessionId, session) {
        const durable = storeKey ?? session.cwd;
        if (typeof sessionId !== 'string' || sessionId === '')
            return;
        this.#persisted.set(durable, {
            sessionId,
            cwd: session.cwd,
            model: session.models?.currentModelId,
        });
    }

    /**
     * The durable Cursor session id recorded for a conversation key, if any.
     * @param storeKey - conversation-scoped durable key.
     */
    persistedFor(storeKey) {
        return this.#persisted.get(storeKey);
    }

    /**
     * Enter the global turn lock, returning the release function.
     *
     * A plain promise chain would let a long run starve later callers only if
     * they were ordered unfairly — a FIFO gate is fair by construction, and the
     * depth counter lets the status route report what is queued.
     */
    async #enter() {
        this.#lockDepth += 1;
        let releaseGate;
        const previous = this.#gate;
        this.#gate = new Promise((resolve) => {
            releaseGate = resolve;
        });
        await previous;
        return () => {
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
