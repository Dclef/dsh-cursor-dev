/**
 * The model-choice CONTINUATION GATE: which turns reuse a live Cursor
 * generation, and which are a genuine switch?
 *
 * One Cursor model choice is spelled two ways — the alias the CLI publishes
 * (`composer-2.5-fast`, `kimi-k3-max`, `cursor-grok-4.6-low`) and the
 * parameterised id `session/set_config_option` accepts
 * (`composer-2.5[fast=true]`, `kimi-k3[reasoning=max]`,
 * `grok-4.6[effort=high,fast=true]`). A gate that compares the spellings as
 * raw strings abandons the live generation on a turn that changed nothing: the
 * pool sends no `set_config_option` at all, so the model is exactly the one
 * the conversation already runs. The opposite error is worse — calling a real
 * switch a continuation and letting a run inherit live context.
 *
 * `gate()` mirrors lib/tool.js's `modelChanged` block. Keep the two in step:
 * the point of this file is that the decision is exercised across the tricky
 * pairs without needing a real CLI.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { SessionPool } from '../lib/session-pool.js';
import { sameModel } from '../lib/models.js';

const FIXTURE_ROSTER = [
    { value: 'default[]', name: 'Auto' },
    { value: 'composer-2.5[fast=true]', name: 'composer-2.5' },
    { value: 'kimi-k3[reasoning=max]', name: 'kimi-k3' },
    { value: 'grok-4.6[effort=high,fast=true]', name: 'grok-4.6' },
];

/**
 * A minimal in-process ACP peer: no child process, every request recorded.
 *
 * @param {string} current - the model the session reports as current.
 * @param {object[]} replay - updates a `session/load` replays before it settles.
 */
