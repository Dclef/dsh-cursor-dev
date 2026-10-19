import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorQuotaGuard, cursorQuotaFailure, usageQuotaExhausted } from '../lib/quota-guard.js';

function usage(total, auto = total, api = total) {
    return { total: { percentUsed: total }, auto: { percentUsed: auto }, api: { percentUsed: api } };
}

test('only all three explicit quota buckets establish global exhaustion', () => {
    assert.equal(usageQuotaExhausted(usage(100, 100, 100)), true);
    assert.equal(usageQuotaExhausted(usage(100, 100, 99.9)), false);
    assert.equal(usageQuotaExhausted({ ...usage(100, 100, 100), displayMessage: "You've hit your usage limit" }), true);
    assert.equal(usageQuotaExhausted({ ...usage(84, 85, 46), displayMessage: "You've hit your usage limit" }), false);
    assert.equal(usageQuotaExhausted({ total: { percentUsed: 100 }, api: { percentUsed: 100 } }), false);
});

test('an advisory dashboard message does not block while usage remains', async () => {
    const guard = new CursorQuotaGuard({ get: async () => ({ ok: true, fetchedAt: 100, usage: {
        ...usage(84, 85, 46), displayMessage: "You've hit your usage limit",
    } }) }, { now: () => 100 });
    assert.equal((await guard.check()).blocked, false);
    assert.equal(guard.snapshot().source, 'usage');
});

test('usage lookup failure fails open when no exhaustion has been confirmed', async () => {
    for (const usageClient of [
        { get: async () => ({ ok: false, error: 'offline' }) },
        { get: async () => { throw new Error('offline'); } },
    ]) {
        const guard = new CursorQuotaGuard(usageClient);
        assert.equal((await guard.check()).blocked, false);
        assert.equal(guard.snapshot().source, 'unknown');
    }
});

test('an upstream exhausted error pauses calls until a fresh usage snapshot clears it', async () => {
    let now = 1_000;
    const forceArgs = [];
    const client = { get: async args => {
        forceArgs.push(args);
        return { ok: true, fetchedAt: now, usage: usage(80, 80, 40) };
    } };
    const guard = new CursorQuotaGuard(client, { now: () => now, recheckMs: 30_000 });
    assert.equal((await guard.check()).blocked, false);
    const blocked = guard.observeFailure(new Error('ConnectError: RESOURCE_EXHAUSTED: Cursor usage quota exhausted'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.source, 'cursor-error');
    assert.equal((await guard.check()).blocked, true, 'do not recheck before the short cooldown');
    assert.equal(forceArgs.length, 1);
    now += 30_001;
    const resumed = await guard.check();
    assert.equal(forceArgs[1].force, true, 'a blocked state must bypass the usage cache');
    assert.equal(resumed.blocked, false);
});

test('stale and unavailable refreshes cannot clear an existing block', async () => {
    let now = 10;
    let mode = 'exhausted';
    const client = { get: async () => {
        if (mode === 'unavailable') return { ok: false };
        if (mode === 'stale') return { ok: true, fetchedAt: 10, usage: usage(80, 80, 40) };
        return { ok: true, fetchedAt: now, usage: usage(100, 100, 100) };
    } };
    const guard = new CursorQuotaGuard(client, { now: () => now, recheckMs: 100 });
    assert.equal((await guard.check()).blocked, true);
    now = 111;
    mode = 'stale';
    assert.equal((await guard.check()).blocked, true);
    now = 212;
    mode = 'unavailable';
    assert.equal((await guard.check()).blocked, true);
    now = 313;
    mode = 'recovered';
    client.get = async () => ({ ok: true, fetchedAt: now, usage: usage(80, 80, 40) });
    assert.equal((await guard.check()).blocked, false);
});

test('temporary throttling is not mistaken for exhausted account quota', () => {
    assert.equal(cursorQuotaFailure(new Error('HTTP 429 rate limit exceeded')), false);
    assert.equal(cursorQuotaFailure(new Error('insufficient quota')), true);
    assert.equal(cursorQuotaFailure({ code: 'RESOURCE_EXHAUSTED', message: 'request failed' }), true);
    assert.equal(cursorQuotaFailure({ code: 8 }), true);
});
