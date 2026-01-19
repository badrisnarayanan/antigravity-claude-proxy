/**
 * Rate Limit Management
 *
 * Handles rate limit tracking and state management for accounts.
 * All rate limits are model-specific.
 */

import { DEFAULT_COOLDOWN_MS } from '../constants.js';
import { formatDuration } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * Check if all accounts are rate-limited for a specific model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check rate limits for
 * @returns {boolean} True if all accounts are rate-limited
 */
export function isAllRateLimited(accounts, modelId) {
    if (accounts.length === 0) return true;
    if (!modelId) return false; // No model specified = not rate limited

    return accounts.every(acc => {
        if (acc.isInvalid) return true; // Invalid accounts count as unavailable
        if (acc.enabled === false) return true; // Disabled accounts count as unavailable
        const modelLimits = acc.modelRateLimits || {};
        const limit = modelLimits[modelId];
        return limit && limit.isRateLimited && limit.resetTime > Date.now();
    });
}

/**
 * Get list of available (non-rate-limited, non-invalid) accounts for a model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} [modelId] - Model ID to filter by
 * @returns {Array} Array of available account objects
 */
export function getAvailableAccounts(accounts, modelId = null) {
    return accounts.filter(acc => {
        if (acc.isInvalid) return false;

        // WebUI: Skip disabled accounts
        if (acc.enabled === false) return false;

        if (modelId && acc.modelRateLimits && acc.modelRateLimits[modelId]) {
            const limit = acc.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime > Date.now()) {
                return false;
            }
        }

        return true;
    });
}

/**
 * Get list of invalid accounts
 *
 * @param {Array} accounts - Array of account objects
 * @returns {Array} Array of invalid account objects
 */
export function getInvalidAccounts(accounts) {
    return accounts.filter(acc => acc.isInvalid);
}

/**
 * Clear expired rate limits
 *
 * @param {Array} accounts - Array of account objects
 * @returns {number} Number of rate limits cleared
 */
export function clearExpiredLimits(accounts) {
    const now = Date.now();
    let cleared = 0;

    for (const account of accounts) {
        if (account.modelRateLimits) {
            for (const [modelId, limit] of Object.entries(account.modelRateLimits)) {
                if (limit.isRateLimited && limit.resetTime <= now) {
                    limit.isRateLimited = false;
                    limit.resetTime = null;
                    cleared++;
                    logger.success(`[AccountManager] Rate limit expired for: ${account.email} (model: ${modelId})`);
                }
            }
        }
    }

    return cleared;
}

/**
 * Clear all rate limits to force a fresh check (optimistic retry strategy)
 *
 * @param {Array} accounts - Array of account objects
 */
export function resetAllRateLimits(accounts) {
    for (const account of accounts) {
        if (account.modelRateLimits) {
            for (const key of Object.keys(account.modelRateLimits)) {
                account.modelRateLimits[key] = { isRateLimited: false, resetTime: null };
            }
        }
    }
    logger.warn('[AccountManager] Reset all rate limits for optimistic retry');
}

/**
 * Mark an account as rate-limited for a specific model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {number|null} resetMs - Time in ms until rate limit resets (from API)
 * @param {string} modelId - Model ID to mark rate limit for
 * @returns {boolean} True if account was found and marked
 */
export function markRateLimited(accounts, email, resetMs = null, modelId) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    // Store the ACTUAL reset time from the API
    // This is used to decide whether to wait (short) or switch accounts (long)
    const actualResetMs = (resetMs && resetMs > 0) ? resetMs : DEFAULT_COOLDOWN_MS;

    if (!account.modelRateLimits) {
        account.modelRateLimits = {};
    }

    account.modelRateLimits[modelId] = {
        isRateLimited: true,
        resetTime: Date.now() + actualResetMs,  // Actual reset time for decisions
        actualResetMs: actualResetMs             // Original duration from API
    };

    // Log appropriately based on duration
    if (actualResetMs > DEFAULT_COOLDOWN_MS) {
        logger.warn(
            `[AccountManager] Quota exhausted: ${email} (model: ${modelId}). Resets in ${formatDuration(actualResetMs)}`
        );
    } else {
        logger.warn(
            `[AccountManager] Rate limited: ${email} (model: ${modelId}). Available in ${formatDuration(actualResetMs)}`
        );
    }

    return true;
}

/**
 * Mark an account as invalid (credentials need re-authentication)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {string} reason - Reason for marking as invalid
 * @returns {boolean} True if account was found and marked
 */
export function markInvalid(accounts, email, reason = 'Unknown error') {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    account.isInvalid = true;
    account.invalidReason = reason;
    account.invalidAt = Date.now();

    logger.error(
        `[AccountManager] ⚠ Account INVALID: ${email}`
    );
    logger.error(
        `[AccountManager]   Reason: ${reason}`
    );
    logger.error(
        `[AccountManager]   Run 'npm run accounts' to re-authenticate this account`
    );

    return true;
}

/**
 * Get the minimum wait time until any account becomes available for a model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check
 * @returns {number} Wait time in milliseconds
 */
export function getMinWaitTimeMs(accounts, modelId) {
    if (!isAllRateLimited(accounts, modelId)) return 0;

    const now = Date.now();
    let minWait = Infinity;
    let soonestAccount = null;

    for (const account of accounts) {
        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime) {
                const wait = limit.resetTime - now;
                if (wait > 0 && wait < minWait) {
                    minWait = wait;
                    soonestAccount = account;
                }
            }
        }
    }

    if (soonestAccount) {
        logger.info(`[AccountManager] Shortest wait: ${formatDuration(minWait)} (account: ${soonestAccount.email})`);
    }

    return minWait === Infinity ? DEFAULT_COOLDOWN_MS : minWait;
}

/**
 * Get the rate limit info for a specific account and model
 * Returns the actual reset time from API, not capped
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @param {string} modelId - Model ID to check
 * @returns {{isRateLimited: boolean, actualResetMs: number|null, waitMs: number}} Rate limit info
 */
export function getRateLimitInfo(accounts, email, modelId) {
    const account = accounts.find(a => a.email === email);
    if (!account || !account.modelRateLimits || !account.modelRateLimits[modelId]) {
        return { isRateLimited: false, actualResetMs: null, waitMs: 0 };
    }

    const limit = account.modelRateLimits[modelId];
    const now = Date.now();
    const waitMs = limit.resetTime ? Math.max(0, limit.resetTime - now) : 0;

    return {
        isRateLimited: limit.isRateLimited && waitMs > 0,
        actualResetMs: limit.actualResetMs || null,
        waitMs
    };
}
