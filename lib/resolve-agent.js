/**
 * Locate the Cursor CLI `agent` executable without reading credentials.
 *
 * Harness subprocess spawn does not use a shell, so on Windows we must resolve
 * `node.exe` (an `.exe`), never the `agent.cmd` shim. The official Win32
 * installer ships `agent.cmd` -> `cursor-agent.ps1` -> bundled `node.exe` +
 * `index.js`, so the usable spawn target is the bundled Node runtime.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { cliModelArg } from './models.js';

const VERSION_DIR = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

/**
 * Whether `path` is a usable spawn target (exists; on win32 must be `.exe`).
 * @param path - candidate file.
 */
export function isSpawnableAgent(path) {
    if (!existsSync(path))
        return false;
    if (process.platform === 'win32')
        return path.toLowerCase().endsWith('.exe');
    return true;
}

/**
 * Sort key for official `versions/` folder names (`YYYY.MM.DD-commit`).
 * @param name - directory name.
 */
export function versionSortKey(name) {
    const datePart = name.split('-')[0] ?? '';
    const parts = datePart.split('.');
    if (parts.length !== 3)
        return 0;
    const year = parts[0] ?? '';
    const month = (parts[1] ?? '').padStart(2, '0');
    const day = (parts[2] ?? '').padStart(2, '0');
    const value = Number(`${year}${month}${day}`);
    return Number.isFinite(value) ? value : 0;
}

/**
 * Unwrap a Cursor CLI install root to `node.exe` + `index.js`.
 * @param root - `%LOCALAPPDATA%\cursor-agent` or a version directory.
 */
export function resolveNodeAgentBundle(root) {
    const directNode = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    const directIndex = join(root, 'index.js');
    if (isSpawnableAgent(directNode) && existsSync(directIndex)) {
        return { command: directNode, entry: directIndex };
    }
    const versionsRoot = join(root, 'versions');
    if (!existsSync(versionsRoot))
        return undefined;
    const dirs = readdirSync(versionsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && VERSION_DIR.test(entry.name))
        .sort((left, right) => versionSortKey(right.name) - versionSortKey(left.name));
    for (const entry of dirs) {
        const nested = resolveNodeAgentBundle(join(versionsRoot, entry.name));
        if (nested !== undefined)
            return nested;
    }
    return undefined;
}

/**
 * Search PATH for `agent` / `agent.exe`.
 * @param pathEnv - `process.env.PATH`.
 */
export function searchPathForAgent(pathEnv) {
    if (pathEnv === undefined || pathEnv === '')
        return undefined;
    const names = process.platform === 'win32' ? ['agent.exe'] : ['agent'];
    for (const dir of pathEnv.split(delimiter)) {
        if (dir === '')
            continue;
        for (const name of names) {
            const candidate = join(dir, name);
            if (isSpawnableAgent(candidate))
                return candidate;
        }
    }
    return undefined;
}

/**
 * Search PATH for `agent.cmd` so the official Win32 shim can be unwrapped.
 * @param pathEnv - `process.env.PATH`.
 */
export function searchPathForAgentCmd(pathEnv) {
    if (pathEnv === undefined || pathEnv === '')
        return undefined;
    for (const dir of pathEnv.split(delimiter)) {
        if (dir === '')
            continue;
        const cmd = join(dir, 'agent.cmd');
        if (existsSync(cmd))
            return dirname(cmd);
    }
    return undefined;
}

/**
 * Well-known install locations from Cursor's official installer.
 * @param env - process env (tests stub LOCALAPPDATA / HOME).
 */
export function wellKnownAgentPaths(env) {
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    const local = env.LOCALAPPDATA;
    const found = [];
    if (local !== undefined && local !== '') {
        found.push({ path: join(local, 'cursor-agent'), source: 'localappdata' });
    }
    found.push({ path: join(home, '.local', 'share', 'cursor-agent'), source: 'home-local' });
    return found;
}

/**
 * Split a config `command` string into one or two path tokens.
 * Supports an unquoted path, a quoted path, or `runtime entry` (each optionally
 * quoted) so Windows paths with spaces stay intact.
 * @param text - trimmed config value.
 * @returns one or two path strings.
 */
