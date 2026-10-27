import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { registerUsageRoutes } from '../lib/usage.js';

// Exercise the actual inline dashboard script with a small DOM surface. No
// network, CLI, browser install or reimplementation of model-selection logic.
async function panel(t) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-panel-model-'));
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
            get options() { return this.children; },
            appendChild(child) { this.children.push(child); return child; },
            addEventListener(name, callback) { this.listeners[name] = callback; },
        };
    }
    const document = {
        createElement: element,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, element(id === 'model-family' || id === 'model-tier' || id === 'depth' || id === 'attribution' ? 'select' : 'div'));
            return nodes.get(id);
        },
    };
    document.getElementById('bootstrap').textContent = bootstrap;
    const requests = [];
    const context = {
        document, window: { localStorage: { getItem: () => 'zh' } },
        fetch: async (url, options) => {
            requests.push({ url, options });
            const patch = JSON.parse(options.body);
            return { json: async () => ({ settings: patch, effectiveModel: patch.model }) };
        },
    };
    const executable = source.replace('\n  applyLanguage();\n', `
  globalThis.panelTest = {
    renderModel: renderModel, modelCell: modelCell,
    configure: function(value, list) { settings = value; models = list || []; },
    setProxy: function(value) { proxyRoute = value.route || ''; proxyError = value.error || ''; }
  };
  return;
  applyLanguage();
`);
    assert.notEqual(executable, source, 'test harness intercepts initial network polling');
    runInNewContext(executable, context);
    return { ...context.panelTest, nodes, requests };
}

test('the panel treats auto and default[] as one model and distinguishes saved from observed state', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'auto', modelPolicy: 'panel' }, [
        { id: 'default[]', name: 'Auto', current: false },
        { id: 'auto', name: 'Auto', current: false },
        { id: 'composer-2.5[fast=true]', name: 'Composer', current: true },
    ]);
    ui.renderModel();
    assert.equal(ui.modelCell('default[]'), 'Auto', 'already on Auto must not show a pending switch');
    assert.match(ui.modelCell('composer-2.5[fast=true]'), /下次调用切换/);
    const options = ui.nodes.get('model-family').children;
    // The family picker collapses tiers: two Auto aliases are ONE routing
    // choice, and composer-2.5 is one family regardless of its fast tier.
    assert.equal(options.filter(option => option.value === 'default[]').length, 1);
    assert.match(options.find(option => option.value === 'default[]').textContent, /已保存选择/);
    assert.doesNotMatch(options.find(option => option.value === 'default[]').textContent, /最近读取时使用/);
    assert.equal(ui.nodes.get('model-family').value, 'default[]');
    ui.configure({ model: 'auto', modelPolicy: 'per-call' });
    assert.match(ui.modelCell('composer-2.5[fast=true]'), /未被调用参数覆盖时使用/);
});

test('one model family offers its tiers as a second dropdown', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'deepseek-v41-flash-1017-high', modelPolicy: 'panel' }, [
        { id: 'deepseek-v41-flash-1017-none', name: 'DeepSeek V4.1 Flash 1017 None' },
        { id: 'deepseek-v41-flash-1017-low', name: 'DeepSeek V4.1 Flash 1017 Low' },
        { id: 'deepseek-v41-flash-1017-medium', name: 'DeepSeek V4.1 Flash 1017 Medium' },
        { id: 'deepseek-v41-flash-1017-high', name: 'DeepSeek V4.1 Flash 1017 High' },
        { id: 'deepseek-v41-flash-1017-max', name: 'DeepSeek V4.1 Flash 1017 Max' },
        { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
    ]);
    ui.renderModel();
    // Five lookalike aliases collapse to ONE model row: the tier is the axis
    // that differs, and it belongs in its own dropdown.
    const families = ui.nodes.get('model-family').children.filter(o => o.value !== '');
    assert.equal(families.length, 2, 'deepseek + composer, not six aliases');
    assert.ok(families.some(o => o.value === 'deepseek-v41-flash-1017-none'), 'the family row carries one alias');
    // The tier dropdown lists every tier of the selected family, plus `max`.
    const tiers = ui.nodes.get('model-tier').children;
    assert.deepEqual(tiers.map(o => o.value), [
        'deepseek-v41-flash-1017-none',
        'deepseek-v41-flash-1017-low',
        'deepseek-v41-flash-1017-medium',
        'deepseek-v41-flash-1017-high',
        'deepseek-v41-flash-1017-max',
    ]);
    assert.equal(ui.nodes.get('model-tier').value, 'deepseek-v41-flash-1017-high', 'the saved tier is selected');
    assert.equal(ui.nodes.get('model-tier').disabled, false);
});

test('picking a tier saves the full alias it stands for', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'deepseek-v41-flash-1017-high', modelPolicy: 'panel' }, [
        { id: 'deepseek-v41-flash-1017-high', name: 'DeepSeek High' },
        { id: 'deepseek-v41-flash-1017-max', name: 'DeepSeek Max' },
    ]);
    ui.renderModel();
    ui.nodes.get('model-tier').value = 'deepseek-v41-flash-1017-max';
    ui.nodes.get('model-tier').listeners.change();
    ui.nodes.get('model-save').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(ui.requests[0].options.body).model, 'deepseek-v41-flash-1017-max');
});

