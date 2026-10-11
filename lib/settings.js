/**
 * Settings the user changes from the panel rather than from YAML.
 *
 * Two things a coding agent's operator keeps wanting to change without editing
 * a profile file and reloading: **which model the child runs on**, and **what
 * language the panel speaks**. Both live in one small JSON file in the plugin's
 * data directory, next to the conversation index, because the profile config
 * belongs to the profile: asking a user to hand-edit `cordis.patch.yml` and
 * restart the app to switch from Composer to Grok is exactly the kind of
 * friction that made the stock ACP provider unusable.
 *
 * The same file caches the model list the CLI reports, so the panel can show a
 * picker instantly instead of waiting on the network every time it opens.
 *
 * @module dsh-cursor-dev/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** File name inside the plugin data directory. */
const FILE = 'settings.json';

/** How long a model list stays fresh. */
export const MODEL_CACHE_MS = 10 * 60 * 1000;

/** Largest settings body accepted from the panel. */
const MAX_BODY_BYTES = 32 * 1024;

/** Largest model listing accepted from the CLI. */
const MAX_LIST_BYTES = 512 * 1024;

/** How long `--list-models` may take before it is killed. */
const LIST_TIMEOUT_MS = 30_000;

/** Locales the panel ships copy for. */
const LANGUAGES = new Set(['zh', 'en']);

/** Modes a Cursor session can run in (`agent` is the default). */
const MODES = new Set(['agent', 'plan', 'ask']);

/** Absolute path of the settings file. */
export function settingsPath(dataDir) {
    return join(dataDir, FILE);
}

/** The settings a fresh install runs with. */
export function emptySettings() {
    return {
        version: 1,
        model: '',
        mode: '',
        language: '',
        updatedAt: 0,
        modelsFetchedAt: 0,
        models: [],
    };
}

/**
 * Coerce anything read off disk (or sent by a client) into the settings shape.
 *
 * Every field is optional and every wrong type falls back to "not set", because
 * this file is edited by hand as often as by the panel and a typo must not take
 * the dashboard down.
 *
 * @param raw - parsed JSON or a patch.
 */
export function normalizeSettings(raw) {
    const value = raw !== null && typeof raw === 'object' ? raw : {};
    const models = Array.isArray(value.models) ? value.models.filter(isModelEntry) : [];
    return {
        version: 1,
        model: stringOrUndefined(value.model) ?? '',
        mode: MODES.has(value.mode) ? value.mode : '',
        language: LANGUAGES.has(value.language) ? value.language : '',
        updatedAt: numberOrUndefined(value.updatedAt) ?? 0,
        modelsFetchedAt: numberOrUndefined(value.modelsFetchedAt) ?? 0,
        models,
    };
}

/**
 * Read the settings file.
 *
 * A corrupt or unreadable file yields the defaults rather than throwing: the
 * panel's job is to show state, and a settings read happens on the way to every
 * page load.
 *
 * @param dataDir - plugin data directory.
 */
export function readSettings(dataDir) {
    try {
        const path = settingsPath(dataDir);
        if (!existsSync(path))
            return emptySettings();
        return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')));
    }
    catch {
        return emptySettings();
    }
}

/**
 * Merge a patch into the settings file and return the stored result.
 *
 * Written through a temporary file and a rename so a reader (the panel polls
 * this) can never observe a half-written file.
 *
 * @param dataDir - plugin data directory.
 * @param patch - fields to change; `undefined` values are ignored.
 */
export function writeSettings(dataDir, patch) {
    const current = readSettings(dataDir);
    const clean = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value !== undefined)
            clean[key] = value;
    }
    const next = normalizeSettings({ ...current, ...clean, updatedAt: Date.now() });
    mkdirSync(dataDir, { recursive: true });
    const path = settingsPath(dataDir);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
    return next;
}

/**
 * Which model a run uses when the tool call does not name one.
 *
 * The order is deliberate: the panel's choice beats the profile's config,
 * because the profile is the machine's default and the panel is the operator's
 * current intent. An empty result means "let the CLI decide", which is what
 * `auto` does.
 *
 * @param settings - result of `readSettings`.
 * @param configModel - `model` from the plugin config.
 */
export function effectiveModel(settings, configModel) {
    return stringOrUndefined(settings?.model) ?? stringOrUndefined(configModel) ?? '';
}

