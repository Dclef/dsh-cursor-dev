/**
 * The one place that knows how a Cursor model choice is named.
 *
 * There are two name spaces in play, and mixing them is what made every model
 * switch fail:
 *
 * 1. The CLI's own listing (`cursor-agent --list-models`) answers with SHORT
 *    ALIASES — `auto`, `composer-2.5`, `composer-2.5-fast`, `glm-5.2-high`.
 *    This is what the panel stores and what a caller writes by hand.
 * 2. The ACP session roster answers with PARAMETERISED IDS — the alias, its
 *    variant options in brackets, and the empty option set spelled `[]`:
 *    `default[]`, `composer-2.5[fast=true]`, `kimi-k3[reasoning=max]`.
 *    `session/set_config_option` accepts ONLY these; sending the alias is
 *    rejected with `-32602 Invalid params: Invalid model value: auto`.
 *
 * So a choice is normalized (alias → the id the protocol speaks) before it is
 * handed to the CLI, and resolved against the live roster so a name the account
 * cannot use is reported before the child is touched.
 *
 * Only ACP's `session/set_config_option` takes these names. The `--model` SPAWN
 * flag is the CLI's own option parser, which wants the bare alias without the
 * bracket suffix — use {@link cliModelArg} for that.
 */

/** Fallback shown when a name cannot be resolved and no roster is known. */
export const ALLOWED_FALLBACK_MODEL = 'default[]';

/**
 * The bare name part of a model id, e.g. `composer-2.5[fast=true]` → `composer-2.5`.
 * @param value - any candidate id.
 */
export function baseName(value) {
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    const bracket = trimmed.indexOf('[');
    return (bracket === -1 ? trimmed : trimmed.slice(0, bracket)).trim();
}

/**
 * Normalize a model choice into the id the ACP `model` config option speaks.
 *
 * `auto` and the empty string mean "whatever the CLI defaults to", which the
 * roster spells `default[]` — an id no listing ever prints, so it is mapped
 * here rather than looked up.
 *
 * @param value - a panel value, a caller-supplied id, or a configured default.
 */
export function normalizeModelId(value) {
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'auto')
        return ALLOWED_FALLBACK_MODEL;
    return trimmed;
}

/**
 * The value for the `--model` SPAWN flag, or `''` to omit the flag.
 *
 * The spawn flag takes the alias the CLI itself lists; the bracket suffix and
 * the protocol-only `default[]` alias are both meaningless to it, and the flag
 * is only a startup preference anyway (the session roster decides what a
 * `set_config_option` will accept).
 *
 * @param value - a panel value, a caller-supplied id, or a configured default.
 */
export function cliModelArg(value) {
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    const name = baseName(trimmed);
    if (name === '' || name === 'default' || name.toLowerCase() === 'auto')
        return '';
    return name;
}

/**
 * Turn the ACP `configOptions` array into the roster shape the pool already
 * reads (`{currentModelId, availableModels: [{modelId, name}]}`).
 *
 * A CLI build that reports models in the legacy `models` shape instead of
 * `configOptions` keeps working: both are reduced to this one shape.
 *
 * @param configOptions - the `configOptions` array of a `session/new` or
 *   `session/load` response, or of a `config_option_update` notification.
 * @param current - the id to report as current when the option does not carry one.
 * @returns the roster, or `undefined` when nothing usable was found.
 */
export function rosterFromConfigOptions(configOptions, current) {
    if (!Array.isArray(configOptions))
        return undefined;
    const option = configOptions.find(entry => entry !== null && typeof entry === 'object' && entry.id === 'model');
    if (option === undefined)
        return undefined;
    const available = Array.isArray(option.options)
        ? option.options
            .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.value === 'string' && entry.value !== '')
            .map(entry => ({
                modelId: entry.value,
                name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.value,
            }))
        : [];
    const currentModelId = typeof option.currentValue === 'string' && option.currentValue !== ''
        ? option.currentValue
        : (typeof current === 'string' ? current : undefined);
    if (available.length === 0 && currentModelId === undefined)
        return undefined;
    return {
        ...(currentModelId === undefined ? {} : { currentModelId }),
        ...(available.length === 0 ? {} : { availableModels: available }),
    };
}

