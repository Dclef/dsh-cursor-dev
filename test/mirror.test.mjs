/**
 * A Cursor run becomes a real DSH child conversation.
 *
 * The point of these tests is the SESSION LOG CONTRACT, not the plumbing: a
 * child conversation only appears in the parent's header when the child session
 * exists and carries a `subagent/descriptor`, and the transcript only renders
 * when every appended event obeys the surface rules. Getting one of those wrong
 * throws inside `Session.append` at run time — in the middle of real work, with
 * the user's files already changed — which is exactly what a fake session that
 * enforces the same rules catches here instead.
 *
 * The rules, from `@deepseek-ai/dsh-session`:
 *   - `user/message`, `assistant/message`, `system/message`, `developer/message`
 *     and `tool/result` are surface-eligible and REQUIRE `surfaceOp`;
 *   - every other type must carry NO surface metadata at all;
 *   - `tool/result` cites the `tool/call` seq it answers through
 *     `sourceEventSeqs`, which is how the UI pairs a result with its card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CursorMirror,
    DESCRIPTOR_VERSION,
    PROVIDER_NAME,
    catalogPayload,
    childSessionMeta,
    createMirrorHub,
    cursorDescriptor,
    delegationDepthOf,
    highestTurn,
    openCursorChild,
    resolveChildAgentOptions,
    resolveChildDepth,
    resumeCursorChild,
    turnEndReason,
} from '../lib/mirror.js';

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/**
 * A session double that enforces the real append contract.
 *
 * @param options - `header`, `events` to start from.
 */
function fakeSession(options = {}) {
    const events = options.events ?? [];
    const appends = [];
    let seq = events.length;
    return {
        header: { id: 'session-child', createdAt: 1_700_000_000_000, ...options.header },
        events,
        appends,
        snapshotEvents() {
            return events;
        },
        append(type, data, opts) {
            if (SURFACE_TYPES.has(type) && opts?.surfaceOp === undefined)
                throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`);
            if (!SURFACE_TYPES.has(type) && (opts?.surfaceOp !== undefined || opts?.sourceEventSeqs !== undefined))
                throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`);
            for (const cited of opts?.sourceEventSeqs ?? []) {
                if (!Number.isSafeInteger(cited) || cited < 0 || cited >= seq)
                    throw new Error(`session event "${type}" cites an impossible source seq ${cited}`);
            }
            const event = { type, seq, time: 1_700_000_000_000 + seq, data, ...opts === undefined ? {} : opts };
            events.push(event);
            appends.push(event);
            seq += 1;
            return event;
        },
    };
}

/** Every event of one type, in order. */
function ofType(session, type) {
    return session.appends.filter(event => event.type === type);
}

test('a mirrored run is a complete, renderable DSH turn', () => {
    const session = fakeSession();
    const mirror = new CursorMirror(session);

    mirror.begin('Write hello.txt with "hi"');
    mirror.observe({
        kind: 'tool-call',
        call: { id: 'c1', name: 'Edit File', kind: 'edit', status: 'pending', path: 'hello.txt', input: { path: 'hello.txt' } },
    });
    mirror.observe({
        kind: 'diff',
        callId: 'c1',
        diff: { path: 'hello.txt', oldText: '', newText: 'hi\n' },
    });
    mirror.observe({ kind: 'tool-update', call: { id: 'c1', status: 'completed', path: 'hello.txt' }, diffCount: 1 });
    mirror.observe({ kind: 'thought', text: 'The file does not exist yet.' });
    mirror.observe({ kind: 'text', text: 'Created hello.txt.' });
    mirror.finish({ ok: true, stopReason: 'end_turn', text: 'Created hello.txt.', model: 'composer-2.5[fast=true]' });

    assert.deepEqual(session.appends.map(event => event.type), [
        'turn/start',
        'step/start',
        'user/message',
        'tool/call',
        'tool/result',
        'assistant/message',
        'step/end',
        'turn/end',
    ]);

    // The task is the child's user message, marked as a surface append.
    const task = ofType(session, 'user/message')[0];
    assert.equal(task.surfaceOp, 'append');
    assert.deepEqual(task.data.content, [{ type: 'text', text: 'Write hello.txt with "hi"' }]);
    assert.equal(task.data.role, 'user');

    // The tool card pairs a result with its call through the cited seq.
    const call = ofType(session, 'tool/call')[0];
    assert.equal(call.surfaceOp, undefined);
    assert.equal(call.data.name, 'Edit File');
    assert.equal(call.data.callId, 'c1');
    assert.equal(call.data.arguments, JSON.stringify({ path: 'hello.txt' }));
    const result = ofType(session, 'tool/result')[0];
    assert.equal(result.surfaceOp, 'append');
    assert.deepEqual(result.sourceEventSeqs, [call.seq]);
    assert.equal(result.data.message.role, 'tool');
    assert.equal(result.data.message.toolCallId, 'c1');
    assert.equal(result.data.message.isError, false);
    assert.match(result.data.message.content[0].text, /completed hello\.txt/);
    assert.match(result.data.message.content[0].text, /\+1\/-0/);

    // Reasoning and answer land in ONE assistant message, in that order.
    const answer = ofType(session, 'assistant/message')[0];
    assert.equal(answer.surfaceOp, 'append');
    assert.deepEqual(answer.data.message.content, [
        { type: 'reasoning', text: 'The file does not exist yet.' },
        { type: 'text', text: 'Created hello.txt.' },
    ]);
    assert.deepEqual(answer.data.message.source, {
        kind: 'model',
        provider: PROVIDER_NAME,
        model: 'composer-2.5[fast=true]',
    });

    assert.deepEqual(ofType(session, 'turn/end')[0].data, { turn: 1, reason: { kind: 'completed' } });
    assert.equal(mirror.open, false);
});

