/**
 * Guards for the outbound transport (`lib/proxy.js`).
 *
 * The usage RPC is the only outbound call in the plugin, and on a machine whose
 * only route to Cursor is the operating system's proxy it is also the call that
 * silently reports "unreachable". These tests pin the discovery rules and the
 * way the usage client hands the proxy to its transport; the tunnel itself is
 * covered by the live quota test in `smoke.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProxy, hostBypassed, readSystemProxy, describeProxy, proxyAwareFetch, proxySettingIsDirect, withProxyEnvironment, resolveChildProxy } from '../lib/proxy.js';
import { UsageClient } from '../lib/usage.js';

test('a proxy becomes the variables the child CLI actually reads', () => {
    // The Cursor CLI honours HTTPS_PROXY/HTTP_PROXY and ignores ALL_PROXY, so
    // ALL_PROXY must never be the only thing a child is handed.
    const env = withProxyEnvironment({ PATH: 'C:\\bin', ALL_PROXY: 'http://ignored:1' }, { host: '127.0.0.1', port: 7890, scheme: 'http' });
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.ALL_PROXY, 'http://ignored:1', 'an unrelated variable is left alone');
    assert.equal(env.PATH, 'C:\\bin', 'the rest of the environment survives');
    assert.deepEqual(withProxyEnvironment({ PATH: 'C:\\bin' }, undefined), { PATH: 'C:\\bin' });
    const inherited = {
        PATH: 'C:\\bin',
        HTTPS_PROXY: 'http://env:1',
        https_proxy: 'http://env:1',
        HTTP_PROXY: 'http://env:1',
        http_proxy: 'http://env:1',
        ALL_PROXY: 'http://env:1',
        all_proxy: 'http://env:1',
    };
    assert.deepEqual(withProxyEnvironment(inherited, undefined), { PATH: 'C:\\bin' });
    assert.deepEqual(withProxyEnvironment(inherited, null), { PATH: 'C:\\bin' });
    assert.equal(inherited.HTTPS_PROXY, 'http://env:1', 'the parent environment is unchanged');
});

test('the proxy setting says what it means, including "none"', async () => {
    assert.equal(proxySettingIsDirect('none'), true);
    assert.equal(proxySettingIsDirect(' DIRECT '), true);
    assert.equal(proxySettingIsDirect('off'), true);
    assert.equal(proxySettingIsDirect('http://127.0.0.1:7890'), false);
    assert.equal(proxySettingIsDirect(''), false);

    // An explicit value wins over the environment and the registry…
    const explicit = await resolveChildProxy('http://explicit:8080', { env: { HTTPS_PROXY: 'http://env:1' } });
    assert.equal(explicit.host, 'explicit');
    assert.equal(explicit.port, 8080);
    assert.equal(explicit.source, 'setting');
    // …and "none" means direct even when the machine has a proxy configured.
    assert.equal(await resolveChildProxy('none', { env: { HTTPS_PROXY: 'http://env:1' } }), undefined);
    assert.equal(await resolveChildProxy(undefined, { env: { HTTPS_PROXY: 'http://env:1' } }), undefined);
    const inherited = await resolveChildProxy('', { env: { HTTPS_PROXY: 'http://env:1' } });
    assert.equal(inherited.host, 'env');
    assert.equal(inherited.port, 1);
    assert.notEqual(inherited.source, 'setting');
    // A value that is neither blank nor usable is not silently reinterpreted.
    assert.equal(await resolveChildProxy('not a proxy', { env: {}, platform: 'linux' }), undefined);
    assert.equal(await resolveChildProxy('not a proxy', { env: {} }), undefined);
});

test('parseProxy accepts every shape the environment and the registry use', () => {
    assert.deepEqual(parseProxy('127.0.0.1:7890'), { host: '127.0.0.1', port: 7890, scheme: 'http' });
    assert.deepEqual(parseProxy('http://proxy.local:3128'), { host: 'proxy.local', port: 3128, scheme: 'http' });
    assert.deepEqual(parseProxy('https://proxy.local'), { host: 'proxy.local', port: 443, scheme: 'https' });
    // WinINET's protocol-keyed form.
    assert.deepEqual(
        parseProxy('http=127.0.0.1:8080;https=127.0.0.1:7890'),
        { host: '127.0.0.1', port: 7890, scheme: 'http' },
    );
    assert.deepEqual(parseProxy('ftp=1.2.3.4:21'), { host: '1.2.3.4', port: 21, scheme: 'http' });
    for (const value of [undefined, '', '   ', 'not a proxy', 'http://']) {
        assert.equal(parseProxy(value), undefined, `expected ${JSON.stringify(value)} to be rejected`);
    }
});

test('hostBypassed mirrors NO_PROXY and ProxyOverride syntax', () => {
    assert.equal(hostBypassed('api2.cursor.sh', 'localhost;127.*;<local>'), false);
    assert.equal(hostBypassed('localhost', undefined), true, 'loopback is never worth a proxy hop');
    assert.equal(hostBypassed('127.0.0.1', ''), true);
    assert.equal(hostBypassed('anything.example.com', '*'), true);
    assert.equal(hostBypassed('build', '<local>'), true);
    assert.equal(hostBypassed('build.corp.local', '<local>'), false);
    assert.equal(hostBypassed('api.corp.example.com', '.corp.example.com'), true);
    assert.equal(hostBypassed('api.corp.example.com', 'corp.example.com'), true);
    assert.equal(hostBypassed('api.corp.example.com', 'other.example.com'), false);
    assert.equal(hostBypassed('api.corp.example.com', 'api.corp.example.com:8443'), true);
});

test('readSystemProxy prefers the environment and never reads the registry off Windows', async () => {
    const fromEnv = await readSystemProxy({
        env: { HTTPS_PROXY: 'http://env-proxy:8080', HTTP_PROXY: 'http://ignored:1', NO_PROXY: 'internal' },
        platform: 'linux',
    });
    assert.equal(fromEnv.host, 'env-proxy');
    assert.equal(fromEnv.port, 8080);
    assert.equal(fromEnv.source, 'HTTPS_PROXY');
    assert.equal(fromEnv.bypass, 'internal');

    const lowercase = await readSystemProxy({ env: { https_proxy: 'other:1' }, platform: 'linux' });
    assert.equal(lowercase.host, 'other');

    const none = await readSystemProxy({ env: {}, platform: 'linux' });
    assert.equal(none, undefined);
});

test('describeProxy always says which route a request takes', () => {
    assert.match(describeProxy(undefined), /direct/);
    assert.match(describeProxy({ host: '127.0.0.1', port: 7890, source: 'registry:X' }), /127\.0\.0\.1:7890 \(registry:X\)/);
});

test('proxyAwareFetch without a proxy still reports a fetch-shaped result', async () => {
    const failing = proxyAwareFetch({ proxy: null, timeoutMs: 250 });
    await assert.rejects(
        () => failing('https://127.0.0.1:9/never', { method: 'POST', body: '{}' }),
        error => typeof error.message === 'string' && error.message.length > 0,
    );
});

test('the usage client resolves the proxy once and reports it', async () => {
    let reads = 0;
    const calls = [];
    const client = new UsageClient({
        readProxy: async () => {
            reads += 1;
            return { host: '127.0.0.1', port: 7890, source: 'test' };
        },
        fetch: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, status: 200, text: async () => JSON.stringify({ planUsage: { totalSpend: 100 } }) };
        },
    });

    const snapshot = await client.get({ force: true });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.transport, 'http://127.0.0.1:7890 (test)');
    assert.match(calls[0].url, /DashboardService\/GetCurrentPeriodUsage$/);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['connect-protocol-version'], '1');

    await client.get({ force: true });
    assert.equal(reads, 1, 'discovery runs once per client, not once per request');
});
