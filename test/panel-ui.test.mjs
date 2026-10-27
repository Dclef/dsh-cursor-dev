import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { normalizeUsage, registerUsageRoutes } from '../lib/usage.js';

// The panel is an iframe inside the app, so its layout is the one thing an
// offline test cannot look at. What it *can* pin is the two structures that
// decide the layout: the scroll container that keeps an 84-character session key
// from widening the page, and the client-side filter that narrows the model
// picker. Both are asserted on the real emitted HTML and the real inline script.
async function panel(t, quotaGuard) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-panel-ui-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const routes = new Map();
    registerUsageRoutes({ get: () => ({ register: route => routes.set(route.path, route) }) }, {
        dataDir: dir, pool: { snapshot: () => [] }, index: { list: () => [] }, quotaGuard,
    });
    let html;
    await routes.get('/plugins/dsh-cursor-dev/').handler({ url: '/', method: 'GET' }, {
        writeHead() {}, end(value) { html = value; },
    });
    const bootstrap = html.match(/id="bootstrap">([\s\S]*?)<\/script>/)[1];
    const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const nodes = new Map();
    function element(tag = 'div') {
        let content = '', selected = '';
        return {
            tag, children: [], style: {}, listeners: {}, attributes: {}, checked: false, hidden: false,
            get textContent() { return content; },
            set textContent(value) { content = value; this.children = []; },
            get value() { return tag === 'select' && !this.children.some(child => child.value === selected) ? '' : selected; },
            set value(value) { selected = value; },
            // A progress bar's fill is the <i> the markup puts inside it.
            get firstElementChild() { return this.children[0] || this.appendChild(element('i')); },
            setAttribute(name, value) { this.attributes[name] = String(value); },
            removeAttribute(name) { delete this.attributes[name]; },
            get options() { return this.children; },
            appendChild(child) { this.children.push(child); return child; },
            addEventListener(name, callback) { this.listeners[name] = callback; },
        };
    }
    const document = {
        documentElement: {},
        querySelectorAll: () => [],
        createElement: element,
        getElementById(id) {
            if (!nodes.has(id)) {
                const node = element(id === 'model' || id === 'model-family' || id === 'model-tier' || id === 'depth' || id === 'attribution' ? 'select' : 'div');
                // The depth picker is static markup, not built by the script: seed the
                // three choices its <select> carries, or a read-back would always be ''.
                if (id === 'depth') {
                    for (const value of ['', '1', '2']) {
                        const option = element('option');
                        option.value = value;
                        node.children.push(option);
                    }
                }
                nodes.set(id, node);
            }
            return nodes.get(id);
        },
    };
    document.getElementById('bootstrap').textContent = bootstrap;
    const calls = [];
    const context = {
        document,
        window: { localStorage: { getItem: () => 'zh' } },
        fetch: async (url, init) => { calls.push({ url, method: init?.method }); return { json: async () => ({}) }; },
        calls,
    };
    const executable = source.replace('\n  applyLanguage();\n', `
  globalThis.panelTest = {
    renderModel: renderModel, shortKey: shortKey,
    filter: function () { return $('model-filter'); },
    options: function () { return $('model-family').children; },
    tiers: function () { return $('model-tier').children; },
    pick: function (id) {
      // Driving the family picker is how an operator narrows to one model; the
      // tier picker then offers that family's tiers.
      $('model-family').value = id;
      var change = $('model-family').listeners.change;
      if (change) change();
    },
    tier: function (id) {
      $('model-tier').value = id;
      var change = $('model-tier').listeners.change;
      if (change) change();
    },
    rows: function () { return $('model-list').children; },
    type: function (value) { $('model-filter').value = value; $('model-filter').listeners.input(); },
    configure: function (value, list) {
      settings = value; models = list || []; draftDisabled = null; draftModel = null; modelTab = 'all'; renderModel();
    },
    disable: function (id) { setDisabled(id, true); renderModel(); },
    tab: function (key) { modelTab = key; renderModel(); },
    history: function (list) {
      lastPayload = { ok: true, extended: { live: [], conversations: list } };
      renderLive(lastPayload);
    },
    cells: function () { return $('convos').children; },
    count: function () { return $('convos-count').textContent; },
    actions: function () {
      var tr = $('convos').children[0];
      return tr ? tr.children[5].children : [];
    },
    forget: function (key) { forgetRow({ key: key }); },
    armed: function () { return armedFor; },
    calls: function () { return calls; },
    render: render,
    lang: function (value) { LANG = value; applyLanguage(); },
    // The depth cap is the one picker whose value the panel does *not* store on
    // its own, so these three hooks are what a regression test needs: read or
    // pick a value the way the <select> does, press 保存, and answer the POST.
    depth: function (value) {
      if (value === undefined) return $('depth').value;
      $('depth').value = String(value);
      var change = $('depth').listeners.change;
      if (change) change();
    },
    save: function () { $('model-save').listeners.click(); },
    reply: function (fn) { globalThis.fetch = fn; },
    // The lock checkbox, the proxy box and the attribution switch are the same
    // shape as the depth picker: read the painted value, make the change the
    // browser would fire, and let a test repaint afterwards.
    lock: function (value) {
      if (value === undefined) return $('model-lock').checked;
      $('model-lock').checked = value === true;
      var change = $('model-lock').listeners.change;
      if (change) change();
    },
    proxy: function (value) {
      if (value === undefined) return $('proxy').value;
      $('proxy').value = String(value);
      var input = $('proxy').listeners.input;
      if (input) input();
    },
    attribution: function (value) {
      if (value === undefined) return $('attribution').value;
      $('attribution').value = String(value);
      var change = $('attribution').listeners.change;
      if (change) change();
    },
    keys: function () { return [Object.keys(T.zh), Object.keys(T.en)]; }
  };
  return;
  applyLanguage();
`);
    assert.notEqual(executable, source, 'test harness intercepts initial network polling');
    runInNewContext(executable, context);
    return { html, node: id => document.getElementById(id), ...context.panelTest };
}

