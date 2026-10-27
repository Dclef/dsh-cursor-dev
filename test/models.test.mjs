/**
 * Guards for `lib/models.js`, the module that keeps the CLI's two model name
 * spaces apart.
 *
 * The failure this pins down is concrete: the panel stores the aliases the CLI
 * lists (`auto`, `composer-2.5`), `session/set_config_option` accepts only
 * parameterised ids (`default[]`, `composer-2.5[fast=true]`), and sending the
 * wrong space is a hard rejection that used to fail the whole turn.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ALLOWED_FALLBACK_MODEL,
    baseName,
    cliModelArg,
    listRosterModels,
    normalizeModelId,
    resolveModel,
    rosterFromConfigOptions,
    rosterFromSession,
    sameModel,
} from '../lib/models.js';
import { acpArgv } from '../lib/resolve-agent.js';

/** The roster shape a live CLI reports for this account (probed 2026-10-12). */
const CONFIG_OPTIONS = [
    {
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'composer-2.5[fast=true]',
        options: [
            { value: 'default[]', name: 'Auto' },
            { value: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
            { value: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]', name: 'Grok 4.7' },
            { value: 'kimi-k3[reasoning=max]', name: 'Kimi K3' },
            { value: 'glm-5.2[reasoning=high]', name: 'GLM 5.2' },
        ],
    },
    { id: 'mode', name: 'Mode', currentValue: 'agent', options: [] },
];

test('normalizeModelId maps every way of saying "the default" to the id ACP speaks', () => {
    assert.equal(normalizeModelId('auto'), ALLOWED_FALLBACK_MODEL);
    assert.equal(normalizeModelId('AUTO'), 'default[]', 'the alias is compared case-insensitively');
    assert.equal(normalizeModelId(''), 'default[]', 'an empty choice is not a choice');
    assert.equal(normalizeModelId(undefined), '');
    assert.equal(normalizeModelId('  default[]  '), 'default[]', 'whitespace is not part of an id');
    assert.equal(normalizeModelId('composer-2.5[fast=true]'), 'composer-2.5[fast=true]', 'a parameterised id passes through');
    assert.equal(normalizeModelId('composer-2.5'), 'composer-2.5');
});

test('cliModelArg keeps the spawn flag to the alias the CLI itself lists', () => {
    // The bracket spelling is not a CLI option, but the tier inside it IS what
    // the process is billed for, so it is carried into the alias rather than
    // dropped: `composer-2.5[fast=true]` and `composer-2.5-fast` are one model.
    assert.equal(cliModelArg('composer-2.5[fast=true]'), 'composer-2.5-fast');
    assert.equal(cliModelArg('grok-4.7[context=256k,reasoning_effort=high,fast=true]'), 'grok-4.7-high-fast');
    assert.equal(cliModelArg('kimi-k3[reasoning=max]'), 'kimi-k3-max');
    assert.equal(cliModelArg('deepseek-v41-flash-1017[reasoning_effort=high]'), 'deepseek-v41-flash-1017-high');
    assert.equal(cliModelArg('auto'), '');
    assert.equal(cliModelArg('default[]'), '', 'the protocol-only default alias is not a CLI model');
    assert.equal(cliModelArg('  glm-5.2-high '), 'glm-5.2-high');
    assert.equal(cliModelArg(undefined), '');
    assert.equal(baseName('a[b=c]'), 'a');
    assert.equal(baseName('a'), 'a');
});

test('rosterFromConfigOptions reduces the ACP option list to the roster shape', () => {
    const roster = rosterFromConfigOptions(CONFIG_OPTIONS);
    assert.equal(roster.currentModelId, 'composer-2.5[fast=true]');
    assert.deepEqual(roster.availableModels.map(entry => entry.modelId), [
        'default[]',
        'composer-2.5[fast=true]',
        'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        'kimi-k3[reasoning=max]',
        'glm-5.2[reasoning=high]',
    ]);
    assert.equal(roster.availableModels[0].name, 'Auto');
});

test('rosterFromConfigOptions refuses what it cannot use', () => {
    assert.equal(rosterFromConfigOptions(undefined), undefined);
    assert.equal(rosterFromConfigOptions([]), undefined, 'no model option at all');
    assert.equal(rosterFromConfigOptions([{ id: 'mode', options: [] }]), undefined);
    assert.equal(
        rosterFromConfigOptions([{ id: 'model', options: ['nope', null, { value: '' }] }]),
        undefined,
        'entries without a usable value are dropped, and an empty roster is not a roster',
    );
    const currentOnly = rosterFromConfigOptions([{ id: 'model', currentValue: 'default[]' }]);
    assert.deepEqual(currentOnly, { currentModelId: 'default[]' }, 'a current value alone is still worth keeping');
    const noCurrent = rosterFromConfigOptions([{ id: 'model', options: [{ value: 'default[]' }] }], 'default[]');
    assert.deepEqual(noCurrent, {
        currentModelId: 'default[]',
        availableModels: [{ modelId: 'default[]', name: 'default[]' }],
    }, 'the caller-supplied current value stands in when the option omits one');
});

test('rosterFromSession reads both the ACP shape and the legacy models shape', () => {
    const fromConfig = rosterFromSession({ configOptions: CONFIG_OPTIONS });
    assert.equal(fromConfig.currentModelId, 'composer-2.5[fast=true]');

    const legacy = rosterFromSession({
        models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto' }] },
    });
    assert.deepEqual(legacy, {
        currentModelId: 'auto',
        availableModels: [{ modelId: 'auto', name: 'Auto' }],
    }, 'a build that reports only `models` still produces a roster');

    const both = rosterFromSession({ configOptions: CONFIG_OPTIONS, models: { currentModelId: 'auto' } });
    assert.equal(both.availableModels.length, 5, 'the richer ACP list stands in when the legacy list is empty');
    assert.equal(both.currentModelId, 'auto', 'the legacy block is the CLI\'s own answer for what is current');

    assert.equal(rosterFromSession(undefined), undefined);
    assert.equal(rosterFromSession({}), undefined);
});

test('resolveModel accepts the parameterised id, and finds the variant of an alias', () => {
    const roster = rosterFromConfigOptions(CONFIG_OPTIONS);

    const exact = resolveModel('kimi-k3[reasoning=max]', roster);
    assert.deepEqual({ id: exact.id, ok: exact.ok, exact: exact.exact }, { id: 'kimi-k3[reasoning=max]', ok: true, exact: true });

    const alias = resolveModel('kimi-k3', roster);
    assert.deepEqual(
        { id: alias.id, ok: alias.ok, exact: alias.exact, aliased: alias.aliased },
        { id: 'kimi-k3[reasoning=max]', ok: true, exact: false, aliased: false },
        'a short alias resolves to the one roster id carrying that name',
    );

    const auto = resolveModel('auto', roster);
    assert.equal(auto.id, 'default[]', '"auto" is the protocol default, not the CLI flag');

    const shortVariant = resolveModel('grok-4.7-xhigh', roster);
    assert.equal(shortVariant.id, 'grok-4.7[context=256k,reasoning_effort=high,fast=true]');
    assert.equal(shortVariant.ok, true);
});

test('resolveModel reports a model the account does not offer, without touching the CLI', () => {
    const roster = rosterFromConfigOptions(CONFIG_OPTIONS);
    const missing = resolveModel('gpt-5.5', roster);
    assert.equal(missing.ok, false);
    assert.equal(missing.id, 'gpt-5.5', 'the requested name is what an error message should name');
    assert.match(missing.error, /gpt-5\.5/);
    assert.match(missing.error, /default\[\]/);
    assert.match(missing.error, /not offered/);
});

test('resolveModel guesses when the build publishes no roster at all', () => {
    const guess = resolveModel('composer-2.5', undefined);
    assert.equal(guess.ok, true, 'without a roster the CLI owns the rejection');
    assert.equal(guess.id, 'composer-2.5');
    assert.equal(resolveModel('auto', undefined).id, 'default[]');
    assert.equal(resolveModel('', undefined).id, '', 'an absent choice stays absent');
    // `listed:false` is the no-roster marker: the returned id is the requested
    // NAME, not an id a roster accepts, so a caller that compares ids (the
    // continuation gate in lib/tool.js) must not read it as the model in effect.
    assert.equal(guess.listed, false);
    assert.equal(resolveModel('composer-2.5', rosterFromConfigOptions(CONFIG_OPTIONS)).listed, true);
});

test('a roster that answered marks the resolution as listed', () => {
    const roster = rosterFromConfigOptions(CONFIG_OPTIONS);
    for (const choice of ['composer-2.5[fast=true]', 'composer-2.5-fast', 'auto', 'kimi-k3-max']) {
        const resolved = resolveModel(choice, roster);
        assert.equal(resolved.ok, true, `${choice} must resolve: ${resolved.error}`);
        assert.equal(resolved.listed, true, `${choice} was resolved against a real roster`);
    }
    const unknown = resolveModel('gpt-5.5', roster);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.listed, false, 'a failed resolution has no id a caller may trust');
});

