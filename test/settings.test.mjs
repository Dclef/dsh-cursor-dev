/**
 * Guards for `lib/settings.js`.
 *
 * This module is what makes "which model does the child run on" and "which
 * language does the panel speak" changeable without editing a profile file and
 * restarting the app, so the pieces worth pinning down are the ones a user can
 * reach: the CLI listing parser, the read/merge/atomic-write cycle, the
 * precedence between the panel and the profile config, and the HTTP contract the
 * dashboard talks to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    MODEL_CACHE_MS,
    effectiveModel,
    emptySettings,
    modelsFor,
    normalizeSettings,
    parseModelList,
    readSettings,
    registerSettingsRoutes,
    resolveModelSelection,
    settingsPath,
    writeSettings,
} from '../lib/settings.js';

/** A throwaway data directory, removed when `body` returns. */
async function withDataDir(body) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cursor-dev-settings-'));
    try {
        return await body(dir);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The real shape of `agent --list-models`: one `id - name` per line, the active
 * one marked, a trailing tip, and display names carrying the zero-width
 * characters the upstream table carries.
 */
const LISTING = [
    'Available models:',
    '',
    'auto - \u200bAuto\u200b (current, default)',
    'composer-2.5 - \u200bComposer 2.5\u200b',
    'composer-2.5-fast - \u200bComposer 2.5\u200b \u200dFast\ufeff',
    'composer-2.5[fast=true] - Composer 2.5 (fast)',
    'cursor-grok-4.6-high - Cursor Grok 4.6 High',
    'grok-4.7-xhigh - Grok 4.7 Extra High',
    'kimi-k3-max - Kimi K3 Max',
    'glm-5.2-high - GLM 5.2 High',
    'auto - Auto',
    'just some stray output',
    'Tip: run `agent --model <id>` to start with a specific model.',
    '',
].join('\r\n');

test('parseModelList reads the CLI listing without its noise', () => {
    const models = parseModelList(LISTING);
    assert.deepEqual(models.map(model => model.id), [
        'auto',
        'composer-2.5',
        'composer-2.5-fast',
        'composer-2.5[fast=true]',
        'cursor-grok-4.6-high',
        'grok-4.7-xhigh',
        'kimi-k3-max',
        'glm-5.2-high',
    ], 'the header, the tip, the stray line and the duplicate id are all dropped');

    assert.deepEqual(models[0], { id: 'auto', name: 'Auto', current: true, isDefault: true });
    assert.equal(models[1].current, false);
    assert.equal(models[1].isDefault, false);
    assert.ok(models.every(model => !/[\u200b-\u200f\ufeff]/.test(model.name)), 'zero-width characters are stripped');
    assert.equal(models[3].name, 'Composer 2.5 (fast)', 'a parenthesised name is not mistaken for a marker');
});

test('parseModelList survives output that is not a listing at all', () => {
    assert.deepEqual(parseModelList(''), []);
    assert.deepEqual(parseModelList(undefined), []);
    assert.deepEqual(parseModelList('error: not logged in'), []);
});

test('readSettings answers with defaults instead of throwing', async () => {
    await withDataDir(async (dir) => {
        assert.deepEqual(readSettings(dir), emptySettings(), 'a missing file is a fresh install');

        writeFileSync(settingsPath(dir), '{ this is not json', 'utf8');
        assert.deepEqual(readSettings(dir), emptySettings(), 'a corrupt file must not take the panel down');
    });
});

test('normalizeSettings ignores values it cannot trust', () => {
    const normalized = normalizeSettings({
        model: 'grok-4.7-high',
        mode: 'sideways',
        language: 'fr',
        updatedAt: 'yesterday',
        modelsFetchedAt: '1700000000000',
        models: [{ id: 'auto', name: 'Auto' }, { id: '', name: 'nope' }, 'nope', null],
    });
    assert.equal(normalized.model, 'grok-4.7-high');
    assert.equal(normalized.mode, '', 'an unknown mode falls back to "not set"');
    assert.equal(normalized.language, '', 'an unknown locale falls back to "not set"');
    assert.equal(normalized.updatedAt, 0);
    assert.equal(normalized.modelsFetchedAt, 1700000000000, 'a numeric string is accepted');
    assert.deepEqual(normalized.models, [{ id: 'auto', name: 'Auto' }], 'only usable model entries are kept');
    assert.equal(normalizeSettings(null).version, 1);
});

test('the proxy setting is text, bounded, and defaults to direct', () => {
    assert.equal(emptySettings().proxy, 'none');
    assert.equal(normalizeSettings({}).proxy, 'none');
    assert.equal(normalizeSettings(null).proxy, 'none');
    assert.equal(normalizeSettings({ proxy: 'http://127.0.0.1:7890' }).proxy, 'http://127.0.0.1:7890');
    assert.equal(normalizeSettings({ proxy: '  none  ' }).proxy, 'none');
    assert.equal(normalizeSettings({ proxy: '' }).proxy, '');
    assert.equal(normalizeSettings({ proxy: '  ' }).proxy, '');
    assert.equal(normalizeSettings({ proxy: 7890 }).proxy, 'none', 'a number is not a proxy');
    assert.equal(normalizeSettings({ proxy: ['http://a:1'] }).proxy, 'none');
    // A settings file is JSON somebody can hand-edit, so a value that is too
    // long to be a proxy is dropped rather than truncated: half a URL is worse
    // than none.
    assert.equal(normalizeSettings({ proxy: 'x'.repeat(5000) }).proxy, 'none');
    assert.equal(normalizeSettings({ proxy: 'x'.repeat(200) }).proxy, 'x'.repeat(200));
});

test('writeSettings merges, and never leaves a half-written file behind', async () => {
    await withDataDir(async (dir) => {
        const first = writeSettings(dir, { model: 'kimi-k3-max' });
        assert.equal(first.model, 'kimi-k3-max');
        assert.ok(first.updatedAt > 0, 'the write is stamped');

        const second = writeSettings(dir, { language: 'en' });
        assert.equal(second.model, 'kimi-k3-max', 'a later patch keeps the earlier fields');
        assert.equal(second.language, 'en');
        assert.equal(readSettings(dir).language, 'en');

        writeSettings(dir, { model: undefined, language: 'zh' });
        assert.equal(readSettings(dir).model, 'kimi-k3-max', 'an explicit undefined is not a value');

        assert.deepEqual(readdirSync(dir), ['settings.json'], 'the temporary file is renamed, not left behind');
        assert.equal(JSON.parse(readFileSync(settingsPath(dir), 'utf8')).language, 'zh');
    });
});

test('the panel choice beats the profile config, and an empty choice is not a choice', () => {
    assert.equal(effectiveModel({ model: 'grok-4.7-high' }, 'composer-2.5'), 'grok-4.7-high');
    assert.equal(effectiveModel({ model: '' }, 'composer-2.5'), 'composer-2.5', 'the profile config is the machine default');
    assert.equal(effectiveModel(emptySettings(), 'composer-2.5'), 'composer-2.5');
    assert.equal(effectiveModel(emptySettings(), undefined), '', 'empty means "let the CLI decide"');
    assert.equal(effectiveModel(undefined, undefined), '');
});

test('locking Auto overrides explicit named models, and unlocking restores per-call selection', () => {
    assert.deepEqual(resolveModelSelection({ model: 'auto', modelPolicy: 'panel' }, 'grok-4.7', 'composer-2.5[fast=true]'), {
        model: 'default[]', source: 'panel-lock', locked: true, requestedModel: 'composer-2.5[fast=true]',
    });
    assert.deepEqual(resolveModelSelection({ model: 'auto', modelPolicy: 'per-call' }, '', 'grok-4.7'), {
        model: 'grok-4.7', source: 'call', locked: false, requestedModel: 'grok-4.7',
    });
    assert.equal(resolveModelSelection({ model: 'default[]' }, '', '').model, 'default[]');
    assert.equal(resolveModelSelection({ model: 'auto' }, '', '  ').source, 'panel');
    assert.equal(resolveModelSelection({ model: '', modelPolicy: 'panel' }, 'auto', 'grok-4.7').source, 'config-lock');
    assert.deepEqual(resolveModelSelection({ model: '', modelPolicy: 'panel' }, '', 'grok-4.7'), {
        model: 'grok-4.7', source: 'call', locked: false, requestedModel: 'grok-4.7',
    }, 'locking an absent default must not suppress the only model choice');
    assert.deepEqual(resolveModelSelection(undefined, undefined, undefined), { model: '', source: 'cli', locked: false });
    assert.equal(resolveModelSelection({ model: 'auto' }, '', 'composer-2.5').model, 'composer-2.5', 'old settings keep per-call behavior');
});

test('the settings API persists the lock and ignores malformed policy patches', async () => {
    await withDataDir(async (dir) => {
        const { ctx, routes } = fakeContext();
        registerSettingsRoutes(ctx, cliDeps(dir, fakeSpawn({ stdout: LISTING })));
        const saved = await call(routes[0], { method: 'POST', body: JSON.stringify({ model: 'auto', modelPolicy: 'panel' }) });
        assert.equal(saved.json.settings.modelPolicy, 'panel');
        assert.equal(saved.json.effectiveModel, 'default[]');
        assert.equal(resolveModelSelection(readSettings(dir), '', 'grok-4.7').model, 'default[]');
        await call(routes[0], { method: 'POST', body: JSON.stringify({ modelPolicy: 'invalid' }) });
        assert.equal(readSettings(dir).modelPolicy, 'panel');
        await call(routes[0], { method: 'POST', body: JSON.stringify({ modelPolicy: 'per-call' }) });
        assert.equal(resolveModelSelection(readSettings(dir), '', 'grok-4.7').model, 'grok-4.7');
    });
});

/** A fake `subprocess` service: one scripted CLI run per call. */
function fakeSpawn(script) {
    const calls = [];
    const spawn = (options) => {
        calls.push(options);
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        let release;
        const done = new Promise(resolve => {
            release = resolve;
        });
        const handle = {
            stdout,
            stderr,
            stdin: { end() {} },
            done,
            terminate() {
                handle.terminated = true;
            },
        };
        const answer = typeof script === 'function' ? script(options, calls.length - 1) : script;
        queueMicrotask(() => {
            if (answer?.hang === true)
                return;
            if (answer?.stdout !== undefined)
                stdout.emit('data', Buffer.from(answer.stdout));
            if (answer?.stderr !== undefined)
                stderr.emit('data', Buffer.from(answer.stderr));
            release();
        });
        return handle;
    };
    spawn.calls = calls;
    return spawn;
}

/** Dependencies for one scripted CLI run. */
function cliDeps(dir, spawn, extra = {}) {
    return {
        spawn,
        resolved: { command: 'node.exe', entry: 'index.js', source: 'bundled' },
        // Point Cursor's config lookup at the throwaway directory: the
        // attribution switch writes a real file, and a test must never edit the
        // config of the machine it runs on.
        env: { CURSOR_CONFIG_DIR: dir },
        cwd: dir,
        dataDir: dir,
        configModel: '',
        ...extra,
    };
}

test('modelsFor fetches the listing once, then serves it from the cache', async () => {
    await withDataDir(async (dir) => {
        const spawn = fakeSpawn({ stdout: LISTING });
        const deps = cliDeps(dir, spawn);

        const cold = await modelsFor(dir, deps);
        assert.equal(cold.ok, true);
        assert.equal(cold.cached, false);
        assert.equal(cold.list.length, 8);
        assert.deepEqual(spawn.calls[0].argv, ['node.exe', 'index.js', '--list-models']);
        assert.equal(spawn.calls[0].stdio.stdout, 'pipe');

        const warm = await modelsFor(dir, deps);
        assert.equal(warm.cached, true, 'a fresh list is not re-fetched');
        assert.equal(spawn.calls.length, 1, 'the CLI is not asked twice');
        assert.equal(readSettings(dir).models.length, 8, 'the list is cached beside the settings');

        const forced = await modelsFor(dir, { ...deps, force: true });
        assert.equal(forced.cached, false);
        assert.equal(spawn.calls.length, 2, 'forcing a refresh asks the CLI again');

        writeSettings(dir, { modelsFetchedAt: Date.now() - MODEL_CACHE_MS - 1000 });
        await modelsFor(dir, deps);
        assert.equal(spawn.calls.length, 3, 'a stale list is refreshed');
    });
});

test('a failing listing keeps the last good models and reports why', async () => {
    await withDataDir(async (dir) => {
        const spawn = fakeSpawn({ stdout: LISTING });
        await modelsFor(dir, cliDeps(dir, spawn));

        const broken = fakeSpawn({ stdout: '', stderr: 'error: not logged in\n' });
        const failed = await modelsFor(dir, { ...cliDeps(dir, broken), force: true });
        assert.equal(failed.ok, false);
        assert.equal(failed.list.length, 8, 'a stale list still beats an empty picker');
        assert.match(failed.error, /not logged in/);
    });
});

test('listModels reports a CLI that answers with nothing, and one that never answers', async () => {
    await withDataDir(async (dir) => {
        const silent = fakeSpawn({ stdout: 'error: no account\nstill nothing\n' });
        const result = await modelsFor(dir, { ...cliDeps(dir, silent), force: true });
        assert.equal(result.ok, false);
        assert.match(result.error, /no account/, 'the CLI\'s own message is what the panel shows');
        assert.deepEqual(result.list, []);

        const stuck = fakeSpawn({ hang: true });
        const slow = await modelsFor(dir, { ...cliDeps(dir, stuck), force: true, timeoutMs: 25 });
        assert.equal(slow.ok, false);
        assert.match(slow.error, /did not answer within/);
    });
});

test('an unresolvable CLI is reported, not thrown at the panel', async () => {
    await withDataDir(async (dir) => {
        const result = await modelsFor(dir, { ...cliDeps(dir, fakeSpawn({ stdout: LISTING })), resolved: undefined });
        assert.equal(result.ok, false);
        assert.match(result.error, /Cursor CLI is not available/);
    });
});

/** A Cordis-shaped context whose `webServer` records the routes it is given. */
function fakeContext() {
    const routes = [];
    const warnings = [];
    const server = {
        register(route) {
            routes.push(route);
            return () => {
                route.disposed = true;
            };
        },
    };
    return {
        routes,
        warnings,
        ctx: {
            get: name => (name === 'webServer' ? server : undefined),
            logger: { warn: message => warnings.push(message) },
        },
    };
}

/** A fake Node request carrying an optional JSON body. */
function fakeRequest({ method = 'GET', url = '/plugins/dsh-cursor-dev/api/settings', body } = {}) {
    const listeners = new Map();
    const req = {
        method,
        url,
        on(event, listener) {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return req;
        },
        destroy() {
            req.destroyed = true;
        },
    };
    queueMicrotask(() => {
        if (body !== undefined)
            for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body));
        for (const listener of listeners.get('end') ?? []) listener();
    });
    return req;
}