/** The account the screenshot came from: spend includes a large bonus, the limit does not. */
function usage(plan = {}) {
    return {
        ok: true, fetchedAt: 1, extended: { live: [], conversations: [] },
        usage: normalizeUsage({
            planUsage: {
                totalSpend: 36564, includedSpend: 2000, bonusSpend: 34564, limit: 2000,
                totalPercentUsed: 79.3, autoPercentUsed: 80.1, apiPercentUsed: 45.8, ...plan,
            },
            autoModelSelectedDisplayMessage: 'You have used 80% of your Auto usage',
            namedModelSelectedDisplayMessage: 'You have used 46% of your API usage',
        }),
    };
}

/** The markup of one <section>, from its id to its closing tag. */
function section(html, id) {
    const start = html.indexOf(`id="${id}"`);
    return html.slice(start, html.indexOf('</section>', start));
}

const MODELS = [
    { id: 'default[]', name: 'Auto', current: true },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
];

test('a long session key cannot widen the page: every table sits in a scroll container', async t => {
    const { html } = await panel(t);
    const wraps = html.match(/<div class="tablewrap"><table>/g) || [];
    assert.equal(wraps.length, 2, 'both the live and the history table are wrapped');
    const tables = html.match(/<table>/g) || [];
    assert.equal(tables.length, 2, 'and no bare table is left outside one');
    assert.match(html, /\.tablewrap \{ overflow-x: auto;/, 'the wrapper, not <body>, owns the horizontal scroll');
    assert.match(html, /select \{[^}]*min-width: min\(180px, 100%\)/, 'a 220px panel shrinks the picker instead of overflowing');
    assert.match(html, /body \{[^}]*max-width: \d+px/, 'a wide window does not stretch the panel edge to edge');
});

test('the four quota cards come first, then the model, then the sessions', async t => {
    const { html } = await panel(t);
    const at = needle => html.indexOf(needle);
    assert.ok(at('id="usage-overview"') > 0);
    assert.ok(at('id="usage-overview"') < at('id="modelcard"'), 'quota above the model picker');
    assert.ok(at('id="modelcard"') < at('data-t="live"'), 'model picker above the sessions');
    const cards = section(html, 'usage-overview');
    assert.equal((cards.match(/<article class="card quota-card">/g) || []).length, 4, 'each usage figure has its own card');
    assert.ok(cards.indexOf('id="total-pct"') < cards.indexOf('id="auto-pct"'));
    assert.ok(cards.indexOf('id="auto-pct"') < cards.indexOf('id="api-pct"'));
    assert.ok(cards.indexOf('id="api-pct"') < cards.indexOf('id="spend"'));
    assert.doesNotMatch(html, /[^-\w]order\s*:/, 'no CSS order fights the DOM order');
    const overview = section(html, 'usage-overview');
    for (const id of ['total-pct', 'total-bar', 'total-sub', 'auto-pct', 'auto-bar', 'auto-sub',
        'api-pct', 'api-bar', 'api-sub', 'spend', 'spend-sub', 'cycle', 'message']) {
        assert.match(overview, new RegExp(`id="${id}"`), `${id} lives in the overview`);
    }
    assert.equal((overview.match(/role="progressbar"/g) || []).length, 3);
    // The picker, the lock, the proxy and the depth cap stay outside the folds;
    // only the long catalogue and the diagnostic line fold away.
    const model = section(html, 'modelcard');
    const firstFold = model.indexOf('<details');
    for (const id of ['model-family', 'model-tier', 'model-save', 'model-lock', 'model-status', 'proxy', 'depth', 'attribution']) {
        const where = model.indexOf(`id="${id}"`);
        assert.ok(where > 0 && where < firstFold, `${id} is visible without unfolding anything`);
    }
    // The choice is the point of this card, so it comes before the machinery.
    assert.ok(model.indexOf('<select id="model-family"') < model.indexOf('id="proxy"'),
        'the picker sits above the proxy');
    assert.ok(model.indexOf('<select id="model-family"') < model.indexOf('<select id="model-tier"'),
        'the model comes before the tier that narrows it');
    assert.ok(model.indexOf('id="model-status"') < model.indexOf('id="proxy"'),
        'the proxy sits below the status line it explains');
    assert.ok(model.indexOf('id="proxy"') < model.indexOf('<select id="depth"'),
        'the depth cap follows the egress route');
    assert.ok(model.indexOf('<select id="depth"') < model.indexOf('<select id="attribution"'),
        'attribution follows the depth cap: both are about what the child may do');
    assert.doesNotMatch(model, /id="model-advanced"/,
        'the diagnostics fold is gone: its line lives in the catalogue fold');
    for (const id of ['model-reload', 'model-filter', 'model-list', 'model-state']) {
        assert.ok(model.indexOf(`id="${id}"`) > firstFold, `${id} sits in a fold`);
    }
    assert.doesNotMatch(model, /<details[^>]* open/, 'the folds start closed');
    assert.match(model, /<select id="model-family" aria-labelledby="model-title"/);
    assert.match(model, /<select id="model-tier" aria-labelledby="model-title"/);
    assert.match(model, /<label[^>]* for="proxy"/);
});

test('the quota shows the upstream percentages and splits the spend without mixing denominators', async t => {
    const p = await panel(t);
    p.render(usage());
    assert.deepEqual(['total', 'auto', 'api'].map(name => p.node(`${name}-pct`).textContent),
        ['79.3%', '80.1%', '45.8%'], 'the three upstream percentages are shown untouched');
    assert.equal(p.node('spend').textContent, '$365.64');
    assert.equal(p.node('spend-sub').textContent, '套餐内 $20.00 · 赠送 $345.64');
    // $365.64 of $20 would contradict the 79.3% right above it.
    assert.equal(p.node('total-sub').textContent, '剩余 20.7% · 偏高');
    assert.doesNotMatch(p.node('total-sub').textContent, /\$/);
    assert.equal(p.node('api-sub').textContent, '剩余 54.2%');
    assert.equal(p.node('auto-sub').title, 'You have used 80% of your Auto usage', 'the raw upstream sentence is kept as a tooltip');
    assert.equal(p.node('total-bar').firstElementChild.style.width, '79.3%');
    assert.equal(p.node('total-bar').className, 'bar warn');
    assert.equal(p.node('total-bar').attributes['aria-valuenow'], '79.3');
    assert.equal(p.node('message-box').hidden, true, 'no official note, no empty fold');
});

test('an unknown or out-of-range percentage never paints a misleading bar', async t => {
    const p = await panel(t);
    p.render(usage({ totalPercentUsed: undefined, autoPercentUsed: 135, apiPercentUsed: -4 }));
    assert.equal(p.node('total-pct').textContent, '—', 'no data is not 0% used');
    assert.equal(p.node('total-sub').textContent, '暂无数据');
    assert.equal(p.node('total-bar').firstElementChild.style.width, '0%');
    assert.equal('aria-valuenow' in p.node('total-bar').attributes, false, 'an unknown bar has no value');
    assert.equal(p.node('total-bar').attributes['aria-valuetext'], '暂无数据');
    assert.equal(p.node('auto-pct').textContent, '135.0%', 'the upstream figure is still reported as is');
    assert.equal(p.node('auto-bar').firstElementChild.style.width, '100%', 'but the bar cannot leave its track');
    assert.equal(p.node('auto-bar').attributes['aria-valuenow'], '100');
    assert.equal(p.node('auto-bar').className, 'bar bad');
    assert.equal(p.node('auto-sub').textContent, '剩余 0.0% · 接近上限');
    assert.equal(p.node('api-bar').firstElementChild.style.width, '0%');
});

test('switching language repaints the quota in the same terms', async t => {
    const p = await panel(t);
    const [zh, en] = p.keys();
    assert.deepEqual([...en].sort(), [...zh].sort(), 'every label exists in both languages');
    p.render(usage());
    p.lang('en');
    assert.equal(p.node('total-pct').textContent, '79.3%');
    assert.equal(p.node('total-sub').textContent, 'remaining 20.7% · high');
    assert.equal(p.node('spend-sub').textContent, 'included $20.00 · bonus $345.64');
    assert.equal(p.node('total-bar').attributes['aria-valuetext'], '79.3%');
    p.lang('zh');
    assert.equal(p.node('total-sub').textContent, '剩余 20.7% · 偏高');
});

test('the quota alert is visible while blocked and clears after a successful refresh', async t => {
    const p = await panel(t, { snapshot: () => ({ blocked: true, source: 'cursor-error' }) });
    assert.match(p.html, /id="quota-alert"[^>]*role="alert"[^>]*hidden[^>]*data-t="quotaBlocked"/);
    p.render({ ok: true, extended: { live: [], conversations: [], quotaGuard: { blocked: true, source: 'cursor-error' } } });
    assert.equal(p.node('quota-alert').hidden, false, 'the blocked state is visible');
    p.render({ ok: true, extended: { live: [], conversations: [], quotaGuard: { blocked: false, source: 'usage' } } });
    assert.equal(p.node('quota-alert').hidden, true, 'a successful clear snapshot removes the warning');
});

test('the history list is bounded and can be folded away, so it cannot grow the page', async t => {
    const { html } = await panel(t);
    // One row per run the operator has ever made lives here; without a bound it
    // is the tallest thing on the page and pushes everything else off it.
    assert.match(html, /#convos-body \{ max-height: \d+px; overflow-y: auto; \}/,
        'the history table scrolls inside a capped box');
    assert.match(html, /id="convos-body"/, 'that box wraps the history table');
    assert.match(html, /id="convos-toggle"/, 'and the heading is the control that folds it');
    assert.match(html, /dsh-cursor-dev:convos-folded/, 'the fold choice is remembered per browser');
});

test('every history row carries a delete control', async t => {
    const { html } = await panel(t);
    assert.match(html, /data-t="colActions">操作</, 'the history table advertises the column');
    assert.match(html, /id="convos-notice"/, 'deleting reports back next to the table it emptied');
    assert.match(html, /"forgetEndpoint":"\/plugins\/dsh-cursor-dev\/api\/forget"/,
        'the panel knows where to forget a conversation');
    // The delete is destructive (index, journal and mirror all go), so it is
    // armed by the first click instead of firing on it.
    assert.match(html, /forgetArmed/);
    assert.match(html, /armedFor/);
});

test('deleting a row arms on the first click and needs a second to fire', async t => {
    const p = await panel(t);
    const calls = p.calls();
    p.history([{ key: 'a::default', cursorSessionId: 'sid-1', workspaceRoot: 'C:\\w', model: 'auto', updatedAt: 1 }]);
    assert.equal(p.cells().length, 1, 'the row is on screen');
    p.forget('a::default');
    assert.deepEqual(calls, [], 'one click only arms the row');
    assert.equal(p.armed(), 'a::default');
    assert.match(p.actions()[0].textContent, /确认删除/, 'the armed row says what the next click does');
    p.forget('a::default');
    assert.equal(calls.length, 1, 'the second click is the delete');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /api\/forget\?key=a%3A%3Adefault/);
    assert.equal(p.armed(), '', 'the confirmation is spent');
});

