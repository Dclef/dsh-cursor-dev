/**
 * Guards for reading the Cursor CLI build stamp out of an install path.
 *
 * The official Win32 layout is
 * `%LOCALAPPDATA%\cursor-agent\versions\<stamp>\node.exe`, and the installer
 * leaves older version directories in place. Two things depend on reading that
 * shape correctly: telling the operator which build is actually running, and
 * noticing that a newer build is installed but not yet loaded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStampOf, newestInstalledBuild } from '../lib/resolve-agent.js';

const exe = process.platform === 'win32' ? 'node.exe' : 'node';

test('the build stamp comes from the version directory above the runtime', () => {
    assert.equal(buildStampOf({
        command: join('C:', 'Users', 'su', 'AppData', 'Local', 'cursor-agent', 'versions', '2026.11.19-f005e9d', exe),
        entry: join('C:', 'Users', 'su', 'AppData', 'Local', 'cursor-agent', 'versions', '2026.11.19-f005e9d', 'index.js'),
    }), '2026.11.19-f005e9d');
});

test('a binary with no version directory reports no stamp rather than a guess', () => {
    assert.equal(buildStampOf({ command: join('/usr', 'local', 'bin', 'agent') }), undefined);
    assert.equal(buildStampOf({ command: 'agent' }), undefined);
    assert.equal(buildStampOf(undefined), undefined);
    // A directory named "versions" two levels up is not enough: the leaf has to
    // look like a real stamp, or a wrapper path would be reported as a build.
    assert.equal(buildStampOf({ command: join('/opt', 'versions', 'latest', 'agent') }), undefined);
});

/**
 * Build a fake `LOCALAPPDATA` with the official layout underneath it:
 * `<root>/cursor-agent/versions/<stamp>/node.exe`.
 */
async function fakeInstall(stamps) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-stamps-'));
    for (const stamp of stamps) {
        const dir = join(root, 'cursor-agent', 'versions', stamp);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, exe), '');
    }
    return root;
}

test('the newest installed build is the one an upgrade just dropped', async t => {
    const root = await fakeInstall(['2026.10.01-e373342', '2026.11.19-f005e9d', '2026.10.22-27dcf5f']);
    t.after(() => rm(root, { recursive: true, force: true }));

    const newest = newestInstalledBuild({ LOCALAPPDATA: root, HOME: '' });
    assert.equal(newest, '2026.11.19-f005e9d', 'newest by date, not by string order');
});

test('an install with no versions directory answers undefined', () => {
    assert.equal(newestInstalledBuild({ LOCALAPPDATA: join(tmpdir(), 'definitely-not-here'), HOME: '' }), undefined);
});