/** A fake Node response capturing the status and body the route wrote. */
function fakeResponse() {
    return {
        headersSent: false,
        status: 0,
        body: '',
        writeHead(status) {
            this.status = status;
            this.headersSent = true;
        },
        end(text) {
            if (text !== undefined)
                this.body = String(text);
        },
    };
}

/** Call one route handler and parse its answer. */
async function call(route, request) {
    const res = fakeResponse();
    await route.handler(fakeRequest(request), res);
    return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) };
}

test('the settings API reports the state the panel needs to render', async () => {
    await withDataDir(async (dir) => {
        writeSettings(dir, { model: 'kimi-k3-max', language: 'en' });
        const { ctx, routes } = fakeContext();
        const spawn = fakeSpawn({ stdout: LISTING });
        const dispose = registerSettingsRoutes(ctx, cliDeps(dir, spawn, { configModel: 'composer-2.5' }));

        assert.equal(routes.length, 1, 'the plugin registers exactly its own settings route');
        assert.equal(routes[0].path, '/plugins/dsh-cursor-dev/api/settings');
        assert.equal(routes[0].kind, 'exact');

        const { status, json } = await call(routes[0], {});
        assert.equal(status, 200);
        assert.equal(json.ok, true);
        assert.deepEqual(json.settings, {
            model: 'kimi-k3-max',
            modelPolicy: 'per-call',
            mode: '',
            language: 'en',
            proxy: 'none',
            // Nothing saved: the panel shows the config default instead.
            maxChildDepth: '',
            attribution: 'off',
            // Nothing says otherwise, so the panel renders the ACP transport.
            transport: 'acp',
            disabledModels: [],
            updatedAt: json.settings.updatedAt,
        });
        assert.equal(json.effectiveModel, 'kimi-k3-max', 'the panel choice is what a run would use');
        assert.equal(json.effectiveMaxChildDepth, 2, 'an untouched install runs the config default');
        assert.equal(json.configModel, 'composer-2.5');
        assert.equal(json.agent.command, 'node.exe');
        assert.equal(json.models.ok, true);
        assert.equal(json.models.list.length, 8);

        dispose();
        assert.equal(routes[0].disposed, true, 'unloading the plugin releases the route');
    });
});