test('the model search box filters the picker without touching the API', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call' }, MODELS);
    assert.equal(p.options().length, 5, 'one "follow the CLI" entry plus four models');

    p.type('glm');
    assert.deepEqual(p.options().map(o => o.value), ['', 'glm-5.3'], 'only the match survives, plus the follow-the-CLI entry');

    p.type('CODEX');
    assert.deepEqual(p.options().map(o => o.value), ['', 'gpt-5.2-codex'], 'matching ignores case and covers the display name');
});

test('filtering never hides the saved choice, or the picker would look reset', async t => {
    const p = await panel(t);
    p.configure({ model: 'glm-5.3', modelPolicy: 'panel' }, MODELS);
    p.type('codex');
    const values = p.options().map(o => o.value);
    assert.ok(values.includes('glm-5.3'), 'the saved model stays in the list even when it does not match');
    assert.ok(values.includes('gpt-5.2-codex'), 'and the match is there too');
    assert.equal(p.options().find(o => o.value === 'glm-5.3').value, 'glm-5.3');
    assert.ok(!values.includes('claude-haiku-5-5'), 'non-matches are still dropped');
});

test('one distinct model is one option, and the count follows the filter', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call' }, [
        { id: 'auto', name: 'Auto' }, { id: 'default[]', name: 'Auto' }, { id: 'glm-5.3', name: 'GLM-5.3' },
    ]);
    assert.deepEqual(p.options().map(o => o.value), ['', 'default[]', 'glm-5.3'], 'auto and default[] collapse to one');
    assert.match(p.filter().placeholder, /搜索/, 'the placeholder is translated');
});

