/**
 * Guards for the one-shot CLI questions (`lib/cli.js`).
 *
 * "Is the CLI installed, is it signed in, which models can this account use" is
 * the first thing a new user needs answered, and every answer here is rendered
 * straight into the panel. A wrong `authenticated: true` sends that user looking
 * for a bug in the plugin; a wrong `false` sends them to the login command they
 * already ran. So the shapes the CLI actually prints are pinned here, including
 * the ugly ones (plain-text "not logged in", an unparseable answer, a CLI that
 * never responds).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTH_CACHE_MS,
    CLI_SETUP,
    authStatus,
    describeAgent,
    forgetAuthStatus,
    parseAuthStatus,
    runOnce,
} from '../lib/cli.js';

/** What `agent status --format json` prints on a signed-in machine. */
const SIGNED_IN = JSON.stringify({
    status: 'authenticated',
    isAuthenticated: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    userInfo: { email: 'dev@example.com', userId: 162660994, createdAt: '2025-02-19T14:47:08.863Z' },
}, null, 2);

/** What it prints on a machine that never ran `agent login`. */
const SIGNED_OUT = JSON.stringify({ status: 'unauthenticated', isAuthenticated: false, hasAccessToken: false });

/**
 * A spawn stand-in that answers with one canned output.
 *
 * `{ hang: true }` models the CLI that never answers — the panel must report a
 * timeout rather than wait forever on a spinner.
 */
function fakeSpawn(plan) {
    const calls = [];
    const spawn = spec => {
        calls.push(spec);
        const stdout = [];
        const stderr = [];
        const handle = {
            stdout: { on: (_event, fn) => stdout.push(fn) },
            stderr: { on: (_event, fn) => stderr.push(fn) },
            stdin: { end: () => { handle.stdinClosed = true; } },
            terminate: () => { handle.terminated = true; },
            done: undefined,
        };
        const answer = typeof plan === 'function' ? plan(spec, calls.length) : plan;
        handle.done = new Promise(resolve => {
            if (answer && answer.hang === true) return;
            queueMicrotask(() => {
                if (answer?.stdout) for (const fn of stdout) fn(answer.stdout);
                if (answer?.stderr) for (const fn of stderr) fn(answer.stderr);
                resolve(answer?.exitCode ?? 0);
            });
        });
        return handle;
    };
    spawn.calls = calls;
    return spawn;
}

/** Dependency bundle for `authStatus`/`runOnce`, with a resolved CLI. */
function deps(spawn, extra = {}) {
    return {
        spawn,
        resolved: { command: 'node.exe', entry: 'index.js', source: 'path-cmd' },
        env: {},
        cwd: process.cwd(),
        ...extra,
    };
}

test('the signed-in answer is read as signed in, with the account', () => {
    const parsed = parseAuthStatus(SIGNED_IN);
    assert.equal(parsed.authenticated, true);
    assert.equal(parsed.status, 'authenticated');
    assert.equal(parsed.email, 'dev@example.com');
    assert.equal(parsed.userId, 162660994);
});

test('an explicitly signed-out answer is not mistaken for a signed-in one', () => {
    const parsed = parseAuthStatus(SIGNED_OUT);
    assert.equal(parsed.authenticated, false);
    assert.equal(parsed.email, '');
    assert.equal(parsed.userId, 0);
});

test('anything that is not that JSON is refused rather than guessed at', () => {
    // A signed-out CLI prints a sentence, and that sentence is not a status.
    assert.equal(parseAuthStatus('Not logged in. Run `agent login`.'), undefined);
    assert.equal(parseAuthStatus(''), undefined);
    assert.equal(parseAuthStatus('null'), undefined);
    assert.equal(parseAuthStatus('[{"isAuthenticated":true}]'), undefined);
    assert.equal(parseAuthStatus('{"isAuthenticated"'), undefined);
    assert.equal(parseAuthStatus(undefined), undefined);
    // A bare object without the flag is a "no" — never a yes.
    assert.equal(parseAuthStatus('{"userInfo":{"email":"dev@example.com"}}').authenticated, false);
});

test('describeAgent turns the resolver into the panel\'s branch field', () => {
    assert.deepEqual(describeAgent(undefined), { found: false, command: '', entry: '', source: '' });
    assert.deepEqual(describeAgent({ command: 'node.exe', entry: 'index.js', source: 'path-cmd' }),
        { found: true, command: 'node.exe', entry: 'index.js', source: 'path-cmd' });
    // A resolver that found something odd still counts as found.
    assert.equal(describeAgent({ command: 'agent' }).found, true);
});

