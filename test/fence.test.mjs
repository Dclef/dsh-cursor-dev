/**
 * The Host/Origin fence.
 *
 * These routes are mounted on the host's web server but *outside* its `/api`
 * carrier, so the carrier's own trust check never runs for them. A live probe
 * proved the consequence: a POST carrying `Origin: https://evil.example` and
 * `Sec-Fetch-Site: cross-site` reached `/plugins/dsh-cursor-dev/api/settings`
 * and rewrote the operator's saved language. Every case below pins one half of
 * the fix, including the deliberate asymmetry that makes it safe to ship: the
 * host's 403 is adopted, its 401 is NOT (these pages stay readable without a
 * browser session, exactly as documented).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRouteFence } from '../lib/fence.js';

/** A response double that records what the fence wrote. */
function makeRes() {
    const written = { status: undefined, headers: undefined, body: undefined, ended: false };
    return {
        written,
        writeHead(status, headers) { written.status = status; written.headers = headers; },
        end(body) { written.body = body; written.ended = true; },
    };
}

/** A Cordis-shaped context whose `get` answers with the given services. */
function makeCtx(services = {}, { throws = false } = {}) {
    return {
        get(name) {
            if (throws)
                throw new Error('service lookup exploded');
            return services[name];
        },
    };
}

/** Run the fence for one request; report the verdict and what was written. */
function attempt(fence, headers, { url = '/plugins/dsh-cursor-dev/api/settings', method = 'POST' } = {}) {
    const res = makeRes();
    const allowed = fence({ url, method, headers }, res);
    return { allowed, ...res.written };
}

test('a cross-site POST is refused with 403, and nothing is written through', () => {
    const fence = createRouteFence(makeCtx());
    const result = attempt(fence, {
        host: '127.0.0.1:19387',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
    });
    assert.equal(result.allowed, false, 'the handler must not run');
    assert.equal(result.status, 403);
    assert.equal(result.ended, true, 'the fence owns the response once it refuses');
});

