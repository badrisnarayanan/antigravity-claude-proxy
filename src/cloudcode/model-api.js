/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    getModelFamily
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { metadataJSON } from './metadata-http.js';
import { recordModels, collectAgentModelIds } from './model-registry.js';
import { cachedMetadata } from './metadata-cache.js';
import { extractSubscriptionFromResponse } from './subscription.js';
import { loadCodeAssistMetadata } from './metadata-api.js';
export { parseTierId } from './subscription.js';

/**
 * Check if a model is supported (Claude or Gemini, by name or backend provider)
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if model is supported
 */
function isSupportedModel(modelId) {
    const family = getModelFamily(modelId);
    return family === 'claude' || family === 'gemini';
}

/**
 * Whether a model id is an old Gemini generation (version below 3.5),
 * hidden from the /v1/models listing in favor of the current line. Claude
 * ids aren't versioned this way and are unaffected.
 * @param {string} modelId
 * @returns {boolean}
 */
function isOldGemini(modelId) {
    // 'gemini-pro-agent' carries no version number in its id at all - it's
    // an unversioned duplicate alias of gemini-3.1-pro-high, so it's always
    // old regardless of what the version regex below would say.
    if (modelId === 'gemini-pro-agent') return true;

    const match = modelId.match(/^gemini-(\d+(?:\.\d+)?)/);
    return !!match && parseFloat(match[1]) < 3.5;
}

/**
 * Whether a model id is a backend placeholder for a model the account can't
 * use (an id ending in '-disabled'), hidden from the
 * /v1/models listing since requests to it can't succeed.
 * @param {string} modelId
 * @returns {boolean}
 */
function isDisabledPlaceholder(modelId) {
    return modelId.endsWith('-disabled');
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
/** Selectable variants from this account's metadata, never synthesized tiers. */
function selectableEntries(data) {
    if (!data || !data.models || typeof data.models !== 'object' || Array.isArray(data.models)) {
        throw new Error('Invalid model metadata response');
    }
    recordModels(data);
    const hasAgentCatalog = Array.isArray(data.agentModelSorts)
        || (data.tieredModelIds && typeof data.tieredModelIds === 'object');
    const agentIds = collectAgentModelIds(data);
    const retired = data.deprecatedModelIds;
    const deprecatedIds = new Set(Array.isArray(retired) ? retired : Object.keys(retired || {}));
    return Object.entries(data.models).filter(([id, model]) => isSupportedModel(id)
        && model && typeof model === 'object' && model.disabled !== true
        && !deprecatedIds.has(id) && !isDisabledPlaceholder(id)
        && (!hasAgentCatalog || agentIds.has(id)));
}

/** Match labels only to exact IDs already returned in models; never add variants. */
function thinkingLevelMetadata(data, id) {
    for (const [base, group] of Object.entries(data.groupedModels || {})) {
        for (const level of group?.supportedThinkingLevels || []) {
            const suffix = level?.thinkingSuffix;
            if (typeof suffix !== 'string' || !suffix) continue;
            if (id === base + suffix || id === `${base}-${suffix}`) {
                return { id: suffix, display_name: level.thinkingDisplayName || suffix };
            }
        }
    }
    return undefined;
}

export async function listModels(token, projectId = null) {
    const data = await fetchAvailableModels(token, projectId);
    const modelList = selectableEntries(data)
        .filter(([id]) => !isOldGemini(id))
        .map(([id, metadata]) => ({
            id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: metadata.displayName || id,
            ...(thinkingLevelMetadata(data, id) ? { thinking_level: thinkingLevelMetadata(data, id) } : {})
        }));
    return { object: 'list', data: modelList };
}

/**
 * Fetch available models with quota info from Cloud Code API
 * Returns model quotas including remaining fraction and reset time
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token, projectId = null) {
    return cachedMetadata('models', token, projectId, async () => {
        const data = await requestAvailableModels(token, projectId);
        // An empty, valid account catalog is authoritative. A malformed one isn't.
        selectableEntries(data);
        return data;
    });
}

async function requestAvailableModels(token, projectId) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Include project ID in body for accurate quota info (per Quotio implementation)
    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await metadataJSON(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = response.data;
                logger.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            return response.data;
        } catch (error) {
            logger.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token, projectId = null) {
    const data = await fetchAvailableModels(token, projectId);
    if (!data || !data.models) return {};
    recordModels(data);

    const quotas = {};
    for (const [modelId, modelData] of selectableEntries(data)) {

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                // When remainingFraction is missing but resetTime is present, quota is exhausted (0%)
                remainingFraction: modelData.quotaInfo.remainingFraction ?? (modelData.quotaInfo.resetTime ? 0 : null),
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        }
    }

    return quotas;
}

/**
 * Get subscription tier for an account
 * Calls loadCodeAssist API to discover project ID and subscription tier
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{tier: string, projectId: string|null}>} Subscription tier (free/pro/ultra) and project ID
 */
export async function getSubscriptionTier(token) {
    try {
        return extractSubscriptionFromResponse(await loadCodeAssistMetadata(token));
    } catch {
        logger.warn('[CloudCode] Subscription metadata unavailable; entitlement remains unknown.');
        return extractSubscriptionFromResponse(null);
    }
}

/** Check only the exact variant this account's catalog offers. Fail closed. */
export async function isValidModel(modelId, token, projectId = null) {
    const data = await fetchAvailableModels(token, projectId);
    return selectableEntries(data).some(([id]) => id === modelId);
}
