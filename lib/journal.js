/**
 * Per-run event journal.
 *
 * The ACP stream is rich (reasoning, tool calls, diffs, permissions) but the
 * parent model must not pay for all of it: the tool result stays compact while
 * the full journal stays available for inspection. Each key keeps a bounded
 * ring so a long session cannot grow without limit.
 */

/** Events kept per key. */
const CAPACITY = 600;

/** Floor for the retention window, so a typo cannot evict a running session. */
const MIN_TTL_MS = 10 * 60 * 1000;

/** Shortest gap between retention sweeps. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** One journal entry. */
let sequence = 0;

/**
 * Bounded, queryable record of everything a Cursor session did.
 */
export class RunJournal {
    #entries = new Map();

    #ttlMs;

    #lastSweep = 0;

    /**
     * @param options - `ttlMs` retention window (default 60 min, min 10 min).
     */
    constructor(options = {}) {
        this.#ttlMs = Math.max(MIN_TTL_MS, options.ttlMs ?? 60 * 60 * 1000);
    }

    /** Retention window in milliseconds. */
    get ttlMs() {
        return this.#ttlMs;
    }

    /**
     * Append one normalized event.
     *
     * @param key - pool key identifying the conversation.
     * @param event - normalized event from `CursorSession`.
     */
    append(key, event) {
        const bucket = this.#bucket(key);
        bucket.updatedAt = Date.now();
        bucket.events.push({ seq: ++sequence, time: Date.now(), ...event });
        if (bucket.events.length > CAPACITY)
            bucket.events.splice(0, bucket.events.length - CAPACITY);
        this.#sweep();
    }

    /**
     * Record run-level facts for a key.
     *
     * @param key - pool key.
     * @param patch - fields to merge.
     */
    annotate(key, patch) {
        const bucket = this.#bucket(key);
        bucket.updatedAt = Date.now();
        Object.assign(bucket, patch);
        this.#sweep();
        return bucket;
    }

    /**
     * Read one key's journal.
     *
     * @param key - pool key.
     */
    read(key) {
        return this.#entries.get(key);
    }

    /**
     * Drop one key's journal.
     *
     * @param key - pool key.
     */
    clear(key) {
        this.#entries.delete(key);
    }

