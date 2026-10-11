/**
 * Outbound HTTPS with the machine's proxy configuration honoured.
 *
 * The usage RPC talks to `api2.cursor.sh`, which is unreachable from some
 * networks unless the request goes through the same proxy the operating system
 * and the browser use. Node's `fetch` ignores the Windows Internet Settings
 * entirely, so a plugin that calls `fetch` directly reports "unreachable" on a
 * machine where the same URL works fine in a browser.
 *
 * The proxy is discovered in the usual order - `HTTPS_PROXY`, `HTTP_PROXY`,
 * `ALL_PROXY`, then the Windows registry (`Internet Settings`) - and applied
 * with the standard `CONNECT` tunnel, so no dependency is involved.
 */

import { execFile } from 'node:child_process';
import http from 'node:http';
import tls from 'node:tls';

const REGISTRY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Environment variables consulted for a proxy, most specific first. */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
/** Environment variables holding the bypass list. */
const BYPASS_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

/**
 * Read one value out of a `reg query` response.
 *
 * @param text - stdout of `reg query <path>`.
 * @param name - value name to find.
 * @returns the raw value text, or undefined.
 */
function registryValue(text, name) {
    const pattern = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'im');
    const match = pattern.exec(text);
    return match === null ? undefined : match[1].trim();
}

/** Run `reg query` and resolve its stdout, or undefined when it cannot run. */
function queryRegistry(timeoutMs) {
    return new Promise(resolve => {
        try {
            execFile(
                'reg.exe',
                ['query', REGISTRY_PATH],
                { timeout: timeoutMs, windowsHide: true },
                (error, stdout) => resolve(error === null ? String(stdout) : undefined),
            );
        }
        catch {
            resolve(undefined);
        }
    });
}

/**
 * Parse a proxy setting into `{ host, port }`.
 *
 * Accepts the plain `host:port` form, a `scheme=host:port` list (WinINET uses
 * that shape when the protocols differ), and a full URL. A value without a port
 * gets the scheme's default.
 *
 * @param raw - proxy text from the environment or the registry.
 * @returns the proxy endpoint, or undefined when nothing usable is in there.
 */
export function parseProxy(raw) {
    if (typeof raw !== 'string') return undefined;
    let text = raw.trim();
    if (text.length === 0) return undefined;

    // `http=127.0.0.1:7890;https=127.0.0.1:7890` — prefer the HTTPS entry.
    if (text.includes('=') && !text.includes('://')) {
        const entries = new Map();
        for (const part of text.split(';')) {
            const at = part.indexOf('=');
            if (at === -1) continue;
            entries.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
        }
        text = entries.get('https') ?? entries.get('http') ?? entries.get('socks') ?? [...entries.values()][0] ?? '';
        if (text.length === 0) return undefined;
    }

    if (!text.includes('://')) text = `http://${text}`;
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return undefined;
    }
    if (url.hostname.length === 0) return undefined;
    const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0) return undefined;
    return { host: url.hostname, port, scheme: url.protocol.replace(':', '') };
}

/**
 * Decide whether a host must skip the proxy.
 *
 * `NO_PROXY` and WinINET's `ProxyOverride` share a syntax: `*` for everything,
 * a leading dot or bare domain for a suffix, `<local>` for plain host names,
 * and `host:port` entries whose port part is ignored here.
 *
 * @param hostname - target host.
 * @param patterns - comma/semicolon-separated bypass list.
 * @returns whether the host is exempt.
 */
export function hostBypassed(hostname, patterns) {
    const host = String(hostname ?? '').toLowerCase();
    if (host.length === 0) return false;
    // The proxy on this machine listens on loopback, so proxying loopback would
    // only add a hop through itself.
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    if (patterns === undefined || patterns === null) return false;

    for (const raw of String(patterns).split(/[,;]/)) {
        const entry = raw.trim().toLowerCase();
        if (entry.length === 0) continue;
        if (entry === '*') return true;
        if (entry === '<local>' && !host.includes('.')) return true;
        const withoutPort = entry.includes(':') && entry.split(':').length === 2 && /^\d+$/.test(entry.split(':')[1])
            ? entry.split(':')[0]
            : entry;
        const bare = withoutPort.startsWith('.') ? withoutPort.slice(1) : withoutPort;
        if (host === bare || host.endsWith(`.${bare}`)) return true;
    }
    return false;
}

/**
 * Resolve the proxy this machine uses for outbound HTTPS.
 *
 * @param options - `env` overrides the process environment; `platform` and
 *                  `timeoutMs` exist for tests.
 * @returns `{ host, port, source, bypass }` or undefined when the connection is
 *          direct.
 */
export async function readSystemProxy(options = {}) {
    const env = options.env ?? process.env;
    const bypass = BYPASS_ENV_KEYS.map(key => env[key]).find(value => typeof value === 'string' && value.length > 0);

    for (const key of PROXY_ENV_KEYS) {
        const parsed = parseProxy(env[key]);
        if (parsed !== undefined) return { ...parsed, source: key, bypass };
    }

    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') return undefined;

    const text = await queryRegistry(options.timeoutMs ?? 4000);
    if (text === undefined) return undefined;
    if (registryValue(text, 'ProxyEnable') !== '0x1') return undefined;
    const parsed = parseProxy(registryValue(text, 'ProxyServer'));
    if (parsed === undefined) return undefined;
    return {
        ...parsed,
        source: 'registry:Internet Settings',
        bypass: bypass ?? registryValue(text, 'ProxyOverride'),
    };
}