/**
 * Fold any roster shape (legacy `models`, ACP `configOptions`) into one shape.
 *
 * @param session - a `session/new` / `session/load` response or a pool record.
 * @param fallbackCurrent - id to keep as current when the response omits one.
 */
export function rosterFromSession(session, fallbackCurrent) {
    if (session === null || typeof session !== 'object')
        return undefined;
    const fromConfig = rosterFromConfigOptions(session.configOptions, fallbackCurrent);
    const legacy = session.models;
    if (legacy === null || typeof legacy !== 'object') {
        return fromConfig;
    }
    const current = typeof legacy.currentModelId === 'string' && legacy.currentModelId !== ''
        ? legacy.currentModelId
        : (fromConfig?.currentModelId ?? fallbackCurrent);
    const fromLegacy = Array.isArray(legacy.availableModels)
        ? legacy.availableModels
            .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.modelId === 'string' && entry.modelId !== '')
            .map(entry => ({
                modelId: entry.modelId,
                name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.modelId,
            }))
        : [];
    const available = fromLegacy.length > 0 ? fromLegacy : (fromConfig?.availableModels ?? []);
    if (current === undefined && available.length === 0)
        return fromConfig;
    return {
        ...(current === undefined ? {} : { currentModelId: current }),
        ...(available.length === 0 ? {} : { availableModels: available }),
    };
}

/** The available ids of a roster, in roster order. */
function availableIds(roster) {
    const list = roster?.availableModels;
    return Array.isArray(list) ? list.map(entry => entry.modelId).filter(id => typeof id === 'string') : [];
}

/**
 * Find the id a roster would accept for a requested choice.
 *
 * @param modelId - the requested choice (alias, parameterised id, or empty).
 * @param roster - `{currentModelId, availableModels}`, or `undefined` when the
 *   build does not report a roster at all.
 * @returns `{ok: true, id, exact, aliased, listed}` with the id to send, or
 *   `{ok: false, error, id}` where `id` is the never-listed fallback. `listed`
 *   is FALSE only for the no-roster branch below, where the returned `id` is
 *   the requested name rather than an id the roster accepts — a caller that
 *   compares ids (rather than sending one) must not read those as a match.
 */
export function resolveModelId(modelId, roster) {
    const wanted = normalizeModelId(modelId);
    const available = availableIds(roster);
    if (available.length === 0) {
        // No roster to check against: the normalized name is the best guess a
        // caller can make, and the CLI's own rejection carries the real message.
        return { ok: true, id: wanted, exact: true, aliased: false, listed: false };
    }
    if (available.includes(wanted))
        return { ok: true, id: wanted, exact: true, aliased: false, listed: true };

    const name = baseName(wanted);
    const byName = available.find(id => baseName(id) === name);
    if (byName !== undefined)
        return { ok: true, id: byName, exact: false, aliased: false, listed: true };

    // The CLI's own listing prefixes its aliases with the workspace vendor
    // (`cursor-grok-4.5-high`) while the session roster publishes the bare family
    // (`grok-4.5[…]`). The prefix is dropped for FAMILY MATCHING ONLY: an exact
    // id is matched verbatim above, so a build that really offers `cursor-…` ids
    // is unaffected, and the id handed back is always a roster id. Both spellings
    // are searched, the roster's own first, so a forked build that publishes
    // `cursor-foo` is matched before its bare `foo` is considered.
    const stripped = name.toLowerCase().startsWith('cursor-') ? name.slice('cursor-'.length) : name;
    const familyNames = stripped === name ? [name] : [name, stripped];

    // A short alias whose variants are all fully parameterised in the roster.
    // This CLI lists `grok-4.7-xhigh` and `glm-5.2-high` while its session
    // roster offers `grok-4.7[context=256k,…,fast=true]` and
    // `glm-5.2[reasoning=high]` — the alias names a variant the roster spells
    // with brackets, so the two name spaces only meet through the alias's
    // family name (`grok-4.7`). Ambiguity is resolved by the roster's own order
    // (its first entry is the vendor's recommendation) and two candidate
    // families are never guessed between.
    //
    // Only VERSIONED families are tried. A family that has collapsed all the
    // way to the bare vendor (`grok-4.6-xhigh` → `grok`) would match any model
    // of that vendor, quietly turning an alias this account does not offer into
    // one it does; requiring the version segment keeps the match honest.
    const families = familyNames
        .flatMap(familyName => familiesOf(familyName))
        .filter(family => /\d/.test(family));

    for (const family of families) {
        const under = available.filter(id => id.toLowerCase().startsWith(`${family}[`));
        if (under.length > 0)
            return { ok: true, id: under[0], exact: false, aliased: true, listed: true };
    }

    for (const family of families) {
        const dashed = available.filter(id => baseName(id).toLowerCase().startsWith(`${family}-`));
        if (dashed.length === 1)
            return { ok: true, id: dashed[0], exact: false, aliased: true, listed: true };
    }

    return {
        ok: false,
        id: wanted,
        error: `model "${modelId}" is not offered by this Cursor account; available: ${shortList(available)}`,
    };
}

