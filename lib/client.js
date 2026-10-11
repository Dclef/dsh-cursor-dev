/**
 * Cursor panel for the right Sidebar.
 *
 * This is the plugin's CLIENT half. The host half (`lib/index.js`) serves the
 * dashboard at `/plugins/dsh-cursor-dev/`; this half puts that same page in a
 * Sidebar tab so it does not have to be opened as a separate web page.
 *
 * It is written by hand rather than built: a DSH client plugin is loaded
 * through `window.__ModuleLoader__.load({ id, factory })`, whose `factory`
 * receives a CommonJS `require` for the shared runtime modules. There is no
 * JSX and no bundler step, which keeps the plugin installable straight from
 * this repository.
 *
 * Registration goes through `dsh-better-sidebar` (the installed sidebar host)
 * rather than the native `sidebarRightTabs` service: its `registerTab` accepts
 * a plain descriptor and it handles the native surface, settings and the
 * per-session tab records itself. `ctx.inject` waits for the service, so load
 * order between the two plugins does not matter.
 *
 * The panel probes the host route before mounting the frame. A frame that
 * cannot load shows nothing useful, so the probe's own answer - reachable, or
 * which HTTP status came back - is rendered instead of an empty pane.
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
        const TAB_TYPE = 'cursor-dev';
        const AUTO_OPEN_KEY = 'dsh-cursor-dev:opened-once';

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

        /** The host route is unreachable: say which answer came back instead of a blank pane. */
        function PanelOffline(props) {
            const { status, text, onRetry } = props;
            const headline = status === 0
                ? '连不上宿主路由 / the host route could not be reached'
                : `宿主路由返回 HTTP ${status} / the host route answered HTTP ${status}`;
            return h(
                'div',
                { style: CARD },
                h('div', { style: { fontWeight: 600 } }, 'Cursor 面板暂时不可用'),
                h('div', { style: { marginTop: 6, opacity: 0.75 } }, headline),
                h(
                    'div',
                    { style: { marginTop: 10, opacity: 0.75 } },
                    '宿主插件 dsh-cursor-dev 已启用，但它没有应答 ' + STATUS_URL + '。',
                ),
                h('code', { style: CODE }, text || '(empty response body)'),
                h('button', { type: 'button', style: BUTTON, onClick: onRetry }, '重试 / Retry'),
            );
        }

        /**
         * The tab body: the host's dashboard, same-origin, filling the pane.
         *
         * The page is a plain server-rendered document with its own styling and
         * its own polling, so the component stays this small and the panel keeps
         * working while the conversation agent is busy.
         */
        function CursorPanel() {
            const [probe, setProbe] = react.useState(null);
            const [attempt, setAttempt] = react.useState(0);

            react.useEffect(() => {
                let alive = true;
                const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
                fetch(STATUS_URL, {
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

            if (probe === null) {
                return h('div', { style: CARD }, '正在连接 Cursor 面板… / connecting…');
            }
            if (!probe.ok) {
                return h(PanelOffline, {
                    status: probe.status,
                    text: probe.text,
                    onRetry: () => {
                        setProbe(null);
                        setAttempt((n) => n + 1);
                    },
                });
            }
            return h('iframe', {
                src: DASHBOARD_URL,
                title: 'Cursor',
                style: {
                    width: '100%',
                    height: '100%',
                    border: '0',
                    display: 'block',
                    background: 'transparent',
                },
            });
        }

        const descriptor = {
            id: TAB_TYPE,
            title: () => 'Cursor',
            description: () => 'Cursor CLI 子智能体的实时进度与用量额度',
            order: 45,
            hidden: false,
            component: CursorPanel,
        };

        /** Open the panel once on a fresh install so the tab is discoverable. */
        function openOnce(sidebar) {
            try {
                if (typeof sidebar?.openTab !== 'function') return;
                if (window.localStorage?.getItem(AUTO_OPEN_KEY) === '1') return;
                sidebar.openTab({ type: TAB_TYPE, title: 'Cursor' });
                window.localStorage?.setItem(AUTO_OPEN_KEY, '1');
            } catch {
                // A failed courtesy open must never take the plugin down.
            }
        }

        function apply(ctx) {
            const seat = ctx.inject(['betterSidebar'], (injected) => {
                const sidebar = injected.get('betterSidebar');
                if (sidebar === undefined || typeof sidebar.registerTab !== 'function') {
                    console.warn('[dsh-cursor-dev] betterSidebar is unavailable; the Cursor panel is not registered.');
                    return;
                }
                const dispose = sidebar.registerTab(descriptor);
                openOnce(sidebar);
                return dispose;
            });
            ctx.effect(() => () => {
                try {
                    seat?.();
                } catch (error) {
                    console.warn('[dsh-cursor-dev] releasing the Cursor panel failed:', error);
                }
            });
        }

        exports.name = 'dsh-cursor-dev-client';
        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
