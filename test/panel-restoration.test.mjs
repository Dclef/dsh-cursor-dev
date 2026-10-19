import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { registerUsageRoutes } from '../lib/usage.js';

async function dashboard(t, { live = [], records = [], children = [] } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-restore-ui-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const routes = new Map();
    const saved = new Map(records.map(row => [row.key, row]));
    let replays = 0;
    registerUsageRoutes({ get: () => ({ register: route => routes.set(route.path, route) }) }, {
        dataDir: dir,
        usage: { get: async () => ({ ok: true }) },
        pool: {
            snapshot: () => live,
            replay: async (options, body) => { replays++; return body({ events: [] }); },
        },
        index: {
            list: () => [...saved.values()],
            get: key => saved.get(key),
            set: async (key, entry) => saved.set(key, entry),
        },
        mirrors: {
            available: true, snapshot: () => children,
            restore: async () => ({ child: { session: { header: { id: 'restored-child', parentSession: 'p' } } } }),
        },
    });
    async function request(path, key, method = 'GET') {
        let status, body;
        await routes.get(path).handler({ url: path + (key ? '?key=' + encodeURIComponent(key) : ''), method }, {
            writeHead(value) { status = value; }, end(value) { body = value; },
        });
        return { status, body: path.endsWith('/') ? body : JSON.parse(body) };
    }
    const { body: html } = await request('/plugins/dsh-cursor-dev/');
    const bootstrap = JSON.parse(html.match(/id="bootstrap">([\s\S]*?)<\/script>/)[1]);
    return { request, bootstrap, html, replays: () => replays };
}

const firstRun = { key: 'p::native-new#1', cursorSessionId: 'cursor-new', turns: 0, running: true };
const savedRun = { key: 'p::native-new', cursorSessionId: 'cursor-new', workspaceRoot: 'C:/work', turns: 1 };

test('a first live turn is not offered as a restorable durable conversation', async t => {
    const panel = await dashboard(t, { live: [firstRun] });
    assert.equal(panel.bootstrap.live[0].restorable, false);
    const reply = await panel.request('/plugins/dsh-cursor-dev/api/restore', firstRun.key, 'POST');
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'conversation_pending');
    assert.equal(panel.replays(), 0, 'opening a first turn never starts history replay');
});

test('a continued turn cannot be replayed while its Cursor writer is running', async t => {
    const panel = await dashboard(t, { live: [{ ...firstRun, turns: 1 }], records: [savedRun] });
    assert.equal(panel.bootstrap.live[0].restorable, false);
    assert.equal(panel.bootstrap.conversations[0].restorable, false);
    const reply = await panel.request('/plugins/dsh-cursor-dev/api/restore', savedRun.key, 'POST');
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'conversation_running');
    assert.equal(panel.replays(), 0);
});

test('finished saved turns still restore by generation-scoped key', async t => {
    const panel = await dashboard(t, { live: [{ ...firstRun, turns: 1, running: false }], records: [savedRun] });
    assert.equal(panel.bootstrap.live[0].restorable, true);
    const reply = await panel.request('/plugins/dsh-cursor-dev/api/restore', firstRun.key, 'POST');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.childSessionId, 'restored-child');
    assert.equal(panel.replays(), 1);
});

test('an older saved generation is not offered as the current live transcript', async t => {
    const panel = await dashboard(t, {
        live: [{ ...firstRun, running: false }], records: [{ ...savedRun, cursorSessionId: 'old-cursor' }],
    });
    assert.equal(panel.bootstrap.live[0].restorable, false);
    const reply = await panel.request('/plugins/dsh-cursor-dev/api/restore', 'unknown::row', 'POST');
    assert.equal(reply.status, 404, 'a missing row remains a real missing-record error');
});