test('resolveModel crosses the `cursor-` workspace prefix the CLI listing adds', () => {
    // Every alias the CLI's `--list-models` prints for this account is prefixed
    // with the workspace vendor (`cursor-grok-4.5-high`) while the session roster
    // publishes the bare family (`grok-4.5[…]`). The picker merges the two
    // sources, so an alias the panel can show MUST resolve to an id the session
    // accepts — otherwise it hands the user a choice that can only fail.
    const roster = rosterFromConfigOptions(CONFIG_OPTIONS);
    const expected = {
        'cursor-grok-4.7-high-fast': 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        'cursor-grok-4.7-high': 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        'cursor-grok-4.7-low': 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        'composer-2.5-fast': 'composer-2.5[fast=true]',
        'kimi-k3-max': 'kimi-k3[reasoning=max]',
        'glm-5.2-max': 'glm-5.2[reasoning=high]',
    };
    for (const [alias, id] of Object.entries(expected)) {
        const resolved = resolveModel(alias, roster);
        assert.equal(resolved.ok, true, `${alias} must resolve, not fail: ${resolved.error}`);
        assert.equal(resolved.id, id, `${alias} must land on a roster id`);
        assert.equal(resolved.aliased, true, `${alias} names a variant the roster spells differently`);
    }

    // A workspace-prefixed name that no roster family backs is still unknown —
    // the prefix is stripped for FAMILY MATCHING, never treated as a wildcard.
    const missing = resolveModel('cursor-grok-9.9-ultra', roster);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /not offered/);
    assert.equal(resolveModel('gpt-5.5', roster).ok, false, 'a genuinely absent model keeps failing');
});