function fakeAcp(current = 'composer-2.5[fast=true]', replay = []) {
    const toChild = new PassThrough();
    const fromChild = new PassThrough();
    const stderr = new PassThrough();
    const sent = [];
    let buffer = '';
    let settled = false;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const finish = () => {
        if (settled)
            return;
        settled = true;
        resolveDone({ exitCode: 0, signal: null });
    };
    const modelOption = () => ({ id: 'model', name: 'Model', type: 'select', currentValue: current, options: FIXTURE_ROSTER });
    const payload = sessionId => ({
        sessionId,
        modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
        configOptions: [modelOption()],
        models: { currentModelId: current, availableModels: FIXTURE_ROSTER.map(entry => ({ modelId: entry.value, name: entry.name })) },
    });
    const write = message => fromChild.write(`${JSON.stringify(message)}\n`);
    let sessions = 0;
    const handle = request => {
        const { id, method, params } = request;
        if (method === 'initialize')
            return write({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        if (method === 'session/new')
            return write({ jsonrpc: '2.0', id, result: payload(`stub-${++sessions}`) });
        if (method === 'session/load') {
            // A real load streams the whole stored transcript as notifications
            // BEFORE the response settles; anything the plugin wants from it must
            // be collected in that window. The params shape is the CLI's:
            // `{sessionId, update}`.
            for (const update of replay)
                write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update } });
            return write({ jsonrpc: '2.0', id, result: payload(params.sessionId) });
        }
        if (method === 'session/set_config_option') {
            sent.push(params.value);
            if (!FIXTURE_ROSTER.some(entry => entry.value === params.value))
                return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid params: Invalid model value: ${params.value}` } });
            current = params.value;
            return write({ jsonrpc: '2.0', id, result: { configOptions: [modelOption()] } });
        }
        if (method === 'session/prompt')
            return write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        if (method === 'session/set_mode')
            return write({ jsonrpc: '2.0', id, result: {} });
        return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    };
    toChild.on('data', chunk => {
        buffer += String(chunk);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.trim() === '')
                continue;
            try {
                handle(JSON.parse(line));
            }
            catch {
                // A malformed line is the plugin's bug; the next request will show it.
            }
        }
    });
    return {
        spawn: () => ({
            stdin: toChild,
            stdout: fromChild,
            stderr,
            done,
            terminate() { finish(); fromChild.end(); stderr.end(); },
        }),
        sent,
        stop() { finish(); fromChild.end(); stderr.end(); },
    };
}

/**
 * Mirror of the gate in lib/tool.js: `modelChanged` from the pool's own view.
 *
 * @param {SessionPool} pool
 * @param {string} storeKey
 * @param {string} pickedModel - the caller's request.
 */
function gate(pool, storeKey, pickedModel) {
    const currentModel = pool.currentModelChoice(storeKey);
    const current = pool.modelContext(storeKey, pickedModel);
    const currentModelId = current.id ?? (currentModel === undefined || currentModel === '' ? undefined : currentModel);
    // Only a roster LISTING can bridge two spellings (see lib/models.js's `listed`).
    const requestModelId = current.request?.listed === true ? current.request.id : undefined;
    return pickedModel !== undefined
        && !sameModel(currentModel, pickedModel)
        && !sameModel(currentModelId, pickedModel)
        && !sameModel(currentModelId, requestModelId);
}

/** Run one turn through the pool and report what the gate decided. */
async function turn(pool, cwd, storeKey, pickedModel) {
    const changed = gate(pool, storeKey, pickedModel);
    const picked = pool.pickKey(storeKey, changed ? 'fresh' : 'continue');
    const info = await pool.run({ key: picked.key, storeKey, cwd, model: pickedModel }, async lease => ({
        sessionId: lease.session.sessionId,
        reused: lease.reused,
    }));
    return { changed, sessionId: info.sessionId, reused: info.reused, generation: picked.generation };
}

async function withPool(run) {
    const stub = fakeAcp();
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-cursor-gate-'));
    const pool = new SessionPool({ resolved: { command: 'stub', entry: undefined }, env: {}, spawn: stub.spawn, maxLiveSessions: 4 }, () => { });
    try {
        await run(pool, cwd, stub);
    }
    finally {
        await pool.dispose();
        stub.stop();
    }
}

test('a spawn reads the environment when it starts, not when the pool was built', async () => {
    const stub = fakeAcp();
    const specs = [];
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-cursor-env-'));
    let env = { PATH: 'C:\\bin' };
    const pool = new SessionPool({
        resolved: { command: 'stub', entry: undefined },
        // A function, because the panel can save a proxy while the app is
        // running: a snapshot taken here would pin every later run to the old
        // route, and the operator would have to restart to be believed.
        env: () => env,
        spawn: spec => { specs.push(spec); return stub.spawn(spec); },
        maxLiveSessions: 4,
    }, () => { });
    try {
        await turn(pool, cwd, 'conv-a', undefined);
        assert.equal(specs.length, 1);
        assert.deepEqual(specs[0].env, { PATH: 'C:\\bin' }, 'the environment reaches the child unchanged');

        env = { PATH: 'C:\\bin', HTTPS_PROXY: 'http://127.0.0.1:7890' };
        await turn(pool, cwd, 'conv-b', undefined);
        assert.equal(specs.length, 2);
        assert.equal(specs[1].env.HTTPS_PROXY, 'http://127.0.0.1:7890', 'the next spawn sees the new proxy');
        assert.equal(specs[0].env.HTTPS_PROXY, undefined, 'the earlier spec is left as it was');
    }
    finally {
        await pool.dispose();
        stub.stop();
    }
});

test('an alias of the in-effect variant reuses the live generation', async () => {
    await withPool(async (pool, cwd, stub) => {
        const first = await turn(pool, cwd, 'conv', 'composer-2.5-fast');
        const second = await turn(pool, cwd, 'conv', 'composer-2.5[fast=true]');
        const third = await turn(pool, cwd, 'conv', 'composer-2.5-fast');
        assert.equal(second.sessionId, first.sessionId, 'the variant spelling continues the live session');
        assert.equal(third.sessionId, first.sessionId, 'the alias continues the live session');
        assert.equal(third.generation, first.generation, 'no new generation may be started');
        assert.equal(second.reused, true);
        assert.equal(third.reused, true);
        // A conversation without a live session and without a durable record has
        // no model in effect, so the gate cannot call the first request a
        // continuation — the pool starts the fresh generation on its own.
        assert.equal(first.changed, false);
        // The pool never had to switch anything: the session it spawned already
        // reported that model, and neither later turn may reach
        // `session/set_config_option` at all.
        assert.deepEqual(stub.sent, [], `no switch was needed, got ${JSON.stringify(stub.sent)}`);
    });
});

test('every alias the CLI publishes bridges to its parameterised id', async () => {
    await withPool(async (pool, cwd) => {
        // No live session yet: seed each conversation with its variant, then ask
        // for the alias and require the continuation to survive.
        const pairs = [
            ['composer-2.5[fast=true]', 'composer-2.5-fast'],
            ['kimi-k3[reasoning=max]', 'kimi-k3-max'],
            ['grok-4.6[effort=high,fast=true]', 'cursor-grok-4.6-low'],
            ['default[]', 'auto'],
        ];
        for (const [variant, alias] of pairs) {
            await turn(pool, cwd, variant, variant);
            const aliasTurn = await turn(pool, cwd, variant, alias);
            assert.equal(aliasTurn.changed, false, `"${alias}" names the model "${variant}" already runs`);
            assert.equal(aliasTurn.reused, true);
        }
    });
});

test('a genuine switch still starts a fresh generation', async () => {
    await withPool(async (pool, cwd) => {
        await turn(pool, cwd, 'conv', 'composer-2.5[fast=true]');
        const switched = await turn(pool, cwd, 'conv', 'kimi-k3[reasoning=max]');
        assert.equal(switched.changed, true, 'a different model must not continue the live generation');
        assert.equal(switched.reused, false);
        const back = await turn(pool, cwd, 'conv', 'auto');
        assert.equal(back.changed, true, 'auto is default[], not the composer variant in effect');
        assert.equal(back.reused, false);
    });
});

test('an unknown roster cannot prove sameness, so the run still starts fresh', async () => {
    await withPool(async (pool, cwd) => {
        // Nothing live and nothing durable: `resolveModel` answers with the
        // requested name and `listed:false`, which the gate must NOT read as the
        // id already in effect (that would compare a request with itself).
        const first = await turn(pool, cwd, 'conv', 'composer-2.5-fast');
        assert.equal(first.changed, false, 'no model is in effect yet, so there is nothing to switch from');
        assert.equal(first.reused, false, 'there is no live generation to continue');
        // The same request on the conversation that now has a model in effect
        // must be a continuation.
        const second = await turn(pool, cwd, 'conv', 'composer-2.5-fast');
        assert.equal(second.sessionId, first.sessionId);
        assert.equal(second.reused, true);
    });
});

test('replaying history reads the stored transcript and holds the turn lock', async () => {
    const stub = fakeAcp('composer-2.5[fast=true]', [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old task' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } },
        { sessionUpdate: 'tool_call', toolCallId: 'replay-0-1', title: 'Edit `a.txt`', kind: 'edit', status: 'pending', rawInput: { path: 'a.txt' }, locations: [{ path: 'a.txt' }] },
        { sessionUpdate: 'tool_call_update', toolCallId: 'replay-0-1', status: 'completed', content: [{ type: 'diff', path: 'a.txt', oldText: '-- /dev/null', newText: '++ b/a.txt\nhi' }] },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrote it' } },
    ]);
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-cursor-replay-'));
    const pool = new SessionPool({ resolved: { command: 'stub', entry: undefined }, env: {}, spawn: stub.spawn, maxLiveSessions: 4 }, () => { });
    try {
        const order = [];
        let queued;
        const events = await pool.replay({ sessionId: 'old-session', cwd }, async ({ session, events }) => {
            // The lock is held for the whole body: a real turn asked for while a
            // replay runs must not start until the body returns.
            order.push('body');
            assert.equal(session.sessionId, 'old-session', 'the loaded session keeps its id');
            queued = pool.run({ key: 'other#1', storeKey: 'other', cwd }, async () => { order.push('turn'); });
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.deepEqual(order, ['body'], 'a turn must not interleave with a replay');
            return events;
        });
        await queued;
        assert.deepEqual(order, ['body', 'turn'], 'the queued turn runs once the replay is done');
        // `session-loaded` is the load's own completion marker; it trails the
        // replayed content because the CLI settles the request last.
        assert.equal(events.at(-1).kind, 'session-loaded');
        assert.deepEqual(events.slice(0, -1).map(event => event.kind), ['prompt', 'thought', 'tool-call', 'diff', 'tool-update', 'text']);
        assert.equal(events[0].text, 'old task');
        // The tool call is ONE object carrying the title from the call and the
        // diff from the update — the merge a replay turn exists to make happen.
        const call = events.find(event => event.kind === 'tool-call').call;
        assert.equal(call.id, 'replay-0-1');
        assert.equal(call.name, 'Edit `a.txt`');
        const update = events.find(event => event.kind === 'tool-update');
        assert.equal(update.call.status, 'completed');
        assert.equal(update.call.diffs[0].newText, 'hi', 'the /dev/null header is stripped');
        // A replay is a read: it must never switch the model or prompt.
        assert.deepEqual(stub.sent, [], 'replaying history must not change the CLI model');
        // The throwaway session is disposed, and nothing was pooled under the
        // replay's name.
        assert.deepEqual(pool.snapshot().map(row => row.key), ['other#1'], 'a replay never becomes a live conversation');
    }
    finally {
        await pool.dispose();
        stub.stop();
    }
});

test('replaying a live conversation closes it first, so the store is never opened twice', async () => {
    const stub = fakeAcp('composer-2.5[fast=true]', [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old task' } },
    ]);
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-cursor-replay-live-'));
    const pool = new SessionPool({ resolved: { command: 'stub', entry: undefined }, env: {}, spawn: stub.spawn, maxLiveSessions: 4 }, () => { });
    try {
        // A real turn puts a live session in the pool…
        await pool.run({ key: 'conv#1', storeKey: 'conv', cwd, persistedSessionId: 'old-session' }, async () => { });
        assert.equal(pool.snapshot().length, 1, 'the turn pooled a live session');
        assert.equal(pool.snapshot()[0].cursorSessionId, 'old-session');

        // …and reading that same conversation back must not open it a second
        // time: the CLI store is single-writer.
        const events = await pool.replay({ sessionId: 'old-session', cwd }, async ({ events }) => events);
        assert.equal(events[0].kind, 'prompt');
        assert.equal(pool.snapshot().length, 0, 'the live entry holding that session was closed');
        // The durable record survives, so the next turn loads it again.
        assert.equal(pool.persistedFor('conv').sessionId, 'old-session');
    }
    finally {
        await pool.dispose();
        stub.stop();
    }
});
