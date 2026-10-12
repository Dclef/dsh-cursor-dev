/**
 * The Host/Origin fence every plugin route runs behind.
 *
 * A `webServer` route is served **outside** the host's own `/api` carrier, so
 * the host's browser-authentication middleware never sees it. Without a fence
 * of its own, a page on any other origin could POST to
 * `http://127.0.0.1:<port>/plugins/dsh-cursor-dev/api/settings` and rewrite the
 * operator's plugin settings — a request the browser sends happily because the
 * listener is loopback and the response is not read (a CSRF write). The same
 * hole would let a foreign page read `/status` and `/api/usage`.
 *
 * Two layers, in order:
 *
 * 1. `ctx.connection.requestRejection(req)` — the host's own check, the exact
 *    function its `/api` carrier uses: the `Host` must be loopback (or a
 *    configured trusted authority), `Sec-Fetch-Site: cross-site` is refused, and
 *    a present `Origin` must match the request's `Host`.
 * 2. A local fallback with the same rules, used when the `connection` service is
 *    absent (a headless host that mounted a webServer without a browser
 *    carrier). Refusing a browser-shaped cross-site request costs a local curl
 *    nothing, so this degrades safely.
 *
 * Only the host's **403** verdict is adopted, never its **401**: these routes
 * are deliberately readable without a browser session (that is how the panel is
 * screenshotted and how the standalone dashboard URL works), so this fence adds
 * a cross-site refusal without ever adding an authentication requirement. The
 * host's 403 also carries its trusted-authority list, which a hand-rolled check
 * would have to duplicate.
 *
 * @param ctx - Cordis context (the same one the routes are mounted on).
 * @returns a `(req, res) => boolean` gate: false means the response is already
 *          written and the handler must not run.
 */
export function createRouteFence(ctx) {
    return (req, res) => {
        const rejection = rejectViaConnection(ctx, req) ?? rejectLocally(req);
        if (rejection === undefined)
            return true;
        sendRejection(res, rejection);
        return false;
    };
}

/**
 * Ask the host's connection service, when this host has one.
 *
 * @returns 403 when the host itself refuses the request as cross-site, or
 *          undefined for anything else — including a 401, which says the host
 *          wants a browser session this plugin deliberately does not require.
 */
function rejectViaConnection(ctx, req) {
    let connection;
    try {
        connection = ctx?.get?.('connection');
    }
    catch {
        // A service lookup that throws is the same as one that is absent.
        return undefined;
    }
    if (typeof connection?.requestRejection !== 'function')
        return undefined;
    try {
        return connection.requestRejection({ headers: req?.headers ?? {} }) === 403 ? 403 : undefined;
    }
    catch {
        // A broken host check must fail CLOSED for a browser request: fall back
        // to the local rules rather than waving everything through.
        return rejectLocally(req);
    }
}

/**
 * The fence used when the host exposes no connection service.
 *
 * This is deliberately the browser-shaped half of the host's own rule: a
 * request that a cross-origin page could have produced is refused, and a
 * request from a tool (no `Origin`, no `Sec-Fetch-Site`) is allowed. It cannot
 * check the session cookie, so it is a fallback, not a replacement.
 */
function rejectLocally(req) {
    const headers = req?.headers ?? {};
    const fetchSite = header(headers, 'sec-fetch-site');
    if (fetchSite === 'cross-site')
        return 403;
    const origin = header(headers, 'origin');
    if (origin === undefined)
        return undefined;
    const host = header(headers, 'host');
    if (host === undefined)
        return 403;
    try {
        return new URL(origin).host === new URL(`http://${host}`).host ? undefined : 403;
    }
    catch {
        return 403;
    }
}

/** Read one header as a plain string, tolerating the Fetch `Headers` shape. */
function header(headers, name) {
    if (typeof headers?.get === 'function')
        return headers.get(name) ?? undefined;
    const value = headers[name];
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value) && typeof value[0] === 'string')
        return value[0];
    return undefined;
}

/** Answer a refused request the way the host's own carrier does. */
function sendRejection(res, status) {
    try {
        res.writeHead(status, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(status === 401
            ? 'dsh web authentication required; open this page from inside DSH.\n'
            : 'this request did not come from the DSH page.\n');
    }
    catch {
        // The socket is already gone; nothing left to answer.
    }
}
