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
 * The same file caches the model list the panel shows, so the picker opens
 * instantly instead of waiting on the CLI every time. There are two name spaces
 * for a model and only one of them can be switched to, so the cache records
 * which source answered: the ACP session roster (`default[]`,
 * `composer-2.5[fast=true]` — the ids `session/set_config_option` accepts) is
 * preferred, and the CLI's own `--list-models` listing is only a fallback for a
 * build that cannot be probed. `source` in the cache and in every `modelsFor`
 * result says which one the panel is looking at, because an alias list and a
 * roster look nothing alike and silently mixing them is what broke switching.
 *
 * @module dsh-cursor-dev/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAttribution, readAttribution } from './attribution.js';
import { runOnce } from './cli.js';
import { normalizeModelId } from './models.js';

/** File name inside the plugin data directory. */
const FILE = 'settings.json';

/**
 * How long a model list stays fresh before it is re-read from the service.
 *
 * The ACP roster is region-dependent: the models an account may use are decided
 * by the network egress, so a proxy in Hong Kong or the mainland simply has no
 * Claude entries while another route does. A long cache would therefore pin a
 * list that the service has already changed — and the panel would keep offering
 * a model a switch rejects, or hide one that just appeared. The window is short
 * on purpose; an explicit refresh still bypasses it entirely.
 */
export const MODEL_CACHE_MS = 60 * 1000;

/** Largest settings body accepted from the panel. */
const MAX_BODY_BYTES = 32 * 1024;

/** Locales the panel ships copy for. */
const LANGUAGES = new Set(['zh', 'en']);

/** Model list sources the cache can have come from. */
const MODEL_SOURCES = new Set(['acp', 'cli']);

/** Modes a Cursor session can run in (`agent` is the default). */
const MODES = new Set(['agent', 'plan', 'ask']);

/** The transports that can launch the child; anything else reads as `acp`. */
const TRANSPORTS = new Set(['acp', 'cli']);

/**
 * What the panel may say about Cursor's commit attribution.
 *
 * `keep` exists so that an operator who sets attribution in Cursor itself can
 * stop this plugin from rewriting that file — the flag lives in Cursor's config,
 * not ours, and a plugin that always wrote it would fight the owner.
 */
const ATTRIBUTIONS = new Set(['off', 'on', 'keep']);

/** Absolute path of the settings file. */
export function settingsPath(dataDir) {
    return join(dataDir, FILE);
}

