/**
 * One-shot questions to the Cursor CLI.
 *
 * A new user hits the same two walls before this plugin can do anything: the CLI
 * is not installed, or it is installed but not signed in. Both look identical
 * from inside the panel (dashes, an empty model picker), so they are answered
 * here explicitly — with the commands that fix them — instead of being left for
 * the user to guess.
 *
 * This module also owns the one-shot spawn helper the model listing uses: the
 * ACP session owns a long-lived child, while these queries ask a question,
 * print, and exit.
 *
 * @module dsh-cursor-dev/cli
 */

/** Largest output accepted from a one-shot CLI query. */
const MAX_OUTPUT_BYTES = 512 * 1024;

/** How long a one-shot query may take before it is killed. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long an authentication answer is reused. */
export const AUTH_CACHE_MS = 60 * 1000;

/**
 * What a user runs by hand when something is missing.
 *
 * Kept in one place because three surfaces quote it: the panel's setup card,
 * the `cursor_code` error, and the README.
 */
export const CLI_SETUP = {
    install: {
        win32: "irm 'https://cursor.com/install?win32=true' | iex",
        unix: 'curl https://cursor.com/install -fsS | bash',
    },
    login: 'agent login',
    verify: 'agent status --format json',
    docs: 'https://cursor.com/docs/cli',
};

/** Last authentication answer, keyed by the CLI it came from. */
let cache = { at: 0, key: '', value: undefined };

/**
 * Describe the resolved CLI for the panel.
 *
 * `found` is the field the panel branches on; the rest is what a user needs in
 * order to see *which* CLI the plugin is actually talking to.
 *
 * @param resolved - result of `resolveAgent`, or undefined.
 */
export function describeAgent(resolved) {
    if (resolved === undefined || resolved === null)
        return { found: false, command: '', entry: '', source: '' };
    return {
        found: true,
        command: typeof resolved.command === 'string' ? resolved.command : '',
        entry: typeof resolved.entry === 'string' ? resolved.entry : '',
        source: typeof resolved.source === 'string' ? resolved.source : '',
    };
}

/**
 * Parse `agent status --format json`.
 *
 * The CLI answers with `{ status, isAuthenticated, hasAccessToken, userInfo }`.
 * Anything that is not that shape is reported as "no answer" rather than being
 * guessed at: a signed-out CLI prints a human sentence, and treating that as
 * signed-in would send the user hunting in the wrong place.
 *
 * @param stdout - raw command output.
 * @returns the parsed status, or undefined when the output is not that JSON.
 */
export function parseAuthStatus(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(String(stdout ?? '').trim());
    }
    catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const user = parsed.userInfo !== null && typeof parsed.userInfo === 'object' ? parsed.userInfo : {};
    return {
        authenticated: parsed.isAuthenticated === true || parsed.status === 'authenticated',
        status: typeof parsed.status === 'string' ? parsed.status : '',
        email: typeof user.email === 'string' ? user.email : '',
        userId: typeof user.userId === 'number' ? user.userId : 0,
    };
}

/**
 * Ask the CLI whether this machine is signed in.
 *
 * Never throws: the answer is exactly what the panel renders, and a throwing
 * "is it set up?" check is useless to a user who is already stuck. A failed
 * check keeps the CLI path and reports the reason instead.
 *
 * @param deps - `spawn`, resolved agent, cwd, env, plus optional `force`.
 */
export async function authStatus(deps) {
    const key = deps?.resolved?.command ?? '';
    if (deps?.force !== true && cache.value !== undefined && cache.key === key && Date.now() - cache.at < AUTH_CACHE_MS)
        return cache.value;
    const value = await probeAuth(deps);
    cache = { at: Date.now(), key, value };
    return value;
}

/** Drop the cached authentication answer (tests, and a config change). */
export function forgetAuthStatus() {
    cache = { at: 0, key: '', value: undefined };
}

/**
 * Run one short-lived CLI command and collect its output.
 *
 * stdin is closed immediately so a CLI that waits on input cannot hang the
 * panel, and the process is terminated when the deadline passes.
 *
 * @param deps - `spawn`, resolved agent, cwd, env, argv `tail`, optional `timeoutMs`.
 */
export async function runOnce(deps) {
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
        if (stdout.length < MAX_OUTPUT_BYTES)
            stdout += String(chunk);
    });
    handle.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT_BYTES)
            stderr += String(chunk);
    });
    try {
        handle.stdin?.end();
    }
    catch {
        // A CLI that already exited has nothing to close.
    }

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
 * The uncached half of {@link authStatus}.
 *
 * @param deps - spawn/agent dependencies.
 */
async function probeAuth(deps) {
    const checkedAt = Date.now();
    const resolved = deps?.resolved;
    if (resolved === undefined)
        return {
            ok: false,
            installed: false,
            authenticated: false,
            email: '',
            checkedAt,
            error: 'the Cursor CLI was not found',
        };
    try {
        const result = await runOnce({ ...deps, tail: ['status', '--format', 'json'] });
        const parsed = parseAuthStatus(result.stdout);
        if (parsed === undefined) {
            const detail = lastLine(result.stderr) || lastLine(result.stdout) || 'the CLI did not report a sign-in status';
            return { ok: false, installed: true, authenticated: false, email: '', checkedAt, error: detail };
        }
        return {
            ok: true,
            installed: true,
            authenticated: parsed.authenticated,
            status: parsed.status,
            email: parsed.email,
            checkedAt,
            error: null,
        };
    }
    catch (error) {
        return {
            ok: false,
            installed: true,
            authenticated: false,
            email: '',
            checkedAt,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** The last non-empty line of a command's output. */
function lastLine(text) {
    return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-1)[0] ?? '';
}
