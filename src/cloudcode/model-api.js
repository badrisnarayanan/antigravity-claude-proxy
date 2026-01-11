/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 */

import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_HEADERS, getModelFamily } from '../constants.js';
import { logger } from '../utils/logger.js';
import { retryWithBackoff, isRetryableError } from '../utils/retry.js';

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
 * Uses retry logic with exponential backoff for network errors
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Try each endpoint, with retry logic for transient errors
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const result = await retryWithBackoff(
                async (attempt) => {
                    const url = `${endpoint}/v1internal:fetchAvailableModels`;
                    const response = await fetch(url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({})
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        const error = new Error(`HTTP ${response.status}: ${errorText}`);
                        // Add status for retry logic
                        error.status = response.status;
                        throw error;
                    }

                    return await response.json();
                },
                {
                    maxAttempts: 3,
                    baseMs: 500,
                    maxMs: 5000,
                    shouldRetry: (error) => {
                        // Don't retry 4xx errors (except 429)
                        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                            return false;
                        }
                        return isRetryableError(error);
                    },
                    onRetry: (error, attempt, backoffMs) => {
                        logger.debug(`[CloudCode] fetchAvailableModels retry ${attempt + 1} at ${endpoint} in ${backoffMs}ms`);
                    }
                }
            );

            return result;
        } catch (error) {
            logger.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
            // Continue to next endpoint
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) return {};

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        // Only include Claude and Gemini models
        if (!isSupportedModel(modelId)) continue;

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                remainingFraction: modelData.quotaInfo.remainingFraction ?? null,
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
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI'
                    }
                })
            });

            if (!response.ok) {
                logger.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                continue;
            }

            const data = await response.json();

            // Extract project ID
            let projectId = null;
            if (typeof data.cloudaicompanionProject === 'string') {
                projectId = data.cloudaicompanionProject;
            } else if (data.cloudaicompanionProject?.id) {
                projectId = data.cloudaicompanionProject.id;
            }

            // Extract subscription tier (priority: paidTier > currentTier)
            let tier = 'free';
            const tierId = data.paidTier?.id || data.currentTier?.id;

            if (tierId) {
                const lowerTier = tierId.toLowerCase();
                if (lowerTier.includes('ultra')) {
                    tier = 'ultra';
                } else if (lowerTier.includes('pro')) {
                    tier = 'pro';
                } else {
                    tier = 'free';
                }
            }

            logger.debug(`[CloudCode] Subscription detected: ${tier}, Project: ${projectId}`);

            return { tier, projectId };
        } catch (error) {
            logger.warn(`[CloudCode] loadCodeAssist failed at ${endpoint}:`, error.message);
        }
    }

    // Fallback: return default values if all endpoints fail
    logger.warn('[CloudCode] Failed to detect subscription tier from all endpoints. Defaulting to free.');
    return { tier: 'free', projectId: null };
}