test('the settings API writes what the panel sends, and only that', async () => {
    await withDataDir(async (dir) => {
        const { ctx, routes } = fakeContext();
        const spawn = fakeSpawn({ stdout: LISTING });
        registerSettingsRoutes(ctx, cliDeps(dir, spawn, { configModel: 'composer-2.5' }));
        const route = routes[0];

        const saved = await call(route, { method: 'POST', body: JSON.stringify({ model: 'grok-4.7-high', language: 'en' }) });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.effectiveModel, 'grok-4.7-high');
        assert.deepEqual(readSettings(dir).model, 'grok-4.7-high');
        assert.equal(readSettings(dir).language, 'en');

        const cleared = await call(route, { method: 'POST', body: JSON.stringify({ model: '' }) });
        assert.equal(cleared.json.effectiveModel, 'composer-2.5', 'clearing the panel choice falls back to the profile config');

        const ignored = await call(route, { method: 'POST', body: JSON.stringify({ language: 'fr', mode: 'sideways' }) });
        assert.equal(ignored.status, 200);
        assert.equal(readSettings(dir).language, 'en', 'an unsupported locale is not stored');
        assert.equal(readSettings(dir).mode, '', 'an unsupported mode is not stored');

        const planned = await call(route, { method: 'POST', body: JSON.stringify({ mode: 'plan' }) });
        assert.equal(planned.json.settings.mode, 'plan');
        assert.equal(readSettings(dir).mode, 'plan');

        // A deny list is what keeps a 200-model catalogue usable for real work:
        // switching a model off only hides it from the picker.
        const denied = await call(route, {
            method: 'POST',
            body: JSON.stringify({ disabledModels: ['gpt-5.2-codex', 'auto', 'gpt-5.2-codex', ''] }),
        });
        assert.equal(denied.status, 200);
        assert.deepEqual(denied.json.settings.disabledModels, ['gpt-5.2-codex', 'default[]'],
            'duplicates drop and Auto is stored as the CLI id');
        assert.deepEqual(readSettings(dir).disabledModels, ['gpt-5.2-codex', 'default[]']);

        // The depth cap is the one number that has to survive a round trip: the
        // panel shows what it stored, and 0 is a real choice, not "unset".
        const refused = await call(route, { method: 'POST', body: JSON.stringify({ maxChildDepth: 0 }) });
        assert.equal(refused.json.settings.maxChildDepth, 0, 'zero is stored, not confused with "follow the config"');
        assert.equal(refused.json.effectiveMaxChildDepth, 0);
        const topOnly = await call(route, { method: 'POST', body: JSON.stringify({ maxChildDepth: 1 }) });
        assert.equal(topOnly.json.effectiveMaxChildDepth, 1);
        const nonsense = await call(route, { method: 'POST', body: JSON.stringify({ maxChildDepth: 9 }) });
        assert.equal(nonsense.json.settings.maxChildDepth, '',
            'a value the panel cannot offer is dropped, so the config default takes over');
        assert.equal(nonsense.json.effectiveMaxChildDepth, 2);

        // Attribution is a two-part answer: the choice stored here, and what
        // Cursor's own file says. Saving the choice has to write that file now,
        // because nothing else would until the next spawn.
        assert.equal(readSettings(dir).attribution, 'off', 'off is the default');
        const credited = await call(route, { method: 'POST', body: JSON.stringify({ attribution: 'on' }) });
        assert.equal(credited.json.settings.attribution, 'on');
        assert.equal(credited.json.attribution.attribution.attributeCommitsToAgent, true,
            'the answer reports the file, not the intent');
        const followed = await call(route, { method: 'POST', body: JSON.stringify({ attribution: 'keep' }) });
        assert.equal(followed.json.settings.attribution, 'keep');
        assert.equal(followed.json.attribution.attribution.attributeCommitsToAgent, true,
            'keep leaves the file exactly as it was');
        const typo = await call(route, { method: 'POST', body: JSON.stringify({ attribution: 'yes' }) });
        assert.equal(typo.json.settings.attribution, 'keep',
            'a word the panel never offers must not silently disable attribution');

        const noBody = await call(route, { method: 'POST' });
        assert.equal(noBody.status, 200, 'an empty body is a read, not an error');
    });
});

