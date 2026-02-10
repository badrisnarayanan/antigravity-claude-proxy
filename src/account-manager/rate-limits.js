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
    if (!modelId) return false; // No model specified = not rate limited

    // Only consider accounts that could become usable again without user action.
    // If there are no such accounts (e.g. all invalid/disabled, or zero accounts),
    // we must NOT treat that as "rate-limited" (waiting would never help).
    const candidates = accounts.filter(acc => !acc.isInvalid && acc.enabled !== false);
    if (candidates.length === 0) return false;

    return candidates.every(acc => {
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

    // Track consecutive failures for progressive backoff (matches opencode-antigravity-auth)
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;

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
        if (account.isInvalid) continue;
        if (account.enabled === false) continue;
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

/**
 * Get the consecutive failure count for an account
 * Used for progressive backoff calculation (matches opencode-antigravity-auth)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @returns {number} Number of consecutive failures
 */
export function getConsecutiveFailures(accounts, email) {
    const account = accounts.find(a => a.email === email);
    return account?.consecutiveFailures || 0;
}

/**
 * Reset the consecutive failure count for an account
 * Called on successful request (matches opencode-antigravity-auth)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @returns {boolean} True if account was found and reset
 */
export function resetConsecutiveFailures(accounts, email) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;
    account.consecutiveFailures = 0;
    return true;
}

/**
 * Increment the consecutive failure count for an account WITHOUT marking as rate limited
 * Used for quick retries where we want to track failures but not skip the account
 * (matches opencode-antigravity-auth behavior of always incrementing on 429)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @returns {number} New consecutive failure count
 */
export function incrementConsecutiveFailures(accounts, email) {
    const account = accounts.find(a => a.email === email);
    if (!account) return 0;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    return account.consecutiveFailures;
}

// ============================================================================
// Cooldown Mechanism (matches opencode-antigravity-auth)
// Separate from rate limits - used for temporary backoff after failures
// ============================================================================

/**
 * Cooldown reasons for debugging/logging
 */
export const CooldownReason = {
    RATE_LIMIT: 'rate_limit',
    AUTH_FAILURE: 'auth_failure',
    CONSECUTIVE_FAILURES: 'consecutive_failures',
    SERVER_ERROR: 'server_error'
};

/**
 * Mark an account as cooling down for a specified duration
 * Used for temporary backoff separate from rate limits
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @param {number} cooldownMs - Duration of cooldown in milliseconds
 * @param {string} [reason] - Reason for the cooldown
 * @returns {boolean} True if account was found and marked
 */
export function markAccountCoolingDown(accounts, email, cooldownMs, reason = CooldownReason.RATE_LIMIT) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    account.coolingDownUntil = Date.now() + cooldownMs;
    account.cooldownReason = reason;

    logger.debug(`[AccountManager] Account ${email} cooling down for ${formatDuration(cooldownMs)} (reason: ${reason})`);
    return true;
}

/**
 * Check if an account is currently cooling down
 * Automatically clears expired cooldowns
 *
 * @param {Object} account - Account object
 * @returns {boolean} True if account is cooling down
 */
export function isAccountCoolingDown(account) {
    if (!account || account.coolingDownUntil === undefined) {
        return false;
    }

    const now = Date.now();
    if (now >= account.coolingDownUntil) {
        // Cooldown expired - clear it
        clearAccountCooldown(account);
        return false;
    }

    return true;
}

/**
 * Clear the cooldown for an account
 *
 * @param {Object} account - Account object
 */
export function clearAccountCooldown(account) {
    if (account) {
        delete account.coolingDownUntil;
        delete account.cooldownReason;
    }
}

/**
 * Get time remaining until cooldown expires for an account
 *
 * @param {Object} account - Account object
 * @returns {number} Milliseconds until cooldown expires, 0 if not cooling down
 */
export function getCooldownRemaining(account) {
    if (!account || account.coolingDownUntil === undefined) {
        return 0;
    }

    const remaining = account.coolingDownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}
