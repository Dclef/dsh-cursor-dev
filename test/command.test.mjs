/**
 * Guards for `/cursor-subagent` (`lib/command.js`).
 *
 * The division of labour is the feature: Cursor writes the business code and the
 * **parent model reviews it**. So the tests below check the two halves that make
 * that true — the handler must dispatch to the child instead of asking the
 * parent to delegate, and the message that wakes the parent afterwards must
 * carry what a review needs (files, counts, the child's own summary) with the
 * review duty stated outright.
 *
 * They run the real registration against a fake host, then drive the handler the
 * way the host does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COMMAND_NAME,
    USAGE,
    failureBrief,
    parseCommandInput,
    registerCursorCommand,
    reviewBrief,
    runChildForReview,
    userMessage,
} from '../lib/command.js';

/** Let the background run's `await` continuations settle. */
const tick = () => new Promise(resolve => setImmediate(resolve));

/** A promise a test settles by hand, standing in for a Cursor run. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((settle, fail) => {
        resolve = settle;
        reject = fail;
    });
    return { promise, resolve, reject };
}

/** A stand-in for the host `commands` service, recording every registration. */
function makeRegistry() {
    const registrations = [];
    const service = {
        register(definition) {
            registrations.push(definition);
            return () => {
                registrations.splice(registrations.indexOf(definition), 1);
            };
        },
    };
    return { service, registrations };
}

/**
 * A stand-in for the plugin's Cordis context, recording `inject` calls the way
 * the runtime defers them: nothing runs until the test invokes the callback.
 */
function makeHost({ commands = makeRegistry(), serviceName = 'commands' } = {}) {
    const injected = [];
    const effects = [];
    const ctx = {
        logger: { info() {}, warn() {} },
        get: name => (name === serviceName ? commands.service : undefined),
        effect: (callback, label) => {
            const dispose = callback();
            effects.push({ dispose, label });
            return () => dispose?.();
        },
        inject: (deps, callback) => {
            injected.push({ deps, callback });
        },
    };
    return { ctx, injected, effects, commands };
}

/** Register against a fake host and hand back the captured definition. */
function register(options = {}, host = makeHost()) {
    registerCursorCommand(host.ctx, options);
    assert.equal(host.injected.length, 1, 'the command must be mounted through an injected dependency');
    assert.deepEqual(host.injected[0].deps, ['commands']);
    host.injected[0].callback(host.ctx);
    assert.equal(host.effects.length, 1, 'the registration must be owned by an effect');
    assert.equal(host.commands.registrations.length, 1, 'exactly one command is registered');
    return { ...host, definition: host.commands.registrations[0] };
}

/** A `cursor_code`-shaped result, overridable per test. */
function childResult(overrides = {}) {
    return {
        ok: true,
        model: 'composer-2.5[fast=true]',
        durationMs: 42_000,
        steps: [{ id: 'c1' }, { id: 'c2' }],
        changes: [{ path: 'src/app.js', operation: 'modified', added: 12, removed: 3 }],
        text: '把存档读写换成了 JSON。',
        ...overrides,
    };
}

test('the command is named for the child agent, with a usable input hint', () => {
    const { definition } = register();
    assert.equal(definition.name, COMMAND_NAME);
    assert.equal(definition.name, 'cursor-subagent');
    assert.match(definition.description, /Cursor/, 'the description must say who does the work');
    assert.match(definition.description, /审查|reviews/, 'and that the parent reviews it');
    assert.match(definition.input.hint, /<.*>/, 'the hint must show what the argument is');
    assert.equal(typeof definition.handler, 'function');
});

test('the handler dispatches to the child instead of asking the parent to delegate', async () => {
    const pending = deferred();
    const runs = [];
    const steered = [];
    const { definition } = register({
        run: input => {
            runs.push(input);
            return pending.promise;
        },
    });

    const result = definition.handler({
        agent: { steer: message => steered.push(message) },
        rawInput: '  把 oldcat 存档格式换成 JSON  ',
    });

    assert.equal(result.kind, 'success');
    assert.equal(runs.length, 1, 'the child must be started by the command itself');
    assert.equal(runs[0].task, '把 oldcat 存档格式换成 JSON');
    assert.ok(runs[0].signal instanceof AbortSignal, 'the run gets its own signal, not the invocation one');
    assert.deepEqual(steered, [], 'the parent is woken for the review, not for the task');

    pending.resolve(childResult());
    await pending.promise;
    await tick();

    assert.equal(steered.length, 1, 'exactly one review message');
    const text = steered[0].content[0].text;
    assert.match(text, /Cursor 子智能体/, 'the message says who wrote the code');
    assert.match(text, /审查/, 'and that reviewing is now the parent\'s job');
    assert.match(text, /不要自己重写/, 'the division of labour is stated, not implied');
    assert.match(text, /src\/app\.js（modified \+12\/-3）/, 'the changed files and counts travel');
    assert.match(text, /composer-2\.5\[fast=true\]/, 'so does the model that ran');
    assert.match(text, /把存档读写换成了 JSON。/, 'and the child\'s own summary');
    assert.match(text, /continueSession: true/, 'plus how to ask the child for another pass');
});

test('a run that throws still reaches the conversation as a message', async () => {
    const pending = deferred();
    const steered = [];
    const { definition } = register({ run: () => pending.promise });

    const result = definition.handler({
        agent: { steer: message => steered.push(message) },
        rawInput: 'do the thing',
    });
    assert.equal(result.kind, 'success');

    pending.reject(new Error('the Cursor CLI is not signed in'));
    await pending.promise.catch(() => undefined);
    await tick();

    assert.equal(steered.length, 1, 'a failed run must not vanish silently');
    const text = steered[0].content[0].text;
    assert.match(text, /没能跑起来/);
    assert.match(text, /not signed in/, 'the error text is what the parent gets');
});

