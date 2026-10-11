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
 */

window.__ModuleLoader__.load({
    id: 'dsh-cursor-dev',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;

        const react = require('react');
        const h = react.createElement;

        const DASHBOARD_URL = '/plugins/dsh-cursor-dev/';
        const TAB_TYPE = 'cursor-dev';
        const AUTO_OPEN_KEY = 'dsh-cursor-dev:opened-once';

        /**
         * The tab body: the host's dashboard, same-origin, filling the pane.
         *
         * The page is a plain server-rendered document with its own styling and
         * its own polling, so the component stays this small and the panel keeps
         * working while the conversation agent is busy.
         */
        function CursorPanel() {
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