test('a call that never reported a result still gets one when the turn closes', () => {
    const session = fakeSession();
    const mirror = new CursorMirror(session);
    mirror.begin('do a thing');
    mirror.observe({ kind: 'tool-call', call: { id: 'c1', name: 'Shell', kind: 'execute', status: 'pending' } });
    mirror.finish({ ok: true, stopReason: 'end_turn' });

    const results = ofType(session, 'tool/result');
    assert.equal(results.length, 1, 'an unanswered call would render as a card that never finishes');
    assert.equal(results[0].data.message.isError, true);
    assert.match(results[0].data.message.content[0].text, /no result reported/);
});

test('a call id is opened once, however many updates repeat it', () => {
    const session = fakeSession();
    const mirror = new CursorMirror(session);
    mirror.begin('do a thing');
    const call = { id: 'c1', name: 'Edit File', kind: 'edit', status: 'pending', path: 'a.txt' };
    mirror.observe({ kind: 'tool-call', call });
    mirror.observe({ kind: 'tool-call', call: { ...call, status: 'in_progress' } });
    mirror.observe({ kind: 'tool-update', call: { id: 'c1', status: 'in_progress' }, diffCount: 0 });
    mirror.observe({ kind: 'tool-update', call: { id: 'c1', status: 'completed' }, diffCount: 0 });
    // A late update after the result must not reopen the card.
    mirror.observe({ kind: 'tool-update', call: { id: 'c1', status: 'completed' }, diffCount: 0 });

    assert.equal(ofType(session, 'tool/call').length, 1);
    assert.equal(ofType(session, 'tool/result').length, 1);
    assert.equal(mirror.calls, 1);
});

test('a second turn continues the same child log instead of restarting it', () => {
    const session = fakeSession();
    const first = new CursorMirror(session);
    first.begin('first task');
    first.finish({ ok: true, stopReason: 'end_turn' });

    // A resumed run builds a new mirror over the same, already-written log.
    const second = new CursorMirror(session);
    assert.equal(highestTurn(session), 1);
    second.begin('second task');
    second.finish({ ok: true, stopReason: 'end_turn' });

    assert.deepEqual(ofType(session, 'turn/start').map(event => event.data.turn), [1, 2]);
    assert.deepEqual(ofType(session, 'turn/end').map(event => event.data.turn), [1, 2]);
    assert.equal(ofType(session, 'user/message').length, 2, 'both tasks are readable in one transcript');
});

test('begin closes a turn left open, so a crashed run cannot strand the log', () => {
    const session = fakeSession();
    const mirror = new CursorMirror(session);
    mirror.begin('first task');
    mirror.begin('second task');

    assert.deepEqual(session.appends.map(event => event.type), [
        'turn/start',
        'step/start',
        'user/message',
        'assistant/message',
        'step/end',
        'turn/end',
        'turn/start',
        'step/start',
        'user/message',
    ]);
    assert.equal(ofType(session, 'turn/end')[0].data.reason.kind, 'error');
});

