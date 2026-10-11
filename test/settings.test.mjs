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
        env: {},
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
        assert.deepEqual(json.settings, { model: 'kimi-k3-max', mode: '', language: 'en', updatedAt: json.settings.updatedAt });
        assert.equal(json.effectiveModel, 'kimi-k3-max', 'the panel choice is what a run would use');
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

        const noBody = await call(route, { method: 'POST' });
        assert.equal(noBody.status, 200, 'an empty body is a read, not an error');
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
