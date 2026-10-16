/**
 * Guards for Cursor CLI discovery and the plugin `command` override.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    resolveAgent,
    resolveConfiguredAgent,
    splitCommandParts,
} from '../lib/resolve-agent.js';

const exe = process.platform === 'win32' ? 'node.exe' : 'node';

/** Create a fake official bundle: `<root>/{node.exe,index.js}`. */
async function fakeBundle() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-cmd-'));
    const runtime = join(root, exe);
    const entry = join(root, 'index.js');
    await writeFile(runtime, '');
    await writeFile(entry, 'export {};\n');
    return { root, runtime, entry };
}

test('splitCommandParts keeps quoted Windows paths intact', () => {
    assert.deepEqual(splitCommandParts(String.raw`C:\tools\node.exe`), [String.raw`C:\tools\node.exe`]);
    assert.deepEqual(
        splitCommandParts(String.raw`"C:\Program Files\cursor\node.exe" "C:\Program Files\cursor\index.js"`),
        [String.raw`C:\Program Files\cursor\node.exe`, String.raw`C:\Program Files\cursor\index.js`],
    );
    assert.deepEqual(
        splitCommandParts(`${exe} ./index.js`),
        [exe, './index.js'],
    );
});

test('resolveConfiguredAgent accepts a runtime+entry pair', async t => {
    const { root, runtime, entry } = await fakeBundle();
    t.after(() => rm(root, { recursive: true, force: true }));

    const resolved = resolveConfiguredAgent(`"${runtime}" "${entry}"`);
    assert.deepEqual(resolved, { command: runtime, entry, source: 'config' });
});

test('resolveConfiguredAgent unwraps an install root', async t => {
    const { root, runtime, entry } = await fakeBundle();
    t.after(() => rm(root, { recursive: true, force: true }));

    const resolved = resolveConfiguredAgent(root);
    assert.deepEqual(resolved, { command: runtime, entry, source: 'config' });
});

test('resolveConfiguredAgent unwraps agent.cmd beside a bundle', async t => {
    const { root, runtime, entry } = await fakeBundle();
    t.after(() => rm(root, { recursive: true, force: true }));
    const cmd = join(root, 'agent.cmd');
    await writeFile(cmd, '@echo off\n');

    const resolved = resolveConfiguredAgent(cmd);
    assert.deepEqual(resolved, { command: runtime, entry, source: 'config' });
});

test('resolveConfiguredAgent accepts a bare spawnable binary', async t => {
    const { root, runtime } = await fakeBundle();
    t.after(() => rm(root, { recursive: true, force: true }));

    const resolved = resolveConfiguredAgent(runtime);
    assert.deepEqual(resolved, { command: runtime, entry: undefined, source: 'config' });
});

test('resolveConfiguredAgent rejects a missing path instead of guessing', () => {
    assert.equal(resolveConfiguredAgent(''), undefined);
    assert.equal(resolveConfiguredAgent('   '), undefined);
    assert.equal(resolveConfiguredAgent(join(tmpdir(), 'no-such-cursor-agent-xyz')), undefined);
});

test('resolveAgent prefers a valid config override over PATH discovery', async t => {
    const { root, runtime, entry } = await fakeBundle();
    t.after(() => rm(root, { recursive: true, force: true }));

    const resolved = resolveAgent({ PATH: '', Path: '', LOCALAPPDATA: '', HOME: root }, { command: root });
    assert.deepEqual(resolved, { command: runtime, entry, source: 'config' });
});

test('a broken config override does not fall back to auto-discovery', async t => {
    const { root, runtime, entry } = await fakeBundle();
    t.after(() => rm(root, { recursive: true, force: true }));
    // Put a real bundle on PATH-equivalent well-known dir, but pass a bad override.
    const home = await mkdtemp(join(tmpdir(), 'dsh-cursor-home-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const install = join(home, '.local', 'share', 'cursor-agent');
    await mkdir(install, { recursive: true });
    await writeFile(join(install, exe), '');
    await writeFile(join(install, 'index.js'), 'export {};\n');

    const resolved = resolveAgent(
        { PATH: '', Path: '', LOCALAPPDATA: '', HOME: home, USERPROFILE: home },
        { command: join(tmpdir(), 'missing-override-agent') },
    );
    assert.equal(resolved, undefined, 'a typo in command must not silently use PATH');

    const auto = resolveAgent(
        { PATH: '', Path: '', LOCALAPPDATA: '', HOME: home, USERPROFILE: home },
        { command: '' },
    );
    assert.deepEqual(auto, { command: join(install, exe), entry: join(install, 'index.js'), source: 'home-local' });
    // Keep the unused pair referenced so a future edit cannot drop the fixture.
    assert.ok(runtime && entry);
});
