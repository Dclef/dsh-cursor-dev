import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUsageRoutes } from '../lib/usage.js';

/**
 * The dashboard's client script is emitted through a template literal, so the
 * panel is one big string that the browser parses on its own. Two mistakes are
 * invisible in the source and fatal in the page:
 *
 *   - a lone backtick inside the script closes the template early, and
 *   - a stray backslash turns a regex class like /[\s-]/ into /[s-]/.
 *
 * The unit tests below all stub the DOM, so they would notice a broken script
 * only if they happened to reach the broken line. These two check the served
 * artifact itself.
 */
async function servedScript(t) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-panel-js-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const routes = new Map();
    registerUsageRoutes({ get: () => ({ register: route => routes.set(route.path, route) }) }, {
        dataDir: dir, pool: { snapshot: () => [] }, index: { list: () => [] },
    });
    let html;
    await routes.get('/plugins/dsh-cursor-dev/').handler({ url: '/', method: 'GET' }, {
        writeHead() {}, end(value) { html = value; },
    });
    return html.match(/<script>([\s\S]*?)<\/script>/)[1];
}

test('the served panel script parses as JavaScript', async t => {
    const script = await servedScript(t);
    // Throws on the first syntax error, naming it.
    assert.doesNotThrow(() => new Function(script), 'the browser must be able to parse the panel');
});

test('the served panel script keeps its whitespace class in the tier regex', async t => {
    const script = await servedScript(t);
    // The source writes the class doubled, so the browser sees one escape. What
    // matters is what the BROWSER's regex does: /[s-]/ would match the letter
    // "s" instead of whitespace, and the tier word is always preceded by a
    // space — so every model would keep its tier suffix and the browser would
    // list "Grok 4.7  Low" as a model name.
    const match = /if \(\/\[([^\]]*)\]fast\$/.exec(script);
    assert.ok(match !== null, 'the tier-stripping regex must be present');
    assert.ok(match[1].includes('\\s'),
        `the class must keep its backslash, got ${JSON.stringify(match[1])}`);
    // And the class the browser builds must actually match a space.
    assert.ok(new RegExp(`[${match[1]}]`).test(' '), 'the class must match whitespace');
    assert.ok(!new RegExp(`[${match[1].replace('\\s', '')}]`).test(' '),
        'without the backslash the class would match "s" and "-" only');
});

test('no comment inside the panel script carries a backtick', async t => {
    const script = await servedScript(t);
    // The panel script is emitted through a template literal, so a backtick in a
    // COMMENT closes the template early: the source still parses as this module,
    // but the page the browser receives is truncated at that point. The served
    // artifact is the only place the damage is visible, so it is checked here.
    const offenders = [];
    script.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*'))
            return;
        if (trimmed.includes('`'))
            offenders.push(`${index + 1}: ${trimmed.slice(0, 70)}`);
    });
    assert.deepEqual(offenders, [],
        'a backtick in a panel comment truncates the served script');
});
