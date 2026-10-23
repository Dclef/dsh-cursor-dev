/**
 * dsh-cursor-dev — run the Cursor CLI as a *child coding agent* under a DSH
 * parent model.
 *
 * Why this exists beside `@deepseek-ai/dsh-subagent-acp` / `dsh-cursor-acp`:
 * the stock ACP provider is one-shot and capability-free by construction — it
 * advertises `agentOptions: false`, implements only `start()`, drops every
 * `session/update` it does not fold into final message text, and spawns a new
 * process per call. That makes per-task model choice, conversation continuity,
 * and progress visibility impossible.
 *
 * This plugin talks ACP directly instead, so it can keep a session alive across
 * turns, switch models per call, and report reasoning, tool calls, and the real
 * file diffs back to the parent.
 *
 * @module dsh-cursor-dev
 */
import z from '@deepseek-ai/schemastery';
import { resolveAgent } from './resolve-agent.js';
import { CLI_SETUP, authStatus, describeAgent } from './cli.js';
import { applyAttribution } from './attribution.js';
import { SessionPool } from './session-pool.js';
import { RunJournal } from './journal.js';
import { ConversationIndex } from './conversations.js';
import { cursorCodeTool, resolveDataDir } from './tool.js';
import { registerCursorCommand } from './command.js';
import { createMirrorHub } from './mirror.js';
import { createRouteFence } from './fence.js';
import { UsageClient, registerUsageRoutes } from './usage.js';
import { CursorQuotaGuard } from './quota-guard.js';
import { effectiveMaxChildDepth, effectiveModel, readSettings, registerSettingsRoutes, resolveModelSelection } from './settings.js';
import { createNativeCursorBridge } from './native-provider.js';
import { describeProxy, proxySettingIsDirect, resolveChildProxy, withProxyEnvironment } from './proxy.js';

export const name = 'dsh-cursor-dev';

/**
 * Services this plugin requires; a missing one keeps the plugin inactive.
 *
 * `webServer` is deliberately NOT listed here: the coding tool is the point of
 * this plugin and must stay active even in a headless profile. The HTTP
 * surfaces still need it, so they are mounted in their own dependency scope
 * (see {@link mountHttpSurfaces}) instead of being read out of this fiber.
 */
export const inject = ['tools', 'subprocess'];

export const Config = z.object({
    /** Model passed to the child at spawn (`composer-2.5`, `grok-4.7`, …). */
    model: z.string().default(''),
    /**
     * Absolute path that overrides Cursor CLI auto-discovery. Accepts a
     * spawnable binary, an install root, an `agent.cmd` shim, or
     * `"node.exe" "index.js"`. Empty string keeps PATH / known-dir probing.
     */
    command: z.string().default(''),
    /** Live Cursor processes kept in the pool. */
    maxLiveSessions: z.number().default(3),
    /** Idle minutes before a pooled conversation is reaped. */
    sessionIdleMinutes: z.number().default(15),
    /** Files examined per workspace fingerprint. */
    maxScanFiles: z.number().default(20000),
    /** Register the `cursor_code` tool. */
    toolName: z.string().default('cursor_code'),
    /** Cursor API host for the usage RPC. */
    usageBaseUrl: z.string().default('https://api2.cursor.sh'),
    /** Disable the usage routes entirely (the coding tool is unaffected). */
    usageUi: z.boolean().default(true),
    /**
     * Recursion budget for Cursor children: `0` refuses them entirely, `1`
     * allows only a top-level agent to start one, `2` lets a subagent start one
     * too.
     *
     * `2` is the default here, against the platform convention of `1`, because
     * the levels above it do not exist: a Cursor run is a leaf — the CLI has no
     * DSH tools, so it can never delegate further. That makes this setting
     * effectively a switch, and the value that matches how people actually use
     * the tool is the one where a teammate can drive it. The panel writes to
     * the same idea (`data/settings.json` wins over this default).
     */
    maxChildDepth: z.natural().default(2),
});

