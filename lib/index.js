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
import { SessionPool } from './session-pool.js';
import { RunJournal } from './journal.js';
import { ConversationIndex } from './conversations.js';
import { cursorCodeTool, resolveDataDir } from './tool.js';
import { UsageClient, registerUsageRoutes } from './usage.js';

export const name = 'dsh-cursor-dev';

/**
 * Services this plugin requires; a missing one keeps the plugin inactive.
 *
 * `webServer` is deliberately NOT listed: the coding tool is the point of this
 * plugin and must stay active even in a headless profile, so the usage routes
 * are resolved with `ctx.get('webServer')` and skipped when absent.
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

    const resolved = resolveAgent(process.env);
    if (resolved === undefined) {
        throw new Error(
            'dsh-cursor-dev: could not find the Cursor CLI. Install it with '
            + '`irm https://cursor.com/install -useb | iex` or set `command` in the plugin config.',
        );
    }
    logger?.info?.(`dsh-cursor-dev: using Cursor CLI at ${resolved.command} (${resolved.source})`);

    const dataDir = resolveDataDir(ctx.baseDir);
    const index = new ConversationIndex(dataDir);
    const journal = new RunJournal({
        // Outlive the pool by a wide margin: a journal is the only record of what
        // the child did, and reading it must not race the idle reaper.
        ttlMs: Math.max(10 * 60 * 1000, config.sessionIdleMinutes * 3 * 60 * 1000),
    });

    const spawn = (spec) => ctx.subprocess.spawn(spec);
    const pool = new SessionPool({
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
    });

    const disposeTool = ctx.tools.register({ ...tool, name: config.toolName });

    const disposeRoute = registerStatusRoute(ctx, { pool, journal, index, resolved });

    // Usage/quota surfaces. Cursor never exposes quota as a CLI command, so the
    // plugin reads the dashboard RPC itself and serves both a JSON view and a
    // self-contained HTML dashboard at /plugins/dsh-cursor-dev/.
    let disposeUsage;
    if (config.usageUi === true) {
        const usage = new UsageClient({ baseUrl: config.usageBaseUrl });
        disposeUsage = registerUsageRoutes(ctx, { usage, pool, journal, index, dataDir });
    }

    ctx.effect(() => {
        void index.load();
        return () => {
            disposeTool?.();
            disposeRoute?.();
            disposeUsage?.();
            pool.dispose();
        };
    });

    logger?.info?.(`dsh-cursor-dev: registered tool \`${config.toolName}\``);
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
            handler: (_req, res) => {
                const body = {
                    agent: { command: deps.resolved.command, source: deps.resolved.source },
                    live: deps.pool.snapshot(),
                    conversations: deps.index.list().map(entry => ({
                        key: entry.key,
                        cursorSessionId: entry.cursorSessionId,
                        workspaceRoot: entry.workspaceRoot,
                        model: entry.model,
                        updatedAt: entry.updatedAt,
                    })),
                };
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
