/**
 * Guards for `lib/attribution.js`.
 *
 * This module edits a file it does not own — Cursor's own `cli-config.json` —
 * because that file is the only switch for commit attribution: no flag, no
 * environment variable. So the tests are mostly about restraint: keep every key
 * we did not come for, do nothing when the file already agrees, and never
 * rewrite a file we cannot parse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyAttribution,
    attributionPath,
    cursorConfigDir,
    desiredAttribution,
    readAttribution,
} from '../lib/attribution.js';

/** Run a test body against a throwaway config directory. */
async function withConfigDir(body) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cursor-dev-attribution-'));
    try {
        return await body(dir, { CURSOR_CONFIG_DIR: dir });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('the config directory follows the order the CLI itself uses', () => {
    assert.equal(cursorConfigDir({ CURSOR_CONFIG_DIR: 'C:/custom' }), 'C:/custom');
    assert.equal(cursorConfigDir({ CURSOR_CONFIG_DIR: '  ', XDG_CONFIG_HOME: 'C:/xdg' }),
        join('C:/xdg', 'cursor'), 'a blank override is not an override');
    assert.match(cursorConfigDir({}), /\.cursor$/, 'and only then the home directory');
    assert.equal(attributionPath({ CURSOR_CONFIG_DIR: 'C:/custom' }), join('C:/custom', 'cli-config.json'));
});

test('a choice maps to the two flags, and keep maps to nothing at all', () => {
    assert.deepEqual(desiredAttribution('off'), { attributeCommitsToAgent: false, attributePRsToAgent: false });
    assert.deepEqual(desiredAttribution('on'), { attributeCommitsToAgent: true, attributePRsToAgent: true });
    assert.equal(desiredAttribution('keep'), undefined, 'keep is a real choice: write nothing');
    assert.equal(desiredAttribution(undefined), undefined);
});

test('a machine with no Cursor config reads as the CLI default, and is created when we turn it off', async () => {
    await withConfigDir(async (dir, env) => {
        const before = readAttribution(env);
        assert.equal(before.present, false);
        assert.deepEqual(before.attribution, { attributeCommitsToAgent: true, attributePRsToAgent: true },
            'a missing file means the CLI would credit itself');

        const applied = applyAttribution('off', { env });
        assert.equal(applied.changed, true);
        assert.equal(applied.error, undefined);
        assert.deepEqual(applied.attribution, { attributeCommitsToAgent: false, attributePRsToAgent: false });
        const written = JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8'));
        assert.equal(written.attribution.attributeCommitsToAgent, false);
        assert.equal(existsSync(join(dir, 'cli-config.json.dsh-cursor-dev.tmp')), false,
            'the temporary file is renamed, not left behind');
    });
});

test('every other key in Cursor settings survives, and an agreeing file is not rewritten', async () => {
    await withConfigDir(async (dir, env) => {
        const path = join(dir, 'cli-config.json');
        const original = {
            version: 1,
            editor: { vimMode: true },
            model: 'grok-4.7',
            permissions: { allow: ['Shell(ls)'], deny: [] },
            authInfo: { email: 'someone@example.com' },
            attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true, extra: 'kept' },
        };
        writeFileSync(path, JSON.stringify(original, null, 2));

        const applied = applyAttribution('off', { env });
        assert.equal(applied.changed, true);
        const written = JSON.parse(readFileSync(path, 'utf8'));
        assert.deepEqual(written.editor, original.editor);
        assert.deepEqual(written.permissions, original.permissions);
        assert.deepEqual(written.authInfo, original.authInfo);
        assert.equal(written.model, 'grok-4.7');
        assert.equal(written.attribution.extra, 'kept', 'a key we did not come for stays');

        // Second call: nothing to do, so the file must not be touched at all.
        const settled = readFileSync(path, 'utf8');
        const again = applyAttribution('off', { env });
        assert.equal(again.changed, false, 'already off is not a change');
        assert.equal(readFileSync(path, 'utf8'), settled, 'an agreeing file is left alone');

        // A file with no attribution block at all is the CLI default, which is
        // "credit everything" — so it is a change, not a no-op.
        writeFileSync(path, '{"marker":"untouched"}');
        const fresh = applyAttribution('off', { env });
        assert.equal(fresh.changed, true);
        const written2 = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(written2.marker, 'untouched', 'an unknown top-level key stays');
        assert.equal(written2.attribution.attributePRsToAgent, false);
    });
});

test('keep writes nothing, even when the file disagrees', async () => {
    await withConfigDir(async (dir, env) => {
        const path = join(dir, 'cli-config.json');
        writeFileSync(path, JSON.stringify({ attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true } }));
        const applied = applyAttribution('keep', { env });
        assert.equal(applied.changed, false);
        assert.deepEqual(applied.attribution, { attributeCommitsToAgent: true, attributePRsToAgent: true });
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).attribution.attributeCommitsToAgent, true);
    });
});

test('a file we cannot parse is reported, never replaced', async () => {
    await withConfigDir(async (dir, env) => {
        const path = join(dir, 'cli-config.json');
        const broken = '{ "version": 1, "attribution": ';
        writeFileSync(path, broken);
        const applied = applyAttribution('off', { env });
        assert.equal(applied.changed, false);
        assert.match(applied.error, /JSON|position|Unexpected/i);
        assert.equal(readFileSync(path, 'utf8'), broken, 'the operator can still see what broke');
        const read = readAttribution(env);
        assert.equal(read.present, true);
        assert.deepEqual(read.attribution, { attributeCommitsToAgent: true, attributePRsToAgent: true },
            'an unreadable file reports what the CLI would fall back to');
    });
});

test('a settings document that is not an object is refused', async () => {
    await withConfigDir(async (dir, env) => {
        const path = join(dir, 'cli-config.json');
        writeFileSync(path, '[]');
        const applied = applyAttribution('off', { env });
        assert.equal(applied.changed, false);
        assert.match(applied.error, /not an object/);
        assert.equal(readFileSync(path, 'utf8'), '[]');
    });
});
