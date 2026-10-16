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
    const context = { document, window: { localStorage: { getItem: () => 'zh' } }, fetch: async () => ({ json: async () => ({}) }) };
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
    tab: function (key) { modelTab = key; renderModel(); }
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
