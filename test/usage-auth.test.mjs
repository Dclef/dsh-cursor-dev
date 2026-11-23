/**
 * Guards for where the usage panel gets its Cursor token (`lib/usage.js`).
 *
 * The CLI's credential store is not one file across platforms: macOS keeps the
 * login in the login Keychain (generic-password items `cursor-access-token` /
 * `cursor-refresh-token` / `cursor-api-key`, all under account `cursor-user`),
 * Windows can use DPAPI, and the legacy file store uses per-user `auth.json`.
 * The tests use fixtures only, never the real Keychain or Windows login.
 *
 * These tests pin the lookup order and the two shapes `/usr/bin/security -g`
 * prints (`password: 0x<hex>` and `password: "<text>"`), and they drive the
 * keychain through an injected fake `security` executable — the real item is
 * never read. The live RPC itself is covered by `smoke.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { authFileCandidates, authFilePath, readAccessToken } from '../lib/usage.js';

/** Whether a test needs a POSIX shell to stand in for `/usr/bin/security`. */
const notWindows = { skip: process.platform === 'win32' };

/** A throw-away directory removed when the test finishes. */
function tempDir(t) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cursor-auth-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/**
 * Write a stand-in for `/usr/bin/security`.
 *
 * The real command answers `-g` by printing the secret on stderr, so the fake
 * prints `stderr` unchanged and exits with `code`; the reader must not care
 * where the text came from.
 */
function fakeSecurity(dir, { stderr = '', code = 0 } = {}) {
    const path = join(dir, 'security');
    writeFileSync(
        path,
        `#!/bin/sh\ncat >&2 <<'DSH_CURSOR_AUTH_EOF'\n${stderr}\nDSH_CURSOR_AUTH_EOF\nexit ${code}\n`,
    );
    chmodSync(path, 0o755);
    return path;
}

/** Write one `auth.json` and return the directory it lives in. */
function writeAuthFile(dir, body) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), body);
    return dir;
}

test('authFilePath keeps the historical single answer', () => {
    // The exported helper is a documented fact ("where is the token"), so its
    // spelling survives even though the reader now walks several stores.
    assert.equal(
        authFilePath({ APPDATA: join('/x', 'AppData', 'Roaming') }),
        join('/x', 'AppData', 'Roaming', 'Cursor', 'auth.json'),
    );
    assert.equal(authFilePath({}), join(homedir(), '.config', 'Cursor', 'auth.json'));
});

test('authFileCandidates orders the stores the CLI can actually use', () => {
    const home = join('/home', 'someone');
    const appData = join('/AppData', 'Roaming');
    const xdg = join('/xdg', 'config');
    const candidates = authFileCandidates({ HOME: home, APPDATA: appData, XDG_CONFIG_HOME: xdg });
    assert.deepEqual(candidates, [
        join(appData, 'Cursor', 'auth.json'),
        join(xdg, 'cursor', 'auth.json'),
        join(home, '.cursor', 'auth.json'),
        join(home, '.config', 'cursor', 'auth.json'),
        join(home, '.config', 'Cursor', 'auth.json'),
    ]);
});

test('Windows usage reads the current-user DPAPI store instead of the auth.json migration marker', async t => {
    const root = tempDir(t);
    const env = { APPDATA: join(root, 'Roaming'), HOME: root };
    const dir = writeAuthFile(join(env.APPDATA, 'Cursor'), JSON.stringify({ storedIn: 'dpapi' }));
    const path = join(dir, 'auth.dpapi');
    writeFileSync(path, JSON.stringify({ version: 1, dpapi: 'Y2lwaGVy' }));
    const auth = await readAccessToken(env, { platform: 'win32', unprotectDpapi: async blob => {
        assert.equal(blob, 'Y2lwaGVy');
        return { token: 'dpapi-fixture-token' };
    } });
    assert.deepEqual(auth, { ok: true, path, token: 'dpapi-fixture-token' });
});

test('Windows usage honours explicit token, file and memory choices before DPAPI', async t => {
    const root = tempDir(t);
    const env = { APPDATA: join(root, 'Roaming'), HOME: root };
    const dir = writeAuthFile(join(env.APPDATA, 'Cursor'), JSON.stringify({ accessToken: 'legacy-fixture-token' }));
    writeFileSync(join(dir, 'auth.dpapi'), JSON.stringify({ dpapi: 'Y2lwaGVy' }));
    const opts = { platform: 'win32', unprotectDpapi: async () => assert.fail('DPAPI must not be tried') };
    assert.equal((await readAccessToken({ ...env, CURSOR_AUTH_TOKEN: 'override-token' }, opts)).token, 'override-token');
    assert.equal((await readAccessToken({ ...env, AGENT_CLI_CREDENTIAL_STORE: 'file' }, opts)).token, 'legacy-fixture-token');
    const memory = await readAccessToken({ ...env, AGENT_CLI_CREDENTIAL_STORE: 'memory' }, opts);
    assert.equal(memory.ok, false);
    assert.match(memory.error, /AGENT_CLI_CREDENTIAL_STORE=memory/);
});