test('an -m override reaches the run and stays out of the task', async () => {
    const pending = deferred();
    const runs = [];
    const { definition } = register({ run: input => { runs.push(input); return pending.promise; } });

    definition.handler({
        agent: { steer: () => {} },
        rawInput: '-m  grok-4.7-xhigh  把入口换成 React',
    });
    assert.equal(runs[0].model, 'grok-4.7-xhigh');
    assert.equal(runs[0].task, '把入口换成 React');

    pending.resolve(childResult());
    await pending.promise;
    await tick();
});

test('an empty command line reports the usage and starts nothing', () => {
    const runs = [];
    const { definition } = register({ run: input => { runs.push(input); return Promise.resolve(childResult()); } });
    const result = definition.handler({ agent: { steer: () => {} }, rawInput: '   ' });
    assert.equal(result.kind, 'error');
    assert.equal(result.text, USAGE);
    assert.deepEqual(runs, [], 'nothing may be dispatched without a task');
});

test('a call with no live agent fails instead of throwing', () => {
    const { definition } = register({ run: () => Promise.resolve(childResult()) });
    const result = definition.handler({ agent: undefined, rawInput: 'do it' });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /session/);
});

test('a host with no child runner says so instead of pretending', () => {
    const { definition } = register();
    const result = definition.handler({ agent: { steer: () => {} }, rawInput: 'do it' });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /runner/);
});

test('a host without a commands service leaves the plugin working', () => {
    const host = makeHost({ serviceName: 'something-else' });
    assert.doesNotThrow(() => {
        registerCursorCommand(host.ctx, { logger: { warn() {} } });
        host.injected[0].callback(host.ctx);
    });
    assert.deepEqual(host.commands.registrations, []);
});

test('disposing the registration removes the command', () => {
    const { effects, commands } = register();
    assert.equal(commands.registrations.length, 1);
    effects[0].dispose();
    assert.deepEqual(commands.registrations, []);
});

test('a host without ctx.inject is mounted eagerly', () => {
    const commands = makeRegistry();
    registerCursorCommand({
        logger: { warn() {}, info() {} },
        get: name => (name === 'commands' ? commands.service : undefined),
        effect: callback => {
            callback();
        },
    });
    assert.equal(commands.registrations.length, 1);
});

test('parseCommandInput keeps dashes that are part of the task', () => {
    assert.deepEqual(parseCommandInput(''), {});
    assert.deepEqual(parseCommandInput('   '), {});
    assert.deepEqual(parseCommandInput('fix it'), { task: 'fix it' });
    assert.deepEqual(parseCommandInput('-m grok-4.7 do it'), { model: 'grok-4.7', task: 'do it' });
    assert.deepEqual(parseCommandInput('-m grok-4.7'), { model: 'grok-4.7' });
    assert.deepEqual(parseCommandInput('add an -m flag to the parser'), { task: 'add an -m flag to the parser' });
    assert.deepEqual(parseCommandInput('-m gpt-5\nline one\nline two'), { model: 'gpt-5', task: 'line one\nline two' });
});

test('reviewBrief lists every changed file, and says when there are none', () => {
    const brief = reviewBrief('do it', childResult({ changes: [] }), { toolName: 'cursor_code' });
    assert.match(brief, /没有落盘的文件改动/);
    assert.match(brief, /审查/);

    const many = Array.from({ length: 25 }, (_unused, index) => ({
        path: `src/f${index}.ts`,
        operation: 'modified',
        added: index,
        removed: 0,
    }));
    const long = reviewBrief('do it', childResult({ changes: many }));
    assert.match(long, /src\/f0\.ts/, 'the first files are listed');
    assert.match(long, /还有 5 个文件/, 'and the remainder is counted, not silently dropped');
});

test('reviewBrief bounds what it hands the parent', () => {
    const brief = reviewBrief('do it', childResult({ text: 'x'.repeat(5000) }));
    assert.ok(brief.length < 3000, `the review message must stay bounded, got ${brief.length}`);
    assert.match(brief, /完整内容在面板里/);
});

test('reviewBrief reports a failure result as a failure, and names the configured tool', () => {
    const brief = reviewBrief('do it', childResult({ ok: false, error: 'the model refused', changes: [] }), { toolName: 'cursor_dev' });
    assert.match(brief, /没跑完/);
    assert.match(brief, /the model refused/);
    assert.match(brief, /`cursor_dev`/, 'the configured tool name is what the parent is told to call');
    assert.doesNotMatch(brief, /`cursor_code`/);
});

test('failureBrief carries the reason and no diff claims', () => {
    const brief = failureBrief('do it', new TypeError('boom'));
    assert.match(brief, /boom/);
    assert.match(brief, /do it/);
    assert.doesNotMatch(brief, /改动 \d+ 个文件/);
});

test('runChildForReview never rejects, even when the report cannot be delivered', async () => {
    const failing = {
        steer: () => {
            throw new Error('the session is gone');
        },
    };
    await assert.doesNotReject(() => runChildForReview({
        run: () => Promise.resolve(childResult()),
        agent: failing,
        task: 'do it',
        logger: { warn() {}, info() {} },
    }));
});

test('userMessage stamps an identity, a role, and a freeze', () => {
    const message = userMessage([{ type: 'text', text: 'hi' }]);
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'user');
    assert.match(message.id, /^[0-9a-f-]{36}$/);
    assert.ok(Object.isFrozen(message));
    assert.ok(Object.isFrozen(message.content));
    assert.notEqual(userMessage([{ type: 'text', text: 'hi' }]).id, message.id, 'identities must be unique');
});
