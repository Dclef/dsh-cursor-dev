/**
 * Offline smoke test for dsh-cursor-dev.
 *
 * Runs the real plugin modules — UsageClient, SessionPool, RunJournal,
 * ConversationIndex, the tool's arg normalization and diff plumbing — against
 * the real Cursor CLI on this machine, with NO DSH host. It is the cheapest way
 * to prove the plugin works before installing it into a profile and restarting.
 *
 * Usage (from the plugin directory, so @deepseek-ai/* resolves):
 *   node --test test/smoke.test.mjs
 *
 * Network calls are made only to Cursor's own usage RPC (read-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAgent, acpArgv } from '../lib/resolve-agent.js';
import { SessionPool, storeKeyOf } from '../lib/session-pool.js';
import { normalizeAcpDiff } from '../lib/cursor-session.js';
import { RunJournal } from '../lib/journal.js';
import { ConversationIndex } from '../lib/conversations.js';
import { cursorCodeTool, resolveDataDir } from '../lib/tool.js';
import { UsageClient, normalizeUsage, authFilePath, readAccessToken, registerUsageRoutes } from '../lib/usage.js';
import { fingerprint, compareFingerprints, mergeChanges, diffStats } from '../lib/changes.js';
import { buildPrompt, summarizeTask } from '../lib/prompt.js';

const here = fileURLToPath(new URL('..', import.meta.url));
/** The resolved Cursor CLI on this machine, or undefined when not installed. */
const agent = resolveAgent(process.env);

/**
 * A stand-in for the host's `ctx.subprocess.spawn`.
 *
 * The plugin only ever touches this narrow surface (argv/cwd/stdio/signal,
 * `handle.done`, `handle.terminate`), so implementing it over node:child_process
 * lets the whole plugin run outside DSH.
 */
function testSpawn(spec) {
    const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let settled = false;
    const done = new Promise(resolve => {
        const finish = (exitCode, signal) => {
            if (settled) return;
            settled = true;
            resolve({ exitCode, signal });
        };
        child.on('exit', (code, signal) => finish(code ?? null, signal ?? null));
        child.on('error', () => finish(null, null));
    });
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        control: undefined,
        collected: {},
        done,
        terminate() {
            try {
                child.kill();
            }
            catch {
                // Already gone.
            }
        },
        async waitForExit() {
            await done;
            return true;
        },
    };
}

/**
 * Remove a temp directory, tolerating the Windows EBUSY that a just-killed
 * child process can cause. Cleanup must never turn a passing test into a
 * failing one.
 */
async function safeRemove(path) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            await rm(path, { recursive: true, force: true });
            return;
        }
        catch {
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
}

test('the Cursor CLI is discoverable and its argv is well formed', () => {
    assert.ok(agent !== undefined, 'no Cursor CLI found');
    assert.ok(agent.command.toLowerCase().endsWith('.exe') || agent.command.toLowerCase().endsWith('node.exe'),
        `unexpected command: ${agent.command}`);
    const auto = acpArgv(agent, 'auto');
    assert.ok(auto.includes('acp'), 'argv must contain the acp subcommand');
    assert.ok(!auto.includes('--model'), 'the "auto" model must not be passed through');
    const pinned = acpArgv(agent, 'composer-2.5[fast=true]');
    assert.equal(pinned[pinned.length - 1], 'acp', 'acp must stay last');
    assert.equal(pinned[pinned.indexOf('--model') + 1], 'composer-2.5[fast=true]');
});

test('data dir honours the environment override', () => {
    const previous = process.env.DSH_CURSOR_DEV_DATA;
    process.env.DSH_CURSOR_DEV_DATA = join(tmpdir(), 'dsh-cursor-dev-explicit');
    try {
        assert.equal(resolveDataDir(here), join(tmpdir(), 'dsh-cursor-dev-explicit'));
    }
    finally {
        if (previous === undefined) delete process.env.DSH_CURSOR_DEV_DATA;
        else process.env.DSH_CURSOR_DEV_DATA = previous;
    }
});

test('prompt scaffolding keeps the parent task verbatim', () => {
    const task = 'Add a --dry-run flag to scripts/deploy.py';
    const text = buildPrompt(task, {
        cwd: 'C:\\work',
        contextFiles: ['scripts/deploy.py'],
        acceptance: 'no behaviour change without the flag',
    });
    assert.ok(text.includes(task), 'the task must appear verbatim');
    assert.ok(text.includes('C:\\work'), 'the workspace must be stated');
    assert.ok(text.toLowerCase().includes('cannot ask questions'), 'the no-questions rule must be present');
    assert.equal(summarizeTask(task).length <= 60, true);
});

