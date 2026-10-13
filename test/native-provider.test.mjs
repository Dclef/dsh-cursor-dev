import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createNativeCursorBridge, createCursorProvider, cursorStopReason } from '../lib/native-provider.js';
import { createMirrorHub } from '../lib/mirror.js';
import { cursorCodeTool } from '../lib/tool.js';
import { SessionPool } from '../lib/session-pool.js';
import { RunJournal } from '../lib/journal.js';
import { resolveModelSelection } from '../lib/settings.js';

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
function session(id, cwd) {
    const events = [];
    return { header: { id, cwd, createdAt: 7 }, snapshotEvents: () => events,
        append(type, data, options) {
            const event = { seq: events.length, time: Date.now(), type, data, ...options };
            events.push(event);
            return event;
        } };
}

/** A controllable ACP peer, using the same JSON stream and CursorSession as production. */
function peerFactory() {
    const peers = [];
    const prompts = [];
    let nextPrompt = deferred();
    const spawn = () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const done = deferred();
        const exit = deferred();
        const terminated = deferred();
        const peer = { terminated, exit, deferredExit: false, terminations: 0, dead: false, requests: [] };
        const emit = message => { if (!stdout.destroyed && !stdout.writableEnded) stdout.write(`${JSON.stringify(message)}\n`); };
        const respond = (request, result) => emit({ jsonrpc: '2.0', id: request.id, result });
        let model = 'default[]';
        const roster = () => ({ sessionId: `cursor-${peers.length}`,
            models: { currentModelId: model, availableModels: [{ modelId: 'default[]', name: 'Auto' }] },
            modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] } });
        peer.finish = () => {
            if (peer.dead) return;
            peer.dead = true;
            stdout.end(); stderr.end();
            done.resolve({ exitCode: 0, signal: null });
            exit.resolve({ exitCode: 0, signal: null });
        };
        let buffer = '';
        stdin.on('data', chunk => {
            buffer += String(chunk);
            let boundary;
            while ((boundary = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 1);
                if (!line.trim()) continue;
                const request = JSON.parse(line);
                peer.requests.push(request);
                if (request.method === 'initialize') respond(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
                else if (request.method === 'session/new' || request.method === 'session/load') respond(request, roster());
                else if (request.method === 'session/set_config_option') {
                    model = request.params.value;
                    respond(request, { configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: model, options: [{ value: 'default[]', name: 'Auto' }] }] });
                }
                else if (request.method === 'session/prompt') {
                    const prompt = { peer, text: request.params.prompt[0].text,
                        textChunk(text) { emit({ jsonrpc: '2.0', method: 'session/update', params: {
                            sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
                        } }); },
                        finish(stopReason = 'end_turn') { respond(request, { stopReason }); },
                        fail() { emit({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture prompt failed' } }); },
                    };
                    peer.current = prompt;
                    prompts.push(prompt);
                    nextPrompt.resolve(prompt);
                    nextPrompt = deferred();
                }
                else if (request.method === 'session/cancel') {
                    respond(request, {});
                    peer.current?.finish('cancelled');
                }
                else respond(request, {});
            }
        });
        peers.push(peer);
        return { stdin, stdout, stderr, done: done.promise, waitForExit: () => exit.promise,
            terminate() {
                peer.terminations++;
                terminated.resolve();
                if (!peer.deferredExit) peer.finish();
                return exit.promise;
            } };
    };
    return { peers, prompts, spawn, next: () => nextPrompt.promise, stop: () => peers.forEach(peer => peer.finish()) };
}