test('switching a model off hides it from the dropdown but keeps it in the browser', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call', disabledModels: [] }, MODELS);
    assert.equal(p.options().length, 5, 'every model starts available');
    assert.ok(p.rows().length >= 4, 'the browser lists every model');

    p.disable('claude-haiku-5-5');
    assert.deepEqual(p.options().map(o => o.value), ['', 'default[]', 'gpt-5.2-codex', 'glm-5.3'],
        'the switch only removes the model from the dropdown');
    assert.match(p.rows().map(r => r.className).join(' '), /\boff\b/, 'the browser still shows the switched-off row');

    p.tab('off');
    assert.equal(p.rows().length, 1, 'the Off chip isolates switched-off models');
    assert.match(p.rows()[0].className, /\boff\b/);
});

test('a session key is elided for the column, never truncated to nothing', async t => {
    const p = await panel(t);
    const long = 'session-2678abe3-6a1c-4dbb-baa9-13385e83ba34::native-1f223daf-8f57-4903-b73f-3201843';
    assert.equal(long.length, 84, 'the key the panel really receives is 84 characters');
    const short = p.shortKey(long);
    assert.ok(short.length <= 48, `elided to ${short.length} characters, so the column can hold it`);
    assert.ok(short.includes('…'), 'the elision is visible rather than silent');
    assert.ok(short.startsWith('2678abe3'), 'the readable head survives');
    assert.ok(short.includes('native-1f223'), 'and the label that tells rows apart survives');
    assert.equal(p.shortKey('short'), 'short', 'a key with no label part is left alone');
    assert.equal(p.shortKey('a::b'), 'a :: b', 'a short key is left readable');
});