test('store keys drop the generation suffix', () => {
    assert.equal(storeKeyOf('agent-1::default#3'), 'agent-1::default#0');
    assert.equal(storeKeyOf('agent-1::default'), 'agent-1::default');
});

test('fingerprint catches adds, edits and deletes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fp-'));
    try {
        await writeFile(join(dir, 'keep.txt'), 'one\n');
        await writeFile(join(dir, 'edit.txt'), 'before\n');
        await writeFile(join(dir, 'gone.txt'), 'bye\n');
        const before = await fingerprint(dir);
        await writeFile(join(dir, 'edit.txt'), 'after\n');
        await writeFile(join(dir, 'new.txt'), 'hello\n');
        await rm(join(dir, 'gone.txt'));
        const after = await fingerprint(dir);
        const comparison = compareFingerprints(before, after);
        assert.deepEqual(comparison.added, ['new.txt']);
        assert.deepEqual(comparison.modified, ['edit.txt']);
        assert.deepEqual(comparison.removed, ['gone.txt']);
        assert.equal(comparison.added.includes('keep.txt'), false);
    }
    finally {
        await safeRemove(dir);
    }
});

test('the filesystem catches changes the ACP diff stream never reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-merge-'));
    try {
        await writeFile(join(dir, 'a.js'), 'new content\n');
        await writeFile(join(dir, 'shell-made.txt'), 'written by a shell command\n');
        const before = { files: new Map(), truncated: false };
        const after = await fingerprint(dir);
        const merged = mergeChanges([{ path: 'a.js', oldText: 'old content\n', newText: 'new content\n' }],
            compareFingerprints(before, after), dir);
        assert.deepEqual(merged.map(change => change.path), ['a.js', 'shell-made.txt']);

        // The ACP diff wins on collision: it carries the real text.
        const fromAcp = merged[0];
        assert.equal(fromAcp.source, 'acp');
        assert.equal(fromAcp.operation, 'modified');
        assert.equal(fromAcp.added, 1);
        assert.equal(fromAcp.removed, 1);

        // Only the fingerprint saw this one, so it must still be reported.
        const fromFs = merged[1];
        assert.equal(fromFs.source, 'fs');
        assert.equal(fromFs.operation, 'created');
    }
    finally {
        await safeRemove(dir);
    }
});

test('a created file is reported as created, not as a git-style pseudo-diff', () => {
    // Verbatim payload Cursor sends for a brand-new file (captured from a live run).
    const created = normalizeAcpDiff({
        path: 'C:\\work\\brand-new.txt',
        oldText: '-- /dev/null',
        newText: '++ b/C:\\work\\brand-new.txt\nDIFFPROBE',
    });
    assert.equal(created.oldText, null, 'a non-existent old side must become null');
    assert.equal(created.newText, 'DIFFPROBE', 'the git header must be stripped');
    const stats = diffStats(created.oldText, created.newText);
    assert.equal(stats.isNew, true);
    assert.equal(stats.added, 1);
    assert.equal(stats.removed, 0);

    // Verbatim payload for an edit of an existing file: real content both sides.
    const edited = normalizeAcpDiff({
        path: 'C:\\work\\existing.js',
        oldText: 'DIFFPROBE\n',
        newText: 'DIFFPROBE-EDITED\n',
    });
    assert.equal(edited.oldText, 'DIFFPROBE\n');
    assert.equal(edited.newText, 'DIFFPROBE-EDITED\n');
    assert.equal(diffStats(edited.oldText, edited.newText).isNew, false);

    // A file whose own first line merely looks like a header must survive.
    const tricky = normalizeAcpDiff({ path: 'x.md', oldText: '', newText: '--- a heading\nbody' });
    assert.equal(tricky.newText, '--- a heading\nbody');

    // A missing old side is the same signal as the sentinel.
    assert.equal(normalizeAcpDiff({ path: 'y.txt', newText: 'hi' }).oldText, null);
});

test('every lib module imports and the entry point is a valid plugin', async () => {
    // A broken relative import inside lib/ only shows up when DSH tries to load
    // the plugin. The rest of this suite imports the modules directly, so it
    // would never notice lib/index.js being unimportable.
    const files = (await readdir(join(here, 'lib'))).filter(name => name.endsWith('.js')).sort();
    assert.ok(files.length >= 10, `expected the lib modules, found ${files.length}`);
    for (const file of files)
        assert.equal(typeof await import(new URL(`../lib/${file}`, import.meta.url).href), 'object', `${file} failed to import`);

    const plugin = await import('../lib/index.js');
    assert.equal(plugin.name, 'dsh-cursor-dev');
    assert.deepEqual(plugin.inject, ['tools', 'subprocess']);
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(typeof plugin.Config, 'function', 'Config must be a schemastery schema');

    // The defaults DSH mounts with when the profile passes no config.
    const config = new plugin.Config({});
    assert.equal(config.toolName, 'cursor_code');
    assert.equal(config.model, '');
    assert.equal(config.maxLiveSessions, 3);
    assert.equal(config.sessionIdleMinutes, 15);
    assert.equal(config.maxScanFiles, 20000);
    assert.equal(config.usageUi, true);
    assert.equal(config.usageBaseUrl, 'https://api2.cursor.sh');
});

