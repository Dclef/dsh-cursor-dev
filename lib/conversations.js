/**
 * Durable conversation index.
 *
 * The live pool holds processes; this file holds the *identity* of each
 * conversation so a later run can tell the difference between "this key never
 * existed" and "this key existed but its process is gone" — and, when Cursor
 * supports it, attempt a cold resume instead of silently starting over.
 *
 * Written with a temp-file + rename so a crash mid-write cannot corrupt it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Small JSON-backed map of pool key -> conversation identity.
 */
export class ConversationIndex {
    #path;
    #entries = new Map();
    #loaded = false;
    #writeChain = Promise.resolve();
    #lastError;

    /**
     * @param dataDir - plugin state directory.
     */
    constructor(dataDir) {
        this.#path = join(dataDir, 'conversations.json');
    }

    /** Absolute path of the backing file. */
    get path() {
        return this.#path;
    }

    /**
     * Why the index could not be read or written, if it could not.
     *
     * Persistence is best effort: a read-only data directory must not fail a
     * coding task. But silently losing conversation identity is what turns a
     * "resume this conversation" run into a brand new session with no history,
     * so the loss is recorded here and the status surface can say so.
     *
     * @returns the last failure message, or undefined when persistence is fine.
     */
    get persistenceWarning() {
        return this.#lastError;
    }

    /** Load from disk once. A corrupt file is discarded, not fatal. */
    async load() {
        if (this.#loaded)
            return;
        this.#loaded = true;
        try {
            const raw = await readFile(this.#path, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object') {
                for (const [key, value] of Object.entries(parsed))
                    this.#entries.set(key, value);
            }
        }
        catch (error) {
            // Missing or unreadable: start empty. A missing file is the normal
            // first run, so only a real failure is worth reporting.
            const message = errorText(error);
            if (!message.includes('ENOENT'))
                this.#lastError = `cannot read ${this.#path}: ${message}`;
        }
    }

    /**
     * Read one entry.
     *
     * @param key - pool key.
     */
    get(key) {
        return this.#entries.get(key);
    }

    /**
     * Insert or update one entry and persist.
     *
     * @param key - pool key.
     * @param entry - conversation identity record.
     */
    async set(key, entry) {
        this.#entries.set(key, entry);
        await this.#flush();
    }

    /**
     * Remove one entry and persist.
     *
     * @param key - pool key.
     */
    async delete(key) {
        if (this.#entries.delete(key))
            await this.#flush();
    }

    /** Every live index entry. */
    list() {
        return [...this.#entries.entries()].map(([key, value]) => ({ key, ...value }));
    }

    /** Persist atomically, serialized so concurrent writes cannot interleave. */
    async #flush() {
        const payload = JSON.stringify(Object.fromEntries(this.#entries), null, 2);
        this.#writeChain = this.#writeChain.then(async () => {
            await mkdir(dirname(this.#path), { recursive: true });
            const temporary = `${this.#path}.tmp`;
            await writeFile(temporary, payload, 'utf8');
            await rename(temporary, this.#path);
            // A write that went through clears the warning: the panel must not
            // keep showing a failure that a later run already fixed.
            this.#lastError = undefined;
        }).catch(error => {
            // A failed index write must not fail the coding task itself. It is
            // remembered instead, because a lost index is exactly why a resumed
            // run silently starts over.
            this.#lastError = `cannot write ${this.#path}: ${errorText(error)}`;
        });
        await this.#writeChain;
    }
}

/**
 * One short line for a failed filesystem call.
 *
 * `Error.message` already carries the `code` for `fs` failures (`ENOENT:
 * no such file …`), so the message is kept as-is; anything non-Error is
 * stringified rather than turning into `[object Object]` in the panel.
 *
 * @param error - the rejection reason.
 */
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