test('an unreadable DPAPI store falls back to legacy JSON without leaking file contents', async t => {
    const root = tempDir(t);
    const env = { APPDATA: join(root, 'Roaming'), HOME: root };
    const dir = writeAuthFile(join(env.APPDATA, 'Cursor'), JSON.stringify({ accessToken: 'legacy-fixture-token' }));
    const path = join(dir, 'auth.dpapi');
    writeFileSync(path, '{ secret-dpapi-text');
    const opts = { platform: 'win32', unprotectDpapi: async () => assert.fail('invalid input must not reach DPAPI') };
    assert.equal((await readAccessToken(env, opts)).token, 'legacy-fixture-token');
    writeAuthFile(dir, '{ secret-legacy-text');
    const failed = await readAccessToken(env, opts);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /auth\.dpapi.+cannot parse the DPAPI credential file/);
    assert.doesNotMatch(failed.error, /secret-dpapi-text|secret-legacy-text/);
});

test('the macOS keychain item is decoded from the hex form of security -g', notWindows, async t => {
    const dir = tempDir(t);
    const token = 'hex-token';
    const security = fakeSecurity(dir, { stderr: `password: 0x${Buffer.from(token).toString('hex')}` });
    const auth = await readAccessToken({ HOME: join(dir, 'home') }, { platform: 'darwin', securityPath: security });
    assert.equal(auth.ok, true, auth.error);
    assert.equal(auth.token, token);
    assert.match(auth.path, /cursor-access-token/);
});

test('the quoted keychain answer is decoded too, including escaped quotes', notWindows, async t => {
    const dir = tempDir(t);
    const security = fakeSecurity(dir, { stderr: 'password: "quoted \\"token\\""' });
    const auth = await readAccessToken({ HOME: join(dir, 'home') }, { platform: 'darwin', securityPath: security });
    assert.equal(auth.ok, true, auth.error);
    assert.equal(auth.token, 'quoted "token"');
});

test('an explicit CURSOR_AUTH_TOKEN wins over every store', notWindows, async t => {
    const dir = tempDir(t);
    // A security that would fail is not even reached: the variable answers first.
    const security = fakeSecurity(dir, { stderr: 'security: no such item', code: 44 });
    const auth = await readAccessToken({ CURSOR_AUTH_TOKEN: '  explicit-token  ' }, { platform: 'darwin', securityPath: security });
    assert.equal(auth.ok, true, auth.error);
    assert.equal(auth.token, 'explicit-token');
    assert.equal(auth.path, 'CURSOR_AUTH_TOKEN');
});

test('AGENT_CLI_CREDENTIAL_STORE=file reads the macOS file store instead of the keychain', notWindows, async t => {
    const dir = tempDir(t);
    writeAuthFile(join(dir, 'home', '.cursor'), '{"accessToken":"file-store-token"}');
    // There is no security here at all, which is what "the CLI is on the file
    // store" means: the keychain must be skipped, not probed and failed.
    const auth = await readAccessToken({ HOME: join(dir, 'home'), AGENT_CLI_CREDENTIAL_STORE: 'file' }, {
        platform: 'darwin',
        securityPath: join(dir, 'missing-security'),
    });
    assert.equal(auth.ok, true, auth.error);
    assert.equal(auth.token, 'file-store-token');
    assert.equal(auth.path, join(dir, 'home', '.cursor', 'auth.json'));
});

test('Windows reads %APPDATA%\\Cursor\\auth.json', async t => {
    const dir = tempDir(t);
    writeAuthFile(join(dir, 'home', '.cursor'), '{"accessToken":"home-token"}');
    writeAuthFile(join(dir, 'appdata', 'Cursor'), '{"accessToken":"windows-token"}');
    const auth = await readAccessToken({ APPDATA: join(dir, 'appdata'), HOME: join(dir, 'home') }, { platform: 'win32' });
    assert.equal(auth.ok, true, auth.error);
    assert.equal(auth.token, 'windows-token');
});

test('the memory-only store is reported, never answered from a stale keychain item', notWindows, async t => {
    const dir = tempDir(t);
    const security = fakeSecurity(dir, { stderr: 'password: "stale"' });
    const auth = await readAccessToken({ AGENT_CLI_CREDENTIAL_STORE: 'memory', HOME: join(dir, 'home') }, {
        platform: 'darwin',
        securityPath: security,
    });
    assert.equal(auth.ok, false);
    assert.match(auth.error, /AGENT_CLI_CREDENTIAL_STORE=memory/);
});

test('a signed-out machine gets one actionable sentence, not an ENOENT dump', notWindows, async t => {
    const dir = tempDir(t);
    const security = fakeSecurity(dir, {
        stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
        code: 44,
    });
    const auth = await readAccessToken({ HOME: join(dir, 'home') }, { platform: 'darwin', securityPath: security });
    assert.equal(auth.ok, false);
    assert.match(auth.error, /agent login/);
    assert.match(auth.error, /CURSOR_AUTH_TOKEN/);
    assert.doesNotMatch(auth.error, /ENOENT/, 'missing files are expected; they must not bury the fix');
});

test('a corrupt auth.json is quoted instead of looking like a signed-out machine', async t => {
    const dir = tempDir(t);
    writeAuthFile(join(dir, 'home', '.cursor'), '{not json');
    const auth = await readAccessToken({ HOME: join(dir, 'home') }, { platform: 'linux' });
    assert.equal(auth.ok, false);
    assert.match(auth.error, /cannot parse/);
});

test('a keychain read that hangs is cut off instead of stalling the panel', notWindows, async t => {
    const dir = tempDir(t);
    const security = join(dir, 'security');
    writeFileSync(security, '#!/bin/sh\nsleep 5\n');
    chmodSync(security, 0o755);
    const auth = await readAccessToken({ HOME: join(dir, 'home') }, {
        platform: 'darwin',
        securityPath: security,
        timeoutMs: 150,
    });
    assert.equal(auth.ok, false);
    assert.match(auth.error, /timed out/);
});
