/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    getModelFamily
} from '../constants.js';
import { logger } from '../utils/logger.js';

/**
 * Check if a model is supported (Claude or Gemini)
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if model is supported
 */
function isSupportedModel(modelId) {
    const family = getModelFamily(modelId);
    return family === 'claude' || family === 'gemini';
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) {
        return { object: 'list', data: [] };
    }

    const modelList = Object.entries(data.models)
        .filter(([modelId]) => isSupportedModel(modelId))
        .map(([modelId, modelData]) => ({
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
        description: modelData.displayName || modelId
    }));

    return {
        object: 'list',
        data: modelList
    };
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
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                continue;
            }

            return await response.json();
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

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        // Only include Claude and Gemini models
        if (!isSupportedModel(modelId)) continue;

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
 * Parse tier ID string to determine subscription level
 * @param {string} tierId - The tier ID from the API
 * @returns {'free' | 'pro' | 'ultra' | 'unknown'} The subscription tier
 */
export function parseTierId(tierId) {
    if (!tierId) return 'unknown';
    const lower = tierId.toLowerCase();

    if (lower.includes('ultra')) {
        return 'ultra';
    }
    if (lower === 'standard-tier') {
        // standard-tier = "Gemini Code Assist" (paid, project-based)
        return 'pro';
    }
    if (lower.includes('pro') || lower.includes('premium')) {
        return 'pro';
    }
    if (lower === 'free-tier' || lower.includes('free')) {
        return 'free';
    }
    return 'unknown';
}

/**
 * Get subscription tier for an account
 * Calls loadCodeAssist API to discover project ID and subscription tier
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{tier: string, projectId: string|null}>} Subscription tier (free/pro/ultra) and project ID
 */
export async function getSubscriptionTier(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...LOAD_CODE_ASSIST_HEADERS
    };

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI',
                        duetProject: 'rising-fact-p41fc'
                    }
                })
            });

            if (!response.ok) {
                logger.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                continue;
            }

            const data = await response.json();

            // Debug: Log all tier-related fields from the response
            logger.debug(`[CloudCode] loadCodeAssist tier data: paidTier=${JSON.stringify(data.paidTier)}, currentTier=${JSON.stringify(data.currentTier)}, allowedTiers=${JSON.stringify(data.allowedTiers?.map(t => ({ id: t?.id, isDefault: t?.isDefault })))}`);

            // Extract project ID
            let projectId = null;
            if (typeof data.cloudaicompanionProject === 'string') {
                projectId = data.cloudaicompanionProject;
            } else if (data.cloudaicompanionProject?.id) {
                projectId = data.cloudaicompanionProject.id;
            }

            // Extract subscription tier
            // Priority: paidTier > currentTier > allowedTiers
            // - paidTier.id: "g1-pro-tier", "g1-ultra-tier" (Google One subscription)
            // - currentTier.id: "standard-tier" (pro), "free-tier" (free)
            // - allowedTiers: fallback when currentTier is missing
            // Note: paidTier is sometimes missing from the response even for Pro accounts
            let tier = 'unknown';
            let tierId = null;
            let tierSource = null;

            // 1. Check paidTier first (Google One AI subscription - most reliable)
            if (data.paidTier?.id) {
                tierId = data.paidTier.id;
                tier = parseTierId(tierId);
                tierSource = 'paidTier';
            }

            // 2. Fall back to currentTier if paidTier didn't give us a tier
            if (tier === 'unknown' && data.currentTier?.id) {
                tierId = data.currentTier.id;
                tier = parseTierId(tierId);
                tierSource = 'currentTier';
            }

            // 3. Fall back to allowedTiers (find the default or first non-free tier)
            if (tier === 'unknown' && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
                // First look for the default tier
                let defaultTier = data.allowedTiers.find(t => t?.isDefault);
                if (!defaultTier) {
                    defaultTier = data.allowedTiers[0];
                }
                if (defaultTier?.id) {
                    tierId = defaultTier.id;
                    tier = parseTierId(tierId);
                    tierSource = 'allowedTiers';
                }
            }

            logger.debug(`[CloudCode] Subscription detected: ${tier} (tierId: ${tierId}, source: ${tierSource}), Project: ${projectId}`);

            return { tier, projectId };
        } catch (error) {
            logger.warn(`[CloudCode] loadCodeAssist failed at ${endpoint}:`, error.message);
        }
    }

    // Fallback: return default values if all endpoints fail
    logger.warn('[CloudCode] Failed to detect subscription tier from all endpoints. Defaulting to free.');
    return { tier: 'free', projectId: null };
}
