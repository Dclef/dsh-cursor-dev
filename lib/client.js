/**
 * The Cursor panel, in the seat a user actually looks in.
 *
 * This is the plugin's CLIENT half. The host half (`lib/index.js`) serves the
 * dashboard at `/plugins/dsh-cursor-dev/`; this half puts that same page in a
 * **Settings page**, registered in the native `settings.section` slot — the
 * place a user looks for "what is this thing doing and what is it set to".
 *
 * It is written by hand rather than built: a DSH client plugin is loaded through
 * `window.__ModuleLoader__.load({ id, factory })`, whose `factory` receives a
 * CommonJS `require` for the shared runtime modules. There is no JSX and no
 * bundler step, which keeps the plugin installable straight from this repository.
 *
 * `ctx.inject` waits for a service, so load order against the settings host does
 * not matter and neither service is a hard dependency: without them the plugin
 * still loads, it just has no page.
 *
 * The panel probes the host route before mounting the frame. A frame that cannot
 * load shows nothing useful, so the probe's own answer — reachable, or which HTTP
 * status came back — is rendered instead of an empty pane.
 *
 * The panel speaks Chinese by default and English on request, following the app
 * locale when it can read it: `ctx.locale.getLocale().active` is passed to the
 * dashboard as `?lang=`, and the dashboard keeps its own switch from then on.
 */

