/**
 * Model Alias Resolver
 *
 * Claude Code (and other Anthropic clients) send their own model names, such
 * as `claude-sonnet-5`, `claude-opus-5-5[1m]` or `claude-haiku-5-5`. Cloud Code
 * doesn't offer those ids; it offers its own lineup (e.g.
 * `claude-sonnet-5-5-medium`), which Google renames every few months.
 *
 * Instead of a hardcoded alias table that goes stale on every rename, aliases
 * are resolved against the live model list the account reports
 * (fetchAvailableModels): an alias names a family and an effort, and resolves
 * to the newest model of that family the account offers. The static
 * BUILTIN_MODEL_MAPPINGS table is only used when no live list is available.
 *
 * Pure functions, no I/O - the caller passes in the available model ids.
 */

// Effort suffixes Cloud Code uses on Claude ids, in fallback order per preference.
const EFFORT_FALLBACKS = {
    low: ['low', 'medium', 'high', 'thinking', ''],
    medium: ['medium', 'high', 'low', 'thinking', ''],
    high: ['high', 'medium', 'thinking', 'low', '']
};

/**
 * Per-family defaults for client aliases.
 * - haiku: the backend has no Haiku, so the closest is the cheapest Sonnet.
 * - fable: the backend has no Fable, so the closest is the strongest Opus.
 */
const FAMILY_TARGETS = {
    opus: { family: 'opus', effort: 'medium' },
    sonnet: { family: 'sonnet', effort: 'medium' },
    haiku: { family: 'sonnet', effort: 'low' },
    fable: { family: 'opus', effort: 'high' }
};

/**
 * Exact aliases whose target effort differs from their family default.
 * `claude-sonnet-5` is what Claude Code's Auto Mode safety classifier sends:
 * short, latency-sensitive calls, so the low-effort Sonnet fits best.
 */
const ALIAS_EFFORT_OVERRIDES = {
    'claude-sonnet-5': 'low'
};

/**
 * Strip a bracketed context suffix such as `[1m]`.
 * @param {string} modelId
 * @returns {string}
 */
export function stripContextSuffix(modelId) {
    return String(modelId || '').replace(/\[[^\]]*\]$/, '');
}

/**
 * Parse a Cloud Code Claude id like `claude-opus-5-5-medium` or
 * `claude-opus-4-6-thinking` into family, version and effort.
 * @param {string} modelId
 * @returns {{family: string, version: number[], effort: string} | null}
 */
export function parseBackendClaudeId(modelId) {
    const match = /^claude-(opus|sonnet|haiku)-(\d+(?:-\d+)*)(?:-([a-z]+))?$/.exec(modelId);
    if (!match) return null;
    return {
        family: match[1],
        version: match[2].split('-').map(Number),
        effort: match[3] || ''
    };
}

function compareVersions(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Work out what family/effort a client alias asks for.
 * Recognises current names (`claude-sonnet-5`, `claude-opus-5-5`,
 * `claude-fable-5-2`, `claude-haiku-5-5`) and legacy dated names
 * (`claude-3-7-sonnet-20250219`).
 * @param {string} alias - Model id without context suffix
 * @returns {{family: string, effort: string} | null}
 */
export function parseClientAlias(alias) {
    const lower = alias.toLowerCase();
    if (!lower.startsWith('claude-')) return null;

    const name = /(opus|sonnet|haiku|fable)/.exec(lower)?.[1];
    if (!name) return null;

    const target = FAMILY_TARGETS[name];
    return {
        family: target.family,
        effort: ALIAS_EFFORT_OVERRIDES[lower] || target.effort
    };
}

/**
 * Pick the best available backend model for a family and preferred effort:
 * newest version first, then the closest effort.
 * @param {string} family - 'opus' | 'sonnet'
 * @param {string} effort - 'low' | 'medium' | 'high'
 * @param {Iterable<string>} availableIds
 * @returns {string | null}
 */
export function pickNewestInFamily(family, effort, availableIds) {
    const candidates = [];
    for (const id of availableIds) {
        if (id.endsWith('-disabled')) continue;
        const parsed = parseBackendClaudeId(id);
        if (parsed && parsed.family === family) candidates.push({ id, ...parsed });
    }
    if (candidates.length === 0) return null;

    const newest = candidates.reduce((best, c) => (compareVersions(c.version, best.version) > 0 ? c : best));
    const sameVersion = candidates.filter(c => compareVersions(c.version, newest.version) === 0);

    for (const wanted of EFFORT_FALLBACKS[effort] || EFFORT_FALLBACKS.medium) {
        const hit = sameVersion.find(c => c.effort === wanted);
        if (hit) return hit.id;
    }
    return sameVersion[0].id;
}

/**
 * Resolve a requested model id to a backend model id.
 *
 * 1. If the account offers the id as-is (with or without `[1m]`), use it.
 * 2. If it's a Claude client alias, pick the newest matching model from the
 *    live list.
 * 3. Otherwise fall back to the static table, then to the id unchanged
 *    (so validation reports it as unknown).
 *
 * @param {string} requestedModel
 * @param {Set<string>|string[]|null} availableIds - Live model ids, or null/empty when unknown
 * @param {Object<string,string>} [staticMappings] - Fallback alias table
 * @returns {{model: string, source: 'exact'|'live'|'static'|'none'}}
 */
export function resolveModelAlias(requestedModel, availableIds, staticMappings = {}) {
    const available = availableIds instanceof Set ? availableIds : new Set(availableIds || []);
    const stripped = stripContextSuffix(requestedModel);

    if (available.has(requestedModel)) return { model: requestedModel, source: 'exact' };
    if (stripped !== requestedModel && available.has(stripped)) return { model: stripped, source: 'exact' };

    if (available.size > 0) {
        const alias = parseClientAlias(stripped);
        if (alias) {
            const picked = pickNewestInFamily(alias.family, alias.effort, available);
            if (picked) return { model: picked, source: 'live' };
        }
    }

    const fromTable = staticMappings[requestedModel] || staticMappings[stripped];
    if (fromTable) return { model: fromTable, source: 'static' };

    return { model: requestedModel, source: 'none' };
}