test('a single-tier model shows one inert option instead of an empty control', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'kimi-k2.7-code', modelPolicy: 'panel' }, [
        { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    ]);
    ui.renderModel();
    // One tier is still one tier: the dropdown shows that alias and locks itself
    // shut, so the operator cannot pick a tier that does not exist.
    assert.equal(ui.nodes.get('model-tier').disabled, true);
    assert.equal(ui.nodes.get('model-tier').value, 'kimi-k2.7-code');
    assert.equal(ui.nodes.get('model-tier').children.length, 1);
});

test('the browser lists one row per model, not one per tier', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'deepseek-v41-flash-1017-high', modelPolicy: 'panel' }, [
        { id: 'default[]', name: 'Auto' },
        { id: 'deepseek-v41-flash-1017-none', name: 'DeepSeek V4.1 Flash 1017 None' },
        { id: 'deepseek-v41-flash-1017-low', name: 'DeepSeek V4.1 Flash 1017 Low' },
        { id: 'deepseek-v41-flash-1017-medium', name: 'DeepSeek V4.1 Flash 1017 Medium' },
        { id: 'deepseek-v41-flash-1017-high', name: 'DeepSeek V4.1 Flash 1017 High' },
        { id: 'deepseek-v41-flash-1017-max', name: 'DeepSeek V4.1 Flash 1017 Max' },
    ]);
    ui.renderModel();
    const rows = ui.nodes.get('model-list').children;
    // Auto plus one DeepSeek row: the five aliases collapse, so an operator
    // scrolls nine families instead of thirty-six lookalike entries.
    assert.equal(rows.length, 2, 'one row per family');
    assert.ok(rows.some(row => row.children[0].textContent === 'Auto'), 'the routing choice keeps its own row');
    assert.ok(rows.some(row => row.children[0].textContent.indexOf('DeepSeek V4.1 Flash 1017') === 0),
        'the family name carries no tier suffix');
});

test('switching a family row off hides all of its tiers at once', async t => {
    const ui = await panel(t);
    ui.configure({ model: '', modelPolicy: 'per-call', disabledModels: [] }, [
        { id: 'deepseek-v41-flash-1017-high', name: 'DeepSeek High' },
        { id: 'deepseek-v41-flash-1017-max', name: 'DeepSeek Max' },
        { id: 'composer-2.5', name: 'Composer 2.5' },
    ]);
    ui.renderModel();
    const row = ui.nodes.get('model-list').children.filter(entry => entry.children[0].textContent.indexOf('DeepSeek') !== -1)[0];
    const box = row.children[1];
    box.checked = false;
    box.listeners.change();
    // Both aliases of the family are denied, so the row keeps meaning "this
    // model is off" rather than flickering per tier.
    ui.nodes.get('model-save').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    const saved = JSON.parse(ui.requests[0].options.body).disabledModels;
    assert.deepEqual(saved.sort(), ['deepseek-v41-flash-1017-high', 'deepseek-v41-flash-1017-max']);
});

test('the panel saves Auto and the lock together', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'auto' }, [{ id: 'default[]', name: 'Auto' }]);
    ui.renderModel();
    ui.nodes.get('model-lock').checked = true;
    ui.nodes.get('model-save').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(ui.requests[0].options.body), {
        // The depth picker travels with the same save: one click must not
        // leave the cap it shows unsaved.
        model: 'default[]', modelPolicy: 'panel', proxy: '', maxChildDepth: 2, attribution: 'off', disabledModels: [],
    });
    assert.match(ui.nodes.get('model-state').textContent, /已锁定模型/);
});

test('the panel saves the proxy and re-reads the list it explains', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'auto', proxy: '' }, [{ id: 'default[]', name: 'Auto' }]);
    ui.renderModel();
    ui.nodes.get('proxy').value = 'http://127.0.0.1:7890';
    ui.nodes.get('model-save').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(ui.requests[0].options.body).proxy, 'http://127.0.0.1:7890');
    // A new route reaches a different catalogue, so the list on screen is now a
    // fact about the old one and has to be re-read.
    assert.deepEqual(ui.requests.map(request => request.url), [
        '/plugins/dsh-cursor-dev/api/settings',
        '/plugins/dsh-cursor-dev/api/settings?refreshModels=1',
    ]);
});

test('the panel says which route a child actually takes', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'auto', proxy: '' }, [{ id: 'default[]', name: 'Auto' }]);
    ui.setProxy({ route: 'http://127.0.0.1:7890 (registry)', error: '' });
    ui.renderModel();
    // The route, not the box, is what explains the model count.
    assert.match(ui.nodes.get('model-state').textContent, /子进程出口：http:\/\/127\.0\.0\.1:7890 \(registry\)/);
    assert.equal(ui.nodes.get('proxy').placeholder, '留空 = 自动检测系统代理 · none = 直连');
});
