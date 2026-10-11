/**
 * The Cursor panel, in the two seats DSH offers.
 *
 * This is the plugin's CLIENT half. The host half (`lib/index.js`) serves the
 * dashboard at `/plugins/dsh-cursor-dev/`; this half puts that same page in
 *
 * - a **right Sidebar tab** (through `dsh-better-sidebar`, the installed sidebar
 *   host: its `registerTab` takes a plain descriptor and it handles the native
 *   `sidebarRightTabs` surface, the per-session tab records and its own settings
 *   itself), and
 * - a **Settings page** (through the native `settings.section` slot), which is
 *   where a user looks for "what is this thing doing and what is it set to".
 *
 * It is written by hand rather than built: a DSH client plugin is loaded through
 * `window.__ModuleLoader__.load({ id, factory })`, whose `factory` receives a
 * CommonJS `require` for the shared runtime modules. There is no JSX and no
 * bundler step, which keeps the plugin installable straight from this repository.
 *
 * `ctx.inject` waits for a service, so load order against the sidebar host does
 * not matter and neither service is a hard dependency: without them the plugin
 * still loads, it just has fewer seats.
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
        const TAB_TYPE = 'cursor-dev';
        const SETTINGS_ID = 'dsh-cursor-dev';
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
                return h('div', { style: CARD }, lang === 'en' ? 'Connecting to the Cursor panel…' : '正在连接 Cursor 面板…');
            }
            if (!probe.ok) {
                return h(PanelOffline, {
                    status: probe.status,
                    text: probe.text,
                    lang,
                    onRetry: () => {
                        setProbe(null);
                        setAttempt((n) => n + 1);
                    },
                });
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

        /** The Sidebar tab body. */
        function CursorPanel() {
            return h(HostFrame, { title: 'Cursor', lang: langOf() });
        }

        /**
         * The Settings page.
         *
         * Settings is the seat a user actually looks in, so the same dashboard is
         * reachable from there instead of only from a Sidebar tab that has to be
         * discovered first.
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
                        ? '额度、cursor_code 使用的模型、以及子智能体跑过的每一次会话（步骤轨迹可展开）。右侧边栏的 Cursor 标签页是同一个视图。'
                        : 'Quota, the model cursor_code uses, and every conversation the child ran (unfold a key for its step timeline). The Cursor tab in the right Sidebar shows the same view.',
                ),
                h(
                    'div',
                    { style: { flex: '1 1 auto', minHeight: '400px' } },
                    h(HostFrame, { title: 'Cursor', lang }),
                ),
            );
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
            // Optional services: each seat is registered only when its host exists,
            // and none of them may fail the plugin load.
            ctx.inject(['locale'], (injected) => {
                localeService = injected.get('locale');
                return undefined;
            });

            const tabSeat = ctx.inject(['betterSidebar'], (injected) => {
                const sidebar = injected.get('betterSidebar');
                if (sidebar === undefined || typeof sidebar.registerTab !== 'function') {
                    console.warn('[dsh-cursor-dev] betterSidebar is unavailable; the Cursor Sidebar tab is not registered.');
                    return undefined;
                }
                const dispose = sidebar.registerTab(descriptor);
                openOnce(sidebar);
                return dispose;
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
                for (const seat of [tabSeat, settingsSeat]) {
                    try {
                        seat?.();
                    } catch (error) {
                        console.warn('[dsh-cursor-dev] releasing a Cursor seat failed:', error);
                    }
                }
            });
        }

        exports.name = 'dsh-cursor-dev-client';
        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
