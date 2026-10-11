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
        catch {
            // Missing or unreadable: start empty.
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
        }).catch(() => {
            // A failed index write must not fail the coding task itself.
        });
        await this.#writeChain;
    }
}