async function client(t, response, options = {}) {
    const panel = await dashboard(t, { live: [firstRun], ...options });
    const nodes = new Map();
    const element = () => ({
        children: [], style: {}, listeners: {},
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        set textContent(value) { this.content = value; this.children = []; },
        get textContent() { return this.content || ''; },
    });
    const document = {
        createElement: element,
        getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    };
    document.getElementById('bootstrap').textContent = JSON.stringify(panel.bootstrap);
    const calls = [];
    const posts = [];
    const window = { parent: { postMessage(message, origin) { posts.push({ message, origin }); } }, location: { origin: 'http://localhost' }, localStorage: { getItem: () => 'zh' } };
    const source = panel.html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const context = {
        document, window,
        fetch: async (url, options) => {
            calls.push({ url, method: options?.method || 'GET' });
            return options?.method === 'POST' ? response : { ok: true, json: async () => ({ steps: [] }) };
        },
    };
    const executable = source.replace('\n  applyLanguage();\n', `
  globalThis.ui = { openRow: openRow, rowHint: rowHint, canRestore: canRestore };
  return;
  applyLanguage();
`);
    assert.notEqual(executable, source);
    runInNewContext(executable, context);
    return { ...context.ui, calls, posts, bootstrap: panel.bootstrap, request: panel.request, replays: panel.replays };
}

test('clicking an unsaved live row opens the timeline without posting restore', async t => {
    const ui = await client(t);
    const entry = { ...firstRun, restorable: false };
    assert.equal(ui.canRestore(entry), false);
    assert.match(ui.rowHint(entry), /轨迹/);
    ui.openRow(entry);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].method, 'GET');
    assert.match(ui.calls[0].url, /api\/journal\?key=/);
});

test('a stale client falls back to the timeline when restore reports a pending turn', async t => {
    const ui = await client(t, { ok: false, json: async () => ({ ok: false, code: 'conversation_pending' }) });
    ui.openRow({ key: firstRun.key, cursorSessionId: firstRun.cursorSessionId });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.calls.length, 2);
    assert.equal(ui.calls[0].method, 'POST');
    assert.match(ui.calls[1].url, /api\/journal\?key=/);
    assert.equal(ui.calls[1].method, 'GET');
});

test('a running native row opens its real child immediately, without history replay or a timeline', async t => {
    const ui = await client(t, undefined, {
        children: [{ key: firstRun.key, childSessionId: 'live-child', parentSessionId: 'p' }],
    });
    const entry = ui.bootstrap.live[0];
    assert.equal(entry.running, true);
    assert.equal(entry.restorable, false, 'a first running turn is not replayable');
    assert.equal(entry.childSessionId, 'live-child');
    assert.match(ui.rowHint(entry), /子智能体/);
    ui.openRow(entry);
    assert.equal(ui.calls.length, 0, 'opening the child does not call restore or journal');
    assert.equal(ui.posts.length, 1);
    const { message, origin } = ui.posts[0];
    assert.equal(message.type, 'dsh-cursor-dev:open-child');
    assert.equal(message.parentSessionId, 'p');
    assert.equal(message.childSessionId, 'live-child');
    assert.equal(message.mode, 'one-shot');
    assert.equal(origin, 'http://localhost');
    const reply = await ui.request('/plugins/dsh-cursor-dev/api/usage');
    assert.equal(reply.body.extended.live[0].childSessionId, 'live-child', 'polls retain the same address');
    assert.equal(ui.replays(), 0);
});

test('a completed live row reuses its saved child after the native mirror lease is released', async t => {
    const ui = await client(t, undefined, {
        live: [{ ...firstRun, turns: 1, running: false }],
        records: [{ ...savedRun, childSessionId: 'saved-child' }],
    });
    for (const entry of [ui.bootstrap.live[0], ui.bootstrap.conversations[0]]) {
        assert.equal(entry.childSessionId, 'saved-child');
        ui.openRow(entry);
    }
    assert.equal(ui.posts.length, 2, 'both tables open the existing conversation');
    assert.equal(ui.calls.length, 0, 'a saved child is not read back again');
});

test('a new live generation never opens the previous Cursor session child', async t => {
    const panel = await dashboard(t, {
        live: [firstRun],
        records: [{ ...savedRun, cursorSessionId: 'old-cursor', childSessionId: 'old-child' }],
    });
    assert.equal(panel.bootstrap.live[0].childSessionId, undefined);
    assert.equal(panel.bootstrap.conversations[0].childSessionId, 'old-child');
});
