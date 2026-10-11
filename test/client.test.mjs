/**
 * Guards for the client half (`lib/client.js`).
 *
 * The client half is hand-written against the runtime's module loader, so
 * nothing else in the toolchain would notice if its shape drifted: the host
 * would simply never register a Sidebar panel. These tests load the bundle the
 * same way the browser does (`window.__ModuleLoader__.load`), run `apply`
 * against a fake client context, and assert both the descriptor it registers
 * and what the panel renders while it probes the host route.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * A stand-in for the shared `react` module: `createElement` builds plain
 * objects, and the two hooks the panel uses are driven by hand so one render
 * pass can be replayed with new state.
 */
function makeReact() {
    const hooks = { states: [], effects: [], cursor: 0 };
    const api = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(initial) {
            const index = hooks.cursor++;
            if (hooks.states.length <= index) hooks.states[index] = initial;
            return [
                hooks.states[index],
                next => {
                    hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
                },
            ];
        },
        useEffect(callback) {
            hooks.effects[hooks.cursor++] = callback;
        },
    };
    hooks.reset = () => {
        hooks.cursor = 0;
    };
    return { api, hooks };
}

/** Evaluate the bundle against a fake loader and capture what it registers. */
function loadBundle({ storage = new Map(), react = makeReact().api } = {}) {
    let loaded;
    const warnings = [];
    const window = {
        __ModuleLoader__: {
            load: module => {
                loaded = module;
            },
        },
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, value),
        },
    };
    const console = { warn: (...args) => warnings.push(args.join(' ')), error: () => {} };
    // eslint-disable-next-line no-new-func -- the bundle is a classic script
    new Function('window', 'console', source)(window, console);
    assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load');
    const factory = loaded.factory;
    assert.equal(typeof factory, 'function', 'the loader entry must carry a factory');
    const require = name => {
        assert.equal(name, 'react', `unexpected require("${name}")`);
        return react;
    };
    return { id: loaded.id, exports: factory(require), warnings };
}

/** A fake `betterSidebar` service recording what the panel asked for. */
function fakeSidebar() {
    const calls = { registerTab: [], openTab: [] };
    return {
        calls,
        service: {
            registerTab: descriptor => {
                calls.registerTab.push(descriptor);
                return () => {};
            },
            openTab: descriptor => calls.openTab.push(descriptor),
        },
    };
}

/** A fake client context that resolves `ctx.inject` and `ctx.effect`. */
function fakeContext(sidebar) {
    const warnings = [];
    const disposers = [];
    const ctx = {
        warnings,
        inject(deps, callback) {
            assert.deepEqual(deps, ['betterSidebar'], 'the panel waits for the sidebar service');
            const dispose = callback({ get: () => sidebar });
            disposers.push(dispose);
            return dispose;
        },
        effect(callback) {
            disposers.push(callback());
        },
    };
    return { ctx, disposers, warnings };
}

/** Render the registered panel once, with the hooks of one render pass wired up. */
function render(descriptor, react) {
    react.hooks.reset();
    return descriptor.component({ visible: true });
}

/** Run the panel's probe effect against a stub `fetch` and settle its promise chain. */
async function probe(react, implementation) {
    // Hook slots are shared between useState and useEffect, so the effect is the
    // last slot filled by the render pass rather than slot zero.
    const effects = react.hooks.effects.filter(callback => typeof callback === 'function');
    assert.equal(effects.length > 0, true, 'the render pass must register the probe effect');
    const original = globalThis.fetch;
    globalThis.fetch = implementation;
    try {
        effects[effects.length - 1]();
        await new Promise(resolve => setTimeout(resolve, 5));
    } finally {
        globalThis.fetch = original;
    }
}

test('the bundle loads through the runtime module loader', () => {
    const { id, exports } = loadBundle();
    assert.equal(id, 'dsh-cursor-dev', 'the module id must be the package name');
    assert.equal(typeof exports.apply, 'function');
    assert.ok(Array.isArray(exports.inject), 'inject must be an array');
});