async function harness(t, options = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-native-'));
    const peer = peerFactory();
    const children = new Map();
    const releases = [];
    const agents = {
        async create(spec) {
            if (options.creationError) throw new Error('fixture child creation failed');
            const child = { id: spec.sessionId, session: session(spec.sessionId, cwd) };
            children.set(child.id, child);
            spec.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => { releases.push(child.id); } };
        },
        async resume(spec) {
            const child = children.get(spec.resumeSessionId);
            if (!child) throw new Error('unknown child');
            spec.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => { releases.push(child.id); } };
        },
    };
    const mirrors = createMirrorHub({ maxChildren: 2 });
    mirrors.bind({ get: key => key === 'agents' ? agents : undefined });
    const journal = new RunJournal();
    const saved = new Map();
    const index = { async load() {}, get: key => saved.get(key), async set(key, value) { saved.set(key, value); }, async delete(key) { saved.delete(key); } };
    const pool = new SessionPool({ resolved: { command: 'fixture' }, env: {}, spawn: peer.spawn, maxLiveSessions: 8 }, (key, event) => {
        journal.append(key, event); mirrors.observe(key, event);
    });
    const raw = cursorCodeTool({ pool, mirrors, journal, index,
        resolveModelSelection: requested => resolveModelSelection({ model: 'auto', modelPolicy: 'panel' }, '', requested) });
    const bridge = createNativeCursorBridge({ execute: raw.execute, mirrors });
    const providers = new Map();
    const lifecycle = [];
    const runtime = {
        registerProvider(provider) {
            assert.equal(providers.has(provider.name), false);
            providers.set(provider.name, provider);
            return () => providers.delete(provider.name);
        },
        async start(name, request) {
            assert.equal(request.parent, parent, 'native lifecycle listeners are scoped by exact parent identity');
            const descriptor = { version: 3, mode: 'one-shot', provider: name, label: request.label };
            const run = await providers.get(name).start({ ...request, descriptor });
            try {
                if (run.localAgent !== undefined) {
                    request.parent.session.append('subagent/catalog', { version: 0, childId: run.localAgent.session.header.id,
                        childCreatedAt: run.localAgent.session.header.createdAt, mode: 'one-shot', label: request.label });
                }
            }
            catch (error) { await run.dispose(); throw error; }
            lifecycle.push({ type: 'start', id: run.id });
            run.result.then(result => lifecycle.push({ type: 'end', id: run.id, reason: result.stopReason }));
            return run;
        },
    };
    const disposers = [];
    const bind = () => bridge.bind({ get: key => key === 'subagents' ? runtime : undefined,
        effect(factory) { disposers.push(factory()); } });
    if (!options.unbound) bind();
    const parent = { id: 'parent', options: {}, ctx: { get: () => undefined }, session: session('parent', cwd) };
    if (options.catalogError) {
        const append = parent.session.append;
        parent.session.append = (type, ...args) => {
            if (type === 'subagent/catalog') throw new Error('fixture catalog failed');
            return append(type, ...args);
        };
    }
    const start = (task = 'perform the task', signal) => runtime.start('cursor', { parent, prompt: [{ type: 'text', text: task }], signal, label: 'task' });
    t.after(async () => {
        peer.stop();
        await bridge.dispose();
        for (const dispose of disposers) await dispose();
        await mirrors.dispose();
        pool.dispose();
        await rm(cwd, { recursive: true, force: true });
    });
    return { cwd, peer, children, releases, mirrors, journal, saved, index, pool, raw, bridge, providers, lifecycle, runtime, parent, start, bind, disposers };
}

for (const [input, expected] of [['end_turn', 'completed'], ['cancelled', 'aborted'], ['max_tokens', 'max-tokens'], ['refusal', 'refusal'], ['max_turn_requests', 'error'], ['future-value', 'error'], [undefined, 'error']]) {
    test(`native stop mapping: ${input} -> ${expected}`, () => {
        assert.equal(cursorStopReason(input), expected);
        assert.equal(cursorStopReason(input, true), 'aborted');
    });
}

test('late native binding registers honest capabilities and preserves standalone fallback', async t => {
    const h = await harness(t, { unbound: true });
    const next = h.peer.next();
    const pending = h.bridge.execute({ task: 'standalone' }, { agent: h.parent });
    (await next).finish();
    assert.equal((await pending).ok, true);
    assert.equal(h.lifecycle.length, 0);
    h.bind();
    const provider = h.providers.get('cursor');
    assert.equal(provider.inheritsParentContext, false);
    assert.ok(Object.values(provider.capabilities).every(value => value === false));
    assert.equal(provider.prepareContinuable, undefined);
    await h.disposers[0]();
    assert.equal(h.providers.size, 0);
});

test('cursor_code routes through native start, keeps rich diffs and continues the same child once in the catalog', async t => {
    const h = await harness(t);
    const next = h.peer.next();
    const pending = h.bridge.execute({ task: 'create a file', model: 'composer-2.5', sessionLabel: 'work', report: 'detailed' }, { agent: h.parent });
    const prompt = await next;
    await writeFile(join(h.cwd, 'result.txt'), 'done\n');
    prompt.textChunk('created result.txt');
    prompt.finish();
    const first = await pending;
    assert.equal(first.ok, true);
    assert.equal(first.model, 'default[]');
    assert.equal(first.modelSource, 'panel-lock');
    assert.equal(first.requestedModel, 'composer-2.5');
    assert.equal(first.changes[0].path, 'result.txt');
    assert.equal(first.preview.length, 1);
    const secondPrompt = h.peer.next();
    const followup = h.bridge.execute({ task: 'continue', sessionLabel: 'work', continueSession: true }, { agent: h.parent });
    (await secondPrompt).finish();
    const second = await followup;
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(first.childSessionId, second.childSessionId);
    assert.equal(first.cursorSessionId, second.cursorSessionId);
    assert.equal(h.children.size, 1);
    const events = h.parent.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === 'subagent/catalog').length, 1);
    assert.deepEqual(h.lifecycle.map(event => event.type), ['start', 'end', 'start', 'end']);
    assert.equal(h.children.get(first.childSessionId).session.snapshotEvents().filter(event => event.type === 'turn/end').length, 2);
});

