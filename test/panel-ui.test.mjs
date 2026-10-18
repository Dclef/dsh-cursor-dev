import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { registerUsageRoutes } from '../lib/usage.js';

// The panel is an iframe inside the app, so its layout is the one thing an
// offline test cannot look at. What it *can* pin is the two structures that
// decide the layout: the scroll container that keeps an 84-character session key
// from widening the page, and the client-side filter that narrows the model
// picker. Both are asserted on the real emitted HTML and the real inline script.
async function panel(t) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-panel-ui-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const routes = new Map();
    registerUsageRoutes({ get: () => ({ register: route => routes.set(route.path, route) }) }, {
        dataDir: dir, pool: { snapshot: () => [] }, index: { list: () => [] },
    });
    let html;
    await routes.get('/plugins/dsh-cursor-dev/').handler({ url: '/', method: 'GET' }, {
        writeHead() {}, end(value) { html = value; },
    });
    const bootstrap = html.match(/id="bootstrap">([\s\S]*?)<\/script>/)[1];
    const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const nodes = new Map();
    function element(tag = 'div') {
        let content = '', selected = '';
        return {
            tag, children: [], style: {}, listeners: {}, checked: false,
            get textContent() { return content; },
            set textContent(value) { content = value; this.children = []; },
            get value() { return tag === 'select' && !this.children.some(child => child.value === selected) ? '' : selected; },
            set value(value) { selected = value; },
            appendChild(child) { this.children.push(child); return child; },
            addEventListener(name, callback) { this.listeners[name] = callback; },
        };
    }
    const document = {
        createElement: element,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, element(id === 'model' ? 'select' : 'div'));
            return nodes.get(id);
        },
    };
    document.getElementById('bootstrap').textContent = bootstrap;
    const calls = [];
    const context = {
        document,
        window: { localStorage: { getItem: () => 'zh' } },
        fetch: async (url, init) => { calls.push({ url, method: init?.method }); return { json: async () => ({}) }; },
        calls,
    };
    const executable = source.replace('\n  applyLanguage();\n', `
  globalThis.panelTest = {
    renderModel: renderModel, shortKey: shortKey,
    filter: function () { return $('model-filter'); },
    options: function () { return $('model').children; },
    rows: function () { return $('model-list').children; },
    type: function (value) { $('model-filter').value = value; $('model-filter').listeners.input(); },
    configure: function (value, list) {
      settings = value; models = list || []; draftDisabled = null; draftModel = null; modelTab = 'all'; renderModel();
    },
    disable: function (id) { setDisabled(id, true); renderModel(); },
    tab: function (key) { modelTab = key; renderModel(); },
    history: function (list) {
      lastPayload = { ok: true, extended: { live: [], conversations: list } };
      renderLive(lastPayload);
    },
    cells: function () { return $('convos').children; },
    count: function () { return $('convos-count').textContent; },
    actions: function () {
      var tr = $('convos').children[0];
      return tr ? tr.children[5].children : [];
    },
    forget: function (key) { forgetRow({ key: key }); },
    armed: function () { return armedFor; },
    calls: function () { return calls; }
  };
  return;
  applyLanguage();
`);
    assert.notEqual(executable, source, 'test harness intercepts initial network polling');
    runInNewContext(executable, context);
    return { html, ...context.panelTest };
}

const MODELS = [
    { id: 'default[]', name: 'Auto', current: true },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
];