test('a failed or cancelled run records that outcome', () => {
    const failed = fakeSession();
    const a = new CursorMirror(failed);
    a.begin('task');
    a.finish({ ok: false, stopReason: 'error', error: 'cursor-acp: prompt failed' });
    assert.deepEqual(ofType(failed, 'turn/end')[0].data.reason, {
        kind: 'error',
        error: { message: 'cursor-acp: prompt failed', code: 'cursor/run-failed' },
    });
    assert.match(ofType(failed, 'assistant/message')[0].data.message.content[0].text, /run failed/);

    const cancelled = fakeSession();
    const b = new CursorMirror(cancelled);
    b.begin('task');
    b.finish({ ok: false, stopReason: 'cancelled' });
    assert.deepEqual(ofType(cancelled, 'turn/end')[0].data.reason, { kind: 'aborted', reason: { kind: 'parent' } });

    const capped = fakeSession();
    const c = new CursorMirror(capped);
    c.begin('task');
    c.finish({ ok: false, stopReason: 'max_tokens' });
    assert.deepEqual(ofType(capped, 'turn/end')[0].data.reason, { kind: 'max-tokens' });
});

test('a run with no text at all still renders something', () => {
    const session = fakeSession();
    const mirror = new CursorMirror(session);
    mirror.begin('task');
    mirror.finish({ ok: true, stopReason: 'end_turn' });
    const content = ofType(session, 'assistant/message')[0].data.message.content;
    assert.equal(content.length, 1);
    assert.match(content[0].text, /no written summary/);
});

test('events that belong to no open turn are ignored', () => {
    const session = fakeSession();
    const mirror = new CursorMirror(session);
    mirror.observe({ kind: 'tool-call', call: { id: 'c1', name: 'Shell', kind: 'execute', status: 'pending' } });
    mirror.observe({ kind: 'text', text: 'stray' });
    assert.equal(session.appends.length, 0);

    // A tool call Cursor announces before the mirror opened its turn is adopted
    // rather than dropped: the alternative is a card that never appears.
    mirror.begin('task');
    mirror.observe({ kind: 'tool-update', call: { id: 'c2', name: 'Shell', kind: 'execute', status: 'completed' } });
    assert.equal(ofType(session, 'tool/call').length, 1);
    assert.equal(ofType(session, 'tool/call')[0].data.callId, 'c2');
});

test('the child carries the descriptor the client folds into a labelled row', () => {
    const descriptor = cursorDescriptor({ label: 'default' });
    assert.deepEqual(descriptor, { version: DESCRIPTOR_VERSION, mode: 'one-shot', provider: PROVIDER_NAME, label: 'default' });
    assert.ok(Object.isFrozen(descriptor));
    // Without a label the row falls back to the raw session id, which is still
    // better than an invalid payload.
    assert.deepEqual(cursorDescriptor({}), { version: 3, mode: 'one-shot', provider: 'cursor' });
    assert.deepEqual(cursorDescriptor({ label: '' }), { version: 3, mode: 'one-shot', provider: 'cursor' });
});

test('the catalog entry matches what the runtime itself appends', () => {
    assert.deepEqual(catalogPayload({ childId: 'session-x', childCreatedAt: 12, label: 'default' }), {
        version: 0,
        childId: 'session-x',
        childCreatedAt: 12,
        mode: 'one-shot',
        label: 'default',
    });
    assert.deepEqual(catalogPayload({ childId: 'session-x', childCreatedAt: 12 }), {
        version: 0,
        childId: 'session-x',
        childCreatedAt: 12,
        mode: 'one-shot',
    });
});

