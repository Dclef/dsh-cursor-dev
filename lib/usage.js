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
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { proxyAwareFetch, readSystemProxy, describeProxy } from './proxy.js';
import { readAttribution } from './attribution.js';
import { effectiveMaxChildDepth, readSettings } from './settings.js';
import { conversationKeyOf } from './session-pool.js';

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
 * The macOS Keychain account the Cursor CLI stores its login under.
 *
 * The CLI's credential store is not one file across platforms: on macOS it
 * keeps the login in the login Keychain as generic-password items named
 * `cursor-access-token`, `cursor-refresh-token` and `cursor-api-key`, all under
 * the account `cursor-user`. Windows and Linux write the same domain
 * ("cursor") to `auth.json` inside the per-user config directory instead. Both
 * stores are tried below, because the store is a user-visible CLI setting
 * (`AGENT_CLI_CREDENTIAL_STORE=file` opts a macOS install into the file), and
 * the earlier builds of this plugin only knew the file spelling.
 */
const KEYCHAIN_ACCOUNT = 'cursor-user';
const KEYCHAIN_ACCESS_TOKEN_SERVICE = 'cursor-access-token';

/**
 * Every `auth.json` location the CLI may have written, in lookup order.
 *
 * The CLI's file credential store (`../cli-credentials` in the CLI bundle) names
 * the file after its credential-store domain: `%APPDATA%\Cursor\auth.json` on
 * Windows (that platform title-cases the domain), `$XDG_CONFIG_HOME/cursor/auth.json`
 * on Linux, and `~/.cursor/auth.json` when the macOS CLI is forced onto the file
 * store. `~/.config/Cursor` is the spelling earlier builds of this plugin
 * assumed, so it stays in the list for machines whose token was already put
 * there. {@link authFilePath} keeps returning that historical single answer.
 */
export function authFileCandidates(env = process.env) {
    const paths = [];
    const add = value => {
        if (typeof value === 'string' && value !== '' && !paths.includes(value))
            paths.push(value);
    };
    const appData = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : '';
    if (appData !== '')
        add(join(appData, 'Cursor', 'auth.json'));
    const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
    if (xdg !== '')
        add(join(xdg, 'cursor', 'auth.json'));
    // Honouring HOME through the injected environment keeps the "env is the
    // only input" contract the rest of this section promises (and lets a test
    // point the reader at a throw-away directory).
    const home = typeof env.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME.trim() : homedir();
    add(join(home, '.cursor', 'auth.json'));
    add(join(home, '.config', 'cursor', 'auth.json'));
    add(join(home, '.config', 'Cursor', 'auth.json'));
    return paths;
}

/**
 * The file the plugin has always named for the token.
 *
 * Kept as the historical public answer ("where is the token") for callers and
 * error messages; the reader itself walks {@link authFileCandidates}, because
 * the real store is Keychain on macOS.
 */
export function authFilePath(env = process.env) {
    const appData = env.APPDATA;
    if (typeof appData === 'string' && appData !== '')
        return join(appData, 'Cursor', 'auth.json');
    return join(homedir(), '.config', 'Cursor', 'auth.json');
}

/**
 * Read one generic password out of the macOS login Keychain.
 *
 * The CLI itself reads these items with `/usr/bin/security` — that is exactly
 * what its own keychain credential store does — so using the same tool keeps
 * this out-of-band read on the code path Cursor's login already relies on: no
 * native binding, no extra dependency, and the same failure modes when the
 * keychain is locked or the item is missing. `-g` prints the secret to stderr
 * as either `password: 0x<hex>` or, on newer macOS releases, as
 * `password: "<text>"`; both shapes are decoded here. The value is returned to
 * the caller and never logged.
 *
 * @param service - keychain item service name (e.g. `cursor-access-token`).
 * @param account - keychain item account; the CLI always uses `cursor-user`.
 * @param options - `securityPath` and `timeoutMs` exist for tests.
 */
