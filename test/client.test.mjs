/**
 * Guards for the client half (`lib/client.js`).
 *
 * The client half is hand-written against the runtime's module loader, so
 * nothing else in the toolchain would notice if its shape drifted: the host
 * would simply never register a Sidebar tab or a Settings page. These tests load
 * the bundle the same way the browser does (`window.__ModuleLoader__.load`), run
 * `apply` against a fake client context, and assert what it registers and what
 * the panel renders while it probes the host route.
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

/** A fake `slots` service recording the seat the panel takes. */
function fakeSlots() {
    const calls = { inject: [], register: [] };
    return {
        calls,
        service: {
            inject(key, callback) {
                calls.inject.push(key);
                return callback();
            },
            register(options, component) {
                calls.register.push({ options, component });
                return () => {};
            },
        },
    };
}

/** A fake locale service, as the client half reads it. */
function fakeLocale(active) {
    return { getLocale: () => ({ active }) };
}

/**
 * A fake client context that resolves `ctx.inject` by service name.
 *
 * `ctx.inject` waits for a service in the real client context and calls back
 * with a context that can `get` it; here the wait is immediate and a service
 * that is absent resolves to `undefined`, which is what the panel must survive.
 */
function fakeContext(services = {}) {
    const disposers = [];
    const injected = [];
    const ctx = {
        inject(deps, callback) {
            injected.push(deps);
            const dispose = callback({ get: name => services[name] });
            disposers.push(dispose);
            return dispose;
        },
        effect(callback) {
            const dispose = callback();
            if (typeof dispose === 'function') disposers.push(dispose);
        },
    };
    return { ctx, disposers, injected };
}

/** Render one component, with the hooks of a fresh render pass wired up. */
function render(component, react, props = {}) {
    react.hooks.reset();
    return component(props);
}

/** Run a component's probe effect against a stub `fetch` and settle its promise chain. */
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

/** The component a probe needs to reach: the frame nested inside the Settings page. */
function frameOf(page) {
    assert.equal(page.type, 'div', 'the Settings page is a column');
    const slot = page.children[page.children.length - 1];
    const frame = slot.children[0];
    assert.equal(typeof frame.type, 'function', 'the Settings page mounts the shared frame');
    return frame;
}

const REACHABLE = async url => {
    assert.equal(url, '/plugins/dsh-cursor-dev/status', 'the probe hits the plugin status route');
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
};

test('the bundle loads through the runtime module loader', () => {
    const { id, exports } = loadBundle();
    assert.equal(id, 'dsh-cursor-dev', 'the module id must be the package name');
    assert.equal(typeof exports.apply, 'function');
    assert.ok(Array.isArray(exports.inject), 'inject must be an array');
});

test('apply registers one Cursor tab in the sidebar', () => {
    const { exports } = loadBundle();
    const sidebar = fakeSidebar();
    exports.apply(fakeContext({ betterSidebar: sidebar.service }).ctx);

    assert.equal(sidebar.calls.registerTab.length, 1, 'exactly one tab is registered');
    const descriptor = sidebar.calls.registerTab[0];
    assert.equal(descriptor.id, 'cursor-dev');
    assert.equal(typeof descriptor.component, 'function', 'the descriptor carries a render function');
    assert.equal(descriptor.hidden, false, 'the tab must be visible in the picker');
    assert.equal(typeof descriptor.title, 'function');
    assert.equal(descriptor.title(), 'Cursor');
});

test('apply registers one Cursor page in Settings, under the native slot name', () => {
    const { exports } = loadBundle();
    const slots = fakeSlots();
    const { ctx } = fakeContext({ slots: slots.service });
    exports.apply(ctx);

    assert.deepEqual(slots.calls.inject, ['settings.section'], 'a Settings page is a settings.section entry');
    assert.equal(slots.calls.register.length, 1, 'exactly one Settings page is registered');
    const { options, component } = slots.calls.register[0];
    assert.equal(options.name, 'settings.section');
    assert.equal(options.id, 'dsh-cursor-dev');
    assert.equal(options.order, 62);
    assert.equal(typeof options.label, 'function');
    assert.equal(typeof component, 'function');
});

test('the Settings label follows the app locale, and defaults to Chinese', () => {
    const zh = fakeSlots();
    loadBundle().exports.apply(fakeContext({ slots: zh.service, locale: fakeLocale('zh') }).ctx);
    assert.equal(zh.calls.register[0].options.label(), 'Cursor 子智能体');

    const en = fakeSlots();
    loadBundle().exports.apply(fakeContext({ slots: en.service, locale: fakeLocale('en') }).ctx);
    assert.equal(en.calls.register[0].options.label(), 'Cursor agent');
});

