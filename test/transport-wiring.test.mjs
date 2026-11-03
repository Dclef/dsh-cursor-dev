/** Mount the real plugin: saving a transport must reach its actual session pool. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { apply, Config } from '../lib/index.js';
import { SessionPool } from '../lib/session-pool.js';
import { CliSession } from '../lib/cli-runner.js';
import { readSettings, writeSettings } from '../lib/settings.js';

test('mounted settings route switches the running pool to CLI before the next run', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-transport-wiring-'));
    const previous = Object.fromEntries(['DSH_CURSOR_DEV_DATA', 'CURSOR_CONFIG_DIR'].map(key => [key, process.env[key]]));
    const disposers = [];
    t.after(async () => {
        for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(dir, { recursive: true, force: true });
    });
    process.env.DSH_CURSOR_DEV_DATA = dir;
    process.env.CURSOR_CONFIG_DIR = dir;
    writeSettings(dir, { transport: 'acp', attribution: 'keep', proxy: 'none' });
    const entry = join(dir, 'agent-stub.mjs');
    await writeFile(entry, '// Resolved only; all spawning is simulated.\n');

    const pools = [];
    t.mock.method(SessionPool.prototype, 'start', function () { pools.push(this); });
    const original = SessionPool.prototype.setTransport;
    const transitions = [];
    t.mock.method(SessionPool.prototype, 'setTransport', function (transport) {
        transitions.push(transport);
        return original.call(this, transport);
    });
    const spawnCalls = [];
    const routes = new Map();
    const server = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } };
    const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        tools: { register: () => () => {} },
        subprocess: { spawn(spec) {
            spawnCalls.push(spec);
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const done = new Promise(resolve => setImmediate(() => {
                if (spec.argv.includes('--list-models')) stdout.end('auto - Auto\ncomposer-2.5 - Composer 2.5\n');
                else stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture complete' })}\n`);
                resolve({ exitCode: 0, signal: null });
            }));
            return { stdout, stderr, stdin: { end() {} }, done, terminate() {} };
        } },
        get: name => name === 'baseDir' ? dir : undefined,
        inject(names, callback) {
            if (!names.includes('webServer')) return;
            return callback({
                get: name => name === 'webServer' ? server : undefined,
                effect(factory) { disposers.push(factory()); },
            });
        },
        effect(factory) { disposers.push(factory()); },
    };
    apply(ctx, new Config({ command: `"${process.execPath}" "${entry}"` }));
    assert.equal(pools.length, 1);
    const route = routes.get('/plugins/dsh-cursor-dev/api/settings');
    assert.ok(route);
    const req = Readable.from([Buffer.from(JSON.stringify({ transport: 'cli' }))]);
    req.method = 'POST';
    req.url = route.path;
    let status, body;
    await route.handler(req, {
        writeHead(code) { status = code; },
        end(value) { body = JSON.parse(value); },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.settings.transport, 'cli');
    assert.equal(readSettings(dir).transport, 'cli');
    assert.deepEqual(transitions, ['cli'], 'saving must update the mounted pool, not only settings.json');
    await pools[0].run({ key: 'transport-test#0', cwd: dir, model: 'auto' }, async ({ session }) => {
        assert.ok(session instanceof CliSession, 'the next run must use CLI without restarting DSH');
        assert.equal((await session.prompt('fixture')).text, 'fixture complete');
    });
    assert.ok(spawnCalls.some(spec => spec.argv.includes('-p')));
    assert.ok(spawnCalls.every(spec => !spec.argv.includes('acp')), 'no real or simulated ACP process is needed');
});
