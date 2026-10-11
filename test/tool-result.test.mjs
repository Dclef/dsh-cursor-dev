/**
 * A tool result the host cannot serialize is worse than a failed run: the child
 * did the work, the file is on disk, and the caller is told the call errored.
 *
 * The host rejects a value a JSON round-trip would not reproduce ("value is not
 * lossless JSON"), and an `undefined` property — an absent `reasoning`, a diff
 * with no line counts, a `usage` the CLI never sent — is exactly that. These
 * tests pin the cleaner that runs on every `cursor_code` result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLosslessJson } from '../lib/tool.js';

/** What the host means by lossless: parse(stringify(value)) deep-equals value. */
function assertLossless(value) {
    const round = JSON.parse(JSON.stringify(value));
    assert.deepEqual(round, value, 'the value survives a JSON round-trip');
    assert.equal(findUnserializable(round), undefined, 'no undefined/NaN slips through');
}

/** Walks the value the way the host does; returns the first offending path. */
function findUnserializable(value, path = 'result') {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value)))
        return `${path} is ${typeof value === 'number' ? 'not finite' : 'undefined'}`;
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            const bad = findUnserializable(item, `${path}[${index}]`);
            if (bad !== undefined)
                return bad;
        }
        return undefined;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            const bad = findUnserializable(item, `${path}.${key}`);
            if (bad !== undefined)
                return bad;
        }
    }
    return undefined;
}

test('a run whose turn never reported a model or usage still round-trips', () => {
    const result = toLosslessJson({
        ok: true,
        sessionKey: 's-1',
        cursorSessionId: 'abc',
        model: undefined,
        mode: undefined,
        stopReason: 'end_turn',
        durationMs: 1234,
        text: 'done',
        steps: [{ seq: 1, kind: 'tool-call', text: 'Write hello.md' }],
        changes: [{ path: 'hello.md', operation: 'created', added: undefined, removed: undefined, source: 'acp' }],
        preview: [{ path: 'hello.md', diff: '+hello' }],
        reasoning: undefined,
        scannedBefore: 3,
        truncatedScan: undefined,
        usage: undefined,
    });
    assert.equal(result.model, undefined);
    assertLossless(result);
    // The keys that only ever hold real data stay; count-only diffs keep a source.
    assert.deepEqual(result.changes, [{ path: 'hello.md', operation: 'created', source: 'acp' }]);
    assert.equal(result.ok, true);
});

test('the error path is cleaned too', () => {
    const result = toLosslessJson({
        ok: false,
        cursorSessionId: undefined,
        stopReason: 'error',
        durationMs: 12,
        error: 'the Cursor CLI is not available',
        steps: [],
        changes: [],
    });
    assertLossless(result);
    assert.equal(result.ok, false);
    assert.ok(!('cursorSessionId' in result));
});

test('falsy values that are real data survive; only absent ones are dropped', () => {
    const result = toLosslessJson({
        zero: 0,
        no: false,
        empty: '',
        nothing: null,
        missing: undefined,
        list: [0, false, '', null, undefined, 'x'],
    });
    assert.deepEqual(result, { zero: 0, no: false, empty: '', nothing: null, list: [0, false, '', null, 'x'] });
    assertLossless(result);
});

test('odd values become JSON instead of killing the turn', () => {
    const when = new Date('2026-10-12T00:49:19.000Z');
    const result = toLosslessJson({
        when,
        big: 10n,
        fn: () => 'x',
        symbol: Symbol('s'),
        infinite: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
        map: new Map([['a', 1], ['b', undefined]]),
        set: new Set(['a', undefined]),
    });
    assert.equal(result.when, '2026-10-12T00:49:19.000Z');
    assert.equal(result.infinite, null);
    assert.equal(result.nan, null);
    assert.deepEqual(result.map, { a: 1 });
    assert.deepEqual(result.set, ['a']);
    assert.ok(!('big' in result) && !('fn' in result) && !('symbol' in result));
    assertLossless(result);
});

test('a cycle is dropped instead of hanging the run', () => {
    const node = { name: 'a', child: undefined };
    node.child = node;
    const result = toLosslessJson({ root: node });
    assert.deepEqual(result, { root: { name: 'a' } });
    assertLossless(result);
});

test('shared references are kept, not mistaken for cycles', () => {
    const shared = { id: 1 };
    const result = toLosslessJson({ first: shared, second: shared });
    assert.deepEqual(result, { first: { id: 1 }, second: { id: 1 } });
    assertLossless(result);
});