/**
 * Mount the plugin.
 *
 * @param ctx - Cordis context.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
    const logger = ctx.logger;

    // A missing CLI must not take the whole plugin down. The usage dashboard,
    // the status route and the journal are still useful without it, and a failed
    // fiber hides the reason — the tool reports the problem instead. The message
    // is the setup path itself, because that is the first thing a new user hits.
    const commandOverride = typeof config.command === 'string' ? config.command.trim() : '';
    const resolved = resolveAgent(process.env, { command: commandOverride });
    const unavailable = resolved === undefined
        ? (commandOverride !== ''
            ? `dsh-cursor-dev: configured command \`${commandOverride}\` is not a usable Cursor CLI. `
                + 'Set `command` to a spawnable binary, an install root, an `agent.cmd` shim, '
                + 'or `"node.exe" "index.js"`, then restart DSH.'
            : 'dsh-cursor-dev: the Cursor CLI was not found. Install it with '
                + `\`${CLI_SETUP.install.win32}\` (Windows PowerShell) or \`${CLI_SETUP.install.unix}\` (macOS/Linux), `
                + `run \`${CLI_SETUP.login}\`, then restart DSH — or point \`command\` in the plugin config at the CLI entry point.`)
        : undefined;
    if (unavailable !== undefined)
        logger?.warn?.(unavailable);
    else
        logger?.info?.(`dsh-cursor-dev: using Cursor CLI at ${resolved.command} (${resolved.source})`);

    // `baseDir` is a Cordis service: reading it as a property throws
    // `cannot get property "baseDir" without inject`. Go through `get()` so the
    // plugin still mounts on a host that does not provide it.
    const dataDir = resolveDataDir(ctx.get('baseDir'));
    const index = new ConversationIndex(dataDir);
    const journal = new RunJournal({
        // Outlive the pool by a wide margin: a journal is the only record of what
        // the child did, and reading it must not race the idle reaper.
        ttlMs: Math.max(10 * 60 * 1000, config.sessionIdleMinutes * 3 * 60 * 1000),
    });

    const spawn = (spec) => ctx.subprocess.spawn(spec);

    // The proxy every child process is spawned with.
    //
    // The Cursor CLI reads `HTTPS_PROXY`/`HTTP_PROXY` and nothing else — not the
    // Windows registry, and not `ALL_PROXY`. So a machine whose proxy lives only
    // in Internet Settings gets a child that talks straight to the API, which
    // answers with the small subset of models the direct route publishes. That is
    // the entire "some models are missing" symptom, and the fix is to hand the
    // child the variables it is looking for.
    //
    // Resolution is asynchronous (the registry has to be asked), so the pool is
    // handed a *function* rather than a snapshot, and re-resolved whenever the
    // panel saves a new value. A run started after the save already uses it.
    let childEnv = process.env;
    let proxyRoute = describeProxy(undefined);
    let proxyError = '';
    // The spawn path awaits this, so a run that starts while the first lookup is
    // still in flight gets the proxy instead of racing it and quietly listing a
    // fraction of the models.
    let resolution = Promise.resolve();
    // Until the first lookup settles the route is unknown, and the panel has to
    // be told that rather than "direct": claiming a direct route during the one
    // window where it is most likely to be wrong is how a fix looks broken.
    let settled = false;
    const resolveProxy = async () => {
        const configured = readSettings(dataDir).proxy;
        const explicit = configured.trim() !== '' && proxySettingIsDirect(configured) === false;
        try {
            const proxy = await resolveChildProxy(configured, { env: process.env });
            childEnv = withProxyEnvironment(process.env, proxy);
            proxyRoute = describeProxy(proxy);
            // `resolveChildProxy` answers `undefined` both for "direct" and for
            // "that text is not a proxy", and only one of those deserves a
            // complaint in the panel.
            proxyError = explicit && proxy === undefined
                ? `\`${configured}\` is not a usable proxy — a child would talk straight to the API`
                : '';
            settled = true;
        }
        catch (error) {
            childEnv = process.env;
            proxyRoute = describeProxy(undefined);
            proxyError = error instanceof Error ? error.message : String(error);
            logger?.warn?.(`dsh-cursor-dev: could not read the proxy setting: ${proxyError}`);
        }
        return proxyRoute;
    };
    const refreshProxy = () => {
        settled = false;
        resolution = resolveProxy();
        return resolution;
    };
    // Cursor credits itself in the commits and pull requests the child makes,
    // and the only switch is a key in Cursor's own config file — so this plugin
    // keeps that file in the state the panel asks for. Best effort by design: a
    // read-only Cursor install must not stop a run, and the change is logged
    // once instead of on every spawn.
    let attributionComplaint = '';
    const syncAttribution = () => {
        try {
            const choice = readSettings(dataDir).attribution;
            const applied = applyAttribution(choice, { env: process.env });
            if (applied.error !== undefined) {
                if (applied.error !== attributionComplaint) {
                    attributionComplaint = applied.error;
                    logger?.warn?.(`dsh-cursor-dev: could not update Cursor attribution in ${applied.path}: ${applied.error}`);
                }
                return applied;
            }
            if (applied.changed)
                logger?.info?.(`dsh-cursor-dev: Cursor commit attribution ${choice === 'on' ? 'on' : 'off'} in ${applied.path}`);
            attributionComplaint = '';
            return applied;
        }
        catch (error) {
            logger?.warn?.(`dsh-cursor-dev: could not update Cursor attribution: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };
    const childEnvironment = () => resolution.then(() => {
        // The child reads its settings file once, at startup, and there is no
        // per-run channel for commit attribution. So the file has to be right
        // *before* the process exists — and this hook is the last moment before
        // that happens, on every path that spawns the CLI.
        syncAttribution();
        return childEnv;
    });
    const routeNow = () => (settled ? proxyRoute : '');
    void refreshProxy().then(route => logger?.info?.(`dsh-cursor-dev: Cursor CLI egress via ${route}`));
    // Applied at load as well as before every spawn: an operator who installs
    // this plugin should not have to wait for a run to stop being credited. With
    // no CLI resolved there is no settings file worth writing.
    if (resolved !== undefined)
        syncAttribution();

    // Child conversations: every Cursor run also becomes a real DSH child
    // session, so the parent's header can list it and clicking it opens the
    // transcript Cursor actually produced. `bind` learns the `agents` service
    // from a context that declared the dependency, because reading it off this
    // fiber answers `undefined` while the agent loop is still activating.
    const usage = new UsageClient({ baseUrl: config.usageBaseUrl });
    const quotaGuard = new CursorQuotaGuard(usage);
    // The depth cap the panel can change without a reload. Read per call from
    // the same file the model comes from: a cached number would keep enforcing
    // the cap that was in force when the plugin loaded.
    const maxChildDepthNow = () => effectiveMaxChildDepth(readSettings(dataDir), config.maxChildDepth);
    const mirrors = createMirrorHub({ logger, maxChildDepth: maxChildDepthNow });
    const pool = resolved === undefined
        ? new UnavailablePool()
        : new SessionPool({
            resolved,
            env: childEnvironment,
            spawn,
            maxLiveSessions: config.maxLiveSessions,
            sessionIdleMinutes: config.sessionIdleMinutes,
        }, (key, event) => {
            journal.append(key, event);
            mirrors.observe(key, event);
        });
    pool.start();

    const rawTool = cursorCodeTool({
        pool,
        journal,
        index,
        logger,
        mirrors,
        quotaGuard,
        maxScanFiles: config.maxScanFiles,
        maxChildDepth: maxChildDepthNow,
        unavailable,
        // The panel writes the model the user picked; a tool call that names no
        // model follows that choice, so switching models does not need a profile
        // edit and a restart. Read per call: the file is a few hundred bytes and
        // a cached value would silently ignore the operator's last click.
        resolveDefaultModel: () => effectiveModel(readSettings(dataDir), config.model),
        resolveModelSelection: requested => resolveModelSelection(readSettings(dataDir), config.model, requested),
        resolveDefaultMode: () => readSettings(dataDir).mode,
    });

    const native = createNativeCursorBridge({ execute: rawTool.execute, mirrors, quotaGuard, maxChildDepth: maxChildDepthNow });
    const tool = { ...rawTool, execute: (args, exec) => native.execute(args, exec) };
    const disposeTool = ctx.tools.register({ ...tool, name: config.toolName });

    ctx.effect(() => {
        void index.load();
        return async () => {
            disposeTool?.();
            await native.dispose();
            await mirrors.dispose();
            pool.dispose();
        };
    });

    // The `agents` service is what makes a run into a navigable child
    // conversation. It is injected rather than declared, for the same reason the
    // HTTP surfaces are: the coding tool must keep working on a host that has no
    // agent loop at all.
    ctx.inject(['agents'], (agentsCtx) => {
        mirrors.bind(agentsCtx);
    });
    ctx.inject(['subagents', 'agents'], (nativeCtx) => {
        mirrors.bind(nativeCtx);
        native.bind(nativeCtx);
    });

    // `/cursor-subagent [-m <model>] <task>` — the same child run the tool
    // performs, dispatched straight from the command line instead of through a
    // parent-model decision. Cursor writes the code; the parent model is woken
    // with the diff facts and reviews them.
    registerCursorCommand(ctx, {
        toolName: config.toolName,
        logger,
        run: ({ task, model, agent, signal }) => tool.execute({
            task,
            model,
            report: 'detailed',
        }, { agent, signal }),
    });

    mountHttpSurfaces(ctx, config, {
        pool,
        journal,
        index,
        resolved,
        spawn,
        dataDir,
        logger,
        mirrors,
        usage,
        quotaGuard,
        // The status route asks the CLI whether the account is signed in, which
        // means spawning it — same environment the ACP child gets.
        env: childEnvironment,
        // The settings route re-resolves this the moment a new proxy is saved,
        // and reports the resulting route back to the panel.
        refreshProxy,
        proxyRoute: routeNow,
        proxyError: () => proxyError,
        cwd: process.cwd(),
    });

    logger?.info?.(`dsh-cursor-dev: registered tool \`${config.toolName}\``);
}

/**
 * Mount the status, usage and settings routes against the `webServer` service.
 *
 * This runs inside its own dependency scope, and that is the whole point: a
 * service is only handed out once its providing fiber is ACTIVE, and at boot
 * this plugin activates while the web server's asynchronous listen is still
 * pending. Reading `ctx.get('webServer')` from *this* fiber therefore answered
 * `undefined`, every `register*Route` quietly skipped its work, and the plugin
 * shipped a working tool with no reachable HTTP surface at all — the panel
 * rendered its own "HTTP 404" card while `cursor_code` kept working.
 * Declaring the dependency keeps the mount pending until the service exists,
 * whatever the host's plugin order turns out to be.
 *
 * @param ctx - Cordis context of the plugin.
 * @param config - resolved plugin config.
 * @param deps - the plugin's own objects, passed through to the route modules.
 */
