/**
 * Guards for the client half (`lib/client.js`).
 *
 * The client half is hand-written against the runtime's module loader, so
 * nothing else in the toolchain would notice if its shape drifted: the host
 * would simply never register a Settings page. These tests load the bundle the
 * same way the browser does (`window.__ModuleLoader__.load`), run `apply`
 * against a fake client context, and assert what it registers and what the page
 * renders while it probes the host route.
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
function loadBundle({ react = makeReact().api } = {}) {
    let loaded;
    const warnings = [];
    const window = {
        __ModuleLoader__: {
            load: module => {
                loaded = module;
            },
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
 * that is absent resolves to `undefined`, which is what the page must survive.
 * `depsOf` records which services were asked for, so a seat that must not come
 * back (the retired Sidebar tab) can be asserted absent.
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

/** Mount the Settings page and hand back its frame, ready to render or probe. */
function settingsFrame(react, services = {}) {
    const { exports } = loadBundle({ react: react.api });
    const slots = fakeSlots();
    exports.apply(fakeContext({ slots: slots.service, ...services }).ctx);
    return frameOf(render(slots.calls.register[0].component, react));
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

test('apply registers one Cursor page in Settings, under the native slot name', () => {
    const { exports } = loadBundle();
    const slots = fakeSlots();
    const { ctx } = fakeContext({ slots: slots.service });
    exports.apply(ctx);

    assert.deepEqual(slots.calls.inject, [
        'settings.section',
        'conversation.session.header.utilities',
        'shell.overlay',
    ], 'the panel takes the Settings page, a conversation-header chip, and the frame-wide overlay');
    assert.equal(slots.calls.register.length, 3, 'three native seats are registered');
    const { options, component } = slots.calls.register[0];
    assert.equal(options.name, 'settings.section');
    assert.equal(options.id, 'dsh-cursor-dev');
    assert.equal(options.order, 62);
    assert.equal(typeof options.label, 'function');
    assert.equal(typeof component, 'function');
});

test('the conversation header carries a Cursor chip, in front of the overlay it opens', () => {
    const { exports } = loadBundle();
    const slots = fakeSlots();
    exports.apply(fakeContext({ slots: slots.service }).ctx);

    const chip = slots.calls.register[1];
    const overlay = slots.calls.register[2];
    assert.equal(chip.options.name, 'conversation.session.header.utilities');
    assert.equal(chip.options.id, 'dsh-cursor-dev');
    assert.equal(chip.options.order, 40);
    assert.equal(overlay.options.name, 'shell.overlay');
    assert.equal(overlay.options.order, 90);
    assert.equal(typeof chip.component, 'function');
    assert.equal(typeof overlay.component, 'function');
    assert.notEqual(chip.component, overlay.component, 'the chip and the panel are separate components');
});

test('the header chip shows the live session count and the model it is running', async () => {
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const slots = fakeSlots();
    exports.apply(fakeContext({ slots: slots.service, locale: fakeLocale('zh') }).ctx);
    const chip = slots.calls.register[1].component;

    render(chip, react, {});
    await probe(react, statusAnswer({ agent: { found: true }, live: [{ model: 'composer-2.5[fast=true]' }] }));

    const element = render(chip, react, {});
    assert.equal(element.type, 'button', 'the chip is a button');
    assert.match(JSON.stringify(element.children), /Cursor · 1/, 'the live count is in the label');
    assert.match(String(element.props.title), /composer-2\.5\[fast=true\]/, 'the model it is running is in the tooltip');

    const empty = render(chip, react, {});
    assert.ok(empty, 'a chip with no live session still renders');
});

test('the chip opens the frame-wide panel, and its close button shuts it', () => {
    // One harness: both seats are rendered by the same bundle, so they share
    // the module's `react` — and, deliberately, the same hook slots, which is
    // what lets a click on one be observed by the other.
    const react = makeReact();
    const { exports } = loadBundle({ react: react.api });
    const slots = fakeSlots();
    exports.apply(fakeContext({ slots: slots.service }).ctx);
    const chip = slots.calls.register[1].component;
    const overlay = slots.calls.register[2].component;

    // Mount the overlay while it is still closed: it renders nothing, but it
    // subscribes to the shared state, which is what the chip notifies. Its
    // effect is slot 1 (the open state is slot 0).
    assert.equal(render(overlay, react), null, 'a closed panel renders nothing');
    react.hooks.effects[1]();

    render(chip, react);
    const closed = render(overlay, react);
    assert.equal(closed, null);

    render(chip, react).props.onClick();
    const opened = render(overlay, react);
    assert.equal(opened.type, 'div', 'the chip opens the panel');
    assert.equal(opened.props.style.position, 'fixed', 'the panel floats above the frame, out of the header\'s flow');
    assert.equal(typeof opened.children[1].children[0].type, 'function', 'the panel mounts the shared host frame');

    const head = opened.children[0];
    const link = head.children.find(child => child?.type === 'a');
    assert.equal(link.props.href, '/plugins/dsh-cursor-dev/?lang=zh', 'the panel links to the same dashboard in a tab');
    const close = head.children.find(child => child?.type === 'button' && child.children.includes('✕'));
    assert.ok(close, 'the panel can be closed from its own header');
    close.props.onClick();
    assert.equal(render(overlay, react), null, 'closing hides the panel again');
});

test('the Settings label follows the app locale, and defaults to Chinese', () => {
    const zh = fakeSlots();
    loadBundle().exports.apply(fakeContext({ slots: zh.service, locale: fakeLocale('zh') }).ctx);
    assert.equal(zh.calls.register[0].options.label(), 'Cursor 子智能体');

    const en = fakeSlots();
    loadBundle().exports.apply(fakeContext({ slots: en.service, locale: fakeLocale('en') }).ctx);
    assert.equal(en.calls.register[0].options.label(), 'Cursor agent');
});

test('the retired right-Sidebar tab is not registered any more', () => {
    const { exports, warnings } = loadBundle();
    const calls = { registerTab: [], openTab: [] };
    const sidebar = {
        registerTab: descriptor => {
            calls.registerTab.push(descriptor);
            return () => {};
        },
        openTab: descriptor => calls.openTab.push(descriptor),
    };
    const { ctx, injected } = fakeContext({ slots: fakeSlots().service, betterSidebar: sidebar });
    exports.apply(ctx);

    assert.equal(calls.registerTab.length, 0, 'the panel lives in Settings only');
    assert.equal(calls.openTab.length, 0, 'nothing may steal the right pane on load');
    assert.equal(
        injected.some(deps => deps.includes('betterSidebar')),
        false,
        'the sidebar host must not be a dependency of this plugin any more',
    );
    assert.equal(warnings.length, 0, 'a present-but-unused sidebar service is not worth a warning');
});

test('the Settings page embeds the dashboard, in the app locale', async () => {
    const react = makeReact();
    const frame = settingsFrame(react, { locale: fakeLocale('en') });

    const connecting = render(frame.type, react, frame.props);
    assert.equal(connecting.type, 'div', 'the page reports that it is connecting first');

    await probe(react, REACHABLE);
    const mounted = render(frame.type, react, frame.props);
    assert.equal(mounted.type, 'iframe', 'a reachable host route mounts the dashboard');
    assert.equal(mounted.props.src, '/plugins/dsh-cursor-dev/?lang=en', 'the frame passes the app locale');
});

test('a reachable host route mounts the dashboard frame', async () => {
    const react = makeReact();
    const frame = settingsFrame(react);

    let element = render(frame.type, react, frame.props);
    assert.equal(element.type, 'div', 'the page reports that it is connecting first');

    await probe(react, REACHABLE);

    element = render(frame.type, react, frame.props);
    assert.equal(element.type, 'iframe', 'a reachable host route mounts the dashboard');
    assert.equal(element.props.src, '/plugins/dsh-cursor-dev/?lang=zh', 'Chinese is the default the frame asks for');
    assert.equal(element.props.style.width, '100%');
    assert.equal(element.props.style.height, '100%');
});

test('an unreachable host route explains itself instead of showing an empty pane', async () => {
    const react = makeReact();
    const frame = settingsFrame(react);

    const connecting = render(frame.type, react, frame.props);
    assert.equal(connecting.type, 'div', 'the page reports that it is connecting first');

    await probe(react, async () => ({
        ok: false,
        status: 404,
        text: async () => 'not found',
    }));

    const element = render(frame.type, react, frame.props);
    assert.equal(typeof element.type, 'function', 'the offline card is its own component');
    const card = element.type(element.props);
    const text = JSON.stringify(card);
    assert.match(text, /Cursor 面板暂时不可用/);
    assert.match(text, /HTTP 404/, 'the card names the status that came back');
    assert.match(text, /not found/, 'the card shows the response body');

    await probe(react, async () => {
        throw new Error('boom');
    });
    const failed = render(frame.type, react, frame.props);
    const failure = JSON.stringify(failed.type(failed.props));
    assert.match(failure, /连不上宿主路由/, 'a rejected probe is reported as unreachable');
    assert.match(failure, /boom/, 'the thrown message is shown as the reason');
});

test('a missing slots service degrades to a warning instead of a failed load', () => {
    const { exports, warnings } = loadBundle();
    assert.doesNotThrow(() => exports.apply(fakeContext({}).ctx));
    assert.equal(warnings.length, 1, 'one warning for the absent seat owner');
    assert.match(warnings.join('\n'), /slots service is unavailable/);
});

/** A probe answer shaped like the host's own `/status` payload. */
const statusAnswer = body => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

const SETUP = {
    install: {
        win32: "irm 'https://cursor.com/install?win32=true' | iex",
        unix: 'curl https://cursor.com/install -fsS | bash',
    },
    login: 'agent login',
    verify: 'agent status --format json',
    docs: 'https://cursor.com/docs/cli',
};

test('a machine without the CLI is told how to install it, not left with dashes', async () => {
    const react = makeReact();
    const frame = settingsFrame(react);
    const connecting = render(frame.type, react, frame.props);
    assert.equal(connecting.type, 'div', 'the panel connects first');
    await probe(react, statusAnswer({
        agent: { found: false, command: '', entry: '', source: '' },
        auth: { ok: false, installed: false, authenticated: false, error: 'the Cursor CLI was not found' },
        setup: SETUP,
    }));

    const element = render(frame.type, react, frame.props);
    assert.equal(typeof element.type, 'function', 'the setup card is its own component');
    const card = JSON.stringify(element.type(element.props));
    assert.match(card, /还没找到 Cursor CLI/);
    assert.match(card, /cursor\.com\/install\?win32=true/, 'the Windows install command is printed');
    assert.match(card, /curl https:\/\/cursor\.com\/install -fsS \| bash/, 'so is the Unix one');
    assert.match(card, /agent login/, 'and the login step that follows it');
});

test('a CLI that is installed but signed out is told which command to run', async () => {
    const react = makeReact();
    const frame = settingsFrame(react);
    render(frame.type, react, frame.props);
    await probe(react, statusAnswer({
        agent: { found: true, command: 'node.exe', entry: 'index.js', source: 'path-cmd' },
        auth: { ok: false, installed: true, authenticated: false, error: 'Not logged in. Run `agent login`.' },
        setup: SETUP,
    }));

    const element = render(frame.type, react, frame.props);
    const card = JSON.stringify(element.type(element.props));
    assert.match(card, /Cursor CLI 还没登录/);
    assert.match(card, /agent login/);
    assert.match(card, /Not logged in/, 'the CLI\'s own words are shown as the reason');
    assert.match(card, /agent status --format json/, 'and the command that confirms the fix');
});

test('the setup card\'s retry asks the host for a fresh sign-in check', async () => {
    const react = makeReact();
    const frame = settingsFrame(react);
    render(frame.type, react, frame.props);
    await probe(react, statusAnswer({
        agent: { found: true },
        auth: { ok: false, installed: true, authenticated: false },
        setup: SETUP,
    }));

    const card = render(frame.type, react, frame.props);
    assert.equal(typeof card.props.onRetry, 'function', 'the setup card offers a retry');
    card.props.onRetry();

    const connecting = render(frame.type, react, frame.props);
    assert.equal(connecting.type, 'div', 'retrying goes back to the connecting state');

    const urls = [];
    await probe(react, async url => {
        urls.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify({ agent: { found: true }, auth: { ok: true, installed: true, authenticated: true } }) };
    });
    assert.deepEqual(urls, ['/plugins/dsh-cursor-dev/status?auth=refresh'],
        'a retry must not meet the host\'s one-minute sign-in cache');
    assert.equal(render(frame.type, react, frame.props).type, 'iframe', 'once signed in, the dashboard mounts');
});

test('the manifest declares the client half through a resolvable export', () => {
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.ok(Array.isArray(manifest.dsh.client.inject));
    assert.equal(manifest.dsh.manifestVersion, 1);
    // The host resolves the browser half through the export map, so a declared
    // client half without `exports["./client"]` is silently never loaded.
    assert.equal(manifest.exports['./client'], './lib/client.js');
});
