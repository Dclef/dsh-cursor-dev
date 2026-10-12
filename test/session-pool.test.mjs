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
 */
function fakeAcp(current = 'composer-2.5[fast=true]') {
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
        if (method === 'session/load')
            return write({ jsonrpc: '2.0', id, result: payload(params.sessionId) });
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