test('the child inherits the parent route and is stamped with its depth', () => {
    const parent = {
        options: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
        session: { header: { id: 'session-parent', cwd: 'E:\\work' } },
    };
    assert.equal(delegationDepthOf(parent), 0);
    assert.equal(resolveChildDepth(parent, undefined), 1);
    assert.throws(() => resolveChildDepth({ session: { header: { delegationDepth: 2 } } }, 2), /exceeds maxDepth 2/);

    const meta = childSessionMeta(parent, 1, false);
    assert.deepEqual(meta, {
        cwd: 'E:\\work',
        parentSession: 'session-parent',
        isSeeded: false,
        origin: 'subagent',
        delegationDepth: 1,
    });

    const options = resolveChildAgentOptions(parent, undefined, 1);
    assert.equal(options.provider, 'workbuddy-ai');
    assert.equal(options.model, 'deepseek-v4.1-flash');
    assert.equal(options.reasoningEffort, 'max');
    assert.equal(options.subagentDepth, 1);
});

test('a child on a different route does not inherit the parent reasoning effort', () => {
    const parent = {
        options: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
        session: { header: { id: 'session-parent' } },
    };
    const options = resolveChildAgentOptions(parent, { provider: 'cursor', model: 'composer-2.5' }, 1);
    assert.equal(options.provider, 'cursor');
    assert.equal(options.model, 'composer-2.5');
    assert.equal('reasoningEffort' in options, false, 'an effort that belongs to the old route must not leak');
});

test('the parent request header outranks the creation options', () => {
    const parent = {
        options: { provider: 'old', model: 'old-model', reasoningEffort: 'low', maxTokens: 100 },
        session: {
            header: { id: 'session-parent' },
            requestHeader: () => ({ config: { provider: 'new', model: 'new-model' } }),
        },
    };
    const options = resolveChildAgentOptions(parent, undefined, 1);
    assert.equal(options.provider, 'new');
    assert.equal(options.model, 'new-model');
    assert.equal('reasoningEffort' in options, false);
    assert.equal(options.maxTokens, 100, 'unrelated options survive');
});

/** A parent agent double, plus the `agents` service double that records calls. */
function fakeParent(overrides = {}) {
    const parentSession = fakeSession({ header: { id: 'session-parent', createdAt: 5, cwd: 'E:\\work' } });
    const parent = {
        id: 'session-parent',
        options: {},
        ctx: { get: () => undefined },
        session: parentSession,
        ...overrides,
    };
    return { parent, parentSession };
}

test('opening a child creates a real session, announces it, and mirrors into it', async () => {
    const { parent, parentSession } = fakeParent();
    const created = [];
    const agents = {
        async create(options) {
            created.push(options);
            const session = fakeSession({ header: { id: options.sessionId, createdAt: 7 } });
            const child = { id: options.sessionId, session };
            options.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => {} };
        },
    };

    const opened = await openCursorChild({ agents, parent, label: 'default', logger: undefined });
    assert.ok(opened !== undefined);
    assert.equal(created.length, 1);
    assert.equal(created[0].sessionId, opened.child.session.header.id);
    assert.equal(created[0].parentAgent, parent);
    assert.deepEqual(created[0].meta, {
        cwd: 'E:\\work',
        parentSession: 'session-parent',
        isSeeded: false,
        origin: 'subagent',
        delegationDepth: 1,
    });
    assert.equal(created[0].agentOptions.subagentDepth, 1);

    // The descriptor goes into the CHILD's log, and the catalog row into the
    // parent's — two different logs, which is what makes the row navigable.
    assert.deepEqual(ofType(opened.child.session, 'subagent/descriptor')[0].data, {
        version: 3,
        mode: 'one-shot',
        provider: 'cursor',
        label: 'default',
    });
    const catalog = ofType(parentSession, 'subagent/catalog');
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].data.childId, opened.child.session.header.id);
    assert.equal(catalog[0].data.childCreatedAt, 7);
    assert.equal(catalog[0].data.mode, 'one-shot');

    opened.mirror.begin('task');
    opened.mirror.finish({ ok: true, stopReason: 'end_turn' });
    assert.equal(ofType(opened.child.session, 'turn/end').length, 1);
});

test('a host without an agent loop simply has no child conversations', async () => {
    const { parent } = fakeParent();
    assert.equal(await openCursorChild({ agents: undefined, parent }), undefined);
    assert.equal(await openCursorChild({ agents: {}, parent }), undefined);
    // A parent with no session cannot own a catalog entry either.
    assert.equal(await openCursorChild({ agents: { create: async () => ({}) }, parent: {} }), undefined);
    assert.equal(await resumeCursorChild({ agents: undefined, parent, childSessionId: 'x' }), undefined);
    assert.equal(await resumeCursorChild({ agents: { resume: async () => ({}) }, parent, childSessionId: '' }), undefined);
});