test('the package manifest is installable as a DSH bundle', async () => {
    const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-cursor-dev');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.main, 'lib/index.js');
    // dsh.bundle.patch is the installation contract: without it DSH installs the
    // package and mounts nothing.
    const patch = manifest.dsh?.bundle?.patch;
    assert.equal(typeof patch, 'string', 'dsh.bundle.patch is required for installation');
    const patchText = await readFile(join(here, patch.replace(/^\.\//, '')), 'utf8');
    assert.match(patchText, /id: dsh-cursor-dev/);
    assert.match(patchText, /name: dsh-cursor-dev/);
    // No browser half, so there must be no dsh.client claim.
    assert.equal(manifest.dsh?.client, undefined);
    // Officially-provided packages must be peers, never bundled dependencies.
    assert.equal(typeof manifest.peerDependencies?.['@deepseek-ai/schemastery'], 'string');
    assert.equal(manifest.dependencies?.['@deepseek-ai/schemastery'], undefined);
    // The one real runtime dependency.
    assert.equal(typeof manifest.dependencies?.['@agentclientprotocol/sdk'], 'string');
});

test('apply() mounts the tool and the HTTP routes against the host contract', async () => {
    const plugin = await import('../lib/index.js');
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-mount-data-'));
    const routes = [];
    const disposers = [];
    let registered;

    /** Minimal stand-in for the host services `apply` touches. */
    const ctx = {
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        tools: { register: (definition) => { registered = definition; return () => { registered = undefined; }; } },
        subprocess: { spawn: testSpawn },
        get: (name) => {
            if (name === 'webServer') {
                return { register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; } };
            }
            if (name === 'baseDir') return dataDir;
            return undefined;
        },
        effect: (factory) => { const dispose = factory(); disposers.push(dispose); return () => {}; },
    };

    // Cordis throws `cannot get property "baseDir" without inject` when a service
    // is read as a plain property. Emulate that here: a real mount once failed on
    // exactly this line while this fake happily exposed `baseDir`.
    Object.defineProperty(ctx, 'baseDir', {
        enumerable: true,
        get: () => {
            if (!plugin.inject?.includes('baseDir')) {
                throw new Error('cannot get property "baseDir" without inject');
            }
            return dataDir;
        },
    });

    try {
        plugin.apply(ctx, new plugin.Config({}));

        // The tool the parent model calls.
        assert.equal(registered.name, 'cursor_code');
        assert.deepEqual(registered.parameters.required, ['task']);
        assert.equal(registered.output.schema.type, 'object');
        assert.equal(typeof registered.execute, 'function');
        assert.equal(registered.isConcurrencySafe({ task: 'x' }), false);

        // The reporting surfaces, by exact path.
        assert.deepEqual(routes.map(route => route.path).sort(), [
            '/plugins/dsh-cursor-dev/',
            '/plugins/dsh-cursor-dev/api/journal',
            '/plugins/dsh-cursor-dev/api/usage',
            '/plugins/dsh-cursor-dev/status',
        ]);
        for (const route of routes) {
            assert.equal(route.kind, 'exact');
            assert.equal(typeof route.handler, 'function');
        }
    }
    finally {
        for (const dispose of disposers)
            if (typeof dispose === 'function')
                dispose();
        await safeRemove(dataDir);
    }
});

test('journal keeps a bounded, queryable timeline', () => {
    const journal = new RunJournal({ ttlMs: 60_000 });
    journal.annotate('k#0', { task: 'do a thing' });
    journal.append('k#0', { kind: 'tool-call', call: { id: 'c1', name: 'Edit File', kind: 'edit', status: 'pending' } });
    journal.append('k#0', { kind: 'tool-update', call: { id: 'c1', status: 'completed', path: 'src/a.js' }, diffCount: 1 });
    const steps = journal.timeline('k#0');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, 'completed');
    assert.equal(steps[0].path, 'src/a.js');
    assert.equal(journal.read('k#0').task, 'do a thing');
    assert.equal(journal.stats().keys, 1);
});

test('conversation index persists and reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-idx-'));
    try {
        const index = new ConversationIndex(dir);
        await index.load();
        await index.set('agent-1::default', { cursorSessionId: 'abc', workspaceRoot: 'C:\\w', turns: 1 });
        const reopened = new ConversationIndex(dir);
        await reopened.load();
        assert.equal((await reopened.get('agent-1::default')).cursorSessionId, 'abc');
        await reopened.delete('agent-1::default');
        assert.equal(await reopened.get('agent-1::default'), undefined);
    }
    finally {
        await safeRemove(dir);
    }
});

