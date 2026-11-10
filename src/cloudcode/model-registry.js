/**
 * Model Registry
 *
 * Records per-model metadata from Cloud Code's fetchAvailableModels response so
 * model family / thinking support can be resolved from what the backend reports
 * (apiProvider, supportsThinking) when the model id itself doesn't say - e.g. a
 * new model shipped under a codename without "gemini" or "claude" in its id.
 *
 * Deliberately has no imports: constants.js reads from it, and model-api.js
 * (which imports constants.js) writes to it.
 */

const registry = new Map();

/**
 * Map a Cloud Code apiProvider value to a model family.
 * @param {string} apiProvider - e.g. 'API_PROVIDER_GOOGLE_GEMINI'
 * @returns {'claude' | 'gemini' | null}
 */
function familyFromProvider(apiProvider) {
    const provider = String(apiProvider || '').toUpperCase();
    if (provider.includes('GOOGLE_GEMINI')) return 'gemini';
    if (provider.includes('ANTHROPIC')) return 'claude';
    return null;
}

/**
 * Collect the ids the backend offers as selectable agent models
 * (agentModelSorts groups and tieredModelIds). Internal/tab-completion
 * models (tab_*, chat_*) never appear in these lists.
 * @param {Object} data - fetchAvailableModels response
 * @returns {Set<string>}
 */
function collectAgentModelIds(data) {
    const ids = new Set();
    for (const sort of data?.agentModelSorts || []) {
        for (const group of sort?.groups || []) {
            for (const id of group?.modelIds || []) ids.add(id);
        }
    }
    for (const list of Object.values(data?.tieredModelIds || {})) {
        if (Array.isArray(list)) list.forEach(id => ids.add(id));
    }
    return ids;
}

/**
 * Whether the model id names its family itself (legacy name-based detection).
 * @param {string} modelId
 * @returns {boolean}
 */
function hasFamilyInName(modelId) {
    const lower = (modelId || '').toLowerCase();
    return lower.includes('claude') || lower.includes('gemini');
}

/**
 * Record model metadata from a fetchAvailableModels response.
 * Ids whose name already identifies the family are always recorded; other ids
 * only when the backend lists them as agent models with a Gemini/Anthropic
 * provider, so internal models (tab_*, chat_*) and other providers (gpt-oss)
 * stay excluded.
 * @param {Object} data - fetchAvailableModels response
 */
export function recordModels(data) {
    if (!data || !data.models) return;
    const agentIds = collectAgentModelIds(data);

    for (const [modelId, modelData] of Object.entries(data.models)) {
        const family = familyFromProvider(modelData?.apiProvider);
        if (!hasFamilyInName(modelId) && !(family && agentIds.has(modelId))) continue;

        registry.set(modelId, {
            family,
            supportsThinking: modelData?.supportsThinking === true,
            maxOutputTokens: modelData?.maxOutputTokens ?? null,
            displayName: modelData?.displayName || null
        });
    }
}

/**
 * Get recorded metadata for a model id.
 * @param {string} modelId
 * @returns {{family: 'claude'|'gemini'|null, supportsThinking: boolean, maxOutputTokens: number|null, displayName: string|null} | undefined}
 */
export function getRegisteredModel(modelId) {
    return registry.get(modelId);
}

/**
 * Clear all recorded metadata (used by tests).
 */
export function clearModelRegistry() {
    registry.clear();
}