test('a long session key cannot widen the page: every table sits in a scroll container', async t => {
    const { html } = await panel(t);
    const wraps = html.match(/<div class="tablewrap"><table>/g) || [];
    assert.equal(wraps.length, 2, 'both the live and the history table are wrapped');
    const tables = html.match(/<table>/g) || [];
    assert.equal(tables.length, 2, 'and no bare table is left outside one');
    assert.match(html, /\.tablewrap \{ overflow-x: auto;/, 'the wrapper, not <body>, owns the horizontal scroll');
    assert.match(html, /minmax\(min\(220px, 100%\), 1fr\)/, 'a narrow panel wraps the quota cards instead of clipping them');
});

test('the history list is bounded and can be folded away, so it cannot grow the page', async t => {
    const { html } = await panel(t);
    // One row per run the operator has ever made lives here; without a bound it
    // is the tallest thing on the page and pushes everything else off it.
    assert.match(html, /#convos-body \{ max-height: \d+px; overflow-y: auto; \}/,
        'the history table scrolls inside a capped box');
    assert.match(html, /id="convos-body"/, 'that box wraps the history table');
    assert.match(html, /id="convos-toggle"/, 'and the heading is the control that folds it');
    assert.match(html, /dsh-cursor-dev:convos-folded/, 'the fold choice is remembered per browser');
});

test('every history row carries a delete control', async t => {
    const { html } = await panel(t);
    assert.match(html, /data-t="colActions">操作</, 'the history table advertises the column');
    assert.match(html, /id="convos-notice"/, 'deleting reports back next to the table it emptied');
    assert.match(html, /"forgetEndpoint":"\/plugins\/dsh-cursor-dev\/api\/forget"/,
        'the panel knows where to forget a conversation');
    // The delete is destructive (index, journal and mirror all go), so it is
    // armed by the first click instead of firing on it.
    assert.match(html, /forgetArmed/);
    assert.match(html, /armedFor/);
});

test('deleting a row arms on the first click and needs a second to fire', async t => {
    const p = await panel(t);
    const calls = p.calls();
    p.history([{ key: 'a::default', cursorSessionId: 'sid-1', workspaceRoot: 'C:\\w', model: 'auto', updatedAt: 1 }]);
    assert.equal(p.cells().length, 1, 'the row is on screen');
    p.forget('a::default');
    assert.deepEqual(calls, [], 'one click only arms the row');
    assert.equal(p.armed(), 'a::default');
    assert.match(p.actions()[0].textContent, /确认删除/, 'the armed row says what the next click does');
    p.forget('a::default');
    assert.equal(calls.length, 1, 'the second click is the delete');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /api\/forget\?key=a%3A%3Adefault/);
    assert.equal(p.armed(), '', 'the confirmation is spent');
});

test('the model search box filters the picker without touching the API', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call' }, MODELS);
    assert.equal(p.options().length, 5, 'one "follow the CLI" entry plus four models');

    p.type('glm');
    assert.deepEqual(p.options().map(o => o.value), ['', 'glm-5.3'], 'only the match survives, plus the follow-the-CLI entry');

    p.type('CODEX');
    assert.deepEqual(p.options().map(o => o.value), ['', 'gpt-5.2-codex'], 'matching ignores case and covers the display name');
});

test('filtering never hides the saved choice, or the picker would look reset', async t => {
    const p = await panel(t);
    p.configure({ model: 'glm-5.3', modelPolicy: 'panel' }, MODELS);
    p.type('codex');
    const values = p.options().map(o => o.value);
    assert.ok(values.includes('glm-5.3'), 'the saved model stays in the list even when it does not match');
    assert.ok(values.includes('gpt-5.2-codex'), 'and the match is there too');
    assert.equal(p.options().find(o => o.value === 'glm-5.3').value, 'glm-5.3');
    assert.ok(!values.includes('claude-haiku-5-5'), 'non-matches are still dropped');
});

test('one distinct model is one option, and the count follows the filter', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call' }, [
        { id: 'auto', name: 'Auto' }, { id: 'default[]', name: 'Auto' }, { id: 'glm-5.3', name: 'GLM-5.3' },
    ]);
    assert.deepEqual(p.options().map(o => o.value), ['', 'default[]', 'glm-5.3'], 'auto and default[] collapse to one');
    assert.match(p.filter().placeholder, /搜索/, 'the placeholder is translated');
});

test('switching a model off hides it from the dropdown but keeps it in the browser', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call', disabledModels: [] }, MODELS);
    assert.equal(p.options().length, 5, 'every model starts available');
    assert.ok(p.rows().length >= 4, 'the browser lists every model');

    p.disable('claude-haiku-5-5');
    assert.deepEqual(p.options().map(o => o.value), ['', 'default[]', 'gpt-5.2-codex', 'glm-5.3'],
        'the switch only removes the model from the dropdown');
    assert.match(p.rows().map(r => r.className).join(' '), /\boff\b/, 'the browser still shows the switched-off row');

    p.tab('off');
    assert.equal(p.rows().length, 1, 'the Off chip isolates switched-off models');
    assert.match(p.rows()[0].className, /\boff\b/);
});

test('a session key is elided for the column, never truncated to nothing', async t => {
    const p = await panel(t);
    const long = 'session-2678abe3-6a1c-4dbb-baa9-13385e83ba34::native-1f223daf-8f57-4903-b73f-3201843';
    assert.equal(long.length, 84, 'the key the panel really receives is 84 characters');
    const short = p.shortKey(long);
    assert.ok(short.length <= 48, `elided to ${short.length} characters, so the column can hold it`);
    assert.ok(short.includes('…'), 'the elision is visible rather than silent');
    assert.ok(short.startsWith('2678abe3'), 'the readable head survives');
    assert.ok(short.includes('native-1f223'), 'and the label that tells rows apart survives');
    assert.equal(p.shortKey('short'), 'short', 'a key with no label part is left alone');
    assert.equal(p.shortKey('a::b'), 'a :: b', 'a short key is left readable');
});