test('a depth pick is kept on screen until 保存 writes it', async t => {
    const p = await panel(t);
    p.configure({}, MODELS);
    assert.equal(p.depth(), '2', 'the config default is what the page opens with');
    p.depth('1');
    assert.equal(p.depth(), '1', 'the pick shows at once, without a save');

    // The model card is repainted by unrelated clicks — a tab, a switch, a model
    // pick. The depth pick has to survive all of them, or the panel looks like
    // it refused the choice by itself.
    p.configure({ model: 'default[]', modelPolicy: 'panel', disabledModels: [] }, MODELS);
    assert.equal(p.depth(), '1');
    assert.match(p.node('model-status').textContent, /有改动未保存/, 'the card says the pick is not saved yet');
});

test('saving a depth paints the value the server stored, not the one from page load', async t => {
    const p = await panel(t);
    p.configure({}, MODELS);
    assert.equal(p.depth(), '2');
    p.depth('1');
    p.reply(async () => ({ json: async () => ({
        ok: true,
        settings: { model: 'default[]', modelPolicy: 'panel', maxChildDepth: 1, disabledModels: [] },
        effectiveModel: 'default[]',
        effectiveMaxChildDepth: 1,
    }) }));
    p.save();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(p.depth(), '1', 'the saved 1 sticks; a stale page-load value must not repaint over it');
    assert.doesNotMatch(p.node('model-status').textContent, /有改动未保存/, 'nothing is left dirty after a save');
});