export function splitCommandParts(text) {
    const two = /^"([^"]+)"\s+"([^"]+)"$/.exec(text)
        ?? /^"([^"]+)"\s+(\S+)$/.exec(text)
        ?? /^(\S+)\s+"([^"]+)"$/.exec(text)
        ?? /^(\S+)\s+(\S+)$/.exec(text);
    if (two !== null)
        return [two[1], two[2]];
    const one = /^"([^"]+)"$/.exec(text);
    if (one !== null)
        return [one[1]];
    return [text];
}

/**
 * Resolve a plugin-config `command` override into a spawn target.
 *
 * Accepts a spawnable binary, an official install root (or version dir), an
 * `agent.cmd` shim, or `node.exe index.js` as two whitespace-separated paths.
 * Returns `undefined` when the override cannot be used — callers must not fall
 * back to auto-discovery in that case, or a typo would silently be ignored.
 *
 * @param command - raw `Config.command` string.
 * @returns `{command, entry?, source:'config'}` or `undefined`.
 */
export function resolveConfiguredAgent(command) {
    const text = String(command ?? '').trim();
    if (text === '')
        return undefined;

    const parts = splitCommandParts(text);
    if (parts.length >= 2) {
        const runtime = parts[0];
        const entry = parts[1];
        if (isSpawnableAgent(runtime) && existsSync(entry))
            return { command: runtime, entry, source: 'config' };
        return undefined;
    }

    const path = parts[0];
    if (path === undefined || path === '' || !existsSync(path))
        return undefined;

    if (path.toLowerCase().endsWith('.cmd')) {
        const bundle = resolveNodeAgentBundle(dirname(path));
        if (bundle !== undefined)
            return { ...bundle, source: 'config' };
        return undefined;
    }

    const bundle = resolveNodeAgentBundle(path);
    if (bundle !== undefined)
        return { ...bundle, source: 'config' };

    if (isSpawnableAgent(path))
        return { command: path, entry: undefined, source: 'config' };

    return undefined;
}

/**
 * Resolve the Cursor CLI spawn target, or `undefined` when missing.
 * The returned `command` + `entry` pair is spawned as `[command, entry, ...args]`.
 *
 * When `options.command` is a non-empty string, only that override is tried
 * (`source: 'config'`). Auto-discovery runs only when the override is absent.
 *
 * @param env - process env.
 * @param options - optional `{ command }` from plugin config.
 */
export function resolveAgent(env = process.env, options = {}) {
    const override = typeof options.command === 'string' ? options.command.trim() : '';
    if (override !== '')
        return resolveConfiguredAgent(override);

    const fromPath = searchPathForAgent(env.PATH ?? env.Path);
    if (fromPath !== undefined) {
        return { command: fromPath, entry: undefined, source: 'path' };
    }
    const cmdRoot = searchPathForAgentCmd(env.PATH ?? env.Path);
    if (cmdRoot !== undefined) {
        const bundle = resolveNodeAgentBundle(cmdRoot);
        if (bundle !== undefined)
            return { ...bundle, source: 'path-cmd' };
    }
    const local = env.LOCALAPPDATA;
    if (local !== undefined && local !== '') {
        const bundle = resolveNodeAgentBundle(join(local, 'cursor-agent'));
        if (bundle !== undefined)
            return { ...bundle, source: 'localappdata' };
    }
    for (const candidate of wellKnownAgentPaths(env)) {
        const bundle = resolveNodeAgentBundle(candidate.path);
        if (bundle !== undefined)
            return { ...bundle, source: candidate.source };
        if (isSpawnableAgent(candidate.path)) {
            return { command: candidate.path, entry: undefined, source: candidate.source };
        }
    }
    return undefined;
}

/**
 * Build the argv tail for an ACP spawn.
 *
 * `--model` must precede the `acp` subcommand. The flag takes the ALIAS the CLI
 * itself lists (`--list-models`), never a parameterised id and never the
 * protocol-only `default[]` — that is exactly the split `cliModelArg` encodes,
 * and getting it wrong makes the CLI refuse to start rather than fail a turn.
 * An empty result (which is what `auto`, `default[]` and `''` all produce) means
 * the flag is omitted, so the CLI applies the account default and the session's
 * own `set_config_option` remains the single owner of the model choice.
 *
 * @param resolved - `resolveAgent` result.
 * @param model - the requested model, in either name space.
 */
export function acpArgv(resolved, model) {
    const base = [];
    if (resolved.entry !== undefined)
        base.push(resolved.entry);
    const flag = cliModelArg(model);
    if (flag !== '')
        base.push('--model', flag);
    base.push('acp');
    return base;
}