test('a foreign Origin is refused even when Sec-Fetch-Site lies', () => {
    // A non-browser client can send any Sec-Fetch-Site it likes, so the Origin
    // comparison has to stand on its own.
    const fence = createRouteFence(makeCtx());
    const result = attempt(fence, {
        host: '127.0.0.1:19387',
        origin: 'http://127.0.0.1:9999',
        'sec-fetch-site': 'same-origin',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
});

test('the panel\'s own same-origin POST passes', () => {
    const fence = createRouteFence(makeCtx());
    const result = attempt(fence, {
        host: '127.0.0.1:19387',
        origin: 'http://127.0.0.1:19387',
        'sec-fetch-site': 'same-origin',
    });
    assert.equal(result.allowed, true, 'the dashboard must keep saving settings');
    assert.equal(result.status, undefined);
});

test('a request with no Origin at all passes, so a local tool still works', () => {
    // curl / Invoke-WebRequest / a test harness send no Origin. Refusing them
    // would break the documented "open the JSON route with curl" workflow while
    // stopping no browser at all.
    const fence = createRouteFence(makeCtx());
    assert.equal(attempt(fence, { host: '127.0.0.1:19387' }).allowed, true);
    assert.equal(attempt(fence, { host: 'localhost:19387', 'sec-fetch-site': 'none' }).allowed, true);
});

test('an Origin with no Host is refused rather than assumed safe', () => {
    const fence = createRouteFence(makeCtx());
    const result = attempt(fence, { origin: 'http://127.0.0.1:19387' });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
});

test('an Origin that is not a URL is refused', () => {
    const fence = createRouteFence(makeCtx());
    const result = attempt(fence, { host: '127.0.0.1:19387', origin: 'not a url' });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
});

test('the host\'s own 403 is adopted, so its trusted-authority list is honoured', () => {
    const fence = createRouteFence(makeCtx({
        connection: { requestRejection: () => 403 },
    }));
    const result = attempt(fence, { host: '127.0.0.1:19387' });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
});

test('the host\'s 401 is ignored, because these pages need no browser session', () => {
    // This is the load-bearing asymmetry. Adopting the 401 would break the
    // standalone dashboard URL and every screenshot flow; ignoring it keeps the
    // route as readable as it was before this fence existed.
    const fence = createRouteFence(makeCtx({
        connection: { requestRejection: () => 401 },
    }));
    assert.equal(attempt(fence, { host: '127.0.0.1:19387' }).allowed, true);
});

test('the host\'s 403 wins even over a locally clean request', () => {
    // A trusted-host deployment (non-loopback) is exactly the case the local
    // rules cannot judge; the host can, so its verdict is taken.
    const fence = createRouteFence(makeCtx({
        connection: { requestRejection: () => 403 },
    }));
    const result = attempt(fence, {
        host: 'devbox.internal:19387',
        origin: 'http://devbox.internal:19387',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
});

test('a host whose check throws fails closed for a browser request', () => {
    const fence = createRouteFence(makeCtx({}, { throws: true }));
    assert.equal(attempt(fence, { host: '127.0.0.1:19387' }).allowed, true, 'a local tool is unaffected');
    const crossSite = attempt(fence, {
        host: '127.0.0.1:19387',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
    });
    assert.equal(crossSite.allowed, false, 'a broken host check must not open the hole back up');
    assert.equal(crossSite.status, 403);
});

test('a connection service without requestRejection degrades to the local rules', () => {
    const fence = createRouteFence(makeCtx({ connection: {} }));
    assert.equal(attempt(fence, { host: '127.0.0.1:19387' }).allowed, true);
    assert.equal(attempt(fence, {
        host: '127.0.0.1:19387',
        origin: 'https://evil.example',
    }).allowed, false);
});

test('header lookup works for both Node records and Fetch Headers', () => {
    // A Node http request gives a plain object whose keys are lowercased; an
    // adapter may hand over a `Headers` instance instead. Both must be read.
    const fence = createRouteFence(makeCtx());
    const headers = new Headers({
        host: '127.0.0.1:19387',
        origin: 'https://evil.example',
    });
    const result = attempt(fence, headers);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
});

test('a refused request is answered, never left hanging', () => {
    const fence = createRouteFence(makeCtx());
    const result = attempt(fence, {
        host: '127.0.0.1:19387',
        origin: 'https://evil.example',
    });
    assert.equal(result.headers['cache-control'], 'no-store', 'a refusal must not be cached');
    assert.match(String(result.headers['content-type']), /text\/plain/);
    assert.match(String(result.body), /did not come from the DSH page/);
});

test('the real routes refuse a cross-site write and accept the panel\'s', async () => {
    // End-to-end through the actual registrar: the gate is only worth anything
    // if it is wired into the routes the browser can reach.
    const { registerSettingsRoutes } = await import('../lib/settings.js');
    const { registerUsageRoutes, UsageClient } = await import('../lib/usage.js');
    const { RunJournal } = await import('../lib/journal.js');
    const { ConversationIndex } = await import('../lib/conversations.js');
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-fence-'));
    const routes = new Map();
    const server = {
        register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
        },
    };
    const ctx = { get: (name) => (name === 'webServer' ? server : undefined), logger: { warn: () => {} } };
    const index = new ConversationIndex(dataDir);
    await index.load();
    const fence = createRouteFence(makeCtx());

    const disposeSettings = registerSettingsRoutes(ctx, { dataDir, fence, logger: { warn: () => {} } });
    const disposeUsage = registerUsageRoutes(ctx, {
        usage: new UsageClient({ baseUrl: 'http://127.0.0.1:1' }),
        journal: new RunJournal({}),
        index,
        dataDir,
        fence,
    });

    try {
        const settings = routes.get('/plugins/dsh-cursor-dev/api/settings');
        assert.equal(typeof settings?.handler, 'function', 'the settings route is mounted');

        /** Drive one route handler with a JSON body and capture the answer. */
        const call = async (route, headers, body) => {
            const req = {
                url: '/plugins/dsh-cursor-dev/api/settings',
                method: 'POST',
                headers,
                on(event, listener) {
                    if (event === 'data')
                        listener(Buffer.from(JSON.stringify(body)));
                    if (event === 'end')
                        setImmediate(listener);
                    return this;
                },
            };
            const captured = makeRes();
            const res = {
                headersSent: false,
                writeHead(status, responseHeaders) {
                    captured.written.status = status;
                    captured.written.headers = responseHeaders;
                    this.headersSent = true;
                },
                end(payload) { captured.written.body = payload; captured.written.ended = true; },
            };
            await route.handler(req, res);
            return captured.written;
        };

        const refused = await call(settings, {
            host: '127.0.0.1:19387',
            origin: 'https://evil.example',
            'sec-fetch-site': 'cross-site',
        }, { language: 'en' });
        assert.equal(refused.status, 403, 'a cross-site write is refused');
        assert.match(String(refused.body), /did not come from the DSH page/);

        const accepted = await call(settings, {
            host: '127.0.0.1:19387',
            origin: 'http://127.0.0.1:19387',
        }, { language: 'zh' });
        assert.equal(accepted.status, 200, 'the panel still saves its own settings');

        // The other registrar must be fenced too — it is the one that spawns.
        const usageRoute = routes.get('/plugins/dsh-cursor-dev/');
        assert.equal(typeof usageRoute?.handler, 'function');
        const dashboard = await call(usageRoute, {
            host: '127.0.0.1:19387',
            origin: 'https://evil.example',
        }, undefined);
        assert.equal(dashboard.status, 403, 'a foreign page cannot read the dashboard either');
    }
    finally {
        disposeSettings?.();
        disposeUsage?.();
        await rm(dataDir, { recursive: true, force: true });
    }
});