test('saving a proxy re-resolves it for the next spawn, not the next restart', async () => {
    await withDataDir(async (dir) => {
        const { ctx, routes } = fakeContext();
        const spawn = fakeSpawn({ stdout: LISTING });
        const refreshes = [];
        registerSettingsRoutes(ctx, cliDeps(dir, spawn, {
            refreshProxy: async () => { refreshes.push(readSettings(dir).proxy); return 'http://127.0.0.1:7890 (setting)'; },
            proxyRoute: () => 'http://127.0.0.1:7890 (setting)',
            proxyError: () => '',
        }));
        const route = routes[0];

        const saved = await call(route, { method: 'POST', body: JSON.stringify({ model: 'auto', proxy: 'http://127.0.0.1:7890' }) });
        assert.equal(saved.status, 200);
        assert.equal(readSettings(dir).proxy, 'http://127.0.0.1:7890', 'the proxy lives beside the model choice');
        assert.deepEqual(refreshes, ['http://127.0.0.1:7890'], 'the child environment is rebuilt on save');
        assert.equal(saved.json.proxy.configured, 'http://127.0.0.1:7890');
        assert.equal(saved.json.proxy.route, 'http://127.0.0.1:7890 (setting)', 'the panel is told which route results');

        // A save that does not touch the proxy must not rebuild the child env.
        await call(route, { method: 'POST', body: JSON.stringify({ model: 'composer-2.5' }) });
        assert.equal(refreshes.length, 1);

        // …and an unusable value is stored verbatim while the host explains it.
        const broken = await call(route, { method: 'POST', body: JSON.stringify({ proxy: 'not a proxy' }) });
        assert.equal(broken.json.settings.proxy, 'not a proxy');
        assert.deepEqual(refreshes, ['http://127.0.0.1:7890', 'not a proxy']);
    });
});