test('usage normalization converts cents and keeps every bucket', () => {
    const usage = normalizeUsage({
        billingCycleStart: '1000',
        billingCycleEnd: '2000',
        planUsage: {
            totalSpend: 31760, includedSpend: 2000, bonusSpend: 29760, limit: 2000,
            autoPercentUsed: 69.44, apiPercentUsed: 45.42, totalPercentUsed: 68.85,
        },
        spendLimitUsage: { limitType: 'user' },
        displayMessage: 'You have hit your usage limit',
        autoBucketModels: ['default', 'composer-2.5'],
    });
    assert.equal(usage.dollars.total, 317.6);
    assert.equal(usage.dollars.included, 20);
    assert.equal(usage.total.percentUsed, 68.85);
    assert.equal(usage.auto.percentUsed, 69.44);
    assert.equal(usage.spendLimit.limitType, 'user');
    assert.equal(usage.displayMessage, 'You have hit your usage limit');
    assert.equal(usage.autoBucketModels.length, 2);
    // Protobuf int64 fields arrive as strings, not numbers — the billing period
    // silently became `undefined` before this was handled.
    assert.equal(usage.billingCycle.start, 1000);
    assert.equal(usage.billingCycle.end, 2000);
    assert.equal(usage.billingCycle.end > usage.billingCycle.start, true);
});

test('the real Cursor account returns live quota data', async () => {
    const auth = await readAccessToken(process.env);
    assert.equal(auth.ok, true, `no Cursor token at ${authFilePath(process.env)}: ${auth.error}`);
    assert.equal(typeof auth.token, 'string');
    assert.equal(auth.token.length > 100, true);

    const client = new UsageClient({});
    const snapshot = await client.get({ force: true });
    assert.equal(snapshot.ok, true, `usage RPC failed: ${snapshot.error}`);
    assert.equal(typeof snapshot.usage.total.percentUsed, 'number');
    assert.equal(snapshot.usage.billingCycle.end > snapshot.usage.billingCycle.start, true);
    // Caching must not issue a second RPC.
    const cached = await client.get({});
    assert.equal(cached.fetchedAt, snapshot.fetchedAt);
    console.log(`[usage] total ${snapshot.usage.total.percentUsed}% | auto ${snapshot.usage.auto.percentUsed}%`
        + ` | spend $${snapshot.usage.dollars.total} | ${snapshot.usage.displayMessage ?? ''}`);
});

test('a broken endpoint degrades instead of throwing', async () => {
    const client = new UsageClient({ baseUrl: 'http://127.0.0.1:9', fetch: globalThis.fetch });
    const snapshot = await client.get({ force: true });
    assert.equal(snapshot.ok, false);
    assert.equal(typeof snapshot.error, 'string');
});

