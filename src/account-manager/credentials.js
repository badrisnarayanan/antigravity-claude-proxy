/**
 * Credentials Management
 *
 * Handles OAuth token handling and project discovery.
 */

import {
    ANTIGRAVITY_DB_PATH,
    TOKEN_REFRESH_INTERVAL_MS,
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    DEFAULT_PROJECT_ID
} from '../constants.js';
import { refreshAccessToken } from '../auth/oauth.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';
import { isNetworkError } from '../utils/helpers.js';

// Map to track in-flight token refresh promises to prevent "thundering herd"
const refreshPromises = new Map();

/**
 * Get OAuth token for an account
 *
 * @param {Object} account - Account object with email and credentials
 * @param {Map} tokenCache - Token cache map
 * @param {Function} onInvalid - Callback when account is invalid (email, reason)
 * @param {Function} onSave - Callback to save changes
 * @returns {Promise<string>} OAuth access token
 * @throws {Error} If token refresh fails
 */
export async function getTokenForAccount(account, tokenCache, onInvalid, onSave) {
    // Check cache first
    const cached = tokenCache.get(account.email);
    if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
        return cached.token;
    }

    // Check if there is already an in-flight refresh for this account
    if (refreshPromises.has(account.email)) {
        return refreshPromises.get(account.email);
    }

    const refreshPromise = (async () => {
        try {
            // Get fresh token based on source
            let token;

            if (account.source === 'oauth' && account.refreshToken) {
                // OAuth account - use refresh token to get new access token
                try {
                    const tokens = await refreshAccessToken(account.refreshToken);
                    token = tokens.accessToken;
                    // Clear invalid flag on success
                    if (account.isInvalid) {
                        account.isInvalid = false;
                        account.invalidReason = null;
                        if (onSave) await onSave();
                    }
                    logger.success(`[AccountManager] Refreshed OAuth token for: ${account.email}`);
                } catch (error) {
                    // Check if it's a transient network error
                    if (isNetworkError(error)) {
                        logger.warn(`[AccountManager] Failed to refresh token for ${account.email} due to network error: ${error.message}`);
                        // Do NOT mark as invalid, just throw so caller knows it failed
                        throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
                    }

                    logger.error(`[AccountManager] Failed to refresh token for ${account.email}:`, error.message);
                    // Mark account as invalid (credentials need re-auth)
                    if (onInvalid) onInvalid(account.email, error.message);
                    throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
                }
            } else if (account.source === 'manual' && account.apiKey) {
                token = account.apiKey;
            } else {
                // Extract from database
                const dbPath = account.dbPath || ANTIGRAVITY_DB_PATH;
                const authData = getAuthStatus(dbPath);
                token = authData.apiKey;
            }

            // Cache the token
            tokenCache.set(account.email, {
                token,
                extractedAt: Date.now()
            });

            return token;
        } finally {
            refreshPromises.delete(account.email);
        }
    })();

    refreshPromises.set(account.email, refreshPromise);
    return refreshPromise;
}

/**
 * Get project ID for an account
 *
 * @param {Object} account - Account object
 * @param {string} token - OAuth access token
 * @param {Map} projectCache - Project cache map
 * @returns {Promise<string>} Project ID
 */
export async function getProjectForAccount(account, token, projectCache) {
    // Check cache first
    const cached = projectCache.get(account.email);
    if (cached) {
        return cached;
    }

    // OAuth or manual accounts may have projectId specified
    if (account.projectId) {
        projectCache.set(account.email, account.projectId);
        return account.projectId;
    }

    // Discover project via loadCodeAssist API
    const project = await discoverProject(token);
    projectCache.set(account.email, project);
    return project;
}

/**
 * Discover project ID via Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<string>} Project ID
 */
export async function discoverProject(token) {
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...ANTIGRAVITY_HEADERS
                },
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI'
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[AccountManager] Project discovery failed at ${endpoint}: ${response.status} - ${errorText}`);
                continue;
            }

            const data = await response.json();

            if (typeof data.cloudaicompanionProject === 'string') {
                logger.success(`[AccountManager] Discovered project: ${data.cloudaicompanionProject}`);
                return data.cloudaicompanionProject;
            }
            if (data.cloudaicompanionProject?.id) {
                logger.success(`[AccountManager] Discovered project: ${data.cloudaicompanionProject.id}`);
                return data.cloudaicompanionProject.id;
            }
        } catch (error) {
            logger.warn(`[AccountManager] Project discovery failed at ${endpoint}:`, error.message);
        }
    }

    logger.warn(`[AccountManager] Project discovery failed for all endpoints. Using default project: ${DEFAULT_PROJECT_ID}`);
    logger.warn(`[AccountManager] If you see 404 errors, your account may not have Gemini Code Assist enabled.`);
    return DEFAULT_PROJECT_ID;
}

/**
 * Clear project cache for an account
 *
 * @param {Map} projectCache - Project cache map
 * @param {string|null} email - Email to clear cache for, or null to clear all
 */
export function clearProjectCache(projectCache, email = null) {
    if (email) {
        projectCache.delete(email);
    } else {
        projectCache.clear();
    }
}

/**
 * Clear token cache for an account
 *
 * @param {Map} tokenCache - Token cache map
 * @param {string|null} email - Email to clear cache for, or null to clear all
 */
export function clearTokenCache(tokenCache, email = null) {
    if (email) {
        tokenCache.delete(email);
    } else {
        tokenCache.clear();
    }
}