test('apply registers one Cursor tab in the sidebar', () => {
    const { exports } = loadBundle();
    const sidebar = fakeSidebar();
    const { ctx } = fakeContext(sidebar.service);
    exports.apply(ctx);

    assert.equal(sidebar.calls.registerTab.length, 1, 'exactly one tab is registered');
    const descriptor = sidebar.calls.registerTab[0];
    assert.equal(descriptor.id, 'cursor-dev');
    assert.equal(typeof descriptor.component, 'function', 'the descriptor carries a render function');
    assert.equal(descriptor.hidden, false, 'the tab must be visible in the picker');
    assert.equal(typeof descriptor.title, 'function');
    assert.equal(descriptor.title(), 'Cursor');
});

test('a reachable host route mounts the dashboard frame', async () => {
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const sidebar = fakeSidebar();
    exports.apply(fakeContext(sidebar.service).ctx);
    const descriptor = sidebar.calls.registerTab[0];

    let element = render(descriptor, react);
    assert.equal(element.type, 'div', 'the panel reports that it is connecting first');

    await probe(react, async url => {
        assert.equal(url, '/plugins/dsh-cursor-dev/status', 'the probe hits the plugin status route');
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
    });

    element = render(descriptor, react);
    assert.equal(element.type, 'iframe', 'a reachable host route mounts the dashboard');
    assert.equal(element.props.src, '/plugins/dsh-cursor-dev/', 'the panel shows the dashboard route');
    assert.equal(element.props.style.width, '100%');
    assert.equal(element.props.style.height, '100%');
});

test('an unreachable host route explains itself instead of showing an empty pane', async () => {
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const sidebar = fakeSidebar();
    exports.apply(fakeContext(sidebar.service).ctx);
    const descriptor = sidebar.calls.registerTab[0];

    const connecting = render(descriptor, react);
    assert.equal(connecting.type, 'div', 'the panel reports that it is connecting first');

    await probe(react, async () => ({
        ok: false,
        status: 404,
        text: async () => 'not found',
    }));

    const element = render(descriptor, react);
    assert.equal(typeof element.type, 'function', 'the offline card is its own component');
    const card = element.type(element.props);
    const text = JSON.stringify(card);
    assert.match(text, /Cursor 面板暂时不可用/);
    assert.match(text, /HTTP 404/, 'the card names the status that came back');
    assert.match(text, /not found/, 'the card shows the response body');

    await probe(react, async () => {
        throw new Error('boom');
    });
    const failed = render(descriptor, react);
    assert.match(JSON.stringify(failed.type(failed.props)), /could not be reached/);
});

test('the panel is opened once and only once per install', () => {
    const storage = new Map();
    const first = fakeSidebar();
    const { ctx: firstCtx } = fakeContext(first.service);
    loadBundle({ storage }).exports.apply(firstCtx);
    assert.deepEqual(first.calls.openTab, [{ type: 'cursor-dev', title: 'Cursor' }]);
    assert.equal(storage.get('dsh-cursor-dev:opened-once'), '1');

    const second = fakeSidebar();
    const { ctx: secondCtx } = fakeContext(second.service);
    loadBundle({ storage }).exports.apply(secondCtx);
    assert.equal(second.calls.openTab.length, 0, 'a later load must not steal the pane again');
    assert.equal(second.calls.registerTab.length, 1, 'the tab is still registered');
});

test('a missing sidebar service degrades to a warning', () => {
    const { exports, warnings } = loadBundle();
    const ctx = {
        inject: (deps, callback) => callback({ get: () => undefined }),
        effect: () => {},
    };
    assert.doesNotThrow(() => exports.apply(ctx));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /betterSidebar is unavailable/);
});

test('the manifest declares the client half through a resolvable export', () => {
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.ok(Array.isArray(manifest.dsh.client.inject));
    assert.equal(manifest.dsh.manifestVersion, 1);
    // The host resolves the browser half through the export map, so a declared
    // client half without `exports["./client"]` is silently never loaded.
    assert.equal(manifest.exports['./client'], './lib/client.js');
});