/**
 * The progressively shorter family names of a CLI alias.
 *
 * `grok-4.7-xhigh` → `['grok-4.7-xhigh', 'grok-4.7']`, so a roster entry named
 * `grok-4.7[…]` can still be found by the alias that pins one of its variants.
 *
 * The walk stops once the next candidate would drop the version: collapsing
 * past `grok-4.7` to `grok` would let an unrelated alias (`cursor-grok-9.9-x`)
 * match this account's `grok-4.7` through nothing but the shared vendor name.
 *
 * @param name - a bare model name.
 */
function familiesOf(name) {
    if (name === '')
        return [];
    const families = [name];
    let candidate = name;
    for (let index = candidate.lastIndexOf('-'); index > 0; index = candidate.lastIndexOf('-')) {
        candidate = candidate.slice(0, index);
        if (/^\d/.test(candidate))
            break;
        families.push(candidate);
    }
    return families;
}

/**
 * Resolve a choice against a roster, returning the flat pieces a caller needs.
 *
 * @param modelId - the requested choice.
 * @param roster - the session roster, or `undefined`.
 */
export function resolveModel(modelId, roster) {
    if (typeof modelId !== 'string' || modelId.trim() === '')
        return { id: '', ok: true, exact: true, aliased: false };
    const resolved = resolveModelId(modelId, roster);
    return {
        id: resolved.id,
        ok: resolved.ok,
        exact: resolved.exact,
        aliased: resolved.aliased,
        listed: resolved.listed === true,
        ...(resolved.error === undefined ? {} : { error: resolved.error }),
    };
}

/** Whether two choices name the same model, ignoring alias spelling. */
export function sameModel(left, right) {
    // An absent choice is not a model: `undefined` (no choice) and `''` (an
    // empty choice) are the same non-decision, but neither equals a real model.
    if (!isChoice(left) || !isChoice(right))
        return !isChoice(left) && !isChoice(right);
    const a = normalizeModelId(left);
    const b = normalizeModelId(right);
    if (a === b)
        return true;
    return baseName(a).toLowerCase() === baseName(b).toLowerCase();
}

/** Whether a value names a model at all (as opposed to no choice). */
function isChoice(value) {
    return typeof value === 'string' && value.trim() !== '';
}

/**
 * The panel-facing list of a roster, so an unpublished option can be shown as
 * unavailable instead of failing a whole run.
 *
 * @param roster - the session roster.
 */
export function listRosterModels(roster) {
    const available = availableIds(roster);
    const current = roster?.currentModelId;
    return available.map(id => ({
        id,
        name: id === ALLOWED_FALLBACK_MODEL ? 'Auto' : baseName(id),
        current: id === current,
        isDefault: id === ALLOWED_FALLBACK_MODEL,
    }));
}

/** A comma-separated, bounded rendering of an id list for an error message. */
function shortList(ids) {
    const head = ids.slice(0, 8).join(', ');
    return ids.length > 8 ? `${head}, … (${ids.length} total)` : head;
}
