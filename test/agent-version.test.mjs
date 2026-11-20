/**
 * Guards for the CLI build stamp (`lib/cli.js` `agentVersion`).
 *
 * The version is the first question in every "why did a run fail" thread: the
 * CLI changes its stream vocabulary between builds, and the plugin has to be
 * able to say which build it is talking to instead of leaving the operator to
 * guess. So the answers pinned here are the shapes the CLI actually prints,
 * plus the ones that must NOT be read as a version.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    VERSION_CACHE_MS,
    agentVersion,
    forgetAgentVersion,
    parseAgentVersion,
} from '../lib/cli.js';

/** What the official CLI prints for `agent --version`. */
const BUILD_STAMP = '2026.11.19-f005e9d\n';

/** A spawn stand-in that answers with one canned output. */
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

function deps(spawn, extra = {}) {
    return {
        spawn,
        resolved: { command: 'node.exe', entry: 'index.js', source: 'path-cmd' },
        env: {},
        cwd: process.cwd(),
        ...extra,
    };
}

test('the official build stamp is read as the version', () => {
    assert.equal(parseAgentVersion(BUILD_STAMP), '2026.11.19-f005e9d');
    // Trailing blank lines and CRLF are noise, not a different answer.
    assert.equal(parseAgentVersion('\r\n2026.11.19-f005e9d\r\n\r\n'), '2026.11.19-f005e9d');
});

test('a wrapper that prints something else is still answering the question', () => {
    assert.equal(parseAgentVersion('agent 1.2.3\n'), 'agent 1.2.3');
    assert.equal(parseAgentVersion('  v0.9  '), 'v0.9');
});

test('silence is not a version', () => {
    assert.equal(parseAgentVersion(''), undefined);
    assert.equal(parseAgentVersion('   \n\n '), undefined);
    assert.equal(parseAgentVersion(undefined), undefined);
});

test('agentVersion asks the CLI for --version, once per cache window', async () => {
    forgetAgentVersion();
    const spawn = fakeSpawn({ stdout: BUILD_STAMP });
    const first = await agentVersion(deps(spawn));
    assert.equal(first.ok, true);
    assert.equal(first.version, '2026.11.19-f005e9d');
    assert.equal(first.error, null);
    assert.equal(spawn.calls.length, 1);
    assert.deepEqual(spawn.calls[0].argv, ['node.exe', 'index.js', '--version']);

    // The answer is reused: a panel refresh must not spawn the CLI again.
    await agentVersion(deps(spawn));
    assert.equal(spawn.calls.length, 1, 'the cached answer is reused');
    assert.equal(VERSION_CACHE_MS > 0, true);

    // An explicit refresh asks again, because a CLI upgrade must show up.
    await agentVersion(deps(spawn, { force: true }));
    assert.equal(spawn.calls.length, 2, 'force re-probes');
});

test('a CLI that will not answer reports the reason instead of a guess', async () => {
    forgetAgentVersion();
    const answer = await agentVersion(deps(fakeSpawn({
        stdout: '',
        stderr: 'error: unknown option --version\n',
    })));
    assert.equal(answer.ok, false);
    assert.equal(answer.version, '');
    assert.match(answer.error, /unknown option/);
});

test('a missing CLI is reported, never spawned', async () => {
    forgetAgentVersion();
    const spawn = () => { throw new Error('must not spawn without a CLI'); };
    const answer = await agentVersion(deps(spawn, { resolved: undefined }));
    assert.equal(answer.ok, false);
    assert.equal(answer.version, '');
    assert.match(answer.error, /not found/);
});
