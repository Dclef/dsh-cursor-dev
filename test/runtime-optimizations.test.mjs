/**
 * Guards for two runtime optimizations the panel depends on.
 *
 * 1. The usage RPC resolves its proxy through a getter on every request, so a
 *    proxy saved from the panel takes effect on the next poll instead of after a
 *    restart. The transport a snapshot reports has to follow that getter.
 *
 * 2. A model refresh that is already running is shared with whoever asks for it
 *    next. The panel asks from more than one place at once (the opening GET and
 *    the `refreshModels` POST that follows it), and a second `--list-models`
 *    process per click is the cost this pins down.
 *
 * Everything here is offline: the usage RPC uses an injected `fetch` and an
 * explicit `CURSOR_AUTH_TOKEN`, and the model listing uses a scripted `spawn`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modelsFor, writeSettings } from '../lib/settings.js';
import { UsageClient } from '../lib/usage.js';
import { describeProxy, resolveChildProxy } from '../lib/proxy.js';

/** A throwaway data directory, removed when `body` returns. */
async function withDataDir(body) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cursor-dev-runtime-'));
    try {
        return await body(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * A fake `subprocess` service in the shape the plugin's other tests use: one
 * scripted CLI run per call, its output emitted on the next microtask.
 */
function fakeSpawn(script) {
    const calls = [];
    const spawn = (options) => {
        calls.push(options);
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        let release;
        const done = new Promise((resolve) => {
            release = resolve;
        });
        const handle = {
            stdout,
            stderr,
            stdin: { end() {} },
            done,
            terminate() {
                handle.terminated = true;
            },
        };
        const answer = typeof script === 'function' ? script(options, calls.length - 1) : script;
        queueMicrotask(() => {
            if (answer?.hang === true)
                return;
            if (answer?.stdout !== undefined)
                stdout.emit('data', Buffer.from(answer.stdout));
            if (answer?.stderr !== undefined)
                stderr.emit('data', Buffer.from(answer.stderr));
            release();
        });
        return handle;
    };
    spawn.calls = calls;
    return spawn;
}

/** Dependencies for one scripted CLI listing. */
function listingDeps(dir, spawn) {
    return {
        spawn,
        resolved: { command: 'node.exe', entry: 'index.js', source: 'bundled' },
        env: { CURSOR_CONFIG_DIR: dir },
        cwd: dir,
        dataDir: dir,
        configModel: '',
    };
}

/** One model line the CLI listing parser accepts. */
const LISTING = 'composer-test - Composer Test\n';

test('the usage RPC follows a proxy that changes between requests', async () => {
    let proxy = { scheme: 'http', host: '127.0.0.1', port: 7890, source: 'setting' };
    const requests = [];
    const client = new UsageClient({
        baseUrl: 'http://127.0.0.1:9',
        // An injected fetch keeps this test offline; the transport the client
        // reports is what is under test, not the socket.
        fetch: async (url, init) => {
            requests.push({ url, init });
            return { ok: true, text: async () => JSON.stringify({}) };
        },
        resolveProxy: async () => proxy,
    });
    // An explicit token keeps the real Cursor login store out of the test.
    const env = { CURSOR_AUTH_TOKEN: 'test-token' };

    const first = await client.get({ force: true, env });
    assert.equal(first.ok, true);
    assert.match(first.transport, /127\.0\.0\.1:7890/);

    proxy = { scheme: 'http', host: '10.0.0.5', port: 1080, source: 'setting' };
    const second = await client.get({ force: true, env });
    assert.equal(second.ok, true);
    assert.match(second.transport, /10\.0\.0\.5:1080/, 'a saved proxy reaches the next RPC');
    assert.notEqual(second.transport, first.transport);

    proxy = undefined;
    const third = await client.get({ force: true, env });
    assert.equal(third.ok, true);
    assert.equal(third.transport, 'direct (no proxy configured)', 'direct is a route too, not a stale proxy');
    assert.equal(client.transport, 'direct (no proxy configured)', 'the status surface agrees');
    assert.equal(requests.length, 3, 'each forced read is one RPC');
    assert.equal(requests[0].init.headers.authorization, 'Bearer test-token');
});

test('the panel proxy getter produces a shape the usage client can describe', async () => {
    // The exact wiring lib/index.js installs. A hand-written proxy object in the
    // test above would not catch resolveChildProxy() returning a different shape.
    let configured = 'http://127.0.0.1:7890';
    const resolve = () => resolveChildProxy(configured, { env: {} });
    const client = new UsageClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: async () => ({ ok: true, text: async () => JSON.stringify({}) }),
        resolveProxy: resolve,
    });
    const env = { CURSOR_AUTH_TOKEN: 'test-token' };

    const proxied = await client.get({ force: true, env });
    assert.equal(proxied.ok, true);
    assert.match(proxied.transport, /127\.0\.0\.1:7890/);
    // The client's description and the shared formatter agree on the same value.
    assert.equal(proxied.transport, describeProxy(await resolve()));

    configured = 'none';
    const direct = await client.get({ force: true, env });
    assert.equal(direct.ok, true);
    assert.equal(direct.transport, 'direct (no proxy configured)');
    assert.equal(describeProxy(await resolve()), 'direct (no proxy configured)');
});

test('concurrent model reads share one in-flight refresh', async () => {
    await withDataDir(async (dir) => {
        writeSettings(dir, { transport: 'cli' });
        const spawn = fakeSpawn({ stdout: LISTING });
        const deps = listingDeps(dir, spawn);

        // A cached read and a forced one, issued together: the force read must
        // join the refresh the first call already started.
        const [cached, forced] = await Promise.all([
            modelsFor(dir, deps),
            modelsFor(dir, { ...deps, force: true }),
        ]);

        assert.equal(spawn.calls.length, 1, 'one click costs one CLI listing');
        assert.equal(cached.ok, true);
        assert.equal(forced.ok, true);
        assert.equal(cached.cached, false);
        assert.equal(forced.cached, false, 'a joined refresh is still a real fetch');
        assert.deepEqual(cached.list.map(entry => entry.id), ['composer-test']);
        assert.deepEqual(forced.list.map(entry => entry.id), ['composer-test']);
        // Each caller gets its own object, so a `cached: false` marker written
        // for one answer cannot rewrite the answer another caller holds.
        assert.notEqual(cached, forced);
        assert.equal(spawn.calls[0].argv.join(' '), 'node.exe index.js --list-models');

        const warm = await modelsFor(dir, deps);
        assert.equal(warm.cached, true, 'the refresh stored its list for the next read');
        assert.equal(spawn.calls.length, 1);
    });
});

test('a CLI refresh and an ACP refresh never share one promise', async () => {
    await withDataDir(async (dir) => {
        writeSettings(dir, { transport: 'cli' });
        const spawn = fakeSpawn({ stdout: LISTING });
        const deps = listingDeps(dir, spawn);

        // The CLI read is in flight (it already spawned) when the operator
        // switches transport; the ACP read must not be answered with the CLI's
        // name space, so it starts its own listing.
        const cli = modelsFor(dir, deps);
        writeSettings(dir, { transport: 'acp' });
        const acp = await modelsFor(dir, deps);

        const cliResult = await cli;
        assert.equal(spawn.calls.length, 2, 'one refresh per transport');
        assert.equal(cliResult.ok, true);
        assert.equal(cliResult.source, 'cli');
        assert.equal(acp.ok, true);
        assert.equal(acp.source, 'acp', 'the roster name space answers the ACP read');
    });
});