window.__ModuleLoader__.load({
    id: 'dsh-cursor-dev',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;

        const react = require('react');
        const h = react.createElement;

        const DASHBOARD_URL = '/plugins/dsh-cursor-dev/';
        const STATUS_URL = '/plugins/dsh-cursor-dev/status';
        const SETTINGS_ID = 'dsh-cursor-dev';

        const CARD = {
            padding: '16px 18px',
            font: '13px/1.6 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif',
            color: 'inherit',
        };
        const CODE = {
            display: 'block',
            marginTop: '10px',
            padding: '10px 12px',
            maxHeight: '220px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            font: '12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
            background: 'rgba(127,127,127,.12)',
            borderRadius: '8px',
        };
        const BUTTON = {
            marginTop: '12px',
            padding: '6px 14px',
            font: 'inherit',
            color: 'inherit',
            background: 'rgba(127,127,127,.16)',
            border: '1px solid rgba(127,127,127,.28)',
            borderRadius: '8px',
            cursor: 'pointer',
        };
        const TITLE = {
            font: '600 14px/1.4 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif',
            color: 'inherit',
        };
        const SUBTITLE = {
            font: '12px/1.6 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif',
            opacity: 0.75,
        };

        /** The locale service, once (and if) it is available. */
        let localeService;

        /** `zh` unless the app is running in English. */
        function langOf() {
            try {
                const active = localeService?.getLocale?.()?.active;
                if (active === 'en' || active === 'zh') return active;
            } catch {
                // An unavailable or throwing locale service must not break a render.
            }
            const tag = typeof document === 'undefined' ? '' : String(document.documentElement?.lang ?? '');
            return tag.toLowerCase().startsWith('en') ? 'en' : 'zh';
        }

        /** The host route is unreachable: say which answer came back instead of a blank pane. */
        function PanelOffline(props) {
            const { status, text, onRetry, lang } = props;
            const zh = lang !== 'en';
            const headline = status === 0
                ? (zh ? '连不上宿主路由' : 'the host route could not be reached')
                : (zh ? `宿主路由返回 HTTP ${status}` : `the host route answered HTTP ${status}`);
            return h(
                'div',
                { style: CARD },
                h('div', { style: { fontWeight: 600 } }, zh ? 'Cursor 面板暂时不可用' : 'The Cursor panel is unavailable'),
                h('div', { style: { marginTop: 6, opacity: 0.75 } }, headline),
                h(
                    'div',
                    { style: { marginTop: 10, opacity: 0.75 } },
                    zh
                        ? `宿主插件 dsh-cursor-dev 已启用，但它没有应答 ${STATUS_URL}。`
                        : `The host plugin dsh-cursor-dev is enabled but did not answer ${STATUS_URL}.`,
                ),
                h('code', { style: CODE }, text || '(empty response body)'),
                h('button', { type: 'button', style: BUTTON, onClick: onRetry }, zh ? '重试' : 'Retry'),
            );
        }

        /**
         * The CLI is missing or signed out, so the plugin cannot do anything yet.
         *
         * These are the two walls every new user hits, and from inside the panel
         * they look identical to a broken plugin. The card states which one it is
         * and prints the exact command that clears it, instead of leaving a pane
         * of dashes to interpret.
         */
        function SetupCard(props) {
            const { kind, setup, detail, lang, onRetry } = props;
            const zh = lang !== 'en';
            const missing = kind === 'missing';
            const windows = setup?.install?.win32 || "irm 'https://cursor.com/install?win32=true' | iex";
            const unix = setup?.install?.unix || 'curl https://cursor.com/install -fsS | bash';
            const login = setup?.login || 'agent login';
            const verify = setup?.verify || 'agent status --format json';
            const installArg = zh ? '安装命令（Windows PowerShell）：' : 'Install (Windows PowerShell):';
            const unixArg = zh ? 'macOS / Linux 用：' : 'macOS / Linux:';
            const loginArg = zh ? '然后在终端里登录（会打开浏览器授权）：' : 'Then sign in from a terminal (it opens the browser):';
            const verifyArg = zh ? `确认状态：${verify}` : `Confirm with ${verify}.`;
            return h(
                'div',
                { style: CARD },
                h(
                    'div',
                    { style: { fontWeight: 600 } },
                    missing
                        ? (zh ? '还没找到 Cursor CLI' : 'The Cursor CLI is not installed yet')
                        : (zh ? 'Cursor CLI 还没登录' : 'The Cursor CLI is not signed in yet'),
                ),
                h(
                    'div',
                    { style: { marginTop: 6, opacity: 0.75 } },
                    missing
                        ? (zh
                            ? '这个插件靠本机的 Cursor CLI 干活，所以先把 CLI 装上；装完回到这里点重试。'
                            : 'This plugin does its work through the local Cursor CLI, so install it first, then retry here.')
                        : (zh
                            ? '插件已经找到 CLI，但它还没登录 Cursor 账号，所以拿不到额度、也开不了会话。'
                            : 'The CLI was found but is not signed in, so there is no quota to report and no session to open.'),
                ),
                missing
                    ? h('code', { style: CODE }, `${installArg}\n${windows}\n\n${unixArg}\n${unix}\n\n${loginArg}\n${login}`)
                    : h('code', { style: CODE }, `${loginArg}\n${login}\n\n${verifyArg}`),
                detail
                    ? h('div', { style: { marginTop: 8, opacity: 0.6 } }, detail)
                    : null,
                h('button', { type: 'button', style: BUTTON, onClick: onRetry }, zh ? '装好 / 登录了，重试' : 'Retry now'),
            );
        }

        /**
         * The host's dashboard, same-origin, filling the pane.
         *
         * The page is a plain server-rendered document with its own styling and
         * its own polling, so the component stays this small and the panel keeps
         * working while the conversation agent is busy.
         */
        function HostFrame(props) {
            const { title, lang, style } = props;
            const [probe, setProbe] = react.useState(null);
            const [attempt, setAttempt] = react.useState(0);

            react.useEffect(() => {
                let alive = true;
                const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
                // Retrying means "I just installed it / logged in" — ask the host
                // for a fresh sign-in check instead of its one-minute cache.
                const url = attempt === 0 ? STATUS_URL : `${STATUS_URL}?auth=refresh`;
                fetch(url, {
                    headers: { accept: 'application/json' },
                    signal: controller?.signal,
                })
                    .then(async (response) => {
                        const text = await response.text();
                        if (alive) {
                            setProbe({ ok: response.ok, status: response.status, text: text.slice(0, 4000) });
                        }
                    })
                    .catch((error) => {
                        if (alive) {
                            setProbe({ ok: false, status: 0, text: String((error && error.message) || error) });
                        }
                    });
                return () => {
                    alive = false;
                    controller?.abort();
                };
            }, [attempt]);

            const retry = () => {
                setProbe(null);
                setAttempt((n) => n + 1);
            };

            if (probe === null) {
                return h('div', { style: CARD }, lang === 'en' ? 'Connecting to the Cursor panel…' : '正在连接 Cursor 面板…');
            }
            if (!probe.ok) {
                return h(PanelOffline, {
                    status: probe.status,
                    text: probe.text,
                    lang,
                    onRetry: retry,
                });
            }
            let status;
            try {
                status = JSON.parse(probe.text);
            }
            catch {
                status = undefined;
            }
            if (status !== undefined && status !== null && typeof status === 'object') {
                if (status.agent !== undefined && status.agent?.found !== true) {
                    return h(SetupCard, { kind: 'missing', setup: status.setup, detail: status.auth?.error, lang, onRetry: retry });
                }
                if (status.auth !== undefined && status.auth?.authenticated !== true) {
                    return h(SetupCard, { kind: 'signed-out', setup: status.setup, detail: status.auth?.error, lang, onRetry: retry });
                }
            }
            return h('iframe', {
                src: `${DASHBOARD_URL}?lang=${lang === 'en' ? 'en' : 'zh'}`,
                title,
                style: Object.assign({
                    width: '100%',
                    height: '100%',
                    border: '0',
                    display: 'block',
                    background: 'transparent',
                }, style),
            });
        }

        /**
         * The Settings page.
         *
         * Settings is the seat a user actually looks in: the dashboard opens
         * from 设置 → Cursor 子智能体 instead of from a Sidebar tab that has to
         * be discovered first.
         */
        function CursorSettings() {
            const lang = langOf();
            const zh = lang !== 'en';
            return h(
                'div',
                {
                    style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        height: '100%',
                        minHeight: '460px',
                        padding: '2px',
                    },
                },
                h('div', { style: TITLE }, zh ? 'Cursor 子智能体' : 'Cursor child agent'),
                h(
                    'div',
                    { style: SUBTITLE },
                    zh
                        ? '额度、cursor_code 使用的模型、以及子智能体跑过的每一次会话（步骤轨迹可展开）。'
                        : 'Quota, the model cursor_code uses, and every conversation the child ran (unfold a key for its step timeline).',
                ),
                h(
                    'div',
                    { style: { flex: '1 1 auto', minHeight: '400px' } },
                    h(HostFrame, { title: 'Cursor', lang }),
                ),
            );
        }

        function apply(ctx) {
            // Optional services: the page is registered only when its host
            // exists, and neither may fail the plugin load.
            ctx.inject(['locale'], (injected) => {
                localeService = injected.get('locale');
                return undefined;
            });

            const settingsSeat = ctx.inject(['slots'], (injected) => {
                const slots = injected.get('slots');
                if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
                    console.warn('[dsh-cursor-dev] the slots service is unavailable; the Cursor Settings page is not registered.');
                    return undefined;
                }
                return slots.inject('settings.section', () => slots.register({
                    name: 'settings.section',
                    id: SETTINGS_ID,
                    order: 62,
                    label: () => (langOf() === 'en' ? 'Cursor agent' : 'Cursor 子智能体'),
                }, CursorSettings));
            });

            ctx.effect(() => () => {
                try {
                    settingsSeat?.();
                } catch (error) {
                    console.warn('[dsh-cursor-dev] releasing the Cursor Settings page failed:', error);
                }
            });
        }

        exports.name = 'dsh-cursor-dev-client';
        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
