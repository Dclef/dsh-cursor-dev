/**
 * Cursor's commit attribution, and the only switch that turns it off.
 *
 * When the agent runs `git commit`, the CLI appends a `Co-authored-by: Cursor`
 * trailer, and it credits Cursor on pull requests it opens. There is no flag and
 * no environment variable for this — `agent --help` has nothing, and the plugin
 * never gets a per-run channel for it — so the setting lives in the CLI's own
 * `cli-config.json` under `attribution`:
 *
 * ```json
 * { "attribution": { "attributeCommitsToAgent": true, "attributePRsToAgent": true } }
 * ```
 *
 * Team admins can force this off server-side (`attributionControls`), which the
 * CLI checks separately; nothing a user writes locally can turn it back on.
 *
 * This module reads and writes that file. Two rules keep it safe to call from a
 * plugin that does not own it: everything except `attribution` is preserved
 * byte for byte, and a file we cannot parse is never overwritten — a broken
 * config is the CLI's problem to report, not ours to replace.
 *
 * @module dsh-cursor-dev/attribution
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The file the CLI keeps its settings in, inside its config directory. */
const FILE = 'cli-config.json';

/** The two things Cursor can attribute. */
const KEYS = ['attributeCommitsToAgent', 'attributePRsToAgent'];

/**
 * Where the CLI looks for its config directory.
 *
 * Mirrors the CLI's own resolution order — `CURSOR_CONFIG_DIR`, then
 * `XDG_CONFIG_HOME/cursor`, then `~/.cursor` — because writing anywhere else
 * would silently do nothing.
 *
 * @param env - environment to read.
 */
export function cursorConfigDir(env = process.env) {
    const explicit = env.CURSOR_CONFIG_DIR;
    if (typeof explicit === 'string' && explicit.trim() !== '')
        return explicit.trim();
    const xdg = env.XDG_CONFIG_HOME;
    if (typeof xdg === 'string' && xdg.trim() !== '')
        return join(xdg.trim(), 'cursor');
    return join(homedir(), '.cursor');
}

/**
 * Absolute path of the CLI settings file.
 *
 * @param env - environment to read.
 */
export function attributionPath(env = process.env) {
    return join(cursorConfigDir(env), FILE);
}

/**
 * The attribution block as it currently stands on disk.
 *
 * A missing file reports the CLI's own defaults (`true` twice) because that is
 * what a run would do; `present: false` says we read nothing.
 *
 * @param env - environment to read.
 */
export function readAttribution(env = process.env) {
    const path = attributionPath(env);
    let raw;
    try {
        if (!existsSync(path))
            return { path, present: false, attribution: defaults() };
        raw = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        return { path, present: true, attribution: defaults(), error: messageOf(error) };
    }
    return { path, present: true, attribution: pick(raw), error: undefined };
}

/**
 * Coerce a panel choice into the two flags, or `undefined` for "leave alone".
 *
 * `keep` is a real choice: an operator who manages Cursor themselves must be
 * able to stop the plugin from rewriting their file on every spawn.
 *
 * @param choice - `off`, `on`, or `keep`.
 */
export function desiredAttribution(choice) {
    if (choice === 'off') return { attributeCommitsToAgent: false, attributePRsToAgent: false };
    if (choice === 'on') return { attributeCommitsToAgent: true, attributePRsToAgent: true };
    return undefined;
}

/**
 * Make the CLI settings file say what the panel asked for.
 *
 * Writes only when a flag actually differs, so a machine that is already
 * configured is never touched. The write goes through a temporary file and a
 * rename: the CLI reads this file at startup, and half a JSON document would
 * take the child down with it.
 *
 * @param choice - `off`, `on`, or `keep`.
 * @param options - `env` override and a `logger` for the one failure worth reporting.
 */
export function applyAttribution(choice, options = {}) {
    const env = options.env ?? process.env;
    const desired = desiredAttribution(choice);
    if (desired === undefined)
        return { ...readAttribution(env), changed: false };
    const path = attributionPath(env);
    let raw;
    try {
        raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1 };
    }
    catch (error) {
        const failure = messageOf(error);
        return { path, present: true, attribution: defaults(), changed: false, error: failure };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { path, present: true, attribution: defaults(), changed: false, error: 'the CLI settings file is not an object' };
    }
    const current = pick(raw);
    const changed = KEYS.some(key => current[key] !== desired[key]);
    if (!changed)
        return { path, present: true, attribution: current, changed: false };
    // Keep every other key — permissions, model, auth — exactly as it was, and
    // merge into the attribution block rather than replacing it: a key we do
    // not know about is still the CLI's to read.
    const block = raw.attribution !== null && typeof raw.attribution === 'object' && !Array.isArray(raw.attribution)
        ? raw.attribution
        : {};
    raw.attribution = { ...block, ...desired };
    try {
        const temporary = `${path}.dsh-cursor-dev.tmp`;
        writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
        renameSync(temporary, path);
    }
    catch (error) {
        const failure = messageOf(error);
        return { path, present: true, attribution: current, changed: false, error: failure };
    }
    return { path, present: true, attribution: { ...current, ...desired }, changed: true };
}

/** The CLI's own defaults, used when it has no opinion yet. */
function defaults() {
    return { attributeCommitsToAgent: true, attributePRsToAgent: true };
}

/** Read just the two flags out of a parsed settings document. */
function pick(raw) {
    const block = raw !== null && typeof raw === 'object' ? raw.attribution : undefined;
    const source = block !== null && typeof block === 'object' ? block : {};
    const picked = { ...defaults() };
    for (const key of KEYS) {
        if (typeof source[key] === 'boolean')
            picked[key] = source[key];
    }
    return picked;
}

/** Render an unknown thrown value as text. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