function mountHttpSurfaces(ctx, config, deps) {
    const mount = (webCtx) => {
        webCtx.effect(() => {
            // Every route below lives outside the host's `/api` carrier, so the
            // host's own Host/Origin fence never runs for them. This is that
            // fence: it refuses a browser request that came from another origin
            // (a CSRF write against `/api/settings`, a forged `/api/restore`)
            // while leaving a local tool's request and the panel's own
            // same-origin fetches exactly as they were.
            const fence = createRouteFence(ctx);
            const fenced = { ...deps, fence };
            const disposers = [registerStatusRoute(webCtx, fenced)];

            // Cursor never exposes quota as a CLI command, so the plugin reads
            // the dashboard RPC itself and serves both a JSON view and a
            // self-contained HTML dashboard.
            if (config.usageUi === true) {
                disposers.push(registerUsageRoutes(webCtx, {
                    usage: deps.usage,
                    quotaGuard: deps.quotaGuard,
                    pool: deps.pool,
                    journal: deps.journal,
                    index: deps.index,
                    dataDir: deps.dataDir,
                    configModel: config.model,
                    // The depth picker lives on this dashboard, and its value is
                    // the stored choice over this config default.
                    maxChildDepth: config.maxChildDepth,
                    // The dashboard reports what Cursor's config file says about
                    // attribution, and that file is looked up from the same
                    // environment the child will be spawned with.
                    env: deps.env,
                    fence,
                    // The dashboard offers a jump into the mirrored child
                    // conversation, so it has to know both whether this host has
                    // one and which child belongs to which run.
                    mirrors: deps.mirrors,
                    // …and it shows the egress route, because that is what
                    // decides how many models the picker can offer.
                    proxyRoute: deps.proxyRoute,
                    proxyError: deps.proxyError,
                }));
            }

            // Settings the panel owns: the child's default model, the language.
            disposers.push(registerSettingsRoutes(webCtx, {
                spawn: deps.spawn,
                resolved: deps.resolved,
                env: deps.env,
                cwd: deps.cwd,
                dataDir: deps.dataDir,
                configModel: config.model,
                // The panel shows the cap in force: the stored choice when there
                // is one, otherwise what the profile hands this plugin.
                maxChildDepth: config.maxChildDepth,
                logger: deps.logger,
                fence,
                // The panel's model list must be the ids `set_config_option`
                // accepts, and only the ACP session roster publishes those. The
                // pool reads one from a throwaway session; a pool that cannot
                // (no CLI) leaves the probe absent and the CLI listing answers.
                probeModelRoster: typeof deps.pool.probeModelRoster === 'function'
                    ? () => deps.pool.probeModelRoster()
                    : undefined,
                // Saving a proxy has to take effect on the next spawn, not on
                // the next restart, and the panel shows the route that results.
                refreshProxy: deps.refreshProxy,
                proxyRoute: deps.proxyRoute,
                proxyError: deps.proxyError,
            }));

            deps.logger?.info?.(`dsh-cursor-dev: serving ${disposers.length} HTTP surface(s)`);

            return () => {
                for (const dispose of disposers) {
                    try {
                        dispose?.();
                    } catch (error) {
                        deps.logger?.warn?.('dsh-cursor-dev: releasing an HTTP surface failed', error);
                    }
                }
            };
        });
    };

    if (typeof ctx.inject !== 'function') {
        // A host without the registry mixin cannot defer anything; mount
        // eagerly and let `ctx.get` decide, exactly as this plugin used to.
        deps.logger?.warn?.('dsh-cursor-dev: ctx.inject is unavailable; mounting the HTTP surfaces eagerly');
        mount(ctx);
        return;
    }
    ctx.inject(['webServer'], mount);
}

