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
    const options = ui.nodes.get('model').children;
    assert.equal(options.filter(option => option.value === 'default[]').length, 1);
    assert.match(options.find(option => option.value === 'default[]').textContent, /已保存选择/);
    assert.doesNotMatch(options.find(option => option.value === 'default[]').textContent, /最近读取时使用/);
    assert.match(options.find(option => option.value.startsWith('composer')).textContent, /最近读取时使用/);
    assert.equal(ui.nodes.get('model').value, 'default[]');
    ui.configure({ model: 'auto', modelPolicy: 'per-call' });
    assert.match(ui.modelCell('composer-2.5[fast=true]'), /未被调用参数覆盖时使用/);
});

test('the panel saves Auto and the lock together', async t => {
    const ui = await panel(t);
    ui.configure({ model: 'auto' }, [{ id: 'default[]', name: 'Auto' }]);
    ui.renderModel();
    ui.nodes.get('model-lock').checked = true;
    ui.nodes.get('model-save').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(ui.requests[0].options.body), {
        model: 'default[]', modelPolicy: 'panel', proxy: '', disabledModels: [],
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