test('usage routes register against the host contract and answer HTTP', async () => {
    const routes = new Map();
    const ctx = {
        get: name => (name === 'webServer' ? { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } : undefined),
        logger: { warn: message => console.log(`[warn] ${message}`) },
    };
    const pool = new SessionPool({
        resolved: agent,
        env: process.env,
        spawn: spec => { throw new Error(`unexpected spawn: ${spec.argv?.join(' ')}`); },
        maxLiveSessions: 1,
        sessionIdleMinutes: 15,
    });
    const journal = new RunJournal({});
    const dir = await mkdtemp(join(tmpdir(), 'dsh-routes-'));
    try {
        const index = new ConversationIndex(dir);
        await index.load();
        await index.set('a::default', { cursorSessionId: 'sid-1', workspaceRoot: 'C:\\w', model: 'composer-2.5', turns: 2 });
        const dispose = registerUsageRoutes(ctx, {
            usage: new UsageClient({}),
            pool,
            journal,
            index,
            dataDir: dir,
        });
        assert.equal(routes.size, 3, `expected 3 routes, got ${[...routes.keys()].join(', ')}`);

        const call = async (path, url) => {
            const route = routes.get(path);
            const chunks = [];
            const res = {
                status: undefined,
                headers: undefined,
                writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
                end(body) { chunks.push(body); },
            };
            await route.handler({ url: url ?? path }, res);
            return { status: res.status, contentType: res.headers?.['content-type'], body: chunks.join('') };
        };

        const dashboard = await call('/plugins/dsh-cursor-dev/');
        assert.equal(dashboard.status, 200);
        assert.match(dashboard.contentType, /text\/html/);
        assert.match(dashboard.body, /<title>Cursor usage/);
        assert.match(dashboard.body, /application\/json/);
        // The embedded bootstrap must be JSON-parseable and must escape `<`.
        const embedded = dashboard.body.match(/id="bootstrap">([\s\S]*?)<\/script>/)[1];
        const parsed = JSON.parse(embedded);
        assert.equal(parsed.conversations.length, 1);
        assert.equal(dashboard.body.includes('</script>', dashboard.body.indexOf('id="bootstrap">') + 20), true);

        const json = await call('/plugins/dsh-cursor-dev/api/usage');
        assert.equal(json.status, 200);
        const payload = JSON.parse(json.body);
        assert.equal(payload.ok, true, payload.error);
        assert.equal(payload.raw, undefined, 'raw upstream payload must not be exposed');
        assert.equal(payload.extended.conversations.length, 1);
        assert.equal(payload.extended.journal.keys, 0);

        const missing = await call('/plugins/dsh-cursor-dev/api/journal', '/plugins/dsh-cursor-dev/api/journal?key=nope');
        assert.equal(missing.status, 404);

        journal.annotate('a::default#0', { task: 'tidy up' });
        journal.append('a::default#0', { kind: 'tool-call', call: { id: 'c9', name: 'Shell', kind: 'execute', status: 'pending' } });
        const found = await call('/plugins/dsh-cursor-dev/api/journal', '/plugins/dsh-cursor-dev/api/journal?key=' + encodeURIComponent('a::default#0'));
        assert.equal(found.status, 200);
        assert.equal(JSON.parse(found.body).task, 'tidy up');

        dispose();
        assert.equal(routes.size, 0, 'dispose must remove every route');
    }
    finally {
        await safeRemove(dir);
    }
});