test('the settings API refuses what it cannot do', async () => {
    await withDataDir(async (dir) => {
        const { ctx, routes, warnings } = fakeContext();
        registerSettingsRoutes(ctx, cliDeps(dir, fakeSpawn({ stdout: LISTING })));
        const route = routes[0];

        const wrongMethod = await call(route, { method: 'DELETE' });
        assert.equal(wrongMethod.status, 405);
        assert.match(wrongMethod.json.error, /DELETE/);

        const badBody = await call(route, { method: 'POST', body: '{ not json' });
        assert.equal(badBody.status, 400);
        assert.match(badBody.json.error, /not JSON/);

        const forced = await call(route, { method: 'POST', url: '/plugins/dsh-cursor-dev/api/settings', body: JSON.stringify({ refreshModels: true }) });
        assert.equal(forced.json.models.ok, true);
        assert.equal(forced.json.models.cached, false, 'refreshModels asks the CLI again');
        assert.deepEqual(warnings, []);
    });
});

test('without a web server the plugin still loads', () => {
    const ctx = { get: () => undefined };
    assert.equal(registerSettingsRoutes(ctx, {}), undefined);
});

test('the ACP roster is the only list the panel offers', async () => {
    await withDataDir(async (dir) => {
        const spawn = fakeSpawn({ stdout: LISTING });
        const probeModelRoster = async () => ({
            ok: true,
            list: [
                { id: 'default[]', name: 'Auto', current: true, isDefault: true },
                { id: 'composer-2.5[fast=true]', name: 'Composer 2.5', current: false, isDefault: false },
            ],
        });

        const answered = await modelsFor(dir, { ...cliDeps(dir, spawn), probeModelRoster });
        assert.equal(answered.ok, true);
        assert.equal(answered.source, 'acp', 'the ids the panel offers are the ones a switch accepts');
        assert.equal(answered.list[0].current, true);
        // Exactly what the roster published, in its order, and nothing else. The
        // CLI aliases are deliberately NOT merged in: the roster is region-scoped
        // (an HK or mainland egress has no Claude entries), and
        // `session/set_config_option` accepts no id outside it — offering a tier
        // every switch rejects is worse than not offering it.
        assert.deepEqual(answered.list.map(entry => entry.id), ['default[]', 'composer-2.5[fast=true]']);
        assert.equal(spawn.calls.length, 0, 'the alias listing is not consulted at all');

        // The cache remembers which source answered, not just the entries.
        assert.equal(readSettings(dir).modelsSource, 'acp');
        const warm = await modelsFor(dir, { ...cliDeps(dir, spawn), probeModelRoster });
        assert.equal(warm.cached, true);
        assert.equal(warm.source, 'acp', 'a cached roster still says it is a roster');
    });
});

