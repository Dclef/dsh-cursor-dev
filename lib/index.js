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
import { SessionPool } from './session-pool.js';
import { RunJournal } from './journal.js';
import { ConversationIndex } from './conversations.js';
import { cursorCodeTool, resolveDataDir } from './tool.js';
import { registerCursorCommand } from './command.js';
import { UsageClient, registerUsageRoutes } from './usage.js';
import { effectiveModel, readSettings, registerSettingsRoutes } from './settings.js';

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
    /** Alternate way to reuse the full spawn mode instead of the ACP provider. */
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
    const resolved = resolveAgent(process.env);
    const unavailable = resolved === undefined
        ? 'dsh-cursor-dev: the Cursor CLI was not found. Install it with '
            + `\`${CLI_SETUP.install.win32}\` (Windows PowerShell) or \`${CLI_SETUP.install.unix}\` (macOS/Linux), `
            + `run \`${CLI_SETUP.login}\`, then restart DSH — or point \`command\` in the plugin config at the CLI entry point.`
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
    const pool = resolved === undefined
        ? new UnavailablePool()
        : new SessionPool({
            resolved,
            env: process.env,
            spawn,
            maxLiveSessions: config.maxLiveSessions,
            sessionIdleMinutes: config.sessionIdleMinutes,
        }, (key, event) => {
            journal.append(key, event);
        });
    pool.start();

    const tool = cursorCodeTool({
        pool,
        journal,
        index,
        logger,
        maxScanFiles: config.maxScanFiles,
        unavailable,
        // The panel writes the model the user picked; a tool call that names no
        // model follows that choice, so switching models does not need a profile
        // edit and a restart. Read per call: the file is a few hundred bytes and
        // a cached value would silently ignore the operator's last click.
        resolveDefaultModel: () => effectiveModel(readSettings(dataDir), config.model),
        resolveDefaultMode: () => readSettings(dataDir).mode,
    });

    const disposeTool = ctx.tools.register({ ...tool, name: config.toolName });

    ctx.effect(() => {
        void index.load();
        return () => {
            disposeTool?.();
            pool.dispose();
        };
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
        // The status route asks the CLI whether the account is signed in, which
        // means spawning it — same environment the ACP child gets.
        env: process.env,
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
            const disposers = [registerStatusRoute(webCtx, deps)];

            // Cursor never exposes quota as a CLI command, so the plugin reads
            // the dashboard RPC itself and serves both a JSON view and a
            // self-contained HTML dashboard.
            if (config.usageUi === true) {
                const usage = new UsageClient({ baseUrl: config.usageBaseUrl });
                disposers.push(registerUsageRoutes(webCtx, {
                    usage,
                    pool: deps.pool,
                    journal: deps.journal,
                    index: deps.index,
                    dataDir: deps.dataDir,
                    configModel: config.model,
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
                logger: deps.logger,
                // The panel's model list must be the ids `set_config_option`
                // accepts, and only the ACP session roster publishes those. The
                // pool reads one from a throwaway session; a pool that cannot
                // (no CLI) leaves the probe absent and the CLI listing answers.
                probeModelRoster: typeof deps.pool.probeModelRoster === 'function'
                    ? () => deps.pool.probeModelRoster()
                    : undefined,
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
                        conversations: deps.index.list().map(entry => ({
                            key: entry.key,
                            cursorSessionId: entry.cursorSessionId,
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