test('the setup commands live in one place, because three surfaces quote them', () => {
    assert.match(CLI_SETUP.install.win32, /cursor\.com\/install\?win32=true/);
    assert.match(CLI_SETUP.install.unix, /curl https:\/\/cursor\.com\/install -fsS \| bash/);
    assert.equal(CLI_SETUP.login, 'agent login');
    assert.equal(CLI_SETUP.verify, 'agent status --format json');
    assert.match(CLI_SETUP.docs, /^https:\/\//);
    assert.equal(AUTH_CACHE_MS > 0, true);
});

test('authStatus asks the CLI for its status JSON', async () => {
    forgetAuthStatus();
    const spawn = fakeSpawn({ stdout: SIGNED_IN });
    const answer = await authStatus(deps(spawn));

    assert.equal(answer.ok, true);
    assert.equal(answer.installed, true);
    assert.equal(answer.authenticated, true);
    assert.equal(answer.email, 'dev@example.com');
    assert.equal(answer.error, null);
    assert.equal(spawn.calls.length, 1);
    assert.deepEqual(spawn.calls[0].argv, ['node.exe', 'index.js', 'status', '--format', 'json']);
    assert.equal(spawn.calls[0].stdio.stdout, 'pipe');
    assert.equal(spawn.calls[0].stdio.stdin, 'pipe');
});

test('a signed-out CLI is reported as installed but not authenticated', async () => {
    forgetAuthStatus();
    const answer = await authStatus(deps(fakeSpawn({ stdout: SIGNED_OUT })));
    assert.equal(answer.ok, true, 'the CLI answered; the answer is just "no"');
    assert.equal(answer.installed, true);
    assert.equal(answer.authenticated, false);
    assert.equal(answer.email, '');
});

test('a CLI that answers with prose reports that prose as the reason', async () => {
    forgetAuthStatus();
    const answer = await authStatus(deps(fakeSpawn({
        stdout: 'Not logged in. Run `agent login`.\n',
        stderr: 'warning: no credentials found\n',
    })));
    assert.equal(answer.ok, false);
    assert.equal(answer.installed, true);
    assert.equal(answer.authenticated, false);
    assert.match(answer.error, /warning: no credentials found/, 'the last stderr line is the reason');
});

test('without a resolved CLI nothing is spawned, and the answer says so', async () => {
    forgetAuthStatus();
    const spawn = () => {
        throw new Error('must not spawn without a CLI');
    };
    const answer = await authStatus(deps(spawn, { resolved: undefined }));
    assert.equal(answer.ok, false);
    assert.equal(answer.installed, false);
    assert.equal(answer.authenticated, false);
    assert.match(answer.error, /not found/);
});

test('the answer is cached, and force re-asks', async () => {
    forgetAuthStatus();
    const spawn = fakeSpawn((_spec, attempt) => ({ stdout: attempt === 1 ? SIGNED_OUT : SIGNED_IN }));

    const first = await authStatus(deps(spawn));
    assert.equal(first.authenticated, false);
    const cached = await authStatus(deps(spawn));
    assert.equal(cached.authenticated, false, 'the second call does not re-ask');
    assert.equal(spawn.calls.length, 1, 'the CLI is spawned once inside the cache window');

    const forced = await authStatus(deps(spawn, { force: true }));
    assert.equal(forced.authenticated, true, 'force is how the panel\'s retry button works');
    assert.equal(spawn.calls.length, 2);

    const after = await authStatus(deps(spawn));
    assert.equal(after.authenticated, true, 'the refreshed answer replaces the cached one');
    assert.equal(spawn.calls.length, 2);

    forgetAuthStatus();
    await authStatus(deps(spawn));
    assert.equal(spawn.calls.length, 3, 'forgetting the cache asks again');
});

test('a CLI that never answers is reported as a timeout, not waited on', async () => {
    forgetAuthStatus();
    const spawn = fakeSpawn({ hang: true });
    const answer = await authStatus(deps(spawn, { timeoutMs: 25 }));
    assert.equal(answer.ok, false);
    assert.equal(answer.authenticated, false);
    assert.match(answer.error, /did not answer within/);
});

test('runOnce reports a missing CLI instead of spawning nothing', async () => {
    await assert.rejects(
        () => runOnce(deps(undefined, { tail: ['--list-models'] })),
        /Cursor CLI is not available/,
    );
});
