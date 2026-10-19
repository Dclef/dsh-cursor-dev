const RECHECK_MS = 30_000;

const QUOTA_ERROR = /\b(?:resource[_ -]?exhausted|insufficient[_ -]?quota|quota[_ -]?exceeded|credit[_ -]?balance[_ -]?exhausted)\b|\b(?:insufficient|out of|no remaining|zero|empty|exhausted|depleted)\b.{0,50}\b(?:cursor\s+)?(?:usage|quota|credits?|balance)\b|\b(?:cursor\s+)?(?:usage|quota|credits?|balance)\b.{0,50}\b(?:exhausted|depleted|used up|is empty|limit (?:has been )?reached|limit exceeded|insufficient)\b|\b(?:you(?:'ve| have) hit your usage limit|usage limit has been reached|no usage credits remaining)\b/i;

/** Only the explicit upstream bucket percentages can establish global exhaustion. */
export function usageQuotaExhausted(usage) {
    const percentages = ['total', 'auto', 'api'].map(name => usage?.[name]?.percentUsed);
    return percentages.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 100);
}

/** Inspect an actual Cursor/ACP failure, never the dashboard's advisory prose. */
export function cursorQuotaFailure(error) {
    const code = error?.code;
    if (code === 8 || /^(?:RESOURCE_EXHAUSTED|INSUFFICIENT_QUOTA|QUOTA_EXCEEDED|CREDIT_BALANCE_EXHAUSTED)$/i.test(String(code ?? '')))
        return true;
    const parts = [error?.name, error?.message, error?.data?.message, error?.cause?.message];
    if (typeof error === 'string') parts.push(error);
    try {
        if (error !== null && typeof error === 'object') parts.push(JSON.stringify(error));
    }
    catch { /* An unstringifiable error can still match its message/code. */ }
    return QUOTA_ERROR.test(parts.filter(value => typeof value === 'string').join(' '));
}

export function quotaBlockedMessage(state) {
    return state?.source === 'cursor-error'
        ? 'CURSOR_QUOTA_EXHAUSTED: Cursor reported that its usage is exhausted. New Cursor child-agent runs are paused until a successful quota refresh confirms capacity has returned.'
        : 'CURSOR_QUOTA_EXHAUSTED: Cursor reports that all usage buckets are exhausted. No child agent was started. Check the quota panel and retry after a successful refresh confirms capacity has returned.';
}

/** Shared gate for native subagent starts and direct cursor_code calls. */
export class CursorQuotaGuard {
    #usage;
    #now;
    #recheckMs;
    #state = { blocked: false, source: 'unknown' };
    #lastCheckAt = 0;
    #revision = 0;
    #inflight;

    constructor(usage, options = {}) {
        this.#usage = usage;
        this.#now = options.now ?? Date.now;
        this.#recheckMs = options.recheckMs ?? RECHECK_MS;
    }

    snapshot() {
        return { ...this.#state };
    }

    async check() {
        const now = this.#now();
        if (this.#state.blocked && now - this.#lastCheckAt < this.#recheckMs)
            return this.snapshot();
        if (this.#inflight !== undefined)
            return this.#inflight;

        const revision = this.#revision;
        this.#inflight = (async () => {
            let snapshot;
            try {
                snapshot = await this.#usage?.get?.({ force: this.#state.blocked });
            }
            catch {
                snapshot = undefined;
            }
            this.#lastCheckAt = this.#now();
            if (revision !== this.#revision && this.#state.blocked)
                return this.snapshot();
            return this.observeUsage(snapshot);
        })().finally(() => { this.#inflight = undefined; });
        return this.#inflight;
    }

    observeUsage(snapshot) {
        if (snapshot?.ok !== true) {
            if (!this.#state.blocked)
                this.#state = { blocked: false, source: 'unknown' };
            return this.snapshot();
        }
        const fetchedAt = snapshot.fetchedAt;
        if (this.#state.blocked
            && (!Number.isFinite(fetchedAt) || fetchedAt <= this.#state.since))
            return this.snapshot();
        this.#lastCheckAt = this.#now();
        if (usageQuotaExhausted(snapshot.usage)) {
            this.#state = {
                blocked: true,
                source: 'usage',
                reason: 'all-usage-buckets-exhausted',
                since: Number.isFinite(fetchedAt) ? fetchedAt : this.#now(),
            };
        }
        else {
            this.#state = { blocked: false, source: 'usage' };
        }
        return this.snapshot();
    }

    observeFailure(error) {
        if (!cursorQuotaFailure(error))
            return this.snapshot();
        this.#revision += 1;
        this.#lastCheckAt = this.#now();
        this.#state = {
            blocked: true,
            source: 'cursor-error',
            reason: 'cursor-reported-exhaustion',
            since: this.#lastCheckAt,
        };
        return this.snapshot();
    }
}