    /**
     * Drop every generation's journal for one conversation.
     *
     * `clear` is exact-keyed, which is right for a live run but useless for a
     * conversation being forgotten: its buckets are keyed `parent::label#2` and
     * the caller only knows `parent::label`. Sweeping the prefix is what makes
     * "delete this history row" actually delete the timeline behind it.
     *
     * @param conversationKey - `parent::label`.
     * @returns how many buckets were dropped.
     */
    clearConversation(conversationKey) {
        const prefix = `${conversationKey}#`;
        let dropped = 0;
        for (const key of [...this.#entries.keys()]) {
            if (key === conversationKey || key.startsWith(prefix)) {
                this.#entries.delete(key);
                dropped += 1;
            }
        }
        return dropped;
    }

    /**
     * Read the newest journal belonging to one conversation.
     *
     * Buckets are keyed by the generation-scoped pool key (`parent::label#2`),
     * but the durable conversation index — and therefore the dashboard's
     * 历史会话 table — only knows the conversation key (`parent::label`). A row
     * that links by the durable key would ask for a bucket that never existed,
     * so the lookup walks the generations and answers with the most recent one
     * that still has a journal.
     *
     * @param conversationKey - `parent::label`.
     * @returns `{key, bucket}` for the newest matching generation, else undefined.
     */
    readConversation(conversationKey) {
        const prefix = `${conversationKey}#`;
        let found;
        for (const [key, bucket] of this.#entries) {
            if (!key.startsWith(prefix))
                continue;
            if (found === undefined || (bucket.updatedAt ?? bucket.startedAt) > (found.bucket.updatedAt ?? found.bucket.startedAt))
                found = { key, bucket };
        }
        return found;
    }

    /**
     * Counts for inspection surfaces (the dashboard, the status route).
     */
    stats() {
        let events = 0;
        for (const bucket of this.#entries.values())
            events += bucket.events.length;
        return { keys: this.#entries.size, events, ttlMs: this.#ttlMs };
    }

    /** Get or create a key's bucket. */
    #bucket(key) {
        let bucket = this.#entries.get(key);
        if (bucket === undefined) {
            const now = Date.now();
            bucket = { events: [], startedAt: now, updatedAt: now, task: undefined, cursorSessionId: undefined };
            this.#entries.set(key, bucket);
        }
        return bucket;
    }

    /**
     * Drop journals nobody has touched inside the retention window. Runs at most
     * once a minute and is driven by writes, so it costs nothing when idle.
     */
    #sweep() {
        const now = Date.now();
        if (now - this.#lastSweep < SWEEP_INTERVAL_MS)
            return;
        this.#lastSweep = now;
        const cutoff = now - this.#ttlMs;
        for (const [key, bucket] of this.#entries) {
            if ((bucket.updatedAt ?? bucket.startedAt) < cutoff)
                this.#entries.delete(key);
        }
    }

    /**
     * Reduce a key's journal to the token-cheap signals a parent model benefits
     * from: what tools ran, in what order, and how they ended.
     *
     * @param key - pool key.
     * @param limit - maximum steps reported.
     */
    timeline(key, limit = 40) {
        const bucket = this.#entries.get(key);
        if (bucket === undefined)
            return [];
        const steps = [];
        const index = new Map();
        for (const event of bucket.events) {
            if (event.kind === 'tool-call') {
                const call = event.call;
                // A malformed event must not take down the caller: this runs
                // inside an HTTP handler, where a throw is a process-level
                // unhandled exception rather than a 500.
                if (call === undefined || call.id === undefined)
                    continue;
                index.set(call.id, steps.length);
                steps.push({
                    id: call.id,
                    name: call.name,
                    kind: call.kind,
                    path: call.path,
                    status: call.status,
                    diffCount: 0,
                });
                continue;
            }
            if (event.kind === 'tool-update') {
                const call = event.call;
                if (call === undefined || call.id === undefined)
                    continue;
                const position = index.get(call.id);
                if (position === undefined)
                    continue;
                const step = steps[position];
                step.status = call.status;
                step.name = call.name ?? step.name;
                if (call.path !== undefined)
                    step.path = call.path;
                step.diffCount += typeof event.diffCount === 'number' ? event.diffCount : 0;
            }
        }
        return steps.slice(0, limit);
    }

    /**
     * Whether a key has recorded anything.
     *
     * @param key - pool key.
     */
    has(key) {
        return this.#entries.has(key);
    }

    /**
     * The newest thing a run did, in one line.
     *
     * This is the answer to "what is the child doing right now" for a table row,
     * where fetching the whole journal per row would be wasteful. The newest
     * event that carries meaning for a reader is used: a tool call, a tool
     * result, a message, a thought. Bookkeeping events (turn-start, mode) are
     * skipped rather than reported as activity.
     *
     * @param key - pool key.
     * @param maxChars - cap for the returned text.
     */
    lastActivity(key, maxChars = 160) {
        const bucket = this.#entries.get(key);
        if (bucket === undefined)
            return undefined;
        for (let position = bucket.events.length - 1; position >= 0; position -= 1) {
            const event = bucket.events[position];
            const text = describeEvent(event);
            if (text === undefined)
                continue;
            return {
                seq: event.seq,
                time: event.time,
                kind: event.kind,
                text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text,
            };
        }
        return undefined;
    }
}

/**
 * One line of human-readable activity for an event, or `undefined` when the
 * event says nothing about what the run is doing.
 *
 * @param event - normalized journal event.
 */
function describeEvent(event) {
    const call = event?.call;
    switch (event?.kind) {
        case 'tool-call':
            return call === undefined
                ? undefined
                : `${call.name ?? 'tool'} ${call.path ?? call.arguments ?? ''}`.trim();
        case 'tool-update':
            return call === undefined
                ? undefined
                : `${call.name ?? 'tool'} → ${call.status ?? 'running'}${call.path === undefined ? '' : ` ${call.path}`}`;
        case 'text':
            return typeof event.text === 'string' ? event.text : undefined;
        case 'thought':
            return typeof event.text === 'string' ? `💭 ${event.text}` : undefined;
        case 'diff':
            return `diff ${event.diff?.path ?? ''}`.trim();
        case 'permission':
            return `permission ${event.kindOf ?? ''}`.trim();
        case 'plan':
            return 'plan update';
        case 'turn-end':
            return `turn ${event.index ?? ''} ${event.stopReason ?? ''}`.trim();
        default:
            return undefined;
    }
}