/** The settings a fresh install runs with. */
export function emptySettings() {
    return {
        version: 1,
        model: '',
        modelPolicy: 'per-call',
        mode: '',
        language: '',
        proxy: 'none',
        // How deep in the delegation chain a Cursor child may still be started.
        // `''` means "not chosen here, use the plugin config" — the panel writes
        // a number, a hand-edited file can leave it out entirely.
        maxChildDepth: '',
        // Whether commits the child makes carry a `Co-authored-by: Cursor`
        // trailer. The switch itself lives in Cursor's own config file, which
        // this plugin writes on the operator's behalf — see `attribution.js`.
        // `off` is the default because these runs are unattended and nobody
        // reading the repository later agreed to have Cursor credited in it.
        attribution: 'off',
        // Which transport launches the child: `acp` (default) or `cli`.
        //
        // ACP keeps a live session and can switch models inside it, but Cursor
        // pins one parameter set per model there and rejects every other spelling
        // character by character, so a tier such as grok-4.7 without `fast` is
        // unreachable. `cli` runs one `agent -p` process per turn, takes the CLI
        // alias that really selects the tier, and feeds the same event vocabulary
        // so its runs still appear as child conversations in the panel.
        transport: 'acp',
        // Models the operator switched off in the picker. A DENY list, not an
        // allow list, so a catalogue that gains entries keeps showing them: an
        // empty list means "everything the CLI knows about" and a fresh install
        // (or one upgrading from before this setting) hides nothing.
        disabledModels: [],
        updatedAt: 0,
        modelsFetchedAt: 0,
        models: [],
        modelsSource: '',
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
        modelPolicy: value.modelPolicy === 'panel' ? 'panel' : 'per-call',
        mode: MODES.has(value.mode) ? value.mode : '',
        language: LANGUAGES.has(value.language) ? value.language : '',
        proxy: proxySetting(value.proxy),
        maxChildDepth: depthSetting(value.maxChildDepth),
        attribution: ATTRIBUTIONS.has(value.attribution) ? value.attribution : 'off',
        transport: TRANSPORTS.has(value.transport) ? value.transport : 'acp',
        disabledModels: modelIdList(value.disabledModels),
        updatedAt: numberOrUndefined(value.updatedAt) ?? 0,
        modelsFetchedAt: numberOrUndefined(value.modelsFetchedAt) ?? 0,
        models,
        // A cache written before sources were recorded says nothing about where
        // its ids came from; `''` means exactly that, not "no list".
        modelsSource: MODEL_SOURCES.has(value.modelsSource) ? value.modelsSource : '',
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
 * current intent. The result is normalized into the name space
 * `session/set_config_option` speaks, so a panel choice of `auto` reaches a run
 * as `default[]` — the id the ACP roster publishes — instead of as an alias the
 * CLI rejects with `-32602 Invalid params: Invalid model value: auto`.
 *
 * An empty result still means "let the CLI decide": nothing was configured at
 * all, which is not the same statement as "the operator picked Auto".
 *
 * @param settings - result of `readSettings`.
 * @param configModel - `model` from the plugin config.
 */
export function effectiveModel(settings, configModel) {
    const chosen = modelChoice(settings?.model) ?? modelChoice(configModel);
    return chosen === undefined ? '' : normalizeModelId(chosen);
}

/**
 * Resolve one run's model. A panel lock is an operator choice that applies to
 * every call; otherwise an explicit call retains the existing override behavior.
 * Auto is an explicit choice (`default[]`), distinct from an unset CLI default.
 */
export function resolveModelSelection(settings, configModel, requestedModel) {
    const requested = modelChoice(requestedModel);
    const panel = modelChoice(settings?.model);
    const configured = modelChoice(configModel);
    const baseline = panel ?? configured;
    const locked = settings?.modelPolicy === 'panel' && baseline !== undefined;
    const selected = locked ? baseline : (requested ?? baseline);
    return {
        model: selected === undefined ? '' : normalizeModelId(selected),
        source: locked ? (panel !== undefined ? 'panel-lock' : 'config-lock')
            : requested !== undefined ? 'call'
                : panel !== undefined ? 'panel' : configured !== undefined ? 'config' : 'cli',
        locked,
        ...(requested === undefined ? {} : { requestedModel: requested }),
    };
}

function modelChoice(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolve the depth cap in force for the next call.
 *
 * The panel choice wins over the config default, the same way the panel model
 * wins over `config.model`: an operator who clicked something expects the click
 * to be what runs. A settings value that is absent hands control back to the
 * config, so a fresh install runs on whatever the profile says.
 *
 * @param settings - result of `readSettings`.
 * @param configDepth - `maxChildDepth` from the plugin config.
 */
export function effectiveMaxChildDepth(settings, configDepth) {
    const chosen = depthSetting(settings?.maxChildDepth);
    if (chosen !== '') return chosen;
    return typeof configDepth === 'number' && Number.isSafeInteger(configDepth) && configDepth >= 0
        ? configDepth
        : MAX_DEPTH_CHOICE;
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
 * Read the model list the panel should show.
 *
 * The ACP session roster is preferred because it is the ONLY list
 * `session/set_config_option` accepts; the CLI's `--list-models` listing is a
 * fallback for the case where a probe cannot answer (no CLI, a signed-out
 * account, a build without `configOptions`). The result always names the source
 * that answered, so the panel can say what the ids it renders actually are
 * instead of implying two name spaces are one.
 *
 * @param dataDir - plugin data directory.
 * @param deps - spawn/agent dependencies, `probeModelRoster` (optional), `force`.
 * @returns `{ok, list, source, fetchedAt, cached, error?}` where `source` is
 *   `'acp'`, `'cli'`, `'cache'` (an old record that never said) or `'none'`.
 */
export async function modelsFor(dataDir, deps) {
    const settings = readSettings(dataDir);
    const age = Date.now() - settings.modelsFetchedAt;
    if (deps.force !== true && settings.models.length > 0 && (settings.modelsFetchedAt > 0 && age < MODEL_CACHE_MS))
        return { ok: true, list: settings.models, source: settings.modelsSource ?? 'cache', fetchedAt: settings.modelsFetchedAt, cached: true };

    const probed = await probeRoster(deps);
    // Only a probe that really produced a roster may answer for the panel. A
    // probe that failed (or answered with an empty list) must fall through to
    // the listing — otherwise a broken probe would look exactly like an account
    // that offers no models, and the picker would come up empty.
    if (probed?.list !== undefined) {
        // The ACP roster is the ONLY source this panel offers now.
        //
        // It is the live answer: the service publishes the models this network
        // egress is allowed to use, so an account behind a Hong Kong or mainland
        // proxy simply has no Claude entries, and one routed elsewhere does. A
        // static list would be wrong for every one of those cases.
        //
        // It also publishes exactly one tier per model
        // (deepseek-v41-flash-1017[reasoning_effort=high]), and
        // `session/set_config_option` accepts nothing outside it — measured, four
        // entry points, all `Invalid params` for the aliases the CLI lists. So
        // those aliases are NOT merged in: offering a tier that every switch
        // attempt rejects is worse than not offering it.
        const list = probed.list;
        const stored = writeSettings(dataDir, { models: list, modelsFetchedAt: Date.now(), modelsSource: 'acp' });
        return { ok: true, list: stored.models, source: 'acp', fetchedAt: stored.modelsFetchedAt, cached: false };
    }

    try {
        const list = await listModels(deps);
        const stored = writeSettings(dataDir, { models: list, modelsFetchedAt: Date.now(), modelsSource: 'cli' });
        // The listing answered, but if the PREFERRED source (the ACP roster) had
        // been skipped, say so: the panel can then explain why it is showing
        // aliases instead of session ids, which are not the same thing.
        return {
            ok: true,
            list: stored.models,
            source: 'cli',
            fetchedAt: stored.modelsFetchedAt,
            cached: false,
            ...(probed?.error === undefined ? {} : { probeError: probed.error }),
        };
    }
    catch (error) {
        // A stale list still beats an empty picker: report the failure beside it,
        // together with the probe's reason (which is the one that matters when
        // the roster was the point of asking).
        return {
            ok: false,
            list: settings.models,
            source: settings.modelsSource ?? 'none',
            fetchedAt: settings.modelsFetchedAt,
            cached: true,
            error: errorText(error),
            ...(probed === undefined ? {} : { probeError: probed.error }),
        };
    }
}

/**
 * Ask the pool for the ACP roster, if a probe was wired in.
 *
 * @param deps - dependencies, optionally carrying `probeModelRoster`.
 * @returns `{list}` on success, `{error}` on a failed probe, or `undefined`
 *   when no probe is available at all (which is not a failure — it just means
 *   the CLI listing is the only source this deployment has).
 */
async function probeRoster(deps) {
    if (typeof deps?.probeModelRoster !== 'function')
        return undefined;
    try {
        const result = await deps.probeModelRoster();
        const list = result !== null && typeof result === 'object' ? result.list : undefined;
        // A probe that answers "not ok" or with an empty list is a FAILED probe,
        // not a successful empty answer: it must fall through to the listing,
        // never be merged as if it were a roster.
        if (result?.ok === true && Array.isArray(list) && list.length > 0)
            return { list };
        return { error: result?.error ?? 'the model probe answered nothing' };
    }
    catch (error) {
        return { error: errorText(error) };
    }
}

/**
 * Merge a preferred list with entries only the other source knows.
 *
 * The preferred (`source`) list keeps its order and its `current`/`isDefault`
 * facts; an extra entry is added only when neither list already names its model.
 * Entries are matched on their model id, which is what a switch is asked for, so
 * a roster id that differs from an alias of the same model is kept once per id.
 *
 * @param preferred - entries from the source that answered first.
 * @param extra - entries from the cache, used to fill gaps.
 */
function mergeListing(preferred, extra) {
    // Each entry carries where it came from: the roster is the list Cursor
    // itself answered with, and anything only the cache or the CLI listing knows
    // about is an id this host cannot necessarily switch to. The browser groups
    // by that.
    const list = (Array.isArray(preferred) ? preferred : []).map(entry => ({ ...entry, source: 'acp' }));
    const seen = new Set(list.map(entry => entry.id));
    // `extra` is the cache or the CLI aliases, and either is allowed to be
    // missing or corrupt; the preferred list is the one that must survive.
    for (const entry of Array.isArray(extra) ? extra : []) {
        if (seen.has(entry.id))
            continue;
        seen.add(entry.id);
        list.push({ ...entry, source: entry.source === 'acp' ? 'acp' : 'cache' });
    }
    return list;
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
                modelPolicy: settings.modelPolicy,
                mode: settings.mode,
                language: settings.language,
                proxy: settings.proxy,
                maxChildDepth: settings.maxChildDepth,
                attribution: settings.attribution,
                transport: settings.transport,
                disabledModels: settings.disabledModels,
                updatedAt: settings.updatedAt,
            },
            // What the `proxy` setting resolves to right now, so the panel can
            // show the route a child would actually take instead of just echoing
            // the box the operator typed in.
            proxy: {
                configured: settings.proxy,
                route: typeof deps.proxyRoute === 'function' ? deps.proxyRoute() : '',
                error: typeof deps.proxyError === 'function' ? deps.proxyError() : '',
            },
            effectiveModel: effectiveModel(settings, deps.configModel),
            configModel: deps.configModel ?? '',
            // The number the next call will enforce, so the picker shows the cap
            // in force rather than the value this file happens to hold.
            effectiveMaxChildDepth: effectiveMaxChildDepth(settings, deps.maxChildDepth),
            configMaxChildDepth: deps.maxChildDepth ?? '',
            // What Cursor's own config file says right now. The panel needs this
            // to tell "asked for off" apart from "off is actually in effect":
            // the flag lives in a file this plugin does not own, and a failed
            // write has to be visible instead of looking like success.
            attribution: { choice: settings.attribution, ...readAttribution(deps.env) },
            agent: deps.resolved === undefined ? null : { command: deps.resolved.command, source: deps.resolved.source },
            models: { ...models, source: models.source ?? 'none' },
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
            if (body?.modelPolicy === 'panel' || body?.modelPolicy === 'per-call')
                patch.modelPolicy = body.modelPolicy;
            if (typeof body?.language === 'string' && LANGUAGES.has(body.language))
                patch.language = body.language;
            if (typeof body?.mode === 'string' && (body.mode === '' || MODES.has(body.mode)))
                patch.mode = body.mode;
            if (typeof body?.proxy === 'string')
                patch.proxy = body.proxy;
            // Refuse a word the panel never offers: the normalizer would fall
            // back to `acp`, silently undoing a change the operator asked for.
            if (typeof body?.transport === 'string' && TRANSPORTS.has(body.transport))
                patch.transport = body.transport;
            // A depth outside 0..2 is refused by normalizeSettings, which stores
            // `''` and hands control back to the config — a number the panel
            // never offers must not become a cap this plugin enforces.
            if (body?.maxChildDepth !== undefined)
                patch.maxChildDepth = body.maxChildDepth;
            // Refuse a word the panel never offers instead of storing it: the
            // normalizer would fall back to `off`, which would silently disable
            // Cursor attribution because of a typo.
            if (typeof body?.attribution === 'string' && ATTRIBUTIONS.has(body.attribution))
                patch.attribution = body.attribution;
            if (Array.isArray(body?.disabledModels))
                patch.disabledModels = body.disabledModels;
            if (Object.keys(patch).length > 0) {
                const saved = writeSettings(deps.dataDir, patch);
                // The attribution switch is not stored here — it lives in
                // Cursor's own config file — so saving has to write it now.
                // Otherwise the answer below would report a choice that is not
                // yet true and would only take effect on some later spawn.
                if (patch.attribution !== undefined) {
                    const applied = applyAttribution(saved.attribution, { env: deps.env });
                    if (applied.error !== undefined)
                        ctx.logger?.warn?.(`dsh-cursor-dev: could not update Cursor attribution in ${applied.path}: ${applied.error}`);
                }
            }
            // Re-resolve before answering: the payload reports the route a child
            // would take, and it has to describe the proxy that was just saved,
            // not the one that was in force a moment ago.
            if (patch.proxy !== undefined && typeof deps.refreshProxy === 'function')
                await deps.refreshProxy();
            // A transport change must reach the pool before the next run.
            if (patch.transport !== undefined && typeof deps.refreshTransport === 'function')
                deps.refreshTransport(patch.transport);
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
            registrations.push(server.register({
                ...route,
                // This route is writable (it changes the child's model, the mode
                // and the panel language) and it is served outside the host's own
                // `/api` carrier, so the host's Host/Origin fence never sees it.
                // Without this gate any page on any origin could POST here and
                // rewrite the operator's settings.
                handler: guard(route.path, (req, res) => {
                    if (deps.fence !== undefined && deps.fence(req, res) !== true)
                        return undefined;
                    return route.handler(req, res);
                }),
            }));
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

/** Longest proxy value accepted; anything past this is a paste accident. */
const MAX_PROXY_CHARS = 200;

/**
 * Coerce the `proxy` setting.
 *
 * `none` is the default and means never proxy; `''` means auto-detect; anything
 * else is an endpoint. Only the shape of the value is checked here — whether it
 * parses is `resolveChildProxy`'s job, and it can report that failure without
 * the settings file having to be valid first. An over-long value is dropped
 * rather than truncated, because half a URL is worse than none.
 */
function proxySetting(value) {
    if (typeof value !== 'string') return 'none';
    const text = value.trim();
    return text.length > MAX_PROXY_CHARS ? 'none' : text;
}

/** Longest model id accepted in the picker's deny list; ids are short by nature. */
const MAX_MODEL_ID_CHARS = 200;

/**
 * Coerce the picker's deny list into a set of distinct, plausible model ids.
 *
 * Anything that is not a non-empty bounded string is dropped rather than
 * repaired: a malformed entry can only ever mean "hide a model", and guessing
 * which model was meant would hide the wrong one.
 */
function modelIdList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    for (const entry of value) {
        const raw = stringOrUndefined(entry);
        if (raw === undefined || raw.length > MAX_MODEL_ID_CHARS) continue;
        // Auto aliases must collapse: the picker switches on `default[]`, and a
        // deny list that stored `auto` beside it would leave one of them on.
        const id = normalizeModelId(raw);
        if (id === '') continue;
        seen.add(id);
    }
    return [...seen];
}

/** Deepest delegation depth the panel offers. */
const MAX_DEPTH_CHOICE = 2;

/**
 * Coerce the `maxChildDepth` setting.
 *
 * `''` means "the panel never wrote this, follow the plugin config", which is
 * why a missing value must not collapse to 0 — 0 is a real choice that refuses
 * every Cursor run. Anything outside 0..2 is treated as not set rather than
 * clamped: a hand-edited 9 is a typo, and silently turning it into 2 would make
 * the panel claim a cap the operator never picked.
 */
function depthSetting(value) {
    const parsed = numberOrUndefined(value);
    if (parsed === undefined) return '';
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_DEPTH_CHOICE ? parsed : '';
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