test('direct native calls publish before the prompt and use independent conversations', async t => {
    const h = await harness(t);
    const next = h.peer.next();
    const first = await h.start('first');
    assert.equal(first.localAgent, undefined, 'Cursor executes externally, not in the DSH Agent loop');
    assert.ok(h.children.has(first.id), 'the external run still has a real navigable transcript mirror');
    const prompt = await next;
    prompt.textChunk('native answer'); prompt.finish();
    const result = await first.result;
    assert.equal(result.stopReason, 'completed');
    assert.match(result.output[0].text, /native answer/);
    await first.dispose();
    const nextSecond = h.peer.next();
    const second = await h.start('second');
    (await nextSecond).finish();
    await second.result;
    assert.notEqual(first.id, second.id);
    const a = await first.cursorReport, b = await second.cursorReport;
    assert.notEqual(a.conversationKey, b.conversationKey);
    assert.equal(a.model, 'default[]');
    const dispose = second.dispose();
    assert.equal(second.dispose(), dispose, 'disposal promise is idempotent');
    await dispose;
});

test('a queued native run aborts promptly without starting a second CLI or stopping the first', async t => {
    const h = await harness(t);
    const next = h.peer.next();
    const first = await h.start('hold the lock');
    const prompt = await next;
    const abort = new AbortController();
    const queued = await h.start('queued', abort.signal);
    abort.abort();
    assert.equal((await queued.result).stopReason, 'aborted');
    await queued.dispose();
    assert.equal(h.peer.peers.length, 1);
    assert.equal(h.peer.peers[0].terminations, 0);
    prompt.finish();
    assert.equal((await first.result).stopReason, 'completed');
    await first.dispose();
});

test('disposing an active run cancels ACP and waits for managed process exit before releasing the mirror', async t => {
    const h = await harness(t);
    const next = h.peer.next();
    const run = await h.start('hold prompt');
    const prompt = await next;
    prompt.textChunk('partial answer');
    prompt.peer.deferredExit = true;
    let disposed = false;
    const disposing = run.dispose().then(() => { disposed = true; });
    await prompt.peer.terminated.promise;
    assert.equal(disposed, false);
    assert.equal(h.releases.length, 0);
    assert.ok(prompt.peer.requests.some(request => request.method === 'session/cancel'));
    prompt.peer.finish();
    await disposing;
    assert.equal((await run.result).stopReason, 'aborted');
    assert.match((await run.result).output[0].text, /partial answer/);
    assert.equal(h.releases.length, 1);
});

test('prompt failure after publication settles as an error and preserves partial text', async t => {
    const h = await harness(t);
    const next = h.peer.next();
    const run = await h.start('fail during prompt');
    const prompt = await next;
    prompt.textChunk('work completed before transport error'); prompt.fail();
    const result = await run.result;
    assert.equal(result.stopReason, 'error');
    assert.match(result.diagnostic, /fixture prompt failed/);
    assert.match(result.output[0].text, /work completed before transport error/);
    await run.dispose();
});

test('pre-aborted, non-text, missing-workspace and unsupported requests fail before publication', async t => {
    const h = await harness(t);
    const base = { parent: h.parent, prompt: [{ type: 'text', text: 'task' }] };
    const provider = h.providers.get('cursor');
    await assert.rejects(provider.start({ ...base, signal: AbortSignal.abort() }));
    await assert.rejects(provider.start({ ...base, prompt: [{ type: 'image', data: 'x' }] }), /text blocks only/);
    await assert.rejects(provider.start({ ...base, parent: { id: 'no-workspace' } }), /workspace/);
    await assert.rejects(provider.start({ ...base, agentOptions: { model: 'other' } }), /unsupported/);
    assert.equal(h.peer.peers.length, 0);
    assert.equal(h.children.size, 0);
});

test('native child creation fails closed and leaves no process or lifecycle event', async t => {
    const h = await harness(t, { creationError: true });
    await assert.rejects(h.start(), /fixture child creation failed/);
    assert.equal(h.peer.peers.length, 0);
    assert.equal(h.lifecycle.length, 0);
});

test('host catalog failure cancels and disposes the unpublished run', async t => {
    const h = await harness(t, { catalogError: true });
    await assert.rejects(h.start(), /fixture catalog failed/);
    assert.equal(h.lifecycle.length, 0);
    assert.equal(h.releases.length, 1);
    assert.ok(h.peer.peers.every(peer => peer.dead));
});

test('native provider startup failure never publishes a holder or rejects its detached result', async () => {
    const provider = createCursorProvider({ execute: async () => { throw new Error('startup failed'); }, mirrors: {} });
    await assert.rejects(provider.start({ parent: { session: { header: { cwd: tmpdir() } } }, prompt: [{ type: 'text', text: 'task' }] }), /startup failed/);
    await provider.dispose();
});