test('a probe that cannot answer falls back to the listing and keeps the good list on total failure', async () => {
    await withDataDir(async (dir) => {
        const spawn = fakeSpawn({ stdout: LISTING });
        const failing = async () => ({ ok: false, error: 'probe exploded' });

        const listed = await modelsFor(dir, { ...cliDeps(dir, spawn), probeModelRoster: failing });
        assert.equal(listed.ok, true);
        assert.equal(listed.source, 'cli', 'the alias listing is the only source left');
        assert.equal(listed.list.length, 8);
        assert.equal(readSettings(dir).modelsSource, 'cli');

        const emptyProbe = async () => ({ ok: true, list: [] });
        const broken = await modelsFor(dir, {
            ...cliDeps(dir, fakeSpawn({ stdout: '', stderr: 'error: not logged in\n' })),
            probeModelRoster: emptyProbe,
            force: true,
        });
        assert.equal(broken.ok, false);
        assert.match(broken.error, /not logged in/);
        assert.match(broken.probeError, /nothing/, 'the probe\'s own reason is reported beside the listing failure');
        assert.equal(broken.list.length, 8, 'a probe that answers nothing must not wipe a good list');
        assert.equal(readSettings(dir).models.length, 8, 'and it must not be written to disk either');
    });
});

test('a settings file the operator hand-edited survives a round trip', async () => {
    await withDataDir(async (dir) => {
        writeFileSync(settingsPath(dir), `${JSON.stringify({ model: 'glm-5.2-max', mode: 'ask' }, null, 4)}\n`, 'utf8');
        const settings = readSettings(dir);
        assert.equal(settings.model, 'glm-5.2-max');
        assert.equal(settings.mode, 'ask');
        assert.equal(settings.language, '', 'an absent field means "follow the app"');

        const stored = writeSettings(dir, { language: 'zh' });
        assert.equal(stored.model, 'glm-5.2-max', 'a panel write keeps what the operator typed');
        assert.equal(existsSync(`${settingsPath(dir)}.tmp`), false);
    });
});