test('the routes answer real HTTP and a throwing view becomes a 500', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-http-'));
    const journal = new RunJournal({});
    const index = new ConversationIndex(dir);
    await index.load();
    await index.set('b::default', { cursorSessionId: 'sid-2', workspaceRoot: 'C:\\w', model: 'kimi-k3', turns: 1 });
    journal.append('b#0', { kind: 'tool-call', call: { id: 'c1', name: 'Edit File', kind: 'edit', path: 'src/app.js', status: 'pending' } });
    journal.append('b#0', { kind: 'tool-update', call: { id: 'c1', name: 'Edit File', kind: 'edit', path: 'src/app.js', status: 'completed' }, diffCount: 2 });
    // Malformed events used to throw inside the HTTP handler, where a throw is a
    // process-level unhandled exception rather than a 500. They must be skipped.
    journal.append('b#0', { kind: 'tool-call' });
    journal.append('b#0', { kind: 'tool-update' });
    journal.annotate('b#0', { task: 'add a health endpoint' });

    const routes = new Map();
    const ctx = {
        get: name => (name === 'webServer' ? { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } : undefined),
        logger: { warn: message => console.log(`[warn] ${message}`) },
    };
    const server = createServer((req, res) => {
        const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
        if (route === undefined) {
            res.writeHead(404);
            res.end('no route');
            return;
        }
        // Deliberately unguarded, exactly like a host that does not wrap its
        // route handlers: an escaping exception would be an unhandled error
        // here, so this is what proves the plugin's own guard works.
        void route.handler(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let dispose;
    try {
        dispose = registerUsageRoutes(ctx, {
            usage: new UsageClient({}),
            pool: { snapshot: () => [], queued: 0 },
            journal,
            index,
            dataDir: dir,
        });

        const page = await fetch(`${base}/plugins/dsh-cursor-dev/`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        const html = await page.text();
        assert.match(html, /id="bootstrap"/);
        assert.match(html, /id="live"/);
        assert.ok(!html.includes('${'), 'the dashboard template must be fully interpolated');

        const usage = await fetch(`${base}/plugins/dsh-cursor-dev/api/usage`);
        assert.equal(usage.status, 200);
        assert.match(usage.headers.get('content-type'), /application\/json/);
        const payload = await usage.json();
        assert.equal(payload.extended.journal.keys, 1);
        assert.equal(payload.extended.conversations.length, 1);

        const found = await fetch(`${base}/plugins/dsh-cursor-dev/api/journal?key=${encodeURIComponent('b#0')}`);
        assert.equal(found.status, 200);
        const timeline = await found.json();
        assert.equal(timeline.task, 'add a health endpoint');
        assert.equal(timeline.steps.length, 1, JSON.stringify(timeline.steps));
        assert.equal(timeline.steps[0].id, 'c1');
        assert.equal(timeline.steps[0].status, 'completed');
        assert.equal(timeline.steps[0].path, 'src/app.js');
        assert.equal(timeline.steps[0].diffCount, 2);

        const missing = await fetch(`${base}/plugins/dsh-cursor-dev/api/journal?key=nope`);
        assert.equal(missing.status, 404);
        dispose();
        assert.equal(routes.size, 0);

        // A view bug must degrade to a logged 500, never to a dead host.
        dispose = registerUsageRoutes(ctx, {
            usage: new UsageClient({}),
            pool: { snapshot: () => { throw new Error('snapshot exploded'); }, queued: 0 },
            journal,
            index,
            dataDir: dir,
        });
        const failed = await fetch(`${base}/plugins/dsh-cursor-dev/api/usage`);
        assert.equal(failed.status, 500);
        assert.match((await failed.json()).error, /snapshot exploded/);
    }
    finally {
        dispose?.();
        await new Promise(resolve => server.close(resolve));
        await safeRemove(dir);
    }
});

test('the child agent really edits a file and the result carries a real diff', { timeout: 900_000 }, async () => {
    assert.ok(agent !== undefined, 'no Cursor CLI found');
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-cursor-ws-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-cursor-data-'));
    try {
        await writeFile(join(workspace, 'greeting.txt'), 'hello world\n');

        const journal = new RunJournal({});
        const index = new ConversationIndex(dataDir);
        await index.load();
        const pool = new SessionPool({
            resolved: agent,
            env: process.env,
            spawn: testSpawn,
            maxLiveSessions: 2,
            sessionIdleMinutes: 15,
        }, (key, event) => journal.append(key, event));
        pool.start();

        const tool = cursorCodeTool({ pool, journal, index, maxScanFiles: 5000 });
        // Mirrors a real tool run context: the workspace comes from the session header.
        const exec = {
            agent: { id: 'smoke-parent', session: { header: { cwd: workspace } } },
            signal: new AbortController().signal,
        };

        const first = await tool.execute({
            task: 'Create a file named `result.txt` in the current directory containing exactly two lines:\n'
                + 'line one is the word PROBE-OK\n'
                + 'line two is the number 42\n'
                + 'Do not modify any other file.',
            contextFiles: ['greeting.txt'],
            acceptance: 'result.txt exists with exactly those two lines.',
            model: 'composer-2.5[fast=true]',
            report: 'detailed',
            timeoutSeconds: 600,
        }, exec);

        assert.equal(first.ok, true, `run failed: ${first.error}`);
        assert.equal(typeof first.cursorSessionId, 'string');
        assert.equal(first.model, 'composer-2.5[fast=true]');
        const written = await readFile(join(workspace, 'result.txt'), 'utf8');
        assert.match(written, /PROBE-OK/);
        assert.match(written, /42/);
        assert.ok(first.steps.length > 0, 'the step timeline must not be empty');
        assert.ok(first.changes.some(change => change.path === 'result.txt'), JSON.stringify(first.changes));
        assert.ok(Array.isArray(first.preview) && first.preview.length > 0, 'a diff preview must be produced');
        console.log(`[run1] ${first.durationMs}ms model=${first.model} steps=${first.steps.length} changes=${first.changes.length}`);

        // The UI card must be a diff card built from the real preview.
        const card = tool.presentResult({}, { isError: false, value: first });
        assert.equal(card.card, 'diff');
        assert.ok(card.diffs.length > 0);
        assert.equal(typeof card.diffs[0].path, 'string');
        assert.equal(typeof card.diffs[0].newText, 'string');
        assert.ok(card.diffs[0].newText.length > 0);

        // A follow-up must continue the SAME conversation and remember it.
        const second = await tool.execute({
            task: 'Append a third line to result.txt containing exactly: RECALLED',
            continueSession: true,
            timeoutSeconds: 600,
        }, exec);
        assert.equal(second.ok, true, `follow-up failed: ${second.error}`);
        assert.equal(second.reused, true, 'the follow-up must reuse the live session');
        assert.equal(second.reloaded, false);
        assert.equal(second.cursorSessionId, first.cursorSessionId, 'the conversation id must be stable');
        const after = await readFile(join(workspace, 'result.txt'), 'utf8');
        assert.match(after, /RECALLED/);
        assert.match(after, /PROBE-OK/, 'the earlier work must survive');
        console.log(`[run2] reused=${second.reused} steps=${second.steps.length} changes=${second.changes.length}`);

        // Durability: a NEW pool (as after a DSH restart) must reload the same
        // conversation from Cursor's own store and still know what it did.
        const journal2 = new RunJournal({});
        const pool2 = new SessionPool({
            resolved: agent,
            env: process.env,
            spawn: testSpawn,
            maxLiveSessions: 2,
            sessionIdleMinutes: 15,
        }, (key, event) => journal2.append(key, event));
        pool2.start();
        try {
            const persisted = pool2.persistedFor(storeKeyOf('smoke-parent::default'));
            assert.equal(persisted, undefined, 'a brand new pool knows nothing');
            const index2 = new ConversationIndex(dataDir);
            await index2.load();
            const tool2 = cursorCodeTool({ pool: pool2, journal: journal2, index: index2, maxScanFiles: 5000 });
            const third = await tool2.execute({
                task: 'Without changing any file, reply with the exact contents of result.txt on one line.',
                continueSession: true,
                timeoutSeconds: 600,
            }, exec);
            assert.equal(third.ok, true, `reload run failed: ${third.error}`);
            assert.equal(third.cursorSessionId, first.cursorSessionId, 'the id must survive a fresh pool');
            assert.match(third.text, /RECALLED/, `the child must recall its own work; got: ${third.text.slice(0, 400)}`);
            // `session/load` replays the whole transcript. Those replayed updates
            // must not leak into this turn: nothing was edited, so nothing may be
            // reported as changed.
            assert.deepEqual(third.changes, [], `replayed history leaked into the change list: ${JSON.stringify(third.changes)}`);
            assert.deepEqual(third.preview, []);
            console.log(`[run3] reloaded=${third.reloaded} session=${String(third.cursorSessionId).slice(0, 8)} text=${JSON.stringify(third.text.slice(0, 120))}`);
        }
        finally {
            await pool2.dispose();
        }

        await pool.dispose();
    }
    finally {
        await safeRemove(workspace);
        await safeRemove(dataDir);
    }
});

test('a bad model is rejected without breaking the pool', { timeout: 300_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-cursor-data2-'));
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-ws2-'));
    const journal = new RunJournal({});
    const index = new ConversationIndex(dataDir);
    await index.load();
    const pool = new SessionPool({
        resolved: agent,
        env: process.env,
        spawn: testSpawn,
        maxLiveSessions: 2,
        sessionIdleMinutes: 15,
    }, (key, event) => journal.append(key, event));
    pool.start();
    try {
        const tool = cursorCodeTool({ pool, journal, index, maxScanFiles: 100 });
        const failed = await tool.execute({ task: 'say nothing', model: 'no-such-model-zzz', workspaceRoot: dir, timeoutSeconds: 120 },
            { agent: { id: 'smoke-parent-2' }, signal: new AbortController().signal });
        assert.equal(failed.ok, false);
        assert.match(String(failed.error), /model/i);
        // The pool must still be usable afterwards.
        assert.equal(typeof pool.snapshot(), 'object');
    }
    finally {
        await pool.dispose();
        await rm(dataDir, { recursive: true, force: true });
        await safeRemove(dir);
    }
});

test('argument validation rejects an empty task', async () => {
    const tool = cursorCodeTool({
        pool: { persistedFor: () => undefined, pickKey: () => ({ key: 'x#0', generation: 0 }), run: async () => { throw new Error('must not run'); } },
        journal: new RunJournal({}),
        index: { get: async () => undefined },
        maxScanFiles: 10,
    });
    const result = await tool.execute({ task: '   ' }, { agent: { id: 'p' }, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.match(result.error, /task/i);
});

test('a missing Cursor CLI degrades the tool instead of failing the mount', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-nocli-'));
    const routes = new Map();
    const mounted = [];
    const warnings = [];
    const ctx = {
        logger: { info: () => {}, warn: message => warnings.push(String(message)), error: () => {} },
        tools: { register: definition => { mounted.push(definition); return () => {}; } },
        subprocess: { spawn: () => { throw new Error('must not spawn without a CLI'); } },
        get: name => {
            if (name === 'webServer')
                return { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } };
            return name === 'baseDir' ? dataDir : undefined;
        },
        effect: () => {},
    };
    const plugin = await import('../lib/index.js');
    // Hide the CLI the way a machine without it looks: no PATH, no LOCALAPPDATA.
    const savedPath = process.env.PATH;
    const savedLocal = process.env.LOCALAPPDATA;
    try {
        delete process.env.PATH;
        delete process.env.LOCALAPPDATA;
        plugin.apply(ctx, new plugin.Config({}));
    }
    finally {
        process.env.PATH = savedPath;
        process.env.LOCALAPPDATA = savedLocal;
    }

    assert.equal(warnings.length, 1, warnings.join(' | '));
    assert.match(warnings[0], /could not find the Cursor CLI/);
    // Everything that does not need the CLI still mounts.
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].name, 'cursor_code');
    assert.equal(routes.size, 4, [...routes.keys()].join(', '));

    const failed = await mounted[0].execute({ task: 'do something' },
        { agent: { id: 'p' }, signal: new AbortController().signal });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /could not find the Cursor CLI/);

    // The status route must answer rather than throw on a missing agent.
    const status = routes.get('/plugins/dsh-cursor-dev/status');
    const chunks = [];
    let code;
    status.handler({ url: '/plugins/dsh-cursor-dev/status' }, {
        writeHead: value => { code = value; },
        end: body => { chunks.push(body); },
    });
    assert.equal(code, 200);
    assert.equal(JSON.parse(chunks.join('')).agent, null);

    await safeRemove(dataDir);
});