test('resolveModel matches a cursor- id exactly when the roster publishes one', () => {
    // A build that really offers `cursor-…` ids must keep working: the exact-id
    // check runs BEFORE any prefix stripping, so a prefixed id is never
    // double-stripped into a family that does not exist.
    const roster = {
        currentModelId: 'cursor-foo[fast=true]',
        availableModels: [
            { modelId: 'cursor-foo[fast=true]', name: 'Cursor Foo' },
            { modelId: 'cursor-foo-v2[fast=false]', name: 'Cursor Foo v2' },
            { modelId: 'bar-2.5[]', name: 'Bar 2.5' },
            { modelId: 'bar-2.5[variant=max]', name: 'Bar 2.5 Max' },
        ],
    };

    const exact = resolveModel('cursor-foo', roster);
    assert.deepEqual(
        { id: exact.id, ok: exact.ok, exact: exact.exact, aliased: exact.aliased },
        { id: 'cursor-foo[fast=true]', ok: true, exact: false, aliased: false },
        'the bare name matches the roster id that carries it, alias or not',
    );
    assert.equal(resolveModel('cursor-foo[fast=true]', roster).exact, true, 'an exact id stays exact');

    // The prefix is stripped for FAMILY matching only, so the bare spelling of a
    // versioned roster family still finds it. Which variant wins is the roster's
    // own order — the vendor's recommendation — never an invented preference.
    assert.equal(resolveModel('cursor-bar-2.5', roster).id, 'bar-2.5[]');
    assert.equal(resolveModel('cursor-bar-2.5-max', roster).id, 'bar-2.5[]', 'the roster order decides between variants');
    assert.equal(resolveModel('cursor-foo-v2', roster).id, 'cursor-foo-v2[fast=false]', 'a real cursor- family is matched as itself');
});

test('sameModel ignores alias spelling so a no-op switch is not sent', () => {
    assert.equal(sameModel('auto', 'default[]'), true);
    assert.equal(sameModel('composer-2.5', 'composer-2.5[fast=true]'), true, 'the alias names the same model as its variant');
    assert.equal(sameModel('', ''), true);
    assert.equal(sameModel(undefined, ''), true);
    assert.equal(sameModel('kimi-k3[reasoning=max]', 'glm-5.2[reasoning=high]'), false);
    assert.equal(sameModel('grok-4.7-a', 'grok-4.7-b'), false, 'two different variants stay different');
});

test('listRosterModels describes the picker entries the roster can actually serve', () => {
    const listed = listRosterModels(rosterFromConfigOptions(CONFIG_OPTIONS));
    assert.equal(listed.length, 5);
    assert.deepEqual(listed[0], { id: 'default[]', name: 'Auto', current: false, isDefault: true });
    assert.equal(listed[1].current, true, 'the option currentValue is the current model');
    assert.deepEqual(listed.map(entry => entry.id), [
        'default[]',
        'composer-2.5[fast=true]',
        'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        'kimi-k3[reasoning=max]',
        'glm-5.2[reasoning=high]',
    ], 'the parameterised ids are what the picker must store');
});

test('acpArgv keeps each name space on the side of the boundary it belongs to', () => {
    const resolved = { command: 'C:\\agent\\node.exe', entry: 'index.js', source: 'test' };

    // The protocol-only default is not a CLI flag, and neither is an absent
    // choice: both leave the model to the account default and to the session.
    for (const model of ['auto', 'default[]', '', undefined]) {
        const argv = acpArgv(resolved, model);
        assert.ok(!argv.includes('--model'), `${String(model)} must not become --model`);
        assert.equal(argv[argv.length - 1], 'acp', 'acp stays last in every case');
    }

    // A parameterised id is what the ACP method takes, not what the CLI flag
    // takes — the flag gets the alias, or the CLI refuses to start at all. The
    // tier travels with it: the process is billed for the tier it was started
    // with, so `grok-4.7[...high,fast=true]` must not become a bare
    // `grok-4.7`, which would run the account default instead.
    const pinned = acpArgv(resolved, 'composer-2.5[fast=true]');
    assert.equal(pinned[pinned.indexOf('--model') + 1], 'composer-2.5-fast');
    assert.equal(pinned[pinned.length - 1], 'acp');

    // An alias passes through untouched, and the entry still leads the argv.
    assert.deepEqual(acpArgv(resolved, 'kimi-k3'), ['index.js', '--model', 'kimi-k3', 'acp']);
    assert.deepEqual(acpArgv({ command: 'node.exe', entry: undefined }, 'glm-5.2'), ['--model', 'glm-5.2', 'acp']);
});