/** Establish the TCP tunnel a proxied HTTPS request runs through. */
function openTunnel(proxy, target, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${target.hostname}:${target.port.length > 0 ? target.port : '443'}`,
            headers: { host: `${target.hostname}:${target.port.length > 0 ? target.port : '443'}` },
            agent: false,
            timeout: timeoutMs,
        });
        const fail = error => {
            request.destroy();
            reject(error);
        };
        request.on('connect', (response, socket) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`proxy CONNECT ${proxy.host}:${proxy.port} answered HTTP ${response.statusCode}`));
                return;
            }
            resolve(socket);
        });
        request.on('timeout', () => fail(new Error(`proxy CONNECT ${proxy.host}:${proxy.port} timed out`)));
        request.on('error', error => fail(new Error(`proxy CONNECT ${proxy.host}:${proxy.port} failed: ${error.message}`)));
        if (signal !== undefined) {
            if (signal.aborted) fail(new Error('request aborted'));
            else signal.addEventListener('abort', () => fail(new Error('request aborted')), { once: true });
        }
        request.end();
    });
}

/** Open a TLS socket, directly or through a proxy tunnel. */
async function openSocket(target, proxy, timeoutMs, signal) {
    if (proxy === undefined) {
        return tls.connect({
            host: target.hostname,
            port: Number(target.port.length > 0 ? target.port : '443'),
            servername: target.hostname,
            signal,
        });
    }
    const tunnel = await openTunnel(proxy, target, timeoutMs, signal);
    return tls.connect({ socket: tunnel, servername: target.hostname, signal });
}

/**
 * One HTTPS request that works behind a mandatory proxy.
 *
 * @param options - `url`, `method`, `headers`, `body`, `timeoutMs`, `signal`,
 *                  and the `proxy` returned by `readSystemProxy`.
 * @returns `{ status, headers, text }`.
 */
export async function httpsRequest(options) {
    const target = new URL(options.url);
    const timeoutMs = options.timeoutMs ?? 15000;
    const proxy = options.proxy !== undefined && !hostBypassed(target.hostname, options.proxy.bypass)
        ? options.proxy
        : undefined;
    const port = Number(target.port.length > 0 ? target.port : '443');

    const socket = await openSocket(target, proxy, timeoutMs, options.signal);
    try {
        return await new Promise((resolve, reject) => {
            // The socket is already the right connection (direct TLS, or TLS
            // inside a proxy tunnel), so the agent hands it straight back
            // instead of dialling `target` itself.
            const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
            agent.createConnection = () => socket;
            const headers = { connection: 'close', ...options.headers };
            if (options.body !== undefined) headers['content-length'] = Buffer.byteLength(options.body);
            const request = http.request({
                host: target.hostname,
                port,
                path: `${target.pathname}${target.search}`,
                method: options.method ?? 'GET',
                agent,
                headers,
                timeout: timeoutMs,
            });
            const fail = error => {
                request.destroy();
                reject(error);
            };
            request.on('response', response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => resolve({
                    status: response.statusCode ?? 0,
                    headers: response.headers,
                    text: Buffer.concat(chunks).toString('utf8'),
                }));
                response.on('error', fail);
            });
            request.on('timeout', () => fail(new Error(`request to ${target.hostname} timed out after ${timeoutMs}ms`)));
            request.on('error', error => fail(new Error(`request to ${target.hostname} failed: ${error.code ?? ''} ${error.message}`)));
            if (options.signal !== undefined) {
                if (options.signal.aborted) fail(new Error('request aborted'));
                else options.signal.addEventListener('abort', () => fail(new Error('request aborted')), { once: true });
            }
            if (options.body !== undefined) request.write(options.body);
            request.end();
        });
    }
    finally {
        socket.destroy();
    }
}

/**
 * A `fetch`-shaped function the usage client can be constructed with.
 *
 * It keeps the callers in `usage.js` unchanged: same arguments, same
 * `Response`-like surface, with the proxy resolved once per process.
 *
 * @param options - `env`, `platform` and `timeoutMs` are forwarded to
 *                  `readSystemProxy`; `proxy` skips discovery entirely.
 * @returns an async function returning `{ ok, status, text() }`.
 */
export function proxyAwareFetch(options = {}) {
    // An explicitly supplied `proxy` (including `null` for "direct") replaces
    // discovery; omitting the key asks for it.
    const explicit = Object.hasOwn(options, 'proxy');
    let resolved;
    let ready = false;
    return async (url, init = {}) => {
        if (!ready) {
            ready = true;
            try {
                resolved = explicit ? options.proxy ?? null : (await readSystemProxy(options)) ?? null;
            }
            catch {
                resolved = null;
            }
        }
        const result = await httpsRequest({
            url,
            method: init.method,
            headers: init.headers,
            body: init.body,
            signal: init.signal,
            timeoutMs: options.timeoutMs ?? 15000,
            proxy: resolved ?? undefined,
        });
        return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            text: async () => result.text,
        };
    };
}

/** Human-readable proxy description for a status surface. */
export function describeProxy(proxy) {
    if (proxy === undefined || proxy === null) return 'direct (no proxy configured)';
    return `${proxy.scheme ?? 'http'}://${proxy.host}:${proxy.port} (${proxy.source})`;
}