test('reopening a child resumes its log and does not list it twice', async () => {
    const { parent, parentSession } = fakeParent();
    const resumed = [];
    const agents = {
        async resume(options) {
            resumed.push(options);
            const session = fakeSession({
                header: { id: options.resumeSessionId, createdAt: 7 },
                events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
            });
            const child = { id: options.resumeSessionId, session };
            options.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => {} };
        },
    };

    const opened = await resumeCursorChild({ agents, parent, childSessionId: 'session-old' });
    assert.ok(opened !== undefined);
    assert.equal(resumed[0].resumeSessionId, 'session-old');
    assert.equal(resumed[0].parentAgent, parent);
    assert.equal(ofType(parentSession, 'subagent/catalog').length, 0, 'the row is already in the parent log');
    assert.equal(ofType(opened.child.session, 'subagent/descriptor').length, 0, 'a second descriptor would reset the row timing');
    assert.equal(highestTurn(opened.child.session), 1, 'the mirror continues the existing turn numbering');
});

test('the hub keeps one child conversation per Cursor conversation', async () => {
    const { parent } = fakeParent();
    const created = [];
    const agents = {
        async create(options) {
            created.push(options);
            const session = fakeSession({ header: { id: options.sessionId, createdAt: 7 } });
            const child = { id: options.sessionId, session };
            options.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => { child.disposed = true; } };
        },
    };
    const hub = createMirrorHub({ logger: undefined });
    assert.equal(hub.available, false);
    hub.bind({ get: name => (name === 'agents' ? agents : undefined) });
    assert.equal(hub.available, true);

    const first = await hub.open({ key: 'parent::default#1', parent, label: 'default' });
    const again = await hub.open({ key: 'parent::default#1', parent, label: 'default' });
    assert.equal(first, again, 'the same conversation must not open two children');
    assert.equal(created.length, 1);

    // Events are routed by key, so a different conversation never contaminates
    // this transcript.
    first.mirror.begin('task');
    hub.observe('parent::default#1', { kind: 'text', text: 'from the right conversation' });
    hub.observe('parent::default#2', { kind: 'text', text: 'from another one' });
    hub.close('parent::default#1', { ok: true, stopReason: 'end_turn' });
    const answer = ofType(first.child.session, 'assistant/message')[0];
    assert.equal(answer.data.message.content[0].text, 'from the right conversation');

    // A reset closes the conversation it is resetting, and only that one.
    const other = await hub.open({ key: 'parent::other#1', parent, label: 'other' });
    await hub.dropConversation('parent::default');
    assert.equal(first.child.disposed, true, 'the reset conversation is closed');
    assert.equal(other.child.disposed, undefined, 'an unrelated conversation stays open');

    await hub.dispose();
    assert.equal(other.child.disposed, true);
});

test('the hub reopens the remembered child instead of opening a second one', async () => {
    const { parent, parentSession } = fakeParent();
    const created = [];
    const resumed = [];
    const agents = {
        async create(options) {
            created.push(options);
            const session = fakeSession({ header: { id: options.sessionId, createdAt: 7 } });
            const child = { id: options.sessionId, session };
            options.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => {} };
        },
        async resume(options) {
            resumed.push(options);
            const session = fakeSession({ header: { id: options.resumeSessionId, createdAt: 7 } });
            const child = { id: options.resumeSessionId, session };
            options.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => {} };
        },
    };
    const hub = createMirrorHub({});
    hub.bind({ get: name => (name === 'agents' ? agents : undefined) });

    const reopened = await hub.open({ key: 'p::default#2', parent, label: 'default', childSessionId: 'session-old' });
    assert.equal(reopened.child.session.header.id, 'session-old');
    assert.equal(resumed.length, 1);
    assert.equal(created.length, 0);
    assert.equal(ofType(parentSession, 'subagent/catalog').length, 0);

    // A child that cannot be reopened falls back to a fresh conversation rather
    // than leaving the run unmirrored.
    const failing = createMirrorHub({});
    failing.bind({
        get: name => (name === 'agents'
            ? { resume: async () => { throw new Error('unknown session'); }, create: agents.create }
            : undefined),
    });
    const fresh = await failing.open({ key: 'p::default#3', parent, label: 'default', childSessionId: 'gone' });
    assert.equal(fresh.resumed, false);
    assert.notEqual(fresh.child.session.header.id, 'gone');
    await failing.dispose();
});