/**
 * Parse `agent --list-models`.
 *
 * The CLI prints one `id - Display name` per line, marks the active one, and
 * follows the list with a tip that is not a model. Display names carry
 * zero-width characters (the upstream list is copy-pasted from a table), so
 * they are stripped here rather than showing up in the picker.
 *
 * @param stdout - raw command output.
 */
export function parseModelList(stdout) {
    const models = [];
    const seen = new Set();
    for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
        const line = stripInvisible(rawLine).trim();
        if (line === '' || line.startsWith('Tip:') || line.startsWith('Available models'))
            continue;
        const split = line.indexOf(' - ');
        if (split <= 0)
            continue;
        const id = line.slice(0, split).trim();
        if (!/^[a-z0-9][a-z0-9._\-[\]=,]*$/i.test(id) || seen.has(id))
            continue;
        let name = line.slice(split + 3).trim();
        let current = false;
        let isDefault = false;
        const marked = /\(([^()]*)\)\s*$/.exec(name);
        if (marked !== null && /\b(current|default)\b/.test(marked[1])) {
            current = /\bcurrent\b/.test(marked[1]);
            isDefault = /\bdefault\b/.test(marked[1]);
            name = name.slice(0, marked.index).trim();
        }
        seen.add(id);
        models.push({ id, name: name === '' ? id : name, current, isDefault });
    }
    return models;
}

/**
 * Ask the CLI which models the account can use.
 *
 * @param deps - `spawn`, resolved agent, cwd, env.
 */
export async function listModels(deps) {
    const result = await runOnce({ ...deps, tail: ['--list-models'] });
    const models = parseModelList(result.stdout);
    if (models.length === 0) {
        const detail = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
        throw new Error(detail === '' ? 'the CLI listed no models' : detail);
    }
    return models;
}

/**
 * Read the model list, refreshing the cache when it is stale or forced.
 *
 * @param dataDir - plugin data directory.
 * @param deps - spawn/agent dependencies, plus `force`.
 */
export async function modelsFor(dataDir, deps) {
    const settings = readSettings(dataDir);
    const age = Date.now() - settings.modelsFetchedAt;
    if (deps.force !== true && settings.models.length > 0 && (settings.modelsFetchedAt > 0 && age < MODEL_CACHE_MS))
        return { ok: true, list: settings.models, fetchedAt: settings.modelsFetchedAt, cached: true };
    try {
        const list = await listModels(deps);
        const stored = writeSettings(dataDir, { models: list, modelsFetchedAt: Date.now() });
        return { ok: true, list: stored.models, fetchedAt: stored.modelsFetchedAt, cached: false };
    }
    catch (error) {
        // A stale list still beats an empty picker: report the failure beside it.
        return {
            ok: false,
            list: settings.models,
            fetchedAt: settings.modelsFetchedAt,
            cached: true,
            error: errorText(error),
        };
    }
}

/**
 * Register the settings API the panel reads and writes.
 *
 * @param ctx - Cordis context.
 * @param deps - data dir, spawn/agent dependencies, config model.
 */
