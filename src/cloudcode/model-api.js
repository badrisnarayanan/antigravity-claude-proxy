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
    CLIENT_METADATA,
    getModelFamily,
    MODEL_VALIDATION_CACHE_TTL_MS
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { throttledFetch } from '../utils/helpers.js';

// Catalogs are account-specific: rollouts can expose different model IDs.
const modelCache = new WeakMap();

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
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {import('../account-manager/index.js').AccountManager} accountManager
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(accountManager) {
    const { models, incomplete } = await populateModelCache(accountManager);
    if (incomplete && Object.keys(models).length === 0) {
        throw new Error('Failed to fetch available models from all accounts');
    }

    const modelList = Object.entries(models)
        .filter(([modelId]) => !isOldGemini(modelId))
        .map(([modelId, modelData]) => ({
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: getModelFamily(modelId) === 'claude' ? 'anthropic' : 'google',
            description: modelData?.displayName || modelId
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
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
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
 * Get user quota summary for an account
 * Fetches quota summary groups (Gemini and Claude/GPT models with weekly and 5h limits)
 * from the Cloud Code retrieveUserQuotaSummary API.
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<Object|null>} Quota summary containing groups and buckets, or null if unavailable
 */
export async function getUserQuotaSummary(token, projectId = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:retrieveUserQuotaSummary`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[CloudCode] retrieveUserQuotaSummary error at ${endpoint}: ${response.status}`);
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            return await response.json();
        } catch (error) {
            if (error.message?.startsWith('ACCOUNT_BANNED:')) throw error;
            logger.warn(`[CloudCode] retrieveUserQuotaSummary failed at ${endpoint}:`, error.message);
        }
    }

    return null;
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
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: CLIENT_METADATA,
                    mode: 1
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
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

/**
 * Refresh each enabled account's catalog and merge the supported model IDs.
 * Failed discovery remains unknown so validation can still fail open.
 * @param {import('../account-manager/index.js').AccountManager} accountManager
 * @returns {Promise<{models: Object, incomplete: boolean}>}
 */
async function populateModelCache(accountManager) {
    const accounts = accountManager.getAllAccounts().filter(account => account.enabled !== false && !account.isInvalid);
    let incomplete = false;
    const catalogs = await Promise.all(accounts.map(async account => {
        let cache = modelCache.get(account);
        if (!cache) {
            cache = { models: null, lastChecked: 0, failed: false, fetchPromise: null };
            modelCache.set(account, cache);
        }

        // Back off failed discovery without hiding previously discovered models.
        const cacheTtl = cache.failed ? 30000 : MODEL_VALIDATION_CACHE_TTL_MS;
        if (!cache.lastChecked || Date.now() - cache.lastChecked >= cacheTtl) {
            if (!cache.fetchPromise) {
                cache.fetchPromise = (async () => {
                    try {
                        const token = await accountManager.getTokenForAccount(account);
                        const projectId = await accountManager.getProjectForAccount(account, token);
                        const data = await fetchAvailableModels(token, projectId);
                        if (!data?.models || typeof data.models !== 'object' || Array.isArray(data.models)) {
                            throw new Error('Missing model catalog in discovery response');
                        }
                        cache.models = Object.fromEntries(Object.entries(data.models).filter(([modelId]) => isSupportedModel(modelId)));
                        account.availableModels = new Set(Object.keys(cache.models));
                        cache.failed = false;
                    } catch (error) {
                        logger.warn(`[CloudCode] Failed to populate model cache for ${account.email}: ${error.message}`);
                        // Do not exclude an account using a catalog that failed to refresh.
                        cache.failed = true;
                        delete account.availableModels;
                    } finally {
                        cache.lastChecked = Date.now();
                    }
                })().finally(() => { cache.fetchPromise = null; });
            }
            await cache.fetchPromise;
        }
        if (account.enabled === false || account.isInvalid) return {};
        if (cache.failed || cache.models === null) incomplete = true;
        return cache.models;
    }));

    return {
        models: Object.assign({}, ...catalogs.filter(Boolean)),
        incomplete
    };
}

/**
 * Check if a model ID is valid (exists in the available models list)
 * Uses a cached model list with TTL-based refresh
 * @param {string} modelId - Model ID to validate
 * @param {import('../account-manager/index.js').AccountManager} accountManager
 * @returns {Promise<boolean>} True if model is valid
 */
export async function isValidModel(modelId, accountManager) {
    try {
        const { models, incomplete } = await populateModelCache(accountManager);
        // Empty/partial discovery must not reject a model another account may have.
        return Object.hasOwn(models, modelId) || incomplete || accountManager.getAllAccounts().length === 0;
    } catch (error) {
        logger.debug(`[CloudCode] Model validation error: ${error.message}`);
        // Fail open - let the API validate
        return true;
    }
}