test('a hub with no agent loop reports itself unavailable and mirrors nothing', async () => {
    const { parent } = fakeParent();
    const hub = createMirrorHub({});
    assert.equal(hub.available, false);
    assert.equal(await hub.open({ key: 'p::default#1', parent, label: 'default' }), undefined);
    // Observing and closing are safe no-ops, so the tool never has to branch.
    hub.observe('p::default#1', { kind: 'text', text: 'ignored' });
    hub.close('p::default#1', { ok: true });
    await hub.release('p::default#1');
    await hub.dropConversation('p::default');
    await hub.dispose();
});

test('the live child set stays bounded; the oldest conversation is closed first', async () => {
    const { parent } = fakeParent();
    const agents = {
        async create(options) {
            const session = fakeSession({ header: { id: options.sessionId, createdAt: 7 } });
            const child = { id: options.sessionId, session, closed: false };
            options.setup?.({ get: () => undefined }, child);
            return {
                agent: child,
                dispose: async () => {
                    child.closed = true;
                },
            };
        },
    };
    const hub = createMirrorHub({ maxChildren: 2 });
    hub.bind({ get: name => (name === 'agents' ? agents : undefined) });

    const first = await hub.open({ key: 'p::a#1', parent, label: 'a' });
    // Touching a conversation makes it the most recently used one.
    hub.observe('p::a#1', { kind: 'text', text: 'still working' });
    const second = await hub.open({ key: 'p::b#1', parent, label: 'b' });
    const third = await hub.open({ key: 'p::c#1', parent, label: 'c' });

    assert.equal(first.child.closed, true, 'the least recently used child is closed, not the newest');
    assert.equal(second.child.closed, false);
    assert.equal(third.child.closed, false);
    await hub.dispose();
    assert.equal(second.child.closed, true);
    assert.equal(third.child.closed, true);
});

test('a failing child conversation never fails the run', async () => {
    const { parent } = fakeParent();
    const warnings = [];
    const hub = createMirrorHub({ logger: { warn: message => warnings.push(message), info: () => {} } });
    hub.bind({ get: () => ({ create: async () => { throw new Error('no factory'); } }) });
    assert.equal(await hub.open({ key: 'p::default#1', parent, label: 'default' }), undefined);
    assert.match(warnings[0], /could not open a child conversation: no factory/);

    // A catalog append that throws is reported, not propagated.
    const agents = {
        async create(options) {
            const session = fakeSession({ header: { id: options.sessionId, createdAt: 7 } });
            const child = { id: options.sessionId, session };
            options.setup?.({ get: () => undefined }, child);
            return { agent: child, dispose: async () => {} };
        },
    };
    const broken = { ...parent, session: { ...parent.session, append: () => { throw new Error('append refused'); } } };
    const second = createMirrorHub({ logger: { warn: message => warnings.push(message), info: () => {} } });
    second.bind({ get: () => agents });
    const opened = await second.open({ key: 'p::default#2', parent: broken, label: 'default' });
    assert.ok(opened !== undefined, 'the child still works without its header entry');
    assert.ok(warnings.some(message => /child catalog entry failed: append refused/.test(message)));
    await second.dispose();
});

test('turn end reasons cover every outcome the runtime understands', () => {
    assert.deepEqual(turnEndReason({ ok: true }), { kind: 'completed' });
    assert.deepEqual(turnEndReason({ ok: false, cancelled: true }), { kind: 'aborted', reason: { kind: 'parent' } });
    assert.deepEqual(turnEndReason({ ok: false, stopReason: 'cancelled' }), { kind: 'aborted', reason: { kind: 'parent' } });
    assert.deepEqual(turnEndReason({ ok: false, stopReason: 'max_tokens' }), { kind: 'max-tokens' });
    assert.deepEqual(turnEndReason({ ok: false, stopReason: 'refusal' }), {
        kind: 'error',
        error: { message: 'cursor run ended with refusal', code: 'cursor/run-failed' },
    });
    assert.equal(turnEndReason({ ok: false, stopReason: 'error', error: 'boom' }).error.message, 'boom');
});
