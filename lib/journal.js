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
}
