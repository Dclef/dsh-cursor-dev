import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliSession, diffFromUnified } from '../lib/cli-runner.js';

/** 一个脚本化的 CLI 进程，写出 NDJSON 后退出。不碰真实 Cursor。 */
function fakeCli(lines, exitCode = 0) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    return {
        stdout, stderr,
        terminate() {},
        done: new Promise(resolve => setImmediate(() => {
            for (const line of lines) stdout.write(`${JSON.stringify(line)}\n`);
            stdout.end();
            resolve(exitCode);
        })),
    };
}

function sink() {
    const events = [];
    return { events, onEvent: event => events.push(event) };
}

function sessionFor(handle, config = {}) {
    return new CliSession({
        resolved: { command: 'agent' },
        model: 'grok-4.7-high',
        cwd: process.cwd(),
        env: {},
        spawn: () => handle,
        ...config,
    }, config.onEvent ?? (() => {}));
}

test('a CLI turn folds stream-json into the shared event vocabulary', async () => {
    const { events, onEvent } = sink();
    const cli = fakeCli([
        { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'grok-4.7-high' },
        { type: 'thinking', subtype: 'delta', text: 'Thinking.' },
        { type: 'tool_call', subtype: 'started', call_id: 'c1',
            tool_call: { editToolCall: { args: { path: 'a.txt' }, toolCallId: 'c1' } } },
        { type: 'tool_call', subtype: 'completed', call_id: 'c1',
            tool_call: { editToolCall: { args: { path: 'a.txt' }, toolCallId: 'c1',
                result: { success: { path: 'a.txt', linesAdded: 1, linesRemoved: 0,
                    diffString: '--- /dev/null\n+++ b/a.txt\n@@ -1,0 +1 @@\n+hi' } } } } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
        { type: 'result', subtype: 'success' },
    ]);
    const session = sessionFor(cli, { onEvent });
    await session.start();
    const turn = await session.prompt('do it');

    assert.equal(turn.stopReason, 'end_turn');
    assert.equal(turn.text, 'Done.');
    assert.equal(turn.reasoning, 'Thinking.');
    assert.equal(session.sessionId, 'sid-1', 'the CLI session id is kept for --resume');
    const kinds = events.map(event => event.kind);
    for (const kind of ['turn-start', 'prompt', 'thought', 'tool-call', 'tool-update', 'diff', 'text', 'turn-end']) {
        assert.ok(kinds.includes(kind), `emits ${kind}`);
    }
    assert.equal(turn.diffs.length, 1);
    assert.equal(turn.diffs[0].path, 'a.txt');
    assert.equal(turn.diffs[0].newText, 'hi');
});

test('the tier reaches the argv as the CLI alias, never a bracket id', async () => {
    let argv;
    const cli = fakeCli([
        { type: 'system', subtype: 'init', session_id: 'sid-2' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
        { type: 'result', subtype: 'success' },
    ]);
    const session = new CliSession({
        resolved: { command: 'agent' }, model: 'grok-4.7-high', cwd: process.cwd(),
        env: {}, spawn: spec => { argv = spec.argv; return cli; },
    }, () => {});
    await session.start();
    await session.prompt('hi');
    assert.ok(argv.includes('--model'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'grok-4.7-high',
        'the alias the CLI lists is what selects a tier; a bracket id is rejected');
    assert.ok(argv.includes('--trust'), 'the child runs unattended in the parent workspace');
    assert.ok(argv.includes('stream-json'));
});

test('a resumed conversation passes --resume with the stored id', async () => {
    let argv;
    const cli = fakeCli([
        { type: 'system', subtype: 'init', session_id: 'sid-3' },
        { type: 'result', subtype: 'success' },
    ]);
    const session = new CliSession({
        resolved: { command: 'agent' }, model: '', cwd: process.cwd(),
        env: {}, spawn: spec => { argv = spec.argv; return cli; },
    }, () => {});
    await session.load('sid-3', {});
    await session.prompt('continue');
    assert.ok(argv.includes('--resume'));
    assert.equal(argv[argv.indexOf('--resume') + 1], 'sid-3');
});

test('a failed result is not reported as a finished turn', async () => {
    const cli = fakeCli([
        { type: 'system', subtype: 'init', session_id: 'sid-4' },
        { type: 'result', subtype: 'error' },
    ]);
    const session = sessionFor(cli);
    await session.start();
    await assert.rejects(session.prompt('hi'), /cursor-cli: run failed/);
});

test('a stream with no result event fails instead of reporting success', async () => {
    const cli = fakeCli([{ type: 'system', subtype: 'init', session_id: 'sid-5' }]);
    const session = sessionFor(cli);
    await session.start();
    await assert.rejects(session.prompt('hi'), /no result event/);
});

test('an edit diff becomes the plugin’s old/new text pair', () => {
    const diff = diffFromUnified('--- /dev/null\n+++ b/a.txt\n@@ -1,0 +1 @@\n+hi', 'a.txt');
    assert.equal(diff.path, 'a.txt');
    assert.match(diff.newText, /hi/);
    assert.doesNotMatch(diff.newText, /\/dev\/null/);
    assert.doesNotMatch(diff.newText, /\+\+\+ b\//);
});
