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

/** Cursor's API host (mirrors `cli-config.json` → serverConfigCache.backendUrl). */
const DEFAULT_BASE_URL = 'https://api2.cursor.sh';
/** Connect-protocol method for the current billing-period usage snapshot. */
const USAGE_RPC = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
/** How long a fetched snapshot stays fresh before another RPC is allowed. */
const CACHE_MS = 30_000;
/** Network budget for one RPC. */
const REQUEST_TIMEOUT_MS = 15_000;

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

    /**
     * @param options - `baseUrl`, `fetch` (injectable for tests).
     */
    constructor(options = {}) {
        this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.#fetchImpl = options.fetch ?? globalThis.fetch;
    }

    /** Base URL the RPC is sent to. */
    get baseUrl() {
        return this.#baseUrl;
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
        try {
            const response = await this.#fetchImpl(`${this.#baseUrl}${USAGE_RPC}`, {
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
 * @param deps - `usage` client, `pool`, `journal`, `index`, `dataDir`.
 */
export function registerUsageRoutes(ctx, deps) {
    const { usage, pool, index, journal, dataDir } = deps;
    const registrations = [];
    // `ctx.get` rather than `ctx.webServer`: a missing service must degrade to
    // "no UI", never to a failed plugin load.
    const server = ctx.get?.('webServer');
    if (server === undefined)
        return undefined;

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
            sendJson(res, 200, {
                ...publicView,
                extended: {
                    live: pool.snapshot(),
                    queueDepth: pool.queued,
                    conversations: index.list(),
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
            const bucket = journal?.read?.(key);
            if (bucket === undefined) {
                sendJson(res, 404, { key, error: 'no journal for that key (it may have expired)' });
                return;
            }
            sendJson(res, 200, {
                key,
                task: bucket.task,
                cursorSessionId: bucket.cursorSessionId,
                model: bucket.model,
                workspaceRoot: bucket.workspaceRoot,
                reloaded: bucket.reloaded,
                startedAt: bucket.startedAt,
                updatedAt: bucket.updatedAt,
                steps: journal.timeline(key, 60),
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

    const dashboardRoute = {
        kind: 'exact',
        path: '/plugins/dsh-cursor-dev/',
        handler: (_req, res) => {
            sendHtml(res, dashboardHtml(pool, index, journal));
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

    for (const route of [jsonRoute, journalRoute, dashboardRoute]) {
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
 * Values are written with `textContent` (never `innerHTML`) and the JSON is
 * embedded as a `<script type="application/json">` block, so no account data can
 * ever be interpreted as markup.
 *
 * @param pool - session pool, for the live-session table.
 * @param index - conversation index, for the durable transcript table.
 */
function dashboardHtml(pool, index, journal) {
    const live = pool.snapshot();
    const conversations = index.list();
    const bootstrap = JSON.stringify({
        live,
        conversations,
        journal: journal?.stats?.() ?? { keys: 0, events: 0 },
        queueDepth: pool.queued,
        endpoint: '/plugins/dsh-cursor-dev/api/usage',
        journalEndpoint: '/plugins/dsh-cursor-dev/api/journal',
    }).replace(/</g, '\\u003c');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cursor usage — dsh-cursor-dev</title>
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
</style>
</head>
<body>
<div class="head">
  <h1>Cursor usage</h1>
  <span class="pill" id="tier">account</span>
  <span class="muted" id="stamp">loading…</span>
  <span class="muted" style="margin-left:auto"><a href="#" id="refresh" style="color:var(--accent)">refresh</a></span>
</div>

<div id="error" class="card err" style="display:none"></div>

<div class="grid">
  <div class="card">
    <h2>Included total</h2>
    <div class="big" id="total-pct">—</div>
    <div class="bar" id="total-bar"><i style="width:0%"></i></div>
    <div class="muted" id="total-sub">—</div>
  </div>
  <div class="card">
    <h2>Auto bucket</h2>
    <div class="big" id="auto-pct">—</div>
    <div class="bar" id="auto-bar"><i style="width:0%"></i></div>
    <div class="muted" id="auto-sub">—</div>
  </div>
  <div class="card">
    <h2>API / named bucket</h2>
    <div class="big" id="api-pct">—</div>
    <div class="bar" id="api-bar"><i style="width:0%"></i></div>
    <div class="muted" id="api-sub">—</div>
  </div>
  <div class="card">
    <h2>Spend</h2>
    <div class="big" id="spend">—</div>
    <div class="muted" id="spend-sub">—</div>
  </div>
</div>

<div class="row card">
  <h2>Billing period</h2>
  <div id="cycle" class="muted">—</div>
  <div id="message" class="muted" style="margin-top:6px"></div>
</div>

<div class="row card">
  <h2>Live Cursor sessions</h2>
  <table><thead><tr>
    <th>key</th><th>session</th><th>model</th><th>mode</th><th class="num">turns</th><th class="num">idle</th><th>what it is doing</th>
  </tr></thead><tbody id="live"></tbody></table>
  <div class="journal" id="journal" style="display:none"></div>
</div>

<div class="row card">
  <h2>Known conversations (durable)</h2>
  <table><thead><tr>
    <th>key</th><th>session</th><th>workspace</th><th>model</th><th class="num">updated</th>
  </tr></thead><tbody id="convos"></tbody></table>
</div>

<div class="note" id="source"></div>

<script type="application/json" id="bootstrap">${bootstrap}</script>
<script>
(function () {
  var boot = JSON.parse(document.getElementById('bootstrap').textContent);
  var $ = function (id) { return document.getElementById(id); };

  function pct(value) {
    return typeof value === 'number' ? value.toFixed(1) + '%' : '—';
  }
  function money(value) {
    return typeof value === 'number' ? '$' + value.toFixed(2) : '—';
  }
  function when(value) {
    if (typeof value !== 'number') return '—';
    var d = new Date(value);
    return d.toLocaleString();
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
   * One cell. A spec with link:true renders a click-to-open link (the run journal).
   */
  function cell(spec, entry) {
    var td = document.createElement('td');
    if (spec.num) td.className = 'num';
    if (spec.link) {
      var a = document.createElement('a');
      a.className = 'link';
      a.href = '#';
      a.textContent = spec.value(entry);
      a.addEventListener('click', function (event) {
        event.preventDefault();
        openJournal(entry.key);
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
      td.textContent = 'none';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    entries.forEach(function (entry) {
      var tr = document.createElement('tr');
      cells.forEach(function (spec) { tr.appendChild(cell(spec, entry)); });
      tbody.appendChild(tr);
    });
  }

  /** Show everything a run did: the step timeline plus recent raw events. */
  function openJournal(key) {
    var panel = $('journal');
    panel.style.display = '';
    panel.textContent = '';
    var title = document.createElement('h3');
    title.textContent = 'Run journal — ' + key;
    panel.appendChild(title);

    fetch(boot.journalEndpoint + '?key=' + encodeURIComponent(key), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var note = document.createElement('div');
        note.className = 'muted';
        if (data.error) {
          note.textContent = data.error;
        } else {
          note.textContent = 'task: ' + (data.task || '—')
            + '  ·  session ' + (data.cursorSessionId ? String(data.cursorSessionId).slice(0, 8) : '—')
            + '  ·  model ' + (data.model || '—')
            + (data.reloaded ? '  ·  resumed from disk' : '');
        }
        panel.appendChild(note);

        var stepsTable = document.createElement('table');
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        ['#', 'tool', 'kind', 'path', 'status'].forEach(function (label) {
          var th = document.createElement('th');
          th.textContent = label;
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        stepsTable.appendChild(thead);
        var tbody = document.createElement('tbody');
        (data.steps || []).forEach(function (step) {
          var tr = document.createElement('tr');
          [step.id, step.name, step.kind, step.path, step.status].forEach(function (value) {
            var td = document.createElement('td');
            text(td, value);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        if (!tbody.children.length) {
          var empty = document.createElement('tr');
          var emptyCell = document.createElement('td');
          emptyCell.colSpan = 5;
          emptyCell.className = 'muted';
          emptyCell.textContent = 'no tool calls recorded';
          empty.appendChild(emptyCell);
          tbody.appendChild(empty);
        }
        stepsTable.appendChild(tbody);
        panel.appendChild(stepsTable);

        var pre = document.createElement('pre');
        pre.textContent = (data.events || []).map(function (event) {
          var label = String(event.kind);
          if (event.text) label += ': ' + event.text;
          else if (event.call) label += ': ' + event.call.name + ' [' + (event.call.status || '?') + ']'
            + (event.call.path ? ' ' + event.call.path : '');
          return label;
        }).join('\n');
        panel.appendChild(pre);
      })
      .catch(function (e) {
        var failed = document.createElement('div');
        failed.className = 'muted';
        failed.textContent = 'journal unavailable: ' + String(e);
        panel.appendChild(failed);
      });
  }

  function renderLive(payload) {
    var live = (payload.extended && payload.extended.live) || boot.live || [];
    var convos = (payload.extended && payload.extended.conversations) || boot.conversations || [];
    rows($('live'), live, [
      { value: function (e) { return e.key; } },
      { value: function (e) { return e.cursorSessionId ? e.cursorSessionId.slice(0, 8) : '—'; } },
      { value: function (e) { return e.model; } },
      { value: function (e) { return e.mode; } },
      { value: function (e) { return e.turns; }, num: true },
      { value: function (e) { return ago(e.idleMs); }, num: true },
      { value: function (e) { return 'steps'; }, link: true }
    ]);
    rows($('convos'), convos, [
      { value: function (e) { return e.key; } },
      { value: function (e) { return e.cursorSessionId ? e.cursorSessionId.slice(0, 8) : '—'; } },
      { value: function (e) { return e.workspaceRoot; } },
      { value: function (e) { return e.model; } },
      { value: function (e) { return when(e.updatedAt); }, num: true }
    ]);
  }
  function render(payload) {
    var err = $('error');
    // A failed snapshot carries no extended block; keep whatever the table
    // already shows rather than blanking it.
    var hasPanels = typeof payload.extended === 'object' && payload.extended !== null;
    if (payload.ok !== true) {
      err.style.display = '';
      err.textContent = 'Usage unavailable: ' + (payload.error || 'unknown error');
      text($('stamp'), 'failed ' + when(payload.fetchedAt));
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
    text($('total-sub'), 'spent ' + money(u.dollars && u.dollars.total) + ' of ' + money(u.dollars && u.dollars.limit));
    text($('auto-sub'), u.autoMessage || 'auto model bucket');
    text($('api-sub'), u.namedMessage || 'named model bucket');
    text($('spend'), money(u.dollars && u.dollars.total));
    text($('spend-sub'), 'included ' + money(u.dollars && u.dollars.included)
      + ' · bonus ' + money(u.dollars && u.dollars.bonus));
    text($('cycle'), 'starts ' + when(u.billingCycle && u.billingCycle.start)
      + '  →  renews ' + when(u.billingCycle && u.billingCycle.end));
    text($('message'), u.displayMessage || '');
    text($('stamp'), 'updated ' + when(payload.fetchedAt));
    text($('source'), 'source: ' + (payload.source || '')
      + (payload.authPath ? '  ·  credentials: ' + payload.authPath : ''));
    renderLive(payload);
  }
  function load(force) {
    text($('stamp'), 'loading…');
    fetch(boot.endpoint + (force ? '?force=1' : ''), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function (e) {
        render({ ok: false, error: String(e) });
      });
  }
  $('refresh').addEventListener('click', function (event) {
    event.preventDefault();
    load(true);
  });
  renderLive({});
  load(false);
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

/** Render an unknown thrown value as text. */
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