/**
 * The host accepts only a JSON Schema subset (see `assertSupportedJsonSchema`
 * in `@deepseek-ai/dsh-tools`): a single `type` string, `oneOf`, and the
 * constraint keywords that match that type. Type arrays are rejected outright —
 * which is how a `type: ['string', 'null']` passed this offline suite and only
 * blew up when the plugin was installed into a real profile.
 */
const HOST_SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const HOST_CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const HOST_ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const HOST_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const HOST_KEYWORD_TYPES = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
};

/** Collect every way `node` breaks the host's schema subset. */
function hostSchemaViolations(node, path = 'schema', out = []) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        out.push(`${path} must be a schema object`);
        return out;
    }
    for (const key of Object.keys(node)) {
        if (HOST_CONSTRAINT_KEYWORDS.has(key) || HOST_ANNOTATION_KEYWORDS.has(key))
            continue;
        out.push(`${path}.${key} is not a supported keyword`);
    }
    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
        out.push(`${path} cannot declare both type and oneOf`);
        return out;
    }
    if (!hasType && !hasOneOf) {
        for (const key of HOST_SIBLING_KEYWORDS) {
            if (Object.hasOwn(node, key))
                out.push(`${path}.${key} requires type or oneOf`);
        }
        return out;
    }
    if (hasOneOf) {
        if (!Array.isArray(node.oneOf) || node.oneOf.length < 2)
            out.push(`${path}.oneOf must hold at least two schemas`);
        else
            node.oneOf.forEach((branch, index) => hostSchemaViolations(branch, `${path}.oneOf[${index}]`, out));
        return out;
    }
    const { type } = node;
    if (typeof type !== 'string' || !HOST_SCHEMA_TYPES.includes(type)) {
        out.push(Array.isArray(type)
            ? `${path}.type must be a single type string (type arrays are not supported)`
            : `${path}.type must be one of ${HOST_SCHEMA_TYPES.join('/')}`);
        return out;
    }
    for (const [key, types] of Object.entries(HOST_KEYWORD_TYPES)) {
        if (Object.hasOwn(node, key) && !types.includes(type))
            out.push(`${path}.${key} is not supported on type "${type}"`);
    }
    if (type === 'object' && Object.hasOwn(node, 'properties')) {
        for (const [name, child] of Object.entries(node.properties))
            hostSchemaViolations(child, `${path}.properties.${name}`, out);
    }
    if (type === 'array' && Object.hasOwn(node, 'items'))
        hostSchemaViolations(node.items, `${path}.items`, out);
    return out;
}

test('both tool schemas stay inside the subset the host accepts', () => {
    // Prove the checker itself catches the bug that reached the profile.
    assert.deepEqual(hostSchemaViolations({ type: ['string', 'null'] }, 's'), [
        's.type must be a single type string (type arrays are not supported)',
    ]);
    assert.deepEqual(hostSchemaViolations({ type: 'string', items: { type: 'string' } }, 's'), [
        's.items is not supported on type "string"',
    ]);
    assert.deepEqual(hostSchemaViolations({ type: 'string', oneOf: [{ type: 'string' }] }, 's'), [
        's cannot declare both type and oneOf',
    ]);
    // Annotation-only schemas are the host's unconstrained-JSON form.
    assert.deepEqual(hostSchemaViolations({ description: 'anything' }, 's'), []);

    const tool = cursorCodeTool({
        pool: { snapshot: () => [] },
        journal: new RunJournal({}),
        index: { get: async () => undefined },
        maxScanFiles: 10,
    });
    assert.deepEqual(hostSchemaViolations(tool.parameters, 'parameters'), []);
    assert.deepEqual(hostSchemaViolations(tool.output.schema, 'output.schema'), []);
});