async function keychainPassword(service, account = KEYCHAIN_ACCOUNT, options = {}) {
    const executable = options.securityPath ?? '/usr/bin/security';
    const timeout = options.timeoutMs ?? 5000;
    return await new Promise(resolve => {
        try {
            execFile(executable, ['find-generic-password', '-a', account, '-s', service, '-g'], { timeout, windowsHide: true }, (error, stdout, stderr) => {
                if (error !== null) {
                    // A locked keychain asks the user for approval through a GUI
                    // dialog; the timeout is what stops that from hanging a panel
                    // refresh, and the error must say so instead of claiming the
                    // item does not exist.
                    const reason = error.killed === true
                        ? `the keychain read timed out after ${timeout}ms (is the login keychain locked?)`
                        : error.message;
                    resolve({ ok: false, error: `no keychain item "${service}" for "${account}": ${reason}` });
                    return;
                }
                const text = `${stdout ?? ''}\n${stderr ?? ''}`;
                const hex = /^password: 0x([0-9a-fA-F]+)$/m.exec(text);
                const quoted = /^password: "(.*)"$/m.exec(text);
                let password;
                if (hex !== null)
                    password = Buffer.from(hex[1], 'hex').toString('utf8');
                else if (quoted !== null)
                    password = quoted[1].replace(/\\"/g, '"');
                if (typeof password !== 'string' || password === '') {
                    resolve({ ok: false, error: `cannot parse the keychain answer for "${service}"` });
                    return;
                }
                resolve({ ok: true, password });
            });
        }
        catch (error) {
            resolve({ ok: false, error: `cannot run ${executable}: ${errorText(error)}` });
        }
    });
}

/**
 * Read the access token the CLI is already signed in with.
 *
 * Every store the CLI may have used is tried, in the order the CLI itself
 * prefers on this platform: an explicit `CURSOR_AUTH_TOKEN` first (the CLI
 * accepts the same variable), then the macOS Keychain, then the file stores.
 * `AGENT_CLI_CREDENTIAL_STORE` is honoured so a CLI deliberately running on the
 * file store, or on the memory-only store, is not shadowed by a stale item.
 * The token is deliberately returned to the caller and never logged.
 *
 * @param env - environment source (injectable for tests).
 * @param options - `platform`, `securityPath` and `timeoutMs` exist for tests.
 */
export async function readAccessToken(env = process.env, options = {}) {
    const explicit = typeof env.CURSOR_AUTH_TOKEN === 'string' ? env.CURSOR_AUTH_TOKEN.trim() : '';
    if (explicit !== '')
        return { ok: true, path: 'CURSOR_AUTH_TOKEN', token: explicit };

    const platform = options.platform ?? process.platform;
    const store = typeof env.AGENT_CLI_CREDENTIAL_STORE === 'string' ? env.AGENT_CLI_CREDENTIAL_STORE.trim() : '';
    const filePaths = authFileCandidates(env);
    const attempted = [];

    // `memory` keeps the login in the CLI process only; nothing else can read
    // it, so only the environment variable above could have answered.
    if (store !== 'memory') {
        if (platform === 'darwin' && store !== 'file') {
            const keychain = await keychainPassword(KEYCHAIN_ACCESS_TOKEN_SERVICE, KEYCHAIN_ACCOUNT, {
                securityPath: options.securityPath,
                timeoutMs: options.timeoutMs,
            });
            if (keychain.ok === true)
                return { ok: true, path: `macOS keychain: ${KEYCHAIN_ACCESS_TOKEN_SERVICE} (${KEYCHAIN_ACCOUNT})`, token: keychain.password };
            attempted.push(keychain.error);
        }
        for (const path of filePaths) {
            let raw;
            try {
                raw = await readFile(path, 'utf8');
            }
            catch (error) {
                attempted.push(`cannot read ${path}: ${errorText(error)}`);
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch (error) {
                attempted.push(`cannot parse ${path}: ${errorText(error)}`);
                continue;
            }
            const token = parsed?.accessToken;
            if (typeof token !== 'string' || token === '') {
                attempted.push(`${path} has no accessToken field`);
                continue;
            }
            return { ok: true, path, token };
        }
    }

    const path = authFilePath(env);
    const stores = [];
    if (platform === 'darwin' && store !== 'file')
        stores.push(`macOS keychain "${KEYCHAIN_ACCESS_TOKEN_SERVICE}"`);
    stores.push(...filePaths);
    // "Missing" is the normal signed-out state and repeating one ENOENT per
    // candidate would bury the actionable sentence; a corrupt file or a locked
    // keychain is worth quoting because it needs a different fix.
    const failures = attempted.filter(reason => !/ENOENT|not be found|ItemNotFound/i.test(reason));
    const parts = [store === 'memory'
        ? `the Cursor CLI runs with AGENT_CLI_CREDENTIAL_STORE=memory, so its login is not readable by another process`
        : `no Cursor login found (tried: ${stores.join(', ')})`];
    if (store !== 'memory')
        parts.push(`sign the CLI in with "agent login"`);
    parts.push(`set CURSOR_AUTH_TOKEN to supply a token explicitly`);
    if (failures.length > 0)
        parts.push(`failures: ${failures.slice(0, 2).join('; ')}`);
    return { ok: false, path, error: parts.join('; ') };
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
 * The depth cap the next call would enforce, for the dashboard's first paint.
 *
 * The panel would otherwise have to guess between the stored choice and the
 * config default and would paint the wrong one for a moment. A settings file
 * that cannot be read falls back to the config value, exactly like `readSettings`.
 *
 * @param deps - route dependencies; `dataDir` and the config `maxChildDepth`.
 */
function effectiveDepthFor(deps) {
    try {
        return effectiveMaxChildDepth(readSettings(deps.dataDir), deps.maxChildDepth);
    }
    catch {
        return typeof deps.maxChildDepth === 'number' ? deps.maxChildDepth : 2;
    }
}

/**
 * The attribution state the dashboard paints first.
 *
 * Two facts, not one: the choice stored in this plugin's settings, and what
 * Cursor's own config file says right now. A panel that showed only the choice
 * would claim a state the CLI might not be in.
 *
 * @param deps - route dependencies; `dataDir` and the child environment.
 */
function attributionFor(deps) {
    try {
        const choice = readSettings(deps.dataDir).attribution;
        return { choice, ...readAttribution(deps.env) };
    }
    catch {
        return { choice: 'off', path: '', present: false, attribution: undefined };
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
    const { usage, quotaGuard, pool, index, journal, dataDir, mirrors, fence } = deps;
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
        const live = pool.snapshot();
        const conversations = index.list();
        const saved = new Map(conversations.map(entry => [conversationKeyOf(entry.key), entry]));
        const running = new Set(live.filter(entry => entry.running === true).map(entry => conversationKeyOf(entry.key)));
        const withRestore = entry => {
            const key = conversationKeyOf(entry.key);
            const recorded = saved.get(key);
            return {
                ...entry,
                restorable: typeof entry.cursorSessionId === 'string' && entry.cursorSessionId !== ''
                    && recorded?.cursorSessionId === entry.cursorSessionId && !running.has(key),
            };
        };
        const withActivity = entry => {
            const activity = journal?.lastActivity?.(entry.key);
            return activity === undefined ? entry : { ...entry, activity };
        };
        const withChild = entry => {
            const child = children.get(entry.key);
            const recorded = saved.get(conversationKeyOf(entry.key));
            // Native run disposal releases the live mirror; its persisted log is
            // still openable. Only use that address for the same Cursor session.
            const remembered = typeof entry.cursorSessionId === 'string'
                && recorded?.cursorSessionId === entry.cursorSessionId ? recorded : undefined;
            const childSessionId = child?.childSessionId ?? entry.childSessionId ?? remembered?.childSessionId;
            if (typeof childSessionId !== 'string' || childSessionId === '')
                return entry;
            return {
                ...entry,
                childSessionId,
                parentSessionId: child?.parentSessionId ?? entry.parentSessionId ?? remembered?.parentSessionId ?? parentOfKey(entry.key),
            };
        };
        return {
            live: live.map(withRestore).map(withActivity).map(withChild),
            conversations: conversations.map(withRestore).map(withActivity).map(withChild),
        };
    };

    const jsonRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/api/usage',
        handler: async (req, res) => {
            const force = typeof req?.url === 'string' && req.url.includes('force=1');
            const snapshot = await usage.get({ force });
            quotaGuard?.observeUsage?.(snapshot);
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
                    quotaGuard: quotaGuard?.snapshot?.() ?? { blocked: false },
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
                modelSource: bucket.modelSource,
                requestedModel: bucket.requestedModel,
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
            // A live row is shown under its generation-scoped pool key
            // (`parent::label#1`) but the durable index is keyed by the bare
            // conversation key (`parent::label`), so try both before giving up.
            const durableKey = conversationKeyOf(key);
            const entry = index?.get?.(key) ?? index?.get?.(durableKey);
            const live = pool.snapshot().filter(row => conversationKeyOf(row.key) === durableKey);
            const current = live.find(row => row.key === key);
            if (entry === undefined) {
                if (live.length > 0)
                    sendJson(res, 409, { ok: false, key, code: 'conversation_pending', error: 'that conversation has not completed a saved turn; open its live timeline instead' });
                else
                    sendJson(res, 404, { ok: false, key, error: 'no durable conversation for that key' });
            }
            else if (live.some(row => row.running === true))
                sendJson(res, 409, { ok: false, key, code: 'conversation_running', error: 'that conversation is still running; open its live timeline instead' });
            else if (current && current.cursorSessionId !== entry.cursorSessionId)
                sendJson(res, 409, { ok: false, key, code: 'conversation_pending', error: 'this generation has not completed a saved turn; open its live timeline instead' });
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
                            key: durableKey,
                            parentSessionId: parentOfKey(durableKey) ?? entry.parentSessionId,
                            cwd,
                            label: labelOfKey(durableKey),
                            model: entry.model,
                            events,
                        });
                    });
                    if (restored === undefined) {
                        sendJson(res, 502, { ok: false, key, error: 'the conversation could not be published as a child conversation' });
                        return;
                    }
                    const childSessionId = restored.child?.session?.header?.id;
                    const parentSessionId = restored.child?.session?.header?.parentSession ?? parentOfKey(durableKey);
                    // Remember it, so the next page load opens the restored
                    // conversation instead of offering to restore it again.
                    // Written under the durable key, the one `lib/tool.js` uses.
                    try {
                        await index.set(durableKey, { ...entry, childSessionId, updatedAt: Date.now() });
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

    /**
     * Forget one conversation: every trace of it, not just the row.
     *
     * The dashboard's delete button, and it deliberately does exactly what
     * `cursor_code`'s `resetSession` does — kill the live generations, drop the
     * journals, remove the durable index row and close the mirrored child —
     * because a row that vanished from the table while any of those survived
     * would come back on the next run and confuse the operator twice.
     *
     * Forgetting something already gone answers `ok` with zero counts: the
     * button's promise is "make it invisible", and a second click on a stale row
     * must not produce a scary 404.
     */
    const forgetRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/api/forget',
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
            // Same two key spaces as the restore route: a live row arrives
            // generation-scoped (`a::default#1`), the rest of the host knows the
            // bare conversation (`a::default`).
            const durableKey = conversationKeyOf(key);
            const entry = index?.get?.(key) ?? index?.get?.(durableKey);
            const live = pool.snapshot().filter(row => conversationKeyOf(row.key) === durableKey);
            // The pool goes first: a disposed session cannot append to the
            // journal or rewrite the index behind the deletions that follow.
            try {
                pool.dropConversation?.(durableKey);
            }
            catch (error) {
                ctx.logger?.warn?.(`dsh-cursor-dev: conversation ${durableKey} was not evicted: ${errorText(error)}`);
            }
            let journals = 0;
            try {
                if (typeof journal?.clearConversation === 'function')
                    journals = journal.clearConversation(durableKey);
                else
                    journal?.clear?.(durableKey);
            }
            catch (error) {
                ctx.logger?.warn?.(`dsh-cursor-dev: journal for ${durableKey} was not cleared: ${errorText(error)}`);
            }
            let indexes = 0;
            for (const each of new Set([durableKey, key])) {
                if (index?.get?.(each) === undefined)
                    continue;
                try {
                    await index.delete(each);
                    indexes += 1;
                }
                catch (error) {
                    ctx.logger?.warn?.(`dsh-cursor-dev: index row ${each} was not removed: ${errorText(error)}`);
                }
            }
            let mirrorsDropped = 0;
            if (typeof mirrors?.dropConversation === 'function') {
                try {
                    await mirrors.dropConversation(durableKey);
                    mirrorsDropped = 1;
                }
                catch (error) {
                    ctx.logger?.warn?.(`dsh-cursor-dev: mirror for ${durableKey} was not closed: ${errorText(error)}`);
                }
            }
            sendJson(res, 200, {
                ok: true,
                key,
                conversationKey: durableKey,
                existed: entry !== undefined || live.length > 0,
                dropped: { live: live.length, journals, index: indexes, mirrors: mirrorsDropped },
            });
        },
    };

    const dashboardRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/',
        handler: (req, res) => {
            sendHtml(res, dashboardHtml({
                ...panelState(),
                quotaGuard: quotaGuard?.snapshot?.() ?? { blocked: false },
                journal,
                dataDir,
                configModel: deps.configModel,
                // First paint only: the settings payload corrects this on load.
                // Seeding it here keeps the picker from briefly showing a cap the
                // operator never chose.
                effectiveMaxChildDepth: effectiveDepthFor(deps),
                // What Cursor's own config file says right now, so the first
                // paint can report the effect instead of the stored choice.
                attribution: attributionFor(deps),
                // Whether this host can open a mirrored child conversation at
                // all. When it cannot, a key click must keep opening the step
                // timeline instead of offering a jump nobody is listening for.
                childrenAvailable: mirrors?.available === true,
                // Which route the child CLI takes to reach Cursor. The panel
                // shows it next to the proxy box, because the models the picker
                // can offer depend on it.
                proxyRoute: typeof deps.proxyRoute === 'function' ? deps.proxyRoute() : '',
                proxyError: typeof deps.proxyError === 'function' ? deps.proxyError() : '',
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

    for (const route of [jsonRoute, journalRoute, restoreRoute, forgetRoute, dashboardRoute]) {
        try {
            registrations.push(server.register({
                ...route,
                // These routes are served outside the host's own `/api` carrier,
                // so its Host/Origin fence never sees them. Without this gate a
                // page on any other origin could POST to `/api/settings` (a CSRF
                // write) or to `/api/restore` (which spawns the CLI). The gate
                // answers and returns false when it refuses.
                handler: guard(route.path, (req, res) => {
                    if (fence !== undefined && fence(req, res) !== true)
                        return undefined;
                    return route.handler(req, res);
                }),
            }));
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
        quotaGuard: state.quotaGuard ?? { blocked: false },
        endpoint: '/plugins/dsh-cursor-dev/api/usage',
        journalEndpoint: '/plugins/dsh-cursor-dev/api/journal',
        restoreEndpoint: '/plugins/dsh-cursor-dev/api/restore',
        forgetEndpoint: '/plugins/dsh-cursor-dev/api/forget',
        settingsEndpoint: '/plugins/dsh-cursor-dev/api/settings',
        statusEndpoint: '/plugins/dsh-cursor-dev/status',
        settings: {
            model: settings.model,
            mode: settings.mode,
            language: settings.language,
            proxy: settings.proxy,
            attribution: settings.attribution,
            disabledModels: settings.disabledModels,
        },
        // The route a child process would take right now. Without it the panel
        // can only echo the box the operator typed in, which says nothing about
        // whether the missing models are actually being fetched.
        proxy: { route: state.proxyRoute ?? '', error: state.proxyError ?? '' },
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
        effectiveMaxChildDepth: state.effectiveMaxChildDepth ?? 2,
        // The stored choice plus what Cursor's own file says, so the first paint
        // can report the effect instead of repeating the choice back.
        attribution: state.attribution ?? { choice: settings.attribution, path: '', present: false },
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
    --hover: rgba(255, 255, 255, .04); --on-accent: #0d1020;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f6f6f8; --card: #ffffff; --line: #e2e2e8; --fg: #1c1c22;
      --muted: #6b6b76; --accent: #3b5bdb; --warn: #b26a00; --bad: #c92a2a; --good: #2b8a3e;
      --hover: rgba(0, 0, 0, .035); --on-accent: #ffffff;
    }
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0 auto; padding: 20px; max-width: 1080px; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
  h2 { font-size: 12px; margin: 0 0 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted); }
  .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .big { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .bar { height: 7px; border-radius: 4px; background: var(--line); overflow: hidden; margin: 8px 0 6px; }
  .bar > i { display: block; width: 0; height: 100%; background: var(--accent); transition: width .3s ease; }
  .bar.warn > i { background: var(--warn); }
  .bar.bad > i { background: var(--bad); }
  /* Keep the four usage figures in the same two-by-two layout as the panel. */
  .quota-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .quota-card { min-width: 0; min-height: 174px; padding: 16px 18px; border-radius: 12px; }
  .quota-card h2 { margin-bottom: 16px; font-size: 13px; letter-spacing: .02em; }
  .quota-card .big { font-size: 34px; font-weight: 700; letter-spacing: -.025em; overflow-wrap: anywhere; }
  .quota-card .bar { height: 8px; margin: 14px 0 8px; }
  .quota-card .muted { font-size: 13px; overflow-wrap: anywhere; }
  .quota-meta { margin-top: 12px; font-size: 12px; }
  .quota-period { display: flex; flex-wrap: wrap; gap: 2px 8px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  details.fold { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
  details.fold > summary { cursor: pointer; width: fit-content; max-width: 100%; color: var(--muted); font-size: 12px; border-radius: 4px; }
  details.fold > summary:hover { color: var(--fg); }
  .quota-meta > details.fold { margin-top: 8px; }
  .status { margin-top: 6px; font-size: 12px; }
  .quota-alert { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--bad);
    border-radius: 8px; background: var(--card); color: var(--bad); }
  .quota-alert[hidden] { display: none; }
  #model-state, #model-status, #message, #error, .note { overflow-wrap: anywhere; }
  /* A session key is one ~84-character token with no break opportunity, so an
     uncontained table stretches <body> instead of scrolling: the panel then
     grows a page-wide scrollbar and the cards drift off-screen. The scroll
     belongs to this wrapper, never to the page. */
  .tablewrap { overflow-x: auto; padding-bottom: 2px; }
  /* The history table is unbounded (one row per run ever made), so it scrolls
     inside a box of its own instead of stretching the card. The inner .tablewrap
     still owns the horizontal scroll; this box owns the vertical one. */
  #convos-body { max-height: 300px; overflow-y: auto; }
  /* A 300px window over a table with one row per run is useless if the column
     labels scroll away with the first row, so the header stays put. */
  #convos-body thead th { position: sticky; top: 0; background: var(--card); z-index: 1; }
  /* A section heading that doubles as the collapse control. */
  h2 > .disclose { color: inherit; text-decoration: none; }
  h2 > .disclose::before { content: '▾ '; color: var(--muted); }
  h2.collapsed > .disclose::before { content: '▸ '; }
  h2 > .disclose:hover { color: var(--accent); }
  h2 > .pill { margin-left: 8px; }
  td.act { white-space: nowrap; }
  /* One row is one run: model names and timestamps must not wrap into a second
     line, or a 300px window shows four rows instead of eight. The long key and
     path columns already clip themselves. */
  #convos td { white-space: nowrap; }
  a.link.danger { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; white-space: nowrap; }
  tbody tr:hover td { background: var(--hover); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* Long ids and paths are clipped, never stretched. */
  td.key { max-width: 320px; }
  td.path { max-width: 240px; }
  td.key > a, td.path > span {
    display: inline-block; max-width: 100%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
  }
  code { background: var(--line); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .row { margin-top: 18px; }
  .note { margin-top: 18px; color: var(--muted); font-size: 12px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    font-size: 11px; color: var(--muted); }
  .err { border-color: var(--bad); }
  .journal { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
  .journal h3 { font-size: 12px; margin: 0 0 8px; font-weight: 600; }
  .journal.warn { border-top-color: var(--warn); color: var(--warn); }
  .journal.bad { border-top-color: var(--bad); color: var(--bad); }
  .journal.ok { border-top-color: var(--good); color: var(--good); }
  .journal pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0;
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px;
    max-height: 260px; overflow: auto; font-size: 12px; }
  a.link { color: var(--accent); text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  a.link.on { color: var(--fg); font-weight: 600; }
  .langs { font-size: 12px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0 6px; }
  select, input[type="search"], input[type="text"], button {
    font: inherit; color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; padding: 5px 9px;
  }
  /* min() lets a control shrink inside a panel narrower than its usual minimum. */
  select { flex: 1 1 260px; min-width: min(180px, 100%); max-width: 100%; }
  input[type="search"] { flex: 0 1 200px; min-width: min(130px, 100%); max-width: 100%; }
  input[type="text"] { flex: 1 1 240px; min-width: min(150px, 100%); max-width: 100%; }
  select:focus, input[type="search"]:focus, input[type="text"]:focus { border-color: var(--accent); }
  button { cursor: pointer; transition: border-color .15s ease, background-color .15s ease; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; padding: 5px 16px; }
  button.primary:hover { background: var(--fg); border-color: var(--fg); color: var(--bg); }
  .lock { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; }
  /* The proxy is machine configuration, not the main choice, so it gets one
     thin strip above the picker rather than a box of its own. It stays open:
     a wrong proxy is the usual reason the model list looks short. */
  .env { margin-top: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .env .controls { margin: 0; }
  /* Each env row is one setting, and a row that follows an explanation needs to
     look like a new setting rather than the tail of the previous one. */
  .env .controls + .controls, .env .muted + .controls { margin-top: 10px; }
  .env input[type="text"] { font-size: 12px; padding: 4px 8px; }
  .env label { font-size: 12px; }
  button.ghost { color: var(--muted); }
  button[disabled] { opacity: .5; cursor: default; border-color: var(--line); }
  .filter-note { font-size: 12px; }
  /* The model browser: a searchable, filterable list on the left and the facts
     about the highlighted model on the right. It scrolls inside itself so the
     card stays a card no matter how long the catalogue gets. */
  .picker { margin-top: 12px; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .picker-top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .picker-top input[type="search"] { flex: 1 1 200px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 2px; }
  .tab { border: 0; background: transparent; color: var(--muted); padding: 4px 9px;
    border-radius: 6px; font: inherit; line-height: 1.4; }
  .tab:hover { border-color: transparent; background: var(--hover); }
  .tab.on { background: var(--hover); color: var(--fg); }
  .tab > b { font-weight: 600; opacity: .75; margin-left: 5px; font-variant-numeric: tabular-nums; }
  .picker-body { display: flex; align-items: stretch; }
  .picker-list { flex: 1 1 56%; min-width: 0; max-height: 250px; overflow-y: auto; }
  .picker-detail { flex: 1 1 44%; min-width: 0; max-height: 250px; overflow-y: auto;
    border-left: 1px solid var(--line); padding: 10px 12px; }
  @media (max-width: 620px) {
    .picker-body { display: block; }
    .picker-detail { border-left: 0; border-top: 1px solid var(--line); }
  }
  .mrow { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer;
    border-bottom: 1px solid var(--line); }
  .mrow:last-child { border-bottom: 0; }
  .mrow:hover { background: var(--hover); }
  .mrow.sel { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
  .mrow.off .mname { color: var(--muted); }
  .mrow > .mname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  /* A toggle is a checkbox the panel can drive, styled as a switch. */
  .sw { flex: none; appearance: none; -webkit-appearance: none; width: 32px; height: 18px;
    margin: 0; padding: 0; border: 0; border-radius: 999px; background: var(--line);
    position: relative; cursor: pointer; transition: background .15s ease; }
  .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
    border-radius: 50%; background: var(--fg); opacity: .9; transition: transform .15s ease; }
  .sw:checked { background: var(--accent); }
  .sw:checked::after { transform: translateX(14px); background: #fff; }
  .empty-row { padding: 14px 12px; color: var(--muted); font-size: 12px; }
  .dtitle { font-weight: 600; font-size: 13px; word-break: break-word; }
  .did { margin-top: 2px; color: var(--muted); font-size: 11px; word-break: break-all; }
  .drow { margin-top: 9px; font-size: 12px; }
  .drow > .k { color: var(--muted); display: block; }
  .drow > .v { word-break: break-all; }
  /* The settings page hands this dashboard a short slot and clips the
     overflow, so a tall layout hides everything that matters. When the
     viewport is short everything tightens and the long explanatory note
     goes away, which keeps the quota and the model picker in view. */
  body.compact { padding: 12px; }
  body.compact .head { margin-bottom: 10px; }
  body.compact .quota-grid { gap: 12px; }
  body.compact .card { padding: 8px 10px; border-radius: 8px; }
  body.compact h2 { margin-bottom: 6px; }
  body.compact .big { font-size: 20px; }
  body.compact .bar { height: 6px; margin: 6px 0 4px; }
  body.compact .row { margin-top: 12px; }
  body.compact .note { margin-top: 12px; }
  body.compact .controls { margin: 8px 0 4px; }
  body.compact .controls label { margin: 6px 0; }
  body.compact th, body.compact td { padding: 4px 7px; }
  body.compact [data-t="modelNote"], body.compact [data-t="modelHint"] { display: none; }
  body.compact .quota-card { min-height: 158px; padding: 14px 16px; border-radius: 12px; }
  body.compact .quota-card .big { font-size: 32px; }
  body.compact .quota-card .bar { height: 8px; margin: 12px 0 8px; }
  @media (max-width: 420px) {
    body { padding: 12px; }
    .quota-grid { grid-template-columns: minmax(0, 1fr); }
    .quota-card { min-height: 158px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; }
  }
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

<div id="quota-alert" class="quota-alert" role="alert" aria-live="assertive" hidden data-t="quotaBlocked">Cursor 额度已耗尽，已暂停新的子智能体任务；额度刷新确认恢复后会自动解除拦截。</div>
<div id="error" class="card err" style="display:none"></div>
<div id="setup" class="card" style="display:none"></div>

<!-- Usage stays above the model controls; each figure keeps its own card. -->
<section id="usage-overview" aria-labelledby="usage-title">
  <h2 class="sr-only" id="usage-title" data-t="usage">额度与用量</h2>
  <div class="quota-grid">
    <article class="card quota-card">
      <h2 id="total-label" data-t="included">总包含额度</h2>
      <div class="big" id="total-pct">—</div>
      <div class="bar" id="total-bar" role="progressbar" aria-labelledby="total-label" aria-valuemin="0" aria-valuemax="100"><i></i></div>
      <div class="muted" id="total-sub">—</div>
    </article>
    <article class="card quota-card">
      <h2 id="auto-label" data-t="auto">Auto 额度</h2>
      <div class="big" id="auto-pct">—</div>
      <div class="bar" id="auto-bar" role="progressbar" aria-labelledby="auto-label" aria-valuemin="0" aria-valuemax="100"><i></i></div>
      <div class="muted" id="auto-sub">—</div>
    </article>
    <article class="card quota-card">
      <h2 id="api-label" data-t="api">API / 指定模型额度</h2>
      <div class="big" id="api-pct">—</div>
      <div class="bar" id="api-bar" role="progressbar" aria-labelledby="api-label" aria-valuemin="0" aria-valuemax="100"><i></i></div>
      <div class="muted" id="api-sub">—</div>
    </article>
    <article class="card quota-card">
      <h2 data-t="spend">本期消费</h2>
      <div class="big" id="spend">—</div>
      <div class="muted" id="spend-sub" style="margin-top:8px">—</div>
    </article>
  </div>
  <div class="quota-meta muted">
    <div class="quota-period">
      <span data-t="period">计费周期</span>
      <span id="cycle">—</span>
    </div>
    <details class="fold" id="message-box" hidden>
      <summary data-t="officialNote">官方说明</summary>
      <div id="message"></div>
    </details>
  </div>
</section>

<section class="row card" id="modelcard" aria-labelledby="model-title">
  <h2 id="model-title" data-t="model">子智能体模型</h2>
  <!-- The choice comes first: it is the one thing this card exists for. -->
  <div class="controls">
    <select id="model" aria-labelledby="model-title"></select>
    <button type="button" id="model-save" class="primary" data-t="save">保存</button>
  </div>
  <div class="muted" data-t="modelHint"></div>
  <label class="lock">
    <input type="checkbox" id="model-lock">
    <span data-t="modelLock">锁定面板模型（忽略单次调用的 model 参数）</span>
  </label>
  <div class="status" id="model-status" role="status" aria-live="polite"></div>
  <!-- Everything below is how the child gets launched, not what it will say:
       the egress route and how deep in the delegate chain it may be started.
       The child CLI does not read the Windows registry, so a machine whose proxy
       lives only in Internet Settings gets a child that lists a fraction of the
       models. Empty means "ask the machine", which is what makes the full
       catalogue appear with nobody configuring anything. -->
  <div class="env">
    <div class="controls">
      <label class="muted" for="proxy" data-t="proxyLabel">代理</label>
      <input type="text" id="proxy" autocomplete="off" spellcheck="false">
    </div>
    <div class="controls">
      <label class="muted" for="depth" data-t="depthLabel">子代理深度</label>
      <select id="depth" aria-describedby="depth-hint"></select>
    </div>
    <div class="muted" id="depth-hint" data-t="depthHint"></div>
    <div class="controls">
      <label class="muted" for="attribution" data-t="attributionLabel">Cursor 署名</label>
      <select id="attribution" aria-describedby="attribution-hint"></select>
    </div>
    <div class="muted" id="attribution-hint" data-t="attributionHint"></div>
    <div class="muted" id="attribution-status"></div>
  </div>
  <!-- The catalogue the CLI reports is too long for a dropdown, so it gets a
       browser: search, filter, and a switch per model. Switching a model off
       only hides it from the picker — it is never deleted, so switching it
       back on restores the same entry. -->
  <details class="fold" id="model-browser">
    <summary data-t="modelBrowse">模型目录、搜索与来源</summary>
    <div class="controls">
      <button type="button" id="model-reload" class="ghost" data-t="reloadModels">重新读取模型列表</button>
    </div>
    <div class="picker">
      <div class="picker-top">
        <input type="search" id="model-filter" autocomplete="off" spellcheck="false">
        <div class="tabs" id="model-tabs"></div>
      </div>
      <div class="picker-body">
        <div class="picker-list" id="model-list"></div>
        <div class="picker-detail" id="model-detail"></div>
      </div>
    </div>
    <div class="muted" data-t="modelNote" style="margin-top:6px"></div>
    <!-- The catalogue and where it came from are one question — "is the list in
         front of me the real list?" — so the diagnostics sit in the same fold
         instead of a second one nobody opens. -->
    <div class="muted" id="model-state"></div>
  </details>
</section>

<div class="row card">
  <h2 data-t="live">运行中的 Cursor 会话</h2>
  <div class="tablewrap"><table><thead><tr>
    <th data-t="colKey">会话键</th><th data-t="colSession">会话号</th><th data-t="colModel">模型</th><th data-t="colMode">模式</th><th class="num" data-t="colTurns">轮次</th><th class="num" data-t="colIdle">空闲</th><th data-t="colDoing">正在做什么</th>
  </tr></thead><tbody id="live"></tbody></table></div>
  <div class="journal" id="journal" style="display:none"></div>
</div>

<div class="row card">
  <h2><a href="#" class="disclose" id="convos-toggle" data-t="conversations">历史会话（可恢复，重装后仍在）</a><span class="pill" id="convos-count">0</span></h2>
  <div class="muted" data-t="conversationsHint"></div>
  <!-- The history table grows one row per run the operator has ever made, so it
       gets its own bounded scroll box and can be dropped entirely: on a busy
       machine this card alone used to push everything else off the page. -->
  <div id="convos-body">
    <div class="tablewrap"><table><thead><tr>
      <th data-t="colKey">会话键</th><th data-t="colSession">会话号</th><th data-t="colWorkspace">工作目录</th><th data-t="colModel">模型</th><th class="num" data-t="colUpdated">更新时间</th><th class="num" data-t="colActions">操作</th>
    </tr></thead><tbody id="convos"></tbody></table></div>
  </div>
  <div class="journal" id="convos-notice" style="display:none"></div>
</div>

<div class="note" id="source"></div>

<script type="application/json" id="bootstrap">${bootstrap}</script>
<script>
(function () {
  var boot = JSON.parse(document.getElementById('bootstrap').textContent);
  var STORE_KEY = 'dsh-cursor-dev:lang';
  /** Where the "history table folded" choice is remembered. */
  var FOLD_KEY = 'dsh-cursor-dev:convos-folded';

  var T = {
    zh: {
      title: 'Cursor 子智能体',
      account: '账号',
      loading: '加载中…',
      refresh: '刷新',
      usage: '额度与用量',
      included: '总包含额度',
      used: '已用',
      auto: 'Auto 额度',
      api: 'API / 指定模型额度',
      spend: '本期消费',
      remaining: '剩余 ',
      noData: '暂无数据',
      levelWarn: '偏高',
      levelBad: '接近上限',
      officialNote: '官方说明',
      model: '子智能体模型',
      modelBrowse: '模型目录、搜索与来源',
      appliesNext: '下次调用生效',
      unsavedShort: '有改动未保存',
      seeAdvanced: '模型列表或代理有异常，见「模型目录、搜索与来源」',
      depthLabel: '子代理深度',
      depthHint: '决定「子代理里的代理」能不能再开一次 Cursor。Cursor 自己不会再往下派，所以 2 就是上限。',
      depthNone: '0 · 禁止（cursor_code 一律拒绝）',
      depthTop: '1 · 仅顶层代理可用',
      depthAll: '2 · 顶层与子代理都可用（默认）',
      depthInEffect: '当前生效：',
      attributionLabel: 'Cursor 署名',
      attributionHint: 'Cursor 会在子智能体提交的 commit 和 PR 上署名。开关在 Cursor 自己的 cli-config.json 里，改这里等于替你改那个文件，其余设置不动。新会话生效。',
      attributionOff: '不加 Cursor 署名（默认）',
      attributionOn: '保留 Cursor 署名',
      attributionKeep: '跟随 Cursor 自己的配置（本插件不写文件）',
      attributionNowOff: 'Cursor 当前：不加署名',
      attributionNowOn: 'Cursor 当前：会署名',
      attributionFailed: '写入 Cursor 配置失败：',
      modelHint: '默认跟随这里的模型；勾选锁定后，智能体传入的 model 参数也不会覆盖你的选择。',
      modelLock: '锁定面板模型（忽略单次调用的 model 参数）',
      modelLocked: '已锁定模型',
      modelOverridable: '单次调用可覆盖',
      modelSelected: '（已保存选择）',
      save: '保存',
      reloadModels: '重新读取模型列表',
      modelFilter: '搜索模型…',
      modelFiltered: '筛选',
      modelFilterNone: '（没有匹配的模型，清空搜索框可看全部）',
    tabAll: '全部',
    tabOn: '已开启',
    tabOff: '已关闭',
    tabAcp: 'ACP 清单',
    tabCli: '缓存',
    pickerEmpty: '（没有匹配的模型）',
    pickerHint: '点一行把它设为面板模型；右边的开关决定它是否出现在上面的下拉框里，关掉的模型只是藏起来，随时可以再打开。',
    detailId: '模型 ID',
    detailFamily: '家族',
    detailSource: '来源',
    detailParams: '参数',
    detailState: '状态',
    detailNone: '—',
    stateOn: '已开启',
    stateOff: '已关闭',
    statePanel: '面板模型',
    pickerSummary: '已开启',
    unsaved: '（开关改动未保存）',
      modelState: '可选模型',
      proxyLabel: '代理',
      proxyPlaceholder: '留空 = 自动检测系统代理 · none = 直连',
      proxyInEffect: '子进程出口：',
      proxyFailed: '代理不可用：',
      period: '计费周期',
      live: '运行中的 Cursor 会话',
      conversations: '历史会话（可恢复，重装后仍在）',
      conversationsHint: '点击会话键打开这次运行：有子智能体对话时直接跳过去；旧对话（这个功能上线前跑的）会当场从 Cursor 里读回来建成子会话；读不到才退回去展开轨迹。',
      colActions: '操作',
      forget: '删除',
      forgetArmed: '确认删除',
      forgetHint: '删除这条历史会话（会话记录、轨迹、镜像一起清掉）',
      forgetting: '正在删除这条历史会话…',
      forgetConfirm: '删除这条历史会话？它的会话记录、轨迹和镜像都会一起清掉，无法恢复。再点一次「确认删除」就执行。',
      forgetFailed: '删除失败：',
      forgotten: '已删除：',
      expandHint: '展开或收起历史会话列表',
      countRows: '条',
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
      quotaBlocked: 'Cursor 额度已耗尽，已暂停新的子智能体任务；额度刷新确认恢复后会自动解除拦截。',
      updated: '更新于 ',
      failed: '获取失败 ',
      includedIn: '套餐内 ',
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
      inEffect: '保存的默认模型：',
      configModel: '配置文件指定：',
      followingCli: '跟随配置 / CLI 默认',
      modelsAge: '列表更新于 ',
      modelsFailed: '无法读取模型列表：',
      noModels: '（模型列表为空，点「重新读取模型列表」）',
      modelsFromAcp: 'ACP 会话清单（这些 id 可以直接切换）',
      modelsFromCli: 'CLI --list-models（别名，仅作后备）',
      modelsFromCache: '缓存（来源未记录）',
      modelInUse: '（最近读取时使用）',
      modelUnavailable: '（当前不可用）',
      modelNote: '保存不会改变正在执行的任务。下一次调用会应用模型选择；未锁定时，调用中的 model 参数仍可覆盖。Auto 在 CLI 中的模型 id 为 default[]。',
      modelPending: '下次调用切换',
      modelConditional: '未被调用参数覆盖时使用',
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
      usage: 'Quota & usage',
      included: 'Included total',
      used: 'used',
      auto: 'Auto bucket',
      api: 'API / named bucket',
      spend: 'Spend this period',
      remaining: 'remaining ',
      noData: 'no data yet',
      levelWarn: 'high',
      levelBad: 'near the limit',
      officialNote: 'Official note',
      model: 'Child-agent model',
      modelBrowse: 'Model catalogue, search and sources',
      appliesNext: 'applies on the next call',
      unsavedShort: 'unsaved changes',
      seeAdvanced: 'model list or proxy problem — see Catalogue, search and sources',
      depthLabel: 'Subagent depth',
      depthHint: 'Whether a subagent may start a Cursor run of its own. Cursor never delegates further, so 2 is the ceiling.',
      depthNone: '0 · never (cursor_code always refuses)',
      depthTop: '1 · top-level agent only',
      depthAll: '2 · top-level and subagents (default)',
      depthInEffect: 'in effect: ',
      attributionLabel: 'Cursor credit',
      attributionHint: 'Cursor credits itself on the commits and pull requests its child makes. The switch lives in Cursor own cli-config.json, so changing it here edits that file and nothing else in it. New sessions only.',
      attributionOff: 'No Cursor credit (default)',
      attributionOn: 'Credit Cursor',
      attributionKeep: 'Leave Cursor own setting alone (this plugin writes nothing)',
      attributionNowOff: 'Cursor now: no credit',
      attributionNowOn: 'Cursor now: credits itself',
      attributionFailed: 'Could not write Cursor config: ',
      modelHint: 'Calls follow this default unless they specify a model. Lock it to prevent the agent from overriding your choice.',
      modelLock: 'Lock the panel model (ignore per-call model arguments)',
      modelLocked: 'model locked',
      modelOverridable: 'calls may override',
      modelSelected: '(saved selection)',
      save: 'Save',
      reloadModels: 'Reload model list',
      modelFilter: 'Search models…',
      modelFiltered: 'filter',
      modelFilterNone: '(no model matches — clear the search box to see them all)',
    tabAll: 'All',
    tabOn: 'On',
    tabOff: 'Off',
    tabAcp: 'ACP roster',
    tabCli: 'Cached',
    pickerEmpty: '(no model matches)',
    pickerHint: 'Click a row to make it the panel model; the switch decides whether it appears in the dropdown above. Switching a model off only hides it — you can always switch it back on.',
    detailId: 'Model id',
    detailFamily: 'Family',
    detailSource: 'Source',
    detailParams: 'Parameters',
    detailState: 'State',
    detailNone: '—',
    stateOn: 'on',
    stateOff: 'off',
    statePanel: 'panel model',
    pickerSummary: 'on',
    unsaved: '(switch changes are not saved yet)',
      modelState: 'available models',
      proxyLabel: 'Proxy',
      proxyPlaceholder: 'empty = detect the system proxy · none = no proxy',
      proxyInEffect: 'child egress: ',
      proxyFailed: 'proxy unusable: ',
      period: 'Billing period',
      live: 'Live Cursor sessions',
      conversations: 'Known conversations (durable)',
      conversationsHint: 'Click a key to open the run: its child conversation when there is one; an older run (made before this feature) is read back out of Cursor and published as one; only if that fails does the step timeline open instead.',
      colActions: 'actions',
      forget: 'Delete',
      forgetArmed: 'Confirm delete',
      forgetHint: 'Delete this history row (its index record, journal and mirror go too)',
      forgetting: 'Deleting this history row…',
      forgetConfirm: 'Delete this history row? Its index record, journal and mirror go with it, and it cannot be undone. Click Confirm delete to go ahead.',
      forgetFailed: 'Delete failed: ',
      forgotten: 'Deleted: ',
      expandHint: 'Fold or unfold the history list',
      countRows: 'rows',
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
      quotaBlocked: 'Cursor quota is exhausted. New child-agent runs are paused until a quota refresh confirms capacity has returned.',
      updated: 'updated ',
      failed: 'failed ',
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
      inEffect: 'saved default: ',
      configModel: 'from config: ',
      followingCli: 'Follow config / CLI default',
      modelsAge: 'list from ',
      modelsFailed: 'could not read the model list: ',
      noModels: '(no models listed — press Reload model list)',
      modelsFromAcp: 'ACP session roster (these ids can be switched to)',
      modelsFromCli: 'CLI --list-models (aliases, fallback only)',
      modelsFromCache: 'cache (source never recorded)',
      modelInUse: '(used when last read)',
      modelUnavailable: '(currently unavailable)',
      modelNote: 'Saving does not change a running task. The next call applies the selection; when unlocked, its model argument may override it. The CLI identifies Auto as default[].',
      modelPending: 'switches on the next call',
      modelConditional: 'used unless the call overrides it',
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
  var settings = boot.settings || { model: '', mode: '', language: '', proxy: '', disabledModels: [] };
  // The route the child CLI actually takes, as the host last resolved it. Shown
  // next to the proxy box because that route — not the box — decides how many
  // models the picker can offer.
  var proxyRoute = (boot.proxy && boot.proxy.route) || '';
  var proxyError = (boot.proxy && boot.proxy.error) || '';
  var models = (boot.models && boot.models.list) || [];
  var modelsFetchedAt = (boot.models && boot.models.fetchedAt) || 0;
  var modelsSource = (boot.models && boot.models.source) || '';
  var quotaGate = boot.quotaGuard || { blocked: false };
  var configModel = boot.configModel || '';
  // What the plugin will actually enforce on the next call: the panel value if
  // one was saved, otherwise the config default. The server computes it, so the
  // panel never has to guess which of the two wins.
  var effectiveDepth = typeof boot.effectiveMaxChildDepth === 'number'
    ? boot.effectiveMaxChildDepth : 2;
  // The depth picker's choices: the value the tool compares against, then the
  // dictionary key for its label. Ordered shallowest first.
  var DEPTH_CHOICES = [['0', 'depthNone'], ['1', 'depthTop'], ['2', 'depthAll']];
  // Whether the child credits Cursor in the commits it makes. The switch is not
  // ours — it is a key in Cursor own config file — so the panel tracks both the
  // choice and what that file says right now.
  var attributionChoice = boot.attribution && boot.attribution.choice
    ? boot.attribution.choice : 'off';
  var attributionState = boot.attribution || null;
  var ATTRIBUTION_CHOICES = [['off', 'attributionOff'], ['on', 'attributionOn'], ['keep', 'attributionKeep']];
  var setupState = null;
  var LANG = pickLang();

  /**
   * The settings page gives this dashboard a slot that can be only ~180px
   * tall, so the whole page has to stay legible inside that. A short viewport
   * turns on the tight styles (see body.compact) and the long note is dropped.
   */
  function applyCompact() {
    try {
      var short = typeof window !== 'undefined'
        && typeof window.innerHeight === 'number'
        && window.innerHeight > 0
        && window.innerHeight < 470;
      var body = document.body;
      if (body && body.classList) body.classList[short ? 'add' : 'remove']('compact');
    }
    catch (error) { /* a stubbed DOM in the tests has no classList */ }
  }
  applyCompact();
  try { window.addEventListener('resize', applyCompact); } catch (error) { /* no window in tests */ }

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
    renderQuotaGuard(quotaGate);
    if (lastPayload.ok === true) render(lastPayload);
    else renderLive(lastPayload);
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

  function known(value) { return typeof value === 'number' && isFinite(value); }
  function pct(value) {
    return known(value) ? value.toFixed(1) + '%' : '—';
  }
  /** The note under a bar, read off the same upstream percentage as the bar. */
  function remaining(value) {
    if (!known(value)) return t('noData');
    var level = value >= 90 ? ' · ' + t('levelBad') : value >= 70 ? ' · ' + t('levelWarn') : '';
    return t('remaining') + Math.max(0, 100 - value).toFixed(1) + '%' + level;
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
    var p = known(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    bar.firstElementChild.style.width = p + '%';
    bar.className = 'bar' + (p >= 90 ? ' bad' : p >= 70 ? ' warn' : '');
    if (known(percent)) bar.setAttribute('aria-valuenow', String(p));
    else bar.removeAttribute('aria-valuenow');
    bar.setAttribute('aria-valuetext', known(percent) ? pct(percent) : t('noData'));
  }

  /** Compare the CLI's Auto id with the panel alias without conflating variants. */
  function canonicalModel(value) {
    var id = String(value || '').trim();
    var lower = id.toLowerCase();
    return lower === 'auto' || lower === 'default[]' || lower === 'default' ? 'default[]' : id;
  }
  function modelLabel(value) {
    return canonicalModel(value) === 'default[]' ? 'Auto' : (value || t('followingCli'));
  }

  /** The saved deny list, or the pending one while the operator is editing. */
  function disabledModels() {
    var source = draftDisabled === null ? settings.disabledModels : draftDisabled;
    if (!Array.isArray(source)) return [];
    var seen = {};
    var out = [];
    source.forEach(function (value) {
      var id = canonicalModel(value);
      if (id === '' || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  /** Whether the browser should show this model as switched off. */
  function isDisabled(id) {
    return disabledModels().indexOf(canonicalModel(id)) !== -1;
  }

  /** Flip one model's switch into the pending list. */
  function setDisabled(id, off) {
    var target = canonicalModel(id);
    var next = disabledModels().filter(function (value) { return value !== target; });
    if (off) next.push(target);
    draftDisabled = next;
  }

  /** Whether the switches on screen differ from the ones on disk. */
  function switchesDirty() {
    if (draftDisabled === null) return false;
    var saved = Array.isArray(settings.disabledModels) ? settings.disabledModels.map(canonicalModel) : [];
    var next = disabledModels();
    if (saved.length !== next.length) return true;
    for (var i = 0; i < next.length; i += 1) {
      if (saved.indexOf(next[i]) === -1) return true;
    }
    return false;
  }

  /** The base name inside a model id: everything before the first '['. */
  function baseOf(id) {
    var text = String(id == null ? '' : id);
    var open = text.indexOf('[');
    return open === -1 ? text : text.slice(0, open);
  }

  /** The '...' parameter list inside a model id, brackets removed. */
  function paramsOf(id) {
    var text = String(id == null ? '' : id);
    var open = text.indexOf('[');
    if (open === -1 || text.charAt(text.length - 1) !== ']') return '';
    return text.slice(open + 1, text.length - 1);
  }

  /** One deduped row per model, in the order the CLI reported them. */
  function modelRows() {
    var seen = {};
    var out = [];
    models.forEach(function (entry) {
      var id = canonicalModel(entry.id);
      if (id === '' || seen[id]) return;
      seen[id] = true;
      out.push({
        id: id,
        name: entry.name == null || entry.name === '' ? baseOf(id) : String(entry.name),
        source: entry.source === 'acp' ? 'acp' : 'cache',
        current: entry.current === true
      });
    });
    return out;
  }

  /** Does one row survive the active chip? */
  function inTab(row) {
    if (modelTab === 'on') return !isDisabled(row.id);
    if (modelTab === 'off') return isDisabled(row.id);
    if (modelTab === 'acp') return row.source === 'acp';
    if (modelTab === 'cache') return row.source === 'cache';
    return true;
  }

  /** The chips, with the count each one would show. */
  function tabsFor(rows) {
    var counts = { all: rows.length, on: 0, off: 0, acp: 0, cache: 0 };
    rows.forEach(function (row) {
      if (isDisabled(row.id)) counts.off += 1; else counts.on += 1;
      counts[row.source] += 1;
    });
    return [
      { key: 'all', label: 'tabAll' },
      { key: 'on', label: 'tabOn' },
      { key: 'off', label: 'tabOff' },
      { key: 'acp', label: 'tabAcp' },
      { key: 'cache', label: 'tabCli' }
    ].filter(function (tab) { return tab.key === 'all' || tab.key === 'on' || tab.key === 'off'
      || counts[tab.key] > 0; })
      .map(function (tab) {
        return { key: tab.key, label: t(tab.label), count: counts[tab.key] };
      });
  }
  function renderModel() {
    var select = $('model');
    select.textContent = '';
    var filter = $('model-filter');
    if (filter) {
      filter.placeholder = t('modelFilter');
      filter.title = t('modelFilter');
      if (filter.value !== modelFilter) filter.value = modelFilter;
    }
    var proxyBox = $('proxy');
    if (proxyBox) {
      proxyBox.placeholder = t('proxyPlaceholder');
      proxyBox.title = t('proxyPlaceholder');
      // Never clobber a half-typed value: the panel repaints on every poll.
      var configuredProxy = settings.proxy == null ? '' : String(settings.proxy);
      if (proxyBox !== document.activeElement && proxyBox.value !== configuredProxy) {
        proxyBox.value = configuredProxy;
      }
    }
    var depthBox = $('depth');
    if (depthBox && depthBox.options) {
      if (depthBox.options.length === 0) {
        DEPTH_CHOICES.forEach(function (pair) {
          var option = document.createElement('option');
          option.value = pair[0];
          depthBox.appendChild(option);
        });
      }
      // Relabelled every paint, so a language switch renames them in place
      // without the <option> elements carrying their own data-t.
      for (var di = 0; di < depthBox.options.length; di += 1) {
        if (DEPTH_CHOICES[di]) depthBox.options[di].textContent = t(DEPTH_CHOICES[di][1]);
      }
      // Same rule as the proxy box: a value the operator just picked survives
      // the poll that arrives before they press 保存.
      if (depthBox !== document.activeElement) depthBox.value = String(effectiveDepth);
    }
    var attributionBox = $('attribution');
    if (attributionBox && attributionBox.options) {
      if (attributionBox.options.length === 0) {
        ATTRIBUTION_CHOICES.forEach(function (pair) {
          var option = document.createElement('option');
          option.value = pair[0];
          attributionBox.appendChild(option);
        });
      }
      for (var ai = 0; ai < attributionBox.options.length; ai += 1) {
        if (ATTRIBUTION_CHOICES[ai]) attributionBox.options[ai].textContent = t(ATTRIBUTION_CHOICES[ai][1]);
      }
      if (attributionBox !== document.activeElement) attributionBox.value = String(attributionChoice);
    }
    // The choice is ours to store; whether it took effect is Cursor's answer, so
    // the line under the picker reports the file rather than repeating the pick.
    var attributionNote = $('attribution-status');
    if (attributionNote) {
      var state = attributionState;
      if (state && state.error) {
        attributionNote.textContent = t('attributionFailed') + state.error;
      }
      else if (state && state.attribution) {
        attributionNote.textContent = state.attribution.attributeCommitsToAgent === false
          ? t('attributionNowOff') : t('attributionNowOn');
      }
      else {
        attributionNote.textContent = '';
      }
    }
    var query = modelFilter.trim().toLowerCase();
    var fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = t('followingCli');
    select.appendChild(fallback);
    var selected = canonicalModel(draftModel === null ? settings.model : draftModel);
    var inEffectNow = settings.model || configModel || '';
    var rows = modelRows();
    var hidden = rows.filter(function (row) { return isDisabled(row.id); }).length;
    var total = 0;
    var shown = 0;
    rows.forEach(function (row) {
      // A switched-off model is not offered, but the saved choice still is:
      // hiding it would make the picker look like it had silently reverted
      // to "follow the CLI".
      if (isDisabled(row.id) && row.id !== selected) return;
      total += 1;
      if (query && row.id !== selected) {
        var hay = row.id + ' ' + row.name;
        if (hay.toLowerCase().indexOf(query) === -1) return;
      }
      shown += 1;
      var option = document.createElement('option');
      option.value = row.id;
      var label = row.name === row.id ? row.id : row.name + ' (' + row.id + ')';
      if (row.id === selected) label += ' ' + t('modelSelected');
      if (row.current === true) label += ' ' + t('modelInUse');
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = selected;
    if (select.value !== selected) {
      var kept = document.createElement('option');
      kept.value = selected;
      kept.textContent = modelLabel(settings.model) + ' ' + t('modelUnavailable');
      select.appendChild(kept);
      select.value = selected;
    }
    $('model-lock').checked = settings.modelPolicy === 'panel';
    var bits = [];
    bits.push(t('inEffect') + modelLabel(inEffectNow));
    bits.push(t(settings.modelPolicy === 'panel' && inEffectNow ? 'modelLocked' : 'modelOverridable'));
    if (configModel) bits.push(t('configModel') + modelLabel(configModel));
    if (models.length === 0) bits.push(t('noModels'));
    else if (query && shown === 0) bits.push(t('modelFilterNone'));
    else bits.push(t('modelState') + ': ' + shown
      + (query ? ' / ' + total + ' ' + t('modelFiltered') : '')
      + (hidden > 0 ? ' · ' + t('tabOff') + ' ' + hidden : '')
      + (switchesDirty() ? ' · ' + t('unsaved') : '')
      + (modelsFetchedAt ? ' · ' + t('modelsAge') + when(modelsFetchedAt) : ''));
    if (modelsSource === 'acp') bits.push(t('modelsFromAcp'));
    else if (modelsSource === 'cli') bits.push(t('modelsFromCli'));
    else if (modelsSource === 'cache') bits.push(t('modelsFromCache'));
    // The egress route explains the model count: a child that reaches Cursor
    // directly only ever sees the subset the direct route publishes.
    if (proxyRoute) bits.push(t('proxyInEffect') + proxyRoute);
    if (proxyError) bits.push(t('proxyFailed') + proxyError);
    if (modelsError) bits.push(t('modelsFailed') + modelsError);
    text($('model-state'), bits.join('  ·  '));
    var dirty = (draftModel !== null && canonicalModel(draftModel) !== canonicalModel(settings.model)) || switchesDirty();
    var status = [t('inEffect') + modelLabel(inEffectNow),
      t(settings.modelPolicy === 'panel' && inEffectNow ? 'modelLocked' : 'modelOverridable'),
      t(dirty ? 'unsavedShort' : 'appliesNext')];
    if (modelsError || proxyError) status.push(t('seeAdvanced'));
    text($('model-status'), status.join(' · '));
    renderPicker(rows, selected, inEffectNow);
  }

  /** Selecting a row moves the dropdown; 保存 is still what commits it. */
  function pickModel(id) {
    draftModel = canonicalModel(id);
    renderModel();
  }

  /** The right-hand pane: what this host knows about the highlighted model. */
  function renderDetail(node, rows, selected) {
    node.textContent = '';
    var row = null;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].id === selected) { row = rows[i]; break; }
    }
    if (row === null) {
      var none = document.createElement('div');
      none.className = 'empty-row';
      none.textContent = t('followingCli');
      node.appendChild(none);
      return;
    }
    var title = document.createElement('div');
    title.className = 'dtitle';
    title.textContent = row.name;
    node.appendChild(title);
    var id = document.createElement('div');
    id.className = 'did';
    id.textContent = row.id;
    node.appendChild(id);

    var params = paramsOf(row.id);
    [
      { key: 'detailFamily', value: baseOf(row.id) },
      { key: 'detailSource', value: row.source === 'acp' ? t('tabAcp') : t('tabCli') },
      { key: 'detailParams', value: params === '' ? t('detailNone') : params }
    ].forEach(function (fact) {
      var line = document.createElement('div');
      line.className = 'drow';
      var key = document.createElement('span');
      key.className = 'k';
      key.textContent = t(fact.key);
      var value = document.createElement('span');
      value.className = 'v';
      value.textContent = fact.value;
      line.appendChild(key);
      line.appendChild(value);
      node.appendChild(line);
    });

    var state = [isDisabled(row.id) ? t('stateOff') : t('stateOn')];
    if (row.id === canonicalModel(settings.model)) state.push(t('statePanel'));
    if (row.current === true) state.push(t('modelInUse'));
    var stateLine = document.createElement('div');
    stateLine.className = 'drow';
    var stateKey = document.createElement('span');
    stateKey.className = 'k';
    stateKey.textContent = t('detailState');
    var stateValue = document.createElement('span');
    stateValue.className = 'v';
    stateValue.textContent = state.join(' · ');
    stateLine.appendChild(stateKey);
    stateLine.appendChild(stateValue);
    node.appendChild(stateLine);
  }

  /**
   * Draw the model browser: the chips, the list, and the facts about the
   * highlighted model.
   *
   * It renders from the same deduped rows as the dropdown, so the two can
   * never disagree about which models this host knows.
   */
  function renderPicker(rows, selected) {
    var tabs = $('model-tabs');
    var list = $('model-list');
    var detail = $('model-detail');
    if (!tabs || !list || !detail) return;

    var chips = tabsFor(rows);
    // A chip that stopped existing (its last model was switched off) must not
    // leave the browser filtering by something the user can no longer see.
    if (!chips.some(function (chip) { return chip.key === modelTab; })) modelTab = 'all';
    tabs.textContent = '';
    chips.forEach(function (chip) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab' + (chip.key === modelTab ? ' on' : '');
      button.textContent = chip.label;
      var count = document.createElement('b');
      count.textContent = String(chip.count);
      button.appendChild(count);
      button.addEventListener('click', function () {
        modelTab = chip.key;
        renderModel();
      });
      tabs.appendChild(button);
    });

    var query = modelFilter.trim().toLowerCase();
    var visible = rows.filter(function (row) {
      if (!inTab(row)) return false;
      if (query === '') return true;
      return (row.id + ' ' + row.name).toLowerCase().indexOf(query) !== -1;
    });

    list.textContent = '';
    if (visible.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty-row';
      empty.textContent = rows.length === 0 ? t('noModels') : t('pickerEmpty');
      list.appendChild(empty);
    }
    visible.forEach(function (row) {
      var off = isDisabled(row.id);
      var line = document.createElement('div');
      line.className = 'mrow' + (row.id === selected ? ' sel' : '') + (off ? ' off' : '');
      line.title = t('pickerHint');
      var name = document.createElement('span');
      name.className = 'mname';
      name.textContent = row.name;
      line.appendChild(name);
      // A switch is a checkbox: the panel paints it, the browser owns the
      // keyboard behaviour, and the row underneath still handles the click.
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'sw';
      box.checked = !off;
      box.title = off ? t('stateOff') : t('stateOn');
      box.addEventListener('click', function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      });
      box.addEventListener('change', function () {
        setDisabled(row.id, box.checked === false);
        renderModel();
      });
      line.appendChild(box);
      line.addEventListener('click', function (event) {
        if (event && event.target && event.target.className === 'sw') return;
        pickModel(row.id);
      });
      list.appendChild(line);
    });

    renderDetail(detail, rows, selected);
  }

  /**
   * A session key squeezed to something a 320px column can hold.
   *
   * The raw key is 'session-<36-char uuid>::<label>'; both halves are longer
   * than the column, and neither has a break opportunity, so the middle of each
   * half is elided and the whole value stays available as the cell's tooltip.
   */
  function shortKey(key) {
    var value = String(key == null ? '' : key);
    var mark = value.indexOf('::');
    if (mark <= 0) return value;
    var head = value.slice(0, mark).replace(/^session-/, '');
    var tail = value.slice(mark + 2);
    if (head.length > 13) head = head.slice(0, 8) + '…' + head.slice(-4);
    if (tail.length > 22) tail = tail.slice(0, 21) + '…';
    return head + ' :: ' + tail;
  }

  /** One cell. A spec with link:true is clickable; 'on' marks it as the open one. */
  function cell(spec, entry) {
    var td = document.createElement('td');
    if (spec.num) td.className = 'num';
    if (spec.cls) td.className = spec.cls;
    if (spec.link) {
      var a = document.createElement('a');
      a.className = 'link' + (spec.on && spec.on(entry) ? ' on' : '')
        + (spec.danger ? ' danger' : '');
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
    // A passive cell can still want a tooltip: the text is clipped to fit.
    var span = document.createElement('span');
    text(span, spec.value(entry));
    if (spec.title) span.title = spec.title(entry);
    td.appendChild(span);
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
    return boot.children.available === true && entry.restorable !== false && entry.running !== true
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
        if (body.code === 'conversation_pending' || body.code === 'conversation_running') {
          openJournal(entry.key);
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
   * One history row's delete control.
   *
   * Destroying a row is irreversible here (the index, the journal and the
   * mirrored child all go), so the first click only arms the link and the second
   * one within the same row does the work. Armed state lives in a module-level
   * variable rather than in the DOM because the table is re-rendered by the
   * poll: a pending confirmation must survive a re-render of its own row.
   */
  function forgetRow(entry) {
    var key = entry.key;
    if (armedFor !== key) {
      armedFor = key;
      forgetNotice(t('forgetConfirm'), 'warn');
      renderLive(lastPayload || {});
      return;
    }
    armedFor = '';
    forgetNotice(t('forgetting'), '');
    fetch(boot.forgetEndpoint + '?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
      .then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      })
      .then(function (answer) {
        var body = answer.body || {};
        if (answer.ok === true && body.ok === true) {
          if (journalKey === key) {
            journalKey = '';
            var panel = $('journal');
            panel.style.display = 'none';
            panel.textContent = '';
          }
          // The row is gone on disk, so drop it from the payload that is about
          // to be re-painted instead of waiting for the next poll to notice.
          var extended = lastPayload && lastPayload.extended;
          if (extended && Array.isArray(extended.conversations)) {
            extended.conversations = extended.conversations.filter(function (row) { return row.key !== key; });
          }
          forgetNotice(t('forgotten') + shortKey(key), 'ok');
          renderLive(lastPayload || {});
          return;
        }
        forgetNotice(t('forgetFailed') + (body.error || 'unknown error'), 'bad');
        renderLive(lastPayload || {});
      })
      .catch(function (error) {
        forgetNotice(t('forgetFailed') + (error && error.message ? error.message : String(error)), 'bad');
        renderLive(lastPayload || {});
      });
  }

  /** One line of feedback under the history table (never the journal panel). */
  function forgetNotice(message, tone) {
    var host = $('convos-notice');
    if (!host) return;
    host.style.display = message === '' ? 'none' : '';
    host.className = 'journal' + (tone ? ' ' + tone : '');
    host.textContent = message;
  }

  /**
   * Fold or unfold the history table.
   *
   * The card is the longest thing on the page on a busy machine, and the fold
   * state is remembered per browser so a panel that fits the operator's screen
   * stays that way across reloads and language switches.
   */
  function setFolded(folded) {
    convosFolded = folded === true;
    try { window.localStorage.setItem(FOLD_KEY, convosFolded ? '1' : '0'); } catch (e) { /* private mode */ }
    applyFolded();
  }
  function applyFolded() {
    var body = $('convos-body');
    if (body) body.style.display = convosFolded ? 'none' : '';
    var title = $('convos-toggle');
    if (title && title.parentNode && title.parentNode.classList) {
      title.parentNode.classList[convosFolded ? 'add' : 'remove']('collapsed');
    }
    if (title) title.title = t('expandHint');
  }
  /** The row count pill next to the heading. */
  function renderCount(count) {
    var pill = $('convos-count');
    if (!pill) return;
    pill.textContent = String(count) + ' ' + t('countRows');
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
  /** The row whose delete is armed; empty means nothing is pending. */
  var armedFor = '';
  /** Whether the history table is folded; remembered per browser. */
  var convosFolded = false;
  try { convosFolded = window.localStorage.getItem(FOLD_KEY) === '1'; } catch (e) { convosFolded = false; }
  /** Live text in the model search box; survives a re-render and a language switch. */
  var modelFilter = '';
  /** Which chip is active in the model browser; also survives a re-render. */
  var modelTab = 'all';
  /**
   * Switches the operator has flipped but not saved yet.
   *
   * Null means "nothing pending, read the saved list", so a save or a fresh
   * payload drops the draft without having to diff anything.
   */
  var draftDisabled = null;
  /** A row the operator picked but has not saved; null means "use the saved one". */
  var draftModel = null;

  /** Saved preference is conditional unless the operator locks the panel model. */
  function modelCell(current) {
    var target = settings.model || configModel || '';
    if (!current) return current;
    if (!target || canonicalModel(current) === canonicalModel(target)) return modelLabel(current);
    var hint = settings.modelPolicy === 'panel' ? 'modelPending' : 'modelConditional';
    return modelLabel(current) + ' → ' + modelLabel(target) + '（' + t(hint) + '）';
  }

  function renderLive(payload) {
    var live = (payload.extended && payload.extended.live) || boot.live || [];
    var convos = (payload.extended && payload.extended.conversations) || boot.conversations || [];
    rows($('live'), live, [
      { value: function (e) { return shortKey(e.key); }, cls: 'key', link: true, onClick: openRow,
        on: function (e) { return journalKey === e.key; },
        title: function (e) { return e.key + '  —  ' + rowHint(e); } },
      { value: function (e) { return e.cursorSessionId ? String(e.cursorSessionId).slice(0, 8) : '—'; } },
      { value: function (e) { return modelCell(e.model); } },
      { value: function (e) { return e.mode; } },
      { value: function (e) { return e.turns; }, num: true },
      { value: function (e) { return ago(e.idleMs); }, num: true },
      { value: function (e) { return e.activity ? e.activity.text : (e.alive === false ? '—' : ''); } }
    ]);
    rows($('convos'), convos, [
      { value: function (e) { return shortKey(e.key); }, cls: 'key', link: true, onClick: openRow,
        on: function (e) { return journalKey === e.key; },
        title: function (e) { return e.key + '  —  ' + rowHint(e); } },
      { value: function (e) { return e.cursorSessionId ? String(e.cursorSessionId).slice(0, 8) : '—'; } },
      { value: function (e) { return e.workspaceRoot; }, cls: 'path',
        title: function (e) { return e.workspaceRoot; } },
      { value: function (e) { return e.model; } },
      { value: function (e) { return when(e.updatedAt); }, num: true },
      { value: function (e) { return armedFor === e.key ? t('forgetArmed') : t('forget'); },
        cls: 'act', link: true, danger: true, onClick: forgetRow,
        title: function () { return t('forgetHint'); } }
    ]);
    renderCount(convos.length);
    applyFolded();
  }
  function renderQuotaGuard(state) {
    if (state && typeof state.blocked === 'boolean') quotaGate = state;
    $('quota-alert').hidden = quotaGate.blocked !== true;
  }
  function render(payload) {
    lastPayload = payload;
    var gate = payload.extended && payload.extended.quotaGuard;
    if (gate) renderQuotaGuard(gate);
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
    var d = u.dollars || {};
    // Every percentage is the upstream percentUsed: the dollar fields count
    // different things (spend includes bonus, limit does not), so a ratio of
    // them disagrees with the bar.
    ['total', 'auto', 'api'].forEach(function (name) {
      var p = u[name] && u[name].percentUsed;
      setBar(name + '-bar', p);
      text($(name + '-pct'), pct(p));
      text($(name + '-sub'), remaining(p));
    });
    $('auto-sub').title = u.autoMessage || '';
    $('api-sub').title = u.namedMessage || '';
    text($('tier'), u.plan || payload.tier || t('account'));
    text($('spend'), money(d.total));
    text($('spend-sub'), t('includedIn') + money(d.included) + t('bonus') + money(d.bonus));
    var cycle = u.billingCycle || {};
    text($('cycle'), known(cycle.start) || known(cycle.end)
      ? t('starts') + when(cycle.start) + t('renews') + when(cycle.end) : t('noData'));
    text($('message'), u.displayMessage || '');
    $('message-box').hidden = !u.displayMessage;
    text($('stamp'), t('updated') + when(payload.fetchedAt));
    text($('source'), t('source') + (payload.source || '') + (payload.authPath ? t('credentials') + payload.authPath : ''));
    renderLive(payload);
  }

  var modelsError = '';
  /**
   * Follow the host's egress route.
   *
   * The route, not the box the operator typed in, is what decides how many
   * models exist, so leaving a stale value on screen would explain the wrong
   * model count.
   *
   * @param data - a settings payload.
   */
  function applyProxy(data) {
    if (!data || !data.proxy) return;
    if (typeof data.proxy.route === 'string') proxyRoute = data.proxy.route;
    if (typeof data.proxy.error === 'string') proxyError = data.proxy.error;
  }
  function applyAttribution(data) {
    if (!data || !data.attribution) return;
    var block = data.attribution;
    if (typeof block.choice === 'string' && block.choice !== '') attributionChoice = block.choice;
    attributionState = block;
  }
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
        if (typeof data.effectiveMaxChildDepth === 'number') effectiveDepth = data.effectiveMaxChildDepth;
        applyAttribution(data);
        applyProxy(data);
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
        // The answer already carries what Cursor file says after the write, so
        // the line under the picker reports the result rather than the intent.
        applyAttribution(data);
        applyProxy(data);
        renderModel();
        return data;
      })
      .catch(function (e) {
        text($('model-state'), t('saveFailed') + String(e));
        text($('model-status'), t('saveFailed') + String(e));
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
  // The heading is the fold control: the table is the one unbounded list on the
  // page, and this is how a busy machine keeps it out of the way.
  try {
    $('convos-toggle').addEventListener('click', function (event) {
      event.preventDefault();
      setFolded(!convosFolded);
    });
  }
  catch (error) { /* a stubbed DOM in the tests has no heading */ }
  $('model-save').addEventListener('click', function () {
    var value = $('model').value;
    var proxyBox = $('proxy');
    var nextProxy = proxyBox ? proxyBox.value.trim() : '';
    var proxyChanged = nextProxy !== (settings.proxy == null ? '' : String(settings.proxy));
    var depthBox = $('depth');
    // An absent picker leaves the stored value alone: a page without it (an
    // older panel, a test stub) must not overwrite the cap with NaN.
    var nextDepth = depthBox && depthBox.options ? Number(depthBox.value) : undefined;
    if (!Number.isFinite(nextDepth)) nextDepth = undefined;
    var attributionBox = $('attribution');
    // Same rule as the depth picker: no element, no change.
    var nextAttribution = attributionBox && attributionBox.options ? String(attributionBox.value) : undefined;
    if (!nextAttribution) nextAttribution = undefined;
    text($('model-state'), '…');
    text($('model-status'), '…');
    post({
      model: value,
      modelPolicy: $('model-lock').checked ? 'panel' : 'per-call',
      proxy: nextProxy,
      maxChildDepth: nextDepth,
      attribution: nextAttribution,
      disabledModels: disabledModels()
    }).then(function (data) {
      if (!data || !data.settings) return;
      // The pending switches are on disk now, so the draft has nothing left to
      // shadow and the next paint must read the saved list again.
      draftModel = null;
      draftDisabled = null;
      renderLive(lastPayload);
      var announce = function () {
        var lock = t(settings.modelPolicy === 'panel' && data.effectiveModel ? 'modelLocked' : 'modelOverridable');
        text($('model-state'), t('saved') + '  ·  ' + t('inEffect') + modelLabel(data.effectiveModel) + '  ·  ' + lock);
        text($('model-status'), t('saved') + ' · ' + modelLabel(data.effectiveModel) + ' · ' + lock + ' · ' + t('appliesNext'));
      };
      // A new route reaches a different catalogue, which makes the list on
      // screen a fact about the old one — so re-read it before saying "saved".
      if (proxyChanged) loadSettings(true).then(announce);
      else announce();
    });
  });
  $('model-reload').addEventListener('click', function () {
    text($('model-state'), t('loading'));
    text($('model-status'), t('loading'));
    loadSettings(true);
  });
  // Filtering is client-side on purpose: the list is already in the payload, so
  // typing must not re-hit the Cursor API or re-spawn the CLI.
  $('model-filter').addEventListener('input', function () {
    modelFilter = $('model-filter').value;
    renderModel();
  });
  $('model-filter').addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && modelFilter !== '') {
      event.preventDefault();
      modelFilter = '';
      $('model-filter').value = '';
      renderModel();
    }
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