test('the Settings page embeds the same dashboard, in the app locale', async () => {
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const slots = fakeSlots();
    exports.apply(fakeContext({ slots: slots.service, locale: fakeLocale('en') }).ctx);
    const page = render(slots.calls.register[0].component, react);
    const frame = frameOf(page);

    const connecting = render(frame.type, react, frame.props);
    assert.equal(connecting.type, 'div', 'the page reports that it is connecting first');

    await probe(react, REACHABLE);
    const mounted = render(frame.type, react, frame.props);
    assert.equal(mounted.type, 'iframe', 'a reachable host route mounts the dashboard');
    assert.equal(mounted.props.src, '/plugins/dsh-cursor-dev/?lang=en', 'the frame passes the app locale');
});

test('a reachable host route mounts the dashboard frame', async () => {
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const sidebar = fakeSidebar();
    exports.apply(fakeContext({ betterSidebar: sidebar.service }).ctx);
    const descriptor = sidebar.calls.registerTab[0];

    const panel = render(descriptor.component, react);
    assert.equal(typeof panel.type, 'function', 'the tab body renders the shared frame');
    let element = render(panel.type, react, panel.props);
    assert.equal(element.type, 'div', 'the panel reports that it is connecting first');

    await probe(react, REACHABLE);

    element = render(panel.type, react, panel.props);
    assert.equal(element.type, 'iframe', 'a reachable host route mounts the dashboard');
    assert.equal(element.props.src, '/plugins/dsh-cursor-dev/?lang=zh', 'Chinese is the default the frame asks for');
    assert.equal(element.props.style.width, '100%');
    assert.equal(element.props.style.height, '100%');
});

test('an unreachable host route explains itself instead of showing an empty pane', async () => {
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const sidebar = fakeSidebar();
    exports.apply(fakeContext({ betterSidebar: sidebar.service }).ctx);
    const descriptor = sidebar.calls.registerTab[0];

    const connecting = render(descriptor.component, react);
    assert.equal(typeof connecting.type, 'function', 'the tab body renders the shared frame');
    const first = render(connecting.type, react, connecting.props);
    assert.equal(first.type, 'div', 'the panel reports that it is connecting first');

    await probe(react, async () => ({
        ok: false,
        status: 404,
        text: async () => 'not found',
    }));

    const element = render(connecting.type, react, connecting.props);
    assert.equal(typeof element.type, 'function', 'the offline card is its own component');
    const card = element.type(element.props);
    const text = JSON.stringify(card);
    assert.match(text, /Cursor 面板暂时不可用/);
    assert.match(text, /HTTP 404/, 'the card names the status that came back');
    assert.match(text, /not found/, 'the card shows the response body');

    await probe(react, async () => {
        throw new Error('boom');
    });
    const failed = render(connecting.type, react, connecting.props);
    const failure = JSON.stringify(failed.type(failed.props));
    assert.match(failure, /连不上宿主路由/, 'a rejected probe is reported as unreachable');
    assert.match(failure, /boom/, 'the thrown message is shown as the reason');
});

test('the panel is opened once and only once per install', () => {
    const storage = new Map();
    const first = fakeSidebar();
    loadBundle({ storage }).exports.apply(fakeContext({ betterSidebar: first.service }).ctx);
    assert.deepEqual(first.calls.openTab, [{ type: 'cursor-dev', title: 'Cursor' }]);
    assert.equal(storage.get('dsh-cursor-dev:opened-once'), '1');

    const second = fakeSidebar();
    loadBundle({ storage }).exports.apply(fakeContext({ betterSidebar: second.service }).ctx);
    assert.equal(second.calls.openTab.length, 0, 'a later load must not steal the pane again');
    assert.equal(second.calls.registerTab.length, 1, 'the tab is still registered');
});

test('missing client services degrade to warnings instead of a failed load', () => {
    const { exports, warnings } = loadBundle();
    assert.doesNotThrow(() => exports.apply(fakeContext({}).ctx));
    assert.equal(warnings.length, 2, 'one warning per absent seat owner');
    assert.match(warnings.join('\n'), /betterSidebar is unavailable/);
    assert.match(warnings.join('\n'), /slots service is unavailable/);
});

test('the manifest declares the client half through a resolvable export', () => {
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.ok(Array.isArray(manifest.dsh.client.inject));
    assert.equal(manifest.dsh.manifestVersion, 1);
    // The host resolves the browser half through the export map, so a declared
    // client half without `exports["./client"]` is silently never loaded.
    assert.equal(manifest.exports['./client'], './lib/client.js');
});
