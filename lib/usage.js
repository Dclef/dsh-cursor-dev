/**
 * Cursor usage & quota — data acquisition plus the two HTTP surfaces.
 *
 * Why this lives in the plugin rather than in the parent model's head: the
 * numbers come from Cursor's own dashboard RPC, which the CLI never exposes as a
 * command. `agent status` has no usage fields at all; the only account-level
 * quota view is `POST https://api2.cursor.sh/aiserver.v1.DashboardService/
 * GetCurrentPeriodUsage`, authenticated with the access token the CLI already
 * stores on disk.
 *
 * Everything here is READ-ONLY and free: no model tokens are spent, no session
 * is created, and the token is never logged, echoed, or returned over HTTP.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { proxyAwareFetch, readSystemProxy, describeProxy } from './proxy.js';
import { readSettings } from './settings.js';

/** Cursor's API host (mirrors `cli-config.json` → serverConfigCache.backendUrl). */
const DEFAULT_BASE_URL = 'https://api2.cursor.sh';
/** Connect-protocol method for the current billing-period usage snapshot. */
const USAGE_RPC = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
/** How long a fetched snapshot stays fresh before another RPC is allowed. */
const CACHE_MS = 30_000;
/** Network budget for one RPC. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Budget for reading one conversation back out of the Cursor CLI.
 *
 * A replay is a local read, but it spawns the CLI and walks the whole stored
 * transcript; the observed cost of a two-turn session is ~6s, so a minute is
 * generous without letting a wedged process hold the pool's turn lock forever.
 */
const RESTORE_TIMEOUT_MS = 60_000;

/**
 * Cursor's own auth store. The CLI keeps the tokens here rather than under
 * `~/.cursor`, which is what makes this discoverable at all.
 */
export function authFilePath(env = process.env) {
    const appData = env.APPDATA;
    if (typeof appData === 'string' && appData !== '')
        return join(appData, 'Cursor', 'auth.json');
    return join(homedir(), '.config', 'Cursor', 'auth.json');
}

/**
 * Read the access token the CLI is already signed in with.
 *
 * The token is deliberately returned to the caller and never logged.
 *
 * @param env - environment source (injectable for tests).
 */
export async function readAccessToken(env = process.env) {
    const path = authFilePath(env);
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        return { ok: false, path, error: `cannot read ${path}: ${errorText(error)}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return { ok: false, path, error: `cannot parse ${path}: ${errorText(error)}` };
    }
    const token = parsed?.accessToken;
    if (typeof token !== 'string' || token === '')
        return { ok: false, path, error: `${path} has no accessToken field` };
    return { ok: true, path, token };
}

/**
 * Normalize the raw Connect-JSON payload into the names a UI should show.
 *
 * The upstream field names are protobuf-generated and versioned
 * (`planUsage.autoPercentUsed`, `planUsage.totalSpend`, …); the dashboard maps
 * them onto stable, self-describing keys so a UI never has to know them.
 *
 * @param raw - decoded RPC response.
 */
export function normalizeUsage(raw) {
    const plan = raw?.planUsage ?? {};
    const limit = raw?.spendLimitUsage ?? {};
    const cents = value => {
        const amount = numberOrUndefined(value);
        return amount === undefined ? undefined : amount / 100;
    };
    return {
        billingCycle: {
            start: numberOrUndefined(raw?.billingCycleStart),
            end: numberOrUndefined(raw?.billingCycleEnd),
        },
        auto: {
            percentUsed: numberOrUndefined(plan.autoPercentUsed),
            spendCents: numberOrUndefined(plan.autoSpend),
            limitCents: numberOrUndefined(plan.autoLimit),
        },
        api: {
            percentUsed: numberOrUndefined(plan.apiPercentUsed),
            spendCents: numberOrUndefined(plan.apiSpend),
            limitCents: numberOrUndefined(plan.apiLimit),
        },
        total: {
            percentUsed: numberOrUndefined(plan.totalPercentUsed),
            spendCents: numberOrUndefined(plan.totalSpend),
            includedCents: numberOrUndefined(plan.includedSpend),
            bonusCents: numberOrUndefined(plan.bonusSpend),
            limitCents: numberOrUndefined(plan.limit),
        },
        spendLimit: {
            limitType: typeof limit.limitType === 'string' ? limit.limitType : undefined,
            overallLimitCents: numberOrUndefined(limit.overallLimit),
            overallUsedCents: numberOrUndefined(limit.overallUsed),
            individualLimitCents: numberOrUndefined(limit.individualLimit),
            individualUsedCents: numberOrUndefined(limit.individualUsed),
        },
        enabled: raw?.enabled === true,
        displayThreshold: numberOrUndefined(raw?.displayThreshold),
        displayMessage: stringOrUndefined(raw?.displayMessage),
        autoMessage: stringOrUndefined(raw?.autoModelSelectedDisplayMessage),
        namedMessage: stringOrUndefined(raw?.namedModelSelectedDisplayMessage),
        bonusTooltip: stringOrUndefined(plan.bonusTooltip),
        freeBestOfN: raw?.freeBestOfNPromotion === undefined ? undefined : {
            trialsUsed: numberOrUndefined(raw.freeBestOfNPromotion?.trialsUsed),
            trialsRemaining: numberOrUndefined(raw.freeBestOfNPromotion?.trialsRemaining),
        },
        autoBucketModels: Array.isArray(raw?.autoBucketModels) ? raw.autoBucketModels : [],
        // Convenience: dollars, so a UI never has to repeat the /100 itself.
        dollars: {
            total: cents(plan.totalSpend),
            included: cents(plan.includedSpend),
            bonus: cents(plan.bonusSpend),
            auto: cents(plan.autoSpend),
            api: cents(plan.apiSpend),
            limit: cents(plan.limit),
        },
    };
}

/**
 * Fetches (and briefly caches) the account's current-period usage.
 *
 * A failed fetch never throws: callers get `{ok:false,error}` so a UI can show a
 * degraded state while the coding tool keeps working.
 */
export class UsageClient {
    #baseUrl;
    #cache;
    #cacheAt = 0;
    #inflight;
    #fetchImpl;
    #readProxy;
    #proxy;
    #proxied = false;

    /**
     * @param options - `baseUrl`, `fetch` (injectable for tests), `readProxy`
     *                  (injectable proxy discovery) and `request` (injectable
     *                  transport).
     */
    constructor(options = {}) {
        this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.#fetchImpl = options.fetch;
        this.#readProxy = options.readProxy ?? readSystemProxy;
        this.#proxy = options.proxy;
        this.#proxied = options.proxy !== undefined;
    }

    /**
     * The machine's proxy, resolved once per client.
     *
     * `fetch` ignores the Windows Internet Settings, so a network that only
     * reaches Cursor through a proxy reports the RPC as unreachable from a
     * plugin while the same URL loads fine in a browser. Resolving it here keeps
     * the discovery cost at one registry read per process.
     */
    async #resolveProxy() {
        if (!this.#proxied) {
            this.#proxied = true;
            try {
                this.#proxy = (await this.#readProxy()) ?? null;
            }
            catch {
                this.#proxy = null;
            }
        }
        return this.#proxy ?? undefined;
    }

    /** Base URL the RPC is sent to. */
    get baseUrl() {
        return this.#baseUrl;
    }

    /** Which transport the RPC uses, for a status surface. */
    get transport() {
        return describeProxy(this.#proxy ?? undefined);
    }

    /**
     * Latest usage snapshot.
     *
     * @param options - `force` bypasses the cache; `env` overrides token lookup.
     */
    async get(options = {}) {
        const fresh = Date.now() - this.#cacheAt < CACHE_MS && this.#cache !== undefined;
        if (fresh && options.force !== true)
            return this.#cache;

        // Collapse concurrent callers (a UI poll racing a tool call) onto one RPC.
        if (this.#inflight !== undefined)
            return this.#inflight;

        this.#inflight = this.#fetch(options).finally(() => {
            this.#inflight = undefined;
        });
        return this.#inflight;
    }

    async #fetch(options) {
        const auth = await readAccessToken(options.env ?? process.env);
        if (auth.ok !== true) {
            const failure = { ok: false, error: auth.error, authPath: auth.path, fetchedAt: Date.now() };
            this.#cache = failure;
            this.#cacheAt = Date.now();
            return failure;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const proxy = await this.#resolveProxy();
        const transport = describeProxy(proxy);
        const request = this.#fetchImpl ?? proxyAwareFetch({ proxy: proxy ?? null, timeoutMs: REQUEST_TIMEOUT_MS });
        try {
            const response = await request(`${this.#baseUrl}${USAGE_RPC}`, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${auth.token}`,
                    'content-type': 'application/json',
                    'connect-protocol-version': '1',
                    'accept': 'application/json',
                },
                body: '{}',
                signal: controller.signal,
            });
            const text = await response.text();
            if (response.ok !== true) {
                const failure = {
                    ok: false,
                    status: response.status,
                    error: `usage RPC failed: HTTP ${response.status}`,
                    body: text.slice(0, 400),
                    authPath: auth.path,
                    transport,
                    fetchedAt: Date.now(),
                };
                this.#cache = failure;
                this.#cacheAt = Date.now();
                return failure;
            }
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch (error) {
                const failure = {
                    ok: false,
                    error: `usage RPC returned non-JSON: ${errorText(error)}`,
                    body: text.slice(0, 400),
                    authPath: auth.path,
                    transport,
                    fetchedAt: Date.now(),
                };
                this.#cache = failure;
                this.#cacheAt = Date.now();
                return failure;
            }
            const snapshot = {
                ok: true,
                fetchedAt: Date.now(),
                authPath: auth.path,
                transport,
                source: `${this.#baseUrl}${USAGE_RPC}`,
                raw: parsed,
                usage: normalizeUsage(parsed),
            };
            this.#cache = snapshot;
            this.#cacheAt = Date.now();
            return snapshot;
        }
        catch (error) {
            const failure = {
                ok: false,
                error: `usage RPC unreachable: ${errorText(error)}`,
                authPath: auth.path,
                transport,
                fetchedAt: Date.now(),
            };
            this.#cache = failure;
            this.#cacheAt = Date.now();
            return failure;
        }
        finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Register the usage surfaces on the host web server.
 *
 * - `GET /plugins/dsh-cursor-dev/`           → self-contained dashboard
 * - `GET /plugins/dsh-cursor-dev/api/usage`  → normalized JSON (+ live state)
 * - `GET /plugins/dsh-cursor-dev/api/journal?key=…` → one run's step timeline
 *
 * The dashboard is plain HTML + inline CSS/JS on purpose: it needs no client
 * bundle, no build step and no React, and it can be opened in DSH's own sidebar
 * browser tab, so it costs nothing to ship and nothing to run.
 *
 * @param ctx - plugin context.
 * @param deps - `usage` client, `pool`, `journal`, `index`, `dataDir`, `mirrors`.
 */