/**
 * Stand-in for the session pool when no Cursor CLI could be found.
 *
 * Everything except running the child keeps working through it: the usage
 * dashboard and the status route still answer, and `cursor_code` reports the
 * resolution problem. A missing CLI must not fail the fiber, because that hides
 * every other surface along with the reason.
 */
class UnavailablePool {
    /** No run can be queued. */
    get queued() {
        return 0;
    }

    /** No live sessions exist. @returns {never[]} */
    snapshot() {
        return [];
    }

    start() {
    }

    async dispose() {
    }
}

/**
 * Expose the live pool over HTTP so the user can inspect a run without asking
 * the model. The route is read-only and never mutates a session.
 *
 * `WebRoute` is a Node-style carrier: `{ kind: 'exact' | 'prefix', path, handler(req, res) }`.
 *
 * @param ctx - Cordis context.
 * @param deps - pool, journal, index, resolved agent.
 */
function registerStatusRoute(ctx, deps) {
    const server = ctx.get('webServer');
    if (server === undefined)
        return undefined;
    try {
        return server.register({
            kind: 'exact',
            path: '/plugins/dsh-cursor-dev/status',
            handler: async (req, res) => {
                // Same cross-site fence as the other plugin routes: this one is
                // readable, but it names the workspace and the live session ids,
                // so a foreign page has no business reading it either.
                if (deps.fence !== undefined && deps.fence(req, res) !== true)
                    return undefined;
                // Nothing here may throw: an escaping exception is an unhandled
                // error in the host's server, not a failed response.
                let body;
                try {
                    const url = new URL(req?.url ?? '/', 'http://localhost');
                    body = {
                        // `found` is what the panel branches on: it turns a panel
                        // full of dashes into the two commands that fix it.
                        agent: describeAgent(deps.resolved),
                        auth: await authStatus({
                            ...deps,
                            // The panel's retry button asks for a fresh answer, so
                            // signing in and clicking it does not meet the cache.
                            force: url.searchParams.get('auth') === 'refresh',
                        }),
                        setup: CLI_SETUP,
                        live: deps.pool.snapshot(),
                        // The child conversations the parent's header lists.
                        // `available: false` means this host has no agent loop,
                        // so a run is visible in the tool result only.
                        children: {
                            available: deps.mirrors?.available === true,
                            open: deps.mirrors?.snapshot?.() ?? [],
                        },
                        conversations: deps.index.list().map(entry => ({
                            key: entry.key,
                            cursorSessionId: entry.cursorSessionId,
                            childSessionId: entry.childSessionId,
                            workspaceRoot: entry.workspaceRoot,
                            model: entry.model,
                            updatedAt: entry.updatedAt,
                        })),
                    };
                }
                catch (error) {
                    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
                    return;
                }
                const payload = JSON.stringify(body, null, 2);
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(payload);
            },
        });
    }
    catch (error) {
        // A status route is a convenience; never let it block the coding tool.
        ctx.logger?.warn?.(`dsh-cursor-dev: status route unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