test('the lock, the proxy and the attribution pick survive an unrelated repaint', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call', proxy: 'none', attribution: 'off' }, MODELS);
    assert.equal(p.lock(), false, 'the saved policy is what the page opens with');
    assert.equal(p.attribution(), 'off');

    p.lock(true);
    p.proxy('http://127.0.0.1:7890');
    p.attribution('on');
    assert.equal(p.lock(), true);
    assert.equal(p.proxy(), 'http://127.0.0.1:7890');
    assert.equal(p.attribution(), 'on', 'a picked attribution is not stored in settings either');

    // The same repaint that used to snap the depth picker back: a tab click, a
    // model pick, a refresh — anything that calls renderModel().
    p.configure({ model: '', modelPolicy: 'per-call', proxy: 'none', attribution: 'off' }, MODELS);
    assert.equal(p.lock(), true, 'the lock stays ticked');
    assert.equal(p.proxy(), 'http://127.0.0.1:7890', 'the typed proxy stays in the box');
    assert.equal(p.attribution(), 'on', 'the attribution pick stays put');
    assert.match(p.node('model-status').textContent, /有改动未保存/, 'and the card says none of it is saved yet');
});

test('saving the card stores all four drafts, and a refused value keeps its 未保存 flag', async t => {
    const p = await panel(t);
    p.configure({ model: '', modelPolicy: 'per-call', proxy: 'none', attribution: 'off' }, MODELS);
    p.depth('1');
    p.lock(true);
    p.proxy('http://127.0.0.1:7890');
    p.attribution('on');
    p.reply(async () => ({ json: async () => ({
        ok: true,
        settings: {
            model: 'default[]', modelPolicy: 'panel', proxy: 'http://127.0.0.1:7890',
            maxChildDepth: 1, attribution: 'on', disabledModels: [],
        },
        effectiveModel: 'default[]',
        effectiveMaxChildDepth: 1,
        attribution: { choice: 'on', attributeCommitsToAgent: true },
    }) }));
    p.save();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(p.depth(), '1');
    assert.equal(p.lock(), true);
    assert.equal(p.proxy(), 'http://127.0.0.1:7890');
    assert.equal(p.attribution(), 'on');
    assert.doesNotMatch(p.node('model-status').textContent, /有改动未保存/, 'the echoed values clear every draft');

    // A value the write refuses is not echoed back: it must stay flagged rather
    // than pretending the save landed.
    p.proxy('http://127.0.0.1:8080');
    p.reply(async () => ({ json: async () => ({
        ok: true,
        settings: {
            model: 'default[]', modelPolicy: 'panel', proxy: 'http://127.0.0.1:7890',
            maxChildDepth: 1, attribution: 'on', disabledModels: [],
        },
        effectiveModel: 'default[]',
        effectiveMaxChildDepth: 1,
        attribution: { choice: 'on', attributeCommitsToAgent: true },
    }) }));
    p.save();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(p.proxy(), 'http://127.0.0.1:8080', 'the refused text is still in the box');
    assert.match(p.node('model-status').textContent, /有改动未保存/, 'and the card keeps saying it is unsaved');
});