export function registerUsageRoutes(ctx, deps) {
    const { usage, pool, index, journal, dataDir, mirrors } = deps;
    const registrations = [];
    // `ctx.get` rather than `ctx.webServer`: a missing service must degrade to
    // "no UI", never to a failed plugin load.
    const server = ctx.get?.('webServer');
    if (server === undefined)
        return undefined;

    /**
     * Live rows and durable rows, each annotated with what it is doing now and
     * with the child conversation that mirrors it.
     *
     * A row can only offer "jump to the conversation" when it knows both ids,
     * and the two tables learn them from different places. A live row is keyed
     * by the generation-scoped pool key, which is exactly how the mirror hub
     * keys its children; a durable row outlives every live child, so its child
     * id was written into the conversation index by the run that created it.
     */
    const panelState = () => {
        const children = new Map((mirrors?.snapshot?.() ?? []).map(child => [child.key, child]));
        const withActivity = entry => {
            const activity = journal?.lastActivity?.(entry.key);
            return activity === undefined ? entry : { ...entry, activity };
        };
        const withChild = entry => {
            const child = children.get(entry.key);
            const childSessionId = child?.childSessionId ?? entry.childSessionId;
            if (typeof childSessionId !== 'string' || childSessionId === '')
                return entry;
            return {
                ...entry,
                childSessionId,
                parentSessionId: child?.parentSessionId ?? entry.parentSessionId ?? parentOfKey(entry.key),
            };
        };
        return {
            live: pool.snapshot().map(withActivity).map(withChild),
            conversations: index.list().map(withActivity).map(withChild),
        };
    };

    const jsonRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/api/usage',
        handler: async (req, res) => {
            const force = typeof req?.url === 'string' && req.url.includes('force=1');
            const snapshot = await usage.get({ force });
            // `raw` is dropped: the normalized view is the contract, and the
            // upstream payload carries 200+ model ids nobody polls for.
            const publicView = { ...snapshot };
            delete publicView.raw;
            const state = panelState();
            sendJson(res, 200, {
                ...publicView,
                extended: {
                    live: state.live,
                    queueDepth: pool.queued,
                    conversations: state.conversations,
                    journal: journal?.stats?.(),
                    dataDir,
                },
            });
        },
    };

    /**
     * The step timeline of one run. This is the answer to "what is the child
     * actually doing": the same events the tool folds into its compact result,
     * but in full and without spending a single model token.
     */
    const journalRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/api/journal',
        handler: (req, res) => {
            const url = new URL(req?.url ?? '/', 'http://localhost');
            const key = url.searchParams.get('key');
            if (key === null || key === '') {
                // With no key, list what is available so a UI can offer links.
                const keys = pool.snapshot().map(entry => entry.key);
                sendJson(res, 200, { keys, journals: journal?.stats?.() });
                return;
            }
            // A live row names its bucket exactly; a durable row only knows the
            // conversation, whose journal lives under a generation suffix.
            const exact = journal?.read?.(key);
            const found = exact === undefined ? journal?.readConversation?.(key) : { key, bucket: exact };
            const bucket = found?.bucket;
            if (bucket === undefined) {
                sendJson(res, 404, { key, error: 'no journal for that key (it may have expired)' });
                return;
            }
            sendJson(res, 200, {
                key: found.key,
                task: bucket.task,
                cursorSessionId: bucket.cursorSessionId,
                model: bucket.model,
                workspaceRoot: bucket.workspaceRoot,
                reloaded: bucket.reloaded,
                startedAt: bucket.startedAt,
                updatedAt: bucket.updatedAt,
                steps: journal.timeline(found.key, 60),
                events: bucket.events.slice(-80).map(event => ({
                    seq: event.seq,
                    time: event.time,
                    kind: event.kind,
                    text: typeof event.text === 'string' ? event.text.slice(0, 2000) : undefined,
                    call: event.call,
                })),
            });
        },
    };

    /**
     * Read one old Cursor conversation back and publish it as a child
     * conversation.
     *
     * This is the only route that does work rather than reporting it, and it is
     * the answer to a durable row that has nothing to open: the Cursor CLI keeps
     * every session it ever ran (`session/load` replays the whole transcript in
     * a brand-new process), while the mirrored child conversation only exists
     * for runs made since the mirror shipped. Restoring costs no model tokens —
     * it is a read of the CLI's own store — but it does take the pool's turn
     * lock, because the CLI's model choice is process-global.
     */
    const restoreRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/api/restore',
        handler: async (req, res) => {
            const method = String(req?.method ?? 'GET').toUpperCase();
            if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: `method ${method} is not supported` });
                return;
            }
            const url = new URL(req?.url ?? '/', 'http://localhost');
            const key = url.searchParams.get('key');
            if (key === null || key === '') {
                sendJson(res, 400, { ok: false, error: 'a conversation key is required' });
                return;
            }
            const entry = index?.get?.(key);
            if (entry === undefined)
                sendJson(res, 404, { ok: false, key, error: 'no durable conversation for that key' });
            else if (typeof entry.cursorSessionId !== 'string' || entry.cursorSessionId === '')
                sendJson(res, 409, { ok: false, key, error: 'that conversation never recorded a Cursor session id' });
            else if (typeof pool?.replay !== 'function')
                sendJson(res, 503, { ok: false, key, error: 'this host cannot read Cursor history (no Cursor CLI wired)' });
            else if (typeof mirrors?.restore !== 'function')
                sendJson(res, 503, { ok: false, key, error: 'this host has no agent loop to hold a child conversation' });
            else {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), RESTORE_TIMEOUT_MS);
                try {
                    const cwd = typeof entry.workspaceRoot === 'string' && entry.workspaceRoot !== '' ? entry.workspaceRoot : undefined;
                    // The replay's own event count is only known inside the body,
                    // and it is worth reporting: it says how much of the stored
                    // transcript the CLI actually handed back.
                    let replayed = 0;
                    const restored = await pool.replay({ sessionId: entry.cursorSessionId, cwd, signal: controller.signal }, async ({ events }) => {
                        replayed = events.length;
                        return await mirrors.restore({
                            key,
                            parentSessionId: parentOfKey(key) ?? entry.parentSessionId,
                            cwd,
                            label: labelOfKey(key),
                            model: entry.model,
                            events,
                        });
                    });
                    if (restored === undefined) {
                        sendJson(res, 502, { ok: false, key, error: 'the conversation could not be published as a child conversation' });
                        return;
                    }
                    const childSessionId = restored.child?.session?.header?.id;
                    const parentSessionId = restored.child?.session?.header?.parentSession ?? parentOfKey(key);
                    // Remember it, so the next page load opens the restored
                    // conversation instead of offering to restore it again.
                    try {
                        await index.set(key, { ...entry, childSessionId, updatedAt: Date.now() });
                    }
                    catch (error) {
                        ctx.logger?.warn?.(`dsh-cursor-dev: restored child was not remembered: ${errorText(error)}`);
                    }
                    sendJson(res, 200, {
                        ok: true,
                        key,
                        childSessionId,
                        parentSessionId,
                        turns: restored.mirror?.turn ?? 0,
                        calls: restored.mirror?.calls ?? 0,
                        events: replayed,
                    });
                }
                finally {
                    clearTimeout(timer);
                }
            }
        },
    };

    const dashboardRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/',
        handler: (req, res) => {
            sendHtml(res, dashboardHtml({
                ...panelState(),
                journal,
                dataDir,
                configModel: deps.configModel,
                // Whether this host can open a mirrored child conversation at
                // all. When it cannot, a key click must keep opening the step
                // timeline instead of offering a jump nobody is listening for.
                childrenAvailable: mirrors?.available === true,
                // The panel is hosted by the plugin, not by the app shell, so the
                // language travels in the URL (the client half knows the app
                // locale) and is remembered per browser from then on.
                lang: String(req?.url ?? '').includes('lang=en') ? 'en' : 'zh',
            }));
        },
    };

    /**
     * Wrap a handler so a view bug can never escape into the host's server.
     *
     * These routes are mounted on somebody else's HTTP server: a synchronous
     * throw inside a handler is an unhandled exception in that process, not a
     * 500 response. Every failure becomes a logged 500 instead.
     *
     * @param path - route path, for the log line.
     * @param handler - the raw route handler.
     */
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
                    sendJson(res, 500, { error: errorText(error) });
            }
            catch {
                // The socket is already gone; nothing left to answer.
            }
        }
    };

    for (const route of [jsonRoute, journalRoute, restoreRoute, dashboardRoute]) {
        try {
            registrations.push(server.register({ ...route, handler: guard(route.path, route.handler) }));
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-cursor-dev: usage route ${route.path} unavailable: ${errorText(error)}`);
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

/** Write a JSON response. */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}

/** Write an HTML response. */
function sendHtml(res, html) {
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(html);
}

/**
 * The dashboard page.
 *
 * One page serves both seats: the right-hand Sidebar tab and the Settings page
 * render the same document, so a quota or a run looks the same wherever it is
 * opened. Copy is bilingual with Chinese as the default — the panel is part of a
 * Chinese-first product, and an English-only panel reads as somebody else's
 * plugin.
 *
 * Values are written with `textContent` (never `innerHTML`) and the JSON is
 * embedded as a `<script type="application/json">` block, so no account data can
 * ever be interpreted as markup.
 *
 * @param state - panel state: live rows, durable rows, journal, data dir, language.
 */
function dashboardHtml(state) {
    const settings = readSettings(state.dataDir);
    const lang = state.lang === 'en' ? 'en' : 'zh';
    const bootstrap = JSON.stringify({
        live: state.live ?? [],
        conversations: state.conversations ?? [],
        journal: state.journal?.stats?.() ?? { keys: 0, events: 0 },
        queueDepth: state.queueDepth ?? 0,
        endpoint: '/plugins/dsh-cursor-dev/api/usage',
        journalEndpoint: '/plugins/dsh-cursor-dev/api/journal',
        restoreEndpoint: '/plugins/dsh-cursor-dev/api/restore',
        settingsEndpoint: '/plugins/dsh-cursor-dev/api/settings',
        statusEndpoint: '/plugins/dsh-cursor-dev/status',
        settings: { model: settings.model, mode: settings.mode, language: settings.language },
        models: {
            list: settings.models,
            fetchedAt: settings.modelsFetchedAt,
            // Which name space the cached ids live in. An alias list and an ACP
            // roster look alike in a select element, so the picker has to say
            // which one it is showing — otherwise an id that cannot be switched
            // to looks exactly like one that can.
            source: settings.modelsSource ?? '',
        },
        configModel: state.configModel ?? '',
        // When the host has an agent loop, a row's key opens the mirrored child
        // conversation in the app itself. When it does not, the key keeps
        // opening the step timeline, which is then the only record of a run.
        children: { available: state.childrenAvailable === true },
        lang,
    }).replace(/</g, '\\u003c');

    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cursor</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #16161a; --card: #1e1e24; --line: #2c2c34; --fg: #e8e8ea;
    --muted: #9a9aa4; --accent: #6d8cff; --warn: #ffb454; --bad: #ff6b6b; --good: #56d364;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f6f6f8; --card: #ffffff; --line: #e2e2e8; --fg: #1c1c22;
      --muted: #6b6b76; --accent: #3b5bdb; --warn: #b26a00; --bad: #c92a2a; --good: #2b8a3e;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
  h2 { font-size: 12px; margin: 0 0 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted); }
  .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .muted { color: var(--muted); }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .big { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .bar { height: 7px; border-radius: 4px; background: var(--line); overflow: hidden; margin: 8px 0 6px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .bar.warn > i { background: var(--warn); }
  .bar.bad > i { background: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: var(--line); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .row { margin-top: 18px; }
  .note { margin-top: 18px; color: var(--muted); font-size: 12px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    font-size: 11px; color: var(--muted); }
  .err { border-color: var(--bad); }
  .journal { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
  .journal h3 { font-size: 12px; margin: 0 0 8px; font-weight: 600; }
  .journal pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0;
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px;
    max-height: 260px; overflow: auto; font-size: 12px; }
  a.link { color: var(--accent); text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  a.link.on { color: var(--fg); font-weight: 600; }
  .langs { font-size: 12px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0 6px; }
  select, button {
    font: inherit; color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; padding: 5px 9px;
  }
  select { min-width: 240px; max-width: 100%; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.ghost { color: var(--muted); }
</style>
</head>
<body>
<div class="head">
  <h1 data-t="title">Cursor 子智能体</h1>
  <span class="pill" id="tier" data-t="account">—</span>
  <span class="muted" id="stamp" data-t="loading">…</span>
  <span class="langs" id="langs"></span>
  <span class="muted" style="margin-left:auto"><a href="#" class="link" id="refresh" data-t="refresh">刷新</a></span>
</div>

<div id="error" class="card err" style="display:none"></div>
<div id="setup" class="card" style="display:none"></div>

<div class="grid">
  <div class="card">
    <h2 data-t="included">总包含额度</h2>
    <div class="big" id="total-pct">—</div>
    <div class="bar" id="total-bar"><i style="width:0%"></i></div>
    <div class="muted" id="total-sub">—</div>
  </div>
  <div class="card">
    <h2 data-t="auto">Auto 额度</h2>
    <div class="big" id="auto-pct">—</div>
    <div class="bar" id="auto-bar"><i style="width:0%"></i></div>
    <div class="muted" id="auto-sub">—</div>
  </div>
  <div class="card">
    <h2 data-t="api">API / 指定模型额度</h2>
    <div class="big" id="api-pct">—</div>
    <div class="bar" id="api-bar"><i style="width:0%"></i></div>
    <div class="muted" id="api-sub">—</div>
  </div>
  <div class="card">
    <h2 data-t="spend">本期消费</h2>
    <div class="big" id="spend">—</div>
    <div class="muted" id="spend-sub">—</div>
  </div>
</div>

<div class="row card">
  <h2 data-t="model">子智能体模型</h2>
  <div class="muted" data-t="modelHint"></div>
  <div class="controls">
    <select id="model"></select>
    <button type="button" id="model-save" data-t="save">保存</button>
    <button type="button" id="model-reload" class="ghost" data-t="reloadModels">重新读取模型列表</button>
  </div>
  <div class="muted" id="model-state"></div>
  <div class="muted" data-t="modelNote" style="margin-top:6px"></div>
</div>

<div class="row card">
  <h2 data-t="period">计费周期</h2>
  <div id="cycle" class="muted">—</div>
  <div id="message" class="muted" style="margin-top:6px"></div>
</div>

<div class="row card">
  <h2 data-t="live">运行中的 Cursor 会话</h2>
  <table><thead><tr>
    <th data-t="colKey">会话键</th><th data-t="colSession">会话号</th><th data-t="colModel">模型</th><th data-t="colMode">模式</th><th class="num" data-t="colTurns">轮次</th><th class="num" data-t="colIdle">空闲</th><th data-t="colDoing">正在做什么</th>
  </tr></thead><tbody id="live"></tbody></table>
  <div class="journal" id="journal" style="display:none"></div>
</div>

<div class="row card">
  <h2 data-t="conversations">历史会话（可恢复，重装后仍在）</h2>
  <div class="muted" data-t="conversationsHint"></div>
  <table><thead><tr>
    <th data-t="colKey">会话键</th><th data-t="colSession">会话号</th><th data-t="colWorkspace">工作目录</th><th data-t="colModel">模型</th><th class="num" data-t="colUpdated">更新时间</th>
  </tr></thead><tbody id="convos"></tbody></table>
</div>

<div class="note" id="source"></div>

<script type="application/json" id="bootstrap">${bootstrap}</script>
<script>
(function () {
  var boot = JSON.parse(document.getElementById('bootstrap').textContent);
  var STORE_KEY = 'dsh-cursor-dev:lang';

  var T = {
    zh: {
      title: 'Cursor 子智能体',
      account: '账号',
      loading: '加载中…',
      refresh: '刷新',
      included: '总包含额度',
      auto: 'Auto 额度',
      api: 'API / 指定模型额度',
      spend: '本期消费',
      model: '子智能体模型',
      modelHint: 'cursor_code 未指定 model 时使用这里的模型；单次调用仍可用 model 参数覆盖。',
      save: '保存',
      reloadModels: '重新读取模型列表',
      modelState: '可选模型',
      period: '计费周期',
      live: '运行中的 Cursor 会话',
      conversations: '历史会话（可恢复，重装后仍在）',
      conversationsHint: '点击会话键打开这次运行：有子智能体对话时直接跳过去；旧对话（这个功能上线前跑的）会当场从 Cursor 里读回来建成子会话；读不到才退回去展开轨迹。',
      openChildHint: '打开这次运行的子智能体对话',
      openJournalHint: '展开这次运行的轨迹',
      restoreHint: '把这次运行的旧对话读回来，建成一个能点开的子智能体会话',
      restoring: '正在从 Cursor 读回这次对话（不花额度，最多一分钟）…',
      restoreFailed: '读回失败：',
      openNeedsApp: '这个页面是单独打开的，跳转到对话需要在 DSH 里打开本面板。',
      close: '收起',
      colKey: '会话键',
      colSession: '会话号',
      colModel: '模型',
      colMode: '模式',
      colTurns: '轮次',
      colIdle: '空闲',
      colDoing: '正在做什么',
      colWorkspace: '工作目录',
      colUpdated: '更新时间',
      none: '暂无',
      unreachable: '无法连接',
      usageUnavailable: '用量暂时取不到：',
      updated: '更新于 ',
      failed: '获取失败 ',
      spentOf: '已用 ',
      of: ' / 共 ',
      includedIn: '包含 ',
      bonus: ' · 赠送 ',
      starts: '开始 ',
      renews: '  →  续订 ',
      source: '数据来源：',
      credentials: '  ·  凭据：',
      steps: '轨迹',
      task: '任务',
      runJournal: '运行轨迹 — ',
      noToolCalls: '还没有工具调用',
      journalUnavailable: '轨迹读取失败：',
      resumed: '  ·  已从磁盘恢复',
      saved: '已保存',
      saveFailed: '保存失败：',
      inEffect: '当前生效：',
      configModel: '配置文件指定：',
      followingCli: '跟随 CLI 默认（Auto）',
      modelsAge: '列表更新于 ',
      modelsFailed: '无法读取模型列表：',
      noModels: '（模型列表为空，点「重新读取模型列表」）',
      modelsFromAcp: 'ACP 会话清单（这些 id 可以直接切换）',
      modelsFromCli: 'CLI --list-models（别名，仅作后备）',
      modelsFromCache: '缓存（来源未记录）',
      modelInUse: '（正在使用）',
      modelUnavailable: '（当前不可用）',
      modelNote: '模型什么时候切换：新会话立刻用新模型；已经存在的会话会在它下一次被调用时切换（Cursor CLI 的模型是全局的，所以同一时刻只会有一个会话在跑）。',
      modelPending: '下次调用切换',
      setupMissing: '还没找到 Cursor CLI —— 这个插件靠本机 CLI 干活，先装上它：',
      setupInstallWin: 'Windows PowerShell',
      setupInstallUnix: 'macOS / Linux',
      setupSignedOut: 'Cursor CLI 还没登录 —— 在终端里跑一次（会打开浏览器授权）：',
      setupThen: '装完/登录后点这里：',
      setupRetry: '重试',
      setupVerify: '确认状态：',
    },
    en: {
      title: 'Cursor child agent',
      account: 'account',
      loading: 'loading…',
      refresh: 'refresh',
      included: 'Included total',
      auto: 'Auto bucket',
      api: 'API / named bucket',
      spend: 'Spend',
      model: 'Child-agent model',
      modelHint: 'Used by cursor_code whenever a call does not name a model. A single call can still override it with the model argument.',
      save: 'Save',
      reloadModels: 'Reload model list',
      modelState: 'available models',
      period: 'Billing period',
      live: 'Live Cursor sessions',
      conversations: 'Known conversations (durable)',
      conversationsHint: 'Click a key to open the run: its child conversation when there is one; an older run (made before this feature) is read back out of Cursor and published as one; only if that fails does the step timeline open instead.',
      openChildHint: 'Open the child conversation for this run',
      openJournalHint: 'Unfold this run’s step timeline',
      restoreHint: 'Read this run’s old conversation back and publish it as an openable child conversation',
      restoring: 'Reading this conversation back out of Cursor (free, up to a minute)…',
      restoreFailed: 'Could not read it back: ',
      openNeedsApp: 'This page is open on its own; opening the conversation needs the panel inside DSH.',
      close: 'close',
      colKey: 'key',
      colSession: 'session',
      colModel: 'model',
      colMode: 'mode',
      colTurns: 'turns',
      colIdle: 'idle',
      colDoing: 'what it is doing',
      colWorkspace: 'workspace',
      colUpdated: 'updated',
      none: 'none',
      unreachable: 'unreachable',
      usageUnavailable: 'Usage unavailable: ',
      updated: 'updated ',
      failed: 'failed ',
      spentOf: 'spent ',
      of: ' of ',
      includedIn: 'included ',
      bonus: ' · bonus ',
      starts: 'starts ',
      renews: '  →  renews ',
      source: 'source: ',
      credentials: '  ·  credentials: ',
      steps: 'steps',
      task: 'task',
      runJournal: 'Run journal — ',
      noToolCalls: 'no tool calls recorded',
      journalUnavailable: 'journal unavailable: ',
      resumed: '  ·  resumed from disk',
      saved: 'saved',
      saveFailed: 'save failed: ',
      inEffect: 'in effect: ',
      configModel: 'from config: ',
      followingCli: 'Follow the CLI default (Auto)',
      modelsAge: 'list from ',
      modelsFailed: 'could not read the model list: ',
      noModels: '(no models listed — press Reload model list)',
      modelsFromAcp: 'ACP session roster (these ids can be switched to)',
      modelsFromCli: 'CLI --list-models (aliases, fallback only)',
      modelsFromCache: 'cache (source never recorded)',
      modelInUse: '(in use)',
      modelUnavailable: '(currently unavailable)',
      modelNote: 'When a switch lands: a new conversation uses the new model immediately; a session that already exists switches on its next call (the Cursor CLI keeps one global model, so only one session runs at a time).',
      modelPending: 'switches on the next call',
      setupMissing: 'The Cursor CLI was not found yet — this plugin does its work through it, so install it first:',
      setupInstallWin: 'Windows PowerShell',
      setupInstallUnix: 'macOS / Linux',
      setupSignedOut: 'The Cursor CLI is not signed in yet — run this once in a terminal (it opens the browser):',
      setupThen: 'After installing or signing in, press:',
      setupRetry: 'Retry',
      setupVerify: 'Confirm with ',
    },
  };

  var $ = function (id) { return document.getElementById(id); };
  var settings = boot.settings || { model: '', mode: '', language: '' };
  var models = (boot.models && boot.models.list) || [];
  var modelsFetchedAt = (boot.models && boot.models.fetchedAt) || 0;
  var modelsSource = (boot.models && boot.models.source) || '';
  var configModel = boot.configModel || '';
  var setupState = null;
  var LANG = pickLang();

  /** Remembered choice, else the app's locale, else Chinese. */
  function pickLang() {
    var stored = null;
    try { stored = window.localStorage.getItem(STORE_KEY); } catch (e) { stored = null; }
    if (stored === 'zh' || stored === 'en') return stored;
    if (settings.language === 'zh' || settings.language === 'en') return settings.language;
    return boot.lang === 'en' ? 'en' : 'zh';
  }
  function t(key) {
    var table = T[LANG] || T.zh;
    return table[key] !== undefined ? table[key] : (T.zh[key] || key);
  }
  function applyLanguage() {
    document.documentElement.lang = LANG;
    var nodes = document.querySelectorAll('[data-t]');
    for (var i = 0; i < nodes.length; i += 1) {
      var key = nodes[i].getAttribute('data-t');
      if (key) nodes[i].textContent = t(key);
    }
    renderLangs();
    renderModel();
    renderLive(lastPayload);
    renderSetup();
  }
  /** The 中文 / English switch, in the header. */
  function renderLangs() {
    var host = $('langs');
    host.textContent = '';
    [['zh', '中文'], ['en', 'English']].forEach(function (pair) {
      var a = document.createElement('a');
      a.className = 'link' + (LANG === pair[0] ? ' on' : '');
      a.href = '#';
      a.textContent = pair[1];
      a.addEventListener('click', function (event) {
        event.preventDefault();
        if (LANG === pair[0]) return;
        LANG = pair[0];
        try { window.localStorage.setItem(STORE_KEY, LANG); } catch (e) { /* private mode */ }
        // Persist too: the Settings page and the Sidebar tab then agree even in a
        // browser that forbids local storage.
        post({ language: LANG });
        applyLanguage();
      });
      host.appendChild(a);
      if (pair[0] === 'zh') {
        var sep = document.createElement('span');
        sep.className = 'muted';
        sep.textContent = ' / ';
        host.appendChild(sep);
      }
    });
  }

  function pct(value) {
    return typeof value === 'number' ? value.toFixed(1) + '%' : '—';
  }
  function money(value) {
    return typeof value === 'number' ? '$' + value.toFixed(2) : '—';
  }
  function when(value) {
    if (typeof value !== 'number') return '—';
    return new Date(value).toLocaleString();
  }
  function ago(ms) {
    if (typeof ms !== 'number') return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }
  function text(node, value) { node.textContent = value == null ? '—' : String(value); }
  function setBar(id, percent) {
    var bar = $(id);
    var p = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0;
    bar.firstElementChild.style.width = p + '%';
    bar.className = 'bar' + (p >= 90 ? ' bad' : p >= 70 ? ' warn' : '');
  }

  /**
   * The model picker: CLI default, then everything the account can use.
   *
   * Two facts the select element cannot say on its own, both of which decide
   * whether pressing Save does anything:
   *
   * 1. Which entry is the one the CLI reports as current. That is the model that
   *    will answer the next call, and it is not always the stored choice — a
   *    profile config or a global CLI switch can put the two apart.
   * 2. Which entries are not actually offered right now. The ids in a stale
   *    cache, or in the CLI's alias listing, are not ids the ACP
   *    set_config_option method accepts, so such an entry must not look
   *    selectable just because it is drawn in the same list.
   */
  function renderModel() {
    var select = $('model');
    select.textContent = '';
    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = t('followingCli');
    select.appendChild(auto);
    var inEffectNow = settings.model || configModel || 'auto';
    models.forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry.id;
      var label = entry.name === entry.id ? entry.id : entry.name + ' (' + entry.id + ')';
      if (entry.id === inEffectNow || entry.current === true) label += ' ' + t('modelInUse');
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = settings.model || '';
    if (select.value !== (settings.model || '')) {
      // A stored model the CLI no longer offers: keep it visible instead of
      // silently switching the user's choice back to Auto — but say plainly that
      // nothing in the fetched list can serve it, so the panel never implies a
      // run would use it.
      var kept = document.createElement('option');
      kept.value = settings.model;
      kept.textContent = settings.model + ' ' + t('modelUnavailable');
      select.appendChild(kept);
      select.value = settings.model;
    }
    var bits = [];
    bits.push(t('inEffect') + inEffectNow);
    if (configModel) bits.push(t('configModel') + configModel);
    if (models.length === 0) bits.push(t('noModels'));
    else bits.push(t('modelState') + ': ' + models.length + (modelsFetchedAt ? ' · ' + t('modelsAge') + when(modelsFetchedAt) : ''));
    if (modelsSource === 'acp') bits.push(t('modelsFromAcp'));
    else if (modelsSource === 'cli') bits.push(t('modelsFromCli'));
    else if (modelsSource === 'cache') bits.push(t('modelsFromCache'));
    if (modelsError) bits.push(t('modelsFailed') + modelsError);
    text($('model-state'), bits.join('  ·  '));
  }

  /** One cell. A spec with link:true is clickable; 'on' marks it as the open one. */
  function cell(spec, entry) {
    var td = document.createElement('td');
    if (spec.num) td.className = 'num';
    if (spec.link) {
      var a = document.createElement('a');
      a.className = 'link' + (spec.on && spec.on(entry) ? ' on' : '');
      a.href = '#';
      a.textContent = spec.value(entry);
      var hint = spec.title ? spec.title(entry) : '';
      if (hint) a.title = hint;
      a.addEventListener('click', function (event) {
        event.preventDefault();
        spec.onClick(entry);
      });
      td.appendChild(a);
      return td;
    }
    text(td, spec.value(entry));
    return td;
  }

  function rows(tbody, entries, cells) {
    tbody.textContent = '';
    if (entries.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = cells.length;
      td.className = 'muted';
      td.textContent = t('none');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    entries.forEach(function (entry) {
      var row = document.createElement('tr');
      cells.forEach(function (spec) { row.appendChild(cell(spec, entry)); });
      tbody.appendChild(row);
    });
  }

  /**
   * Whether this row can jump to the child conversation that mirrors it.
   *
   * Two things have to be true, and both come from the host: the host must have
   * an agent loop at all (children.available), and this particular run must
   * have been mirrored. A host without an agent loop has no child to open, and
   * there the key keeps its old meaning — the step timeline.
   */
  function canOpenChild(entry) {
    return boot.children.available === true
      && typeof entry.childSessionId === 'string' && entry.childSessionId !== '';
  }

  /**
   * Ask the app shell to open one mirrored child conversation.
   *
   * The dashboard is an iframe inside the app, so the address travels to the
   * parent window and the plugin's client half does the opening — the same
   * '{parentSessionId, childSessionId, mode}' address the subagent tree itself
   * uses. Opened in a standalone tab there is no parent window to receive it,
   * so say that instead of appearing to do nothing.
   */
  function openChild(entry) {
    if (window.parent === window) {
      notice(t('openNeedsApp'));
      return;
    }
    window.parent.postMessage({
      type: 'dsh-cursor-dev:open-child',
      parentSessionId: entry.parentSessionId || '',
      childSessionId: entry.childSessionId,
      mode: 'one-shot',
    }, window.location.origin);
  }

  /**
   * Whether this row can be turned into a child conversation on demand.
   *
   * A durable row made before the mirror existed has no child id, but the Cursor
   * CLI still holds the whole conversation: the host can read it back and
   * publish it. That needs the same two host capabilities as opening a child
   * (an agent loop to hold it, a recorded Cursor session to read).
   */
  function canRestore(entry) {
    return boot.children.available === true
      && typeof entry.cursorSessionId === 'string' && entry.cursorSessionId !== '';
  }

  /** What clicking this row's key will do, for the tooltip. */
  function rowHint(entry) {
    if (canOpenChild(entry)) return t('openChildHint');
    if (canRestore(entry)) return t('restoreHint');
    return t('openJournalHint');
  }

  /**
   * Ask the host to read an old conversation back out of Cursor, then open it.
   *
   * The read is local and free — it replays the CLI's own store into a child
   * conversation — but it spawns the CLI and walks the transcript, so the panel
   * says what it is doing rather than looking stuck.
   */
  function restoreRow(entry) {
    if (window.parent === window) {
      notice(t('openNeedsApp'));
      return;
    }
    notice(t('restoring'));
    fetch(boot.restoreEndpoint + '?key=' + encodeURIComponent(entry.key), {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
      .then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      })
      .then(function (answer) {
        var body = answer.body || {};
        if (answer.ok === true && body.ok === true && body.childSessionId) {
          openChild({
            parentSessionId: body.parentSessionId || entry.parentSessionId || '',
            childSessionId: body.childSessionId,
          });
          return;
        }
        notice(t('restoreFailed') + (body.error || 'unknown error'));
      })
      .catch(function (error) {
        notice(t('restoreFailed') + (error && error.message ? error.message : String(error)));
      });
  }

  /** Replace the journal panel with one line of explanation. */
  function notice(message) {
    var panel = $('journal');
    journalKey = '';
    panel.style.display = '';
    panel.textContent = '';
    var div = document.createElement('div');
    div.className = 'muted';
    div.textContent = message;
    panel.appendChild(div);
    renderLive(lastPayload || {});
  }

  /**
   * The key cell: the conversation when there is one, else the step timeline.
   *
   * An old durable row is the interesting case — it has a Cursor conversation
   * that the panel could not open at all before, so the click offers to read it
   * back rather than silently showing an expired timeline.
   */
  function openRow(entry) {
    if (canOpenChild(entry)) openChild(entry);
    else if (canRestore(entry)) restoreRow(entry);
    else openJournal(entry.key);
  }

  /**
   * One run's step timeline, or close it when that run is already open.
   *
   * The panel is deliberately small: the task (which appears nowhere else on the
   * page), and one row per tool call with the file it touched. The raw ACP event
   * dump that used to sit underneath was one 'text' event per streamed chunk —
   * a sentence re-split into two-character lines — so it is gone; the mirrored
   * child conversation is where the full transcript lives.
   */
  function openJournal(key) {
    var panel = $('journal');
    if (journalKey === key && panel.style.display !== 'none') {
      journalKey = '';
      panel.style.display = 'none';
      panel.textContent = '';
      renderLive(lastPayload || {});
      return;
    }
    journalKey = key;
    panel.style.display = '';
    panel.textContent = '';
    renderLive(lastPayload || {});

    var title = document.createElement('h3');
    title.textContent = t('runJournal') + key;
    var close = document.createElement('a');
    close.className = 'link';
    close.href = '#';
    close.textContent = '✕';
    close.title = t('close');
    close.style.float = 'right';
    close.addEventListener('click', function (event) {
      event.preventDefault();
      openJournal(key);
    });
    title.appendChild(close);
    panel.appendChild(title);

    fetch(boot.journalEndpoint + '?key=' + encodeURIComponent(key), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var note = document.createElement('div');
        note.className = 'muted';
        if (data.error) {
          note.textContent = data.error;
        } else {
          // Session and model are on the row that was just clicked; repeating
          // them here only pushed the table down the page.
          note.textContent = t('task') + ': ' + (data.task || '—')
            + (data.reloaded ? t('resumed') : '');
        }
        panel.appendChild(note);

        var stepsTable = document.createElement('table');
        var thead = document.createElement('thead');
        var headRow = document.createElement('tr');
        ['#', 'tool', 'kind', 'path', 'status'].forEach(function (label) {
          var th = document.createElement('th');
          th.textContent = label;
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        stepsTable.appendChild(thead);
        var tbody = document.createElement('tbody');
        (data.steps || []).forEach(function (step, index) {
          var row = document.createElement('tr');
          // The raw call id was a 64-character opaque string in the widest
          // column of the table; the ordinal is what the column reads as.
          [[index + 1, undefined], [step.name, step.name], [step.kind, undefined], [step.path, undefined], [step.status, undefined]]
            .forEach(function (pair) {
              var td = document.createElement('td');
              text(td, pair[0]);
              // Cursor's title for a shell call IS the command line, so the cell
              // is clamped and the full text stays reachable on hover.
              if (typeof pair[1] === 'string' && pair[1].length > 60) {
                td.textContent = pair[1].slice(0, 59) + '…';
                td.title = pair[1];
              }
              row.appendChild(td);
            });
          tbody.appendChild(row);
        });
        if (!tbody.children.length) {
          var empty = document.createElement('tr');
          var emptyCell = document.createElement('td');
          emptyCell.colSpan = 5;
          emptyCell.className = 'muted';
          emptyCell.textContent = t('noToolCalls');
          empty.appendChild(emptyCell);
          tbody.appendChild(empty);
        }
        stepsTable.appendChild(tbody);
        panel.appendChild(stepsTable);
      })
      .catch(function (e) {
        var failed = document.createElement('div');
        failed.className = 'muted';
        failed.textContent = t('journalUnavailable') + String(e);
        panel.appendChild(failed);
      });
  }

  var lastPayload = {};
  var journalKey = '';

  /**
   * A live session's model, plus the model the picker is set to when the two
   * differ.
   *
   * The Cursor CLI applies its model switch on a session's NEXT call, so an
   * operator who has just picked a model otherwise sees the old id in this
   * table and concludes the picker did nothing. Showing both ids — and which
   * one is about to take over — is the difference between "it is broken" and
   * "it lands on the next call".
   */
  function modelCell(current) {
    var target = settings.model || configModel || '';
    if (!current) return current;
    if (!target || current === target) return current;
    return current + ' → ' + target + '（' + t('modelPending') + '）';
  }

  function renderLive(payload) {
    var live = (payload.extended && payload.extended.live) || boot.live || [];
    var convos = (payload.extended && payload.extended.conversations) || boot.conversations || [];
    rows($('live'), live, [
      { value: function (e) { return e.key; }, link: true, onClick: openRow,
        on: function (e) { return journalKey === e.key; },
        title: rowHint },
      { value: function (e) { return e.cursorSessionId ? String(e.cursorSessionId).slice(0, 8) : '—'; } },
      { value: function (e) { return modelCell(e.model); } },
      { value: function (e) { return e.mode; } },
      { value: function (e) { return e.turns; }, num: true },
      { value: function (e) { return ago(e.idleMs); }, num: true },
      { value: function (e) { return e.activity ? e.activity.text : (e.alive === false ? '—' : ''); } }
    ]);
    rows($('convos'), convos, [
      { value: function (e) { return e.key; }, link: true, onClick: openRow,
        on: function (e) { return journalKey === e.key; },
        title: rowHint },
      { value: function (e) { return e.cursorSessionId ? String(e.cursorSessionId).slice(0, 8) : '—'; } },
      { value: function (e) { return e.workspaceRoot; } },
      { value: function (e) { return e.model; } },
      { value: function (e) { return when(e.updatedAt); }, num: true }
    ]);
  }
  function render(payload) {
    lastPayload = payload;
    var err = $('error');
    // A failed snapshot carries no extended block; keep whatever the table
    // already shows rather than blanking it.
    var hasPanels = typeof payload.extended === 'object' && payload.extended !== null;
    if (payload.ok !== true) {
      err.style.display = '';
      err.textContent = t('usageUnavailable') + (payload.error || 'unknown error');
      text($('stamp'), t('failed') + when(payload.fetchedAt));
      if (hasPanels) renderLive(payload);
      return;
    }
    err.style.display = 'none';
    var u = payload.usage || {};
    setBar('total-bar', u.total && u.total.percentUsed);
    setBar('auto-bar', u.auto && u.auto.percentUsed);
    setBar('api-bar', u.api && u.api.percentUsed);
    text($('total-pct'), pct(u.total && u.total.percentUsed));
    text($('auto-pct'), pct(u.auto && u.auto.percentUsed));
    text($('api-pct'), pct(u.api && u.api.percentUsed));
    text($('tier'), u.plan || payload.tier || t('account'));
    text($('total-sub'), t('spentOf') + money(u.dollars && u.dollars.total) + t('of') + money(u.dollars && u.dollars.limit));
    text($('auto-sub'), u.autoMessage || t('auto'));
    text($('api-sub'), u.namedMessage || t('api'));
    text($('spend'), money(u.dollars && u.dollars.total));
    text($('spend-sub'), t('includedIn') + money(u.dollars && u.dollars.included) + t('bonus') + money(u.dollars && u.dollars.bonus));
    text($('cycle'), t('starts') + when(u.billingCycle && u.billingCycle.start) + t('renews') + when(u.billingCycle && u.billingCycle.end));
    text($('message'), u.displayMessage || '');
    text($('stamp'), t('updated') + when(payload.fetchedAt));
    text($('source'), t('source') + (payload.source || '') + (payload.authPath ? t('credentials') + payload.authPath : ''));
    renderLive(payload);
  }

  var modelsError = '';
  function loadSettings(force) {
    return fetch(boot.settingsEndpoint + (force ? '?refreshModels=1' : ''), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.settings) settings = data.settings;
        if (data && data.models) {
          models = data.models.list || [];
          modelsFetchedAt = data.models.fetchedAt || 0;
          // A payload that does not name a source must not erase the one already
          // shown: the label is a fact about the ids in the list, not about this
          // particular response.
          if (typeof data.models.source === 'string' && data.models.source !== '') modelsSource = data.models.source;
          modelsError = data.models.ok === false ? String(data.models.error || '') : '';
        }
        if (typeof data.configModel === 'string') configModel = data.configModel;
        renderModel();
        return data;
      })
      .catch(function (e) {
        modelsError = String(e);
        renderModel();
        return undefined;
      });
  }
  function post(patch) {
    return fetch(boot.settingsEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.settings) settings = data.settings;
        if (data && data.models) {
          models = data.models.list || [];
          modelsFetchedAt = data.models.fetchedAt || 0;
          if (typeof data.models.source === 'string' && data.models.source !== '') modelsSource = data.models.source;
          modelsError = data.models.ok === false ? String(data.models.error || '') : '';
        }
        renderModel();
        return data;
      })
      .catch(function (e) {
        text($('model-state'), t('saveFailed') + String(e));
        return undefined;
      });
  }
  function load(force) {
    text($('stamp'), t('loading'));
    fetch(boot.endpoint + (force ? '?force=1' : ''), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function (e) {
        render({ ok: false, error: String(e) });
      });
  }

  /**
   * Is the CLI installed, and is it signed in?
   *
   * A fresh install answers "no quota, no models, no sessions" — three correct
   * empty answers that look exactly like a broken plugin. This asks the host the
   * one question that tells them apart, and prints the command that clears it.
   */
  function refreshAuth(force) {
    fetch(boot.statusEndpoint + (force ? '?auth=refresh' : ''), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : undefined; })
      .then(function (data) { setupState = data || null; renderSetup(); })
      .catch(function () { setupState = null; renderSetup(); });
  }
  function codeBlock(label, command) {
    var wrap = document.createElement('div');
    if (label) {
      var caption = document.createElement('div');
      caption.className = 'muted';
      caption.style.marginTop = '8px';
      caption.textContent = label;
      wrap.appendChild(caption);
    }
    var pre = document.createElement('code');
    pre.style.display = 'block';
    pre.style.marginTop = '4px';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-all';
    pre.textContent = command;
    wrap.appendChild(pre);
    return wrap;
  }
  function renderSetup() {
    var host = $('setup');
    if (!host) return;
    var status = setupState;
    var setup = (status && status.setup) || {};
    var install = setup.install || {};
    var missing = !!(status && status.agent && status.agent.found !== true);
    var signedOut = !missing && !!(status && status.auth && status.auth.authenticated !== true);
    if (!missing && !signedOut) {
      host.style.display = 'none';
      host.textContent = '';
      return;
    }
    host.style.display = '';
    host.textContent = '';
    var title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = missing ? t('setupMissing') : t('setupSignedOut');
    host.appendChild(title);
    if (missing) {
      host.appendChild(codeBlock(t('setupInstallWin'), install.win32 || "irm 'https://cursor.com/install?win32=true' | iex"));
      host.appendChild(codeBlock(t('setupInstallUnix'), install.unix || 'curl https://cursor.com/install -fsS | bash'));
    }
    host.appendChild(codeBlock(missing ? t('setupThen') : undefined, setup.login || 'agent login'));
    var verify = document.createElement('div');
    verify.className = 'muted';
    verify.style.marginTop = '8px';
    verify.textContent = t('setupVerify') + (setup.verify || 'agent status --format json');
    host.appendChild(verify);
    var button = document.createElement('button');
    button.type = 'button';
    button.style.marginTop = '10px';
    button.textContent = t('setupRetry');
    button.addEventListener('click', function () {
      refreshAuth(true);
      load(true);
      loadSettings(false);
    });
    host.appendChild(button);
  }

  $('refresh').addEventListener('click', function (event) {
    event.preventDefault();
    load(true);
    loadSettings(false);
    refreshAuth(true);
  });
  $('model-save').addEventListener('click', function () {
    var value = $('model').value;
    text($('model-state'), '…');
    post({ model: value }).then(function (data) {
      if (data && data.settings) text($('model-state'), t('saved') + '  ·  ' + t('inEffect') + (data.effectiveModel || 'auto'));
    });
  });
  $('model-reload').addEventListener('click', function () {
    text($('model-state'), t('loading'));
    loadSettings(true);
  });

  applyLanguage();
  renderLive({});
  load(false);
  refreshAuth(false);
  // The model list is refreshed the first time the panel opens with an empty
  // cache, so a fresh install gets a working picker without a manual step.
  loadSettings(models.length === 0).then(function () {
    if (models.length === 0) loadSettings(true);
  });
  setInterval(function () { load(false); }, 30000);
})();
</script>
</body>
</html>`;
}

/**
 * Coerce a finite number, else undefined.
 *
 * Protobuf `int64` fields arrive from Connect-JSON as *strings* (proto3 maps
 * 64-bit integers to strings to avoid precision loss), so the session's
 * `billingCycleStart` / `billingCycleEnd` are `"1791527669000"`, not numbers.
 * Accepting both shapes here is what keeps the billing period from silently
 * becoming `undefined`.
 */
function numberOrUndefined(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && value !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** Coerce a string, else undefined. */
function stringOrUndefined(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The parent session id inside a conversation key.
 *
 * A conversation key is `${parentId}::${label}` and the parent id IS a session
 * id, so the prefix is the parent — the last resort when a durable row predates
 * the child id being written into the index, and the only source of the parent
 * for a row whose child has already been reaped.
 *
 * @param key - conversation key.
 */
function parentOfKey(key) {
    if (typeof key !== 'string')
        return undefined;
    const mark = key.indexOf('::');
    return mark <= 0 ? undefined : key.slice(0, mark);
}

/**
 * The session label inside a conversation key.
 *
 * `sessionLabel` is what the model passes to `cursor_code`, and it is the name
 * the child conversation is filed under — a restored row must keep it, or the
 * child appears in the parent's catalog under a different name than the run it
 * came from.
 *
 * @param key - conversation key.
 */
function labelOfKey(key) {
    if (typeof key !== 'string')
        return undefined;
    const mark = key.indexOf('::');
    return mark <= 0 ? undefined : key.slice(mark + 2);
}

/** Render an unknown thrown value as text. */
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