export function registerSettingsRoutes(ctx, deps) {
    const registrations = [];
    const server = ctx.get?.('webServer');
    if (server === undefined)
        return undefined;

    const payload = async (force, justRefreshed = false) => {
        const settings = readSettings(deps.dataDir);
        const models = await modelsFor(deps.dataDir, { ...deps, force });
        // A refresh asked for by this very request is not answered from the
        // cache it just filled: the panel says "just refreshed" only when the
        // list was really fetched for it.
        if (justRefreshed === true && models.ok === true)
            models.cached = false;
        return {
            ok: true,
            settings: {
                model: settings.model,
                mode: settings.mode,
                language: settings.language,
                updatedAt: settings.updatedAt,
            },
            effectiveModel: effectiveModel(settings, deps.configModel),
            configModel: deps.configModel ?? '',
            agent: deps.resolved === undefined ? null : { command: deps.resolved.command, source: deps.resolved.source },
            models,
        };
    };

    const settingsRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/api/settings',
        handler: async (req, res) => {
            const method = String(req?.method ?? 'GET').toUpperCase();
            const url = new URL(req?.url ?? '/', 'http://localhost');
            if (method === 'GET') {
                sendJson(res, 200, await payload(url.searchParams.get('refreshModels') === '1'));
                return;
            }
            if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: `method ${method} is not supported` });
                return;
            }
            let body;
            try {
                body = await readJsonBody(req);
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: errorText(error) });
                return;
            }
            let refreshed = false;
            if (body !== null && typeof body === 'object' && typeof body.refreshModels === 'boolean' && body.refreshModels) {
                await modelsFor(deps.dataDir, { ...deps, force: true });
                refreshed = true;
            }
            const patch = {};
            if (typeof body?.model === 'string')
                patch.model = body.model.trim();
            if (typeof body?.language === 'string' && LANGUAGES.has(body.language))
                patch.language = body.language;
            if (typeof body?.mode === 'string' && (body.mode === '' || MODES.has(body.mode)))
                patch.mode = body.mode;
            if (Object.keys(patch).length > 0)
                writeSettings(deps.dataDir, patch);
            sendJson(res, 200, await payload(false, refreshed));
        },
    };

    const guard = (path, handler) => async (req, res) => {
        try {
            await handler(req, res);
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-cursor-dev: ${path} failed: ${errorText(error)}`);
            try {
                if (res.headersSent === true)
                    res.end();
                else
                    sendJson(res, 500, { ok: false, error: errorText(error) });
            }
            catch {
                // The socket is already gone; nothing left to answer.
            }
        }
    };

    for (const route of [settingsRoute]) {
        try {
            registrations.push(server.register({ ...route, handler: guard(route.path, route.handler) }));
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-cursor-dev: settings route ${route.path} unavailable: ${errorText(error)}`);
        }
    }

    return () => {
        for (const dispose of registrations) {
            try {
                dispose();
            }
            catch {
                // Unloading is best-effort.
            }
        }
    };
}

/**
 * Run one short-lived CLI command and collect its output.
 *
 * The ACP session owns a long-lived child; this is for the one-shot queries
 * (`--list-models`) that answer a question and exit. stdin is closed
 * immediately so a CLI that waits on input cannot hang the panel, and the
 * process is terminated when the deadline passes.
 *
 * @param deps - `spawn`, resolved agent, cwd, env, argv tail, timeout.
 */
async function runOnce(deps) {
    const { spawn, resolved, tail } = deps;
    if (spawn === undefined || resolved === undefined)
        throw new Error('the Cursor CLI is not available');
    const argv = [resolved.command, ...(resolved.entry === undefined ? [] : [resolved.entry]), ...tail];
    const handle = spawn({
        argv,
        cwd: deps.cwd,
        env: deps.env,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 2000,
    });
    let stdout = '';
    let stderr = '';
    handle.stdout?.on('data', (chunk) => {
        if (stdout.length < MAX_LIST_BYTES)
            stdout += String(chunk);
    });
    handle.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_LIST_BYTES)
            stderr += String(chunk);
    });
    try {
        handle.stdin?.end();
    }
    catch {
        // A CLI that already exited has nothing to close.
    }

    const timeoutMs = deps.timeoutMs ?? LIST_TIMEOUT_MS;
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the CLI did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        timer.unref?.();
    });
    try {
        await Promise.race([Promise.resolve(handle.done).catch(() => undefined), deadline]);
    }
    catch (error) {
        try {
            handle.terminate?.();
        }
        catch {
            // Already gone.
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
    return { stdout, stderr };
}

/**
 * Read a JSON request body with a size cap.
 *
 * @param req - Node request.
 */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
                req.destroy?.();
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text === '') {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(text));
            }
            catch (error) {
                reject(new Error(`body is not JSON: ${errorText(error)}`));
            }
        });
    });
}

/** Write a JSON response. */
function sendJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body, null, 2));
}

/** Strip zero-width characters a copy-pasted CLI table carries. */
function stripInvisible(value) {
    return String(value).replace(/[\u200b-\u200f\ufeff]/g, '');
}

/** Coerce a string, else undefined. */
function stringOrUndefined(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Coerce a finite number, else undefined. */
function numberOrUndefined(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && value !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** Whether one cached model entry is usable. */
function isModelEntry(value) {
    return value !== null
        && typeof value === 'object'
        && typeof value.id === 'string'
        && value.id !== ''
        && typeof value.name === 'string';
}

/** Render an unknown thrown value as text. */
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
