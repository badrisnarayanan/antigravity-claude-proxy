/**
 * Account Selection
 *
 * Handles account picking logic (round-robin, sticky) for cache continuity.
 * All rate limit checks are model-specific.
 */

import { MAX_WAIT_BEFORE_ERROR_MS } from '../constants.js';
import { formatDuration } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { clearExpiredLimits, getAvailableAccounts } from './rate-limits.js';

/**
 * Get the effective quota threshold for an account and model.
 * Priority: per-model > per-account > global > 0
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID
 * @param {Object} globalConfig - Global config object with quotaThreshold
 * @returns {number} Effective threshold (0-1)
 */
export function getEffectiveThreshold(account, modelId, globalConfig = null) {
    // Priority 1: Per-model threshold
    if (modelId && account.modelQuotaThresholds?.[modelId] !== undefined) {
        return account.modelQuotaThresholds[modelId];
    }

    // Priority 2: Per-account threshold
    if (account.quotaThreshold !== undefined) {
        return account.quotaThreshold;
    }

    // Priority 3: Global threshold
    return globalConfig?.quotaThreshold || 0;
}

/**
 * Check if an account is below quota threshold for a specific model.
 * Implements fail-open strategy: if quota data is missing/stale, allow the account.
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID to check
 * @param {Object} globalConfig - Global config object
 * @returns {{belowThreshold: boolean, remaining: number|null, threshold: number}}
 */
function checkQuotaThreshold(account, modelId, globalConfig) {
    const threshold = getEffectiveThreshold(account, modelId, globalConfig);

    // No threshold configured, always allow
    if (threshold <= 0) {
        return { belowThreshold: false, remaining: null, threshold: 0 };
    }

    // Get remaining quota for this model
    const remaining = account.quota?.models?.[modelId]?.remainingFraction;

    // Fail-open: if no quota data, allow the account (better to try than block with stale data)
    if (remaining === null || remaining === undefined) {
        return { belowThreshold: false, remaining: null, threshold };
    }

    // Check if below threshold
    const belowThreshold = remaining < threshold;
    return { belowThreshold, remaining, threshold };
}

/**
 * Check if an account is usable for a specific model
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID to check
 * @param {Object} globalConfig - Global config object for quota threshold
 * @returns {boolean} True if account is usable
 */
function isAccountUsable(account, modelId, globalConfig = null) {
    if (!account || account.isInvalid) return false;

    // WebUI: Skip disabled accounts
    if (account.enabled === false) return false;

    if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
        const limit = account.modelRateLimits[modelId];
        if (limit.isRateLimited && limit.resetTime > Date.now()) {
            return false;
        }
    }

    // Quota threshold check
    if (modelId && globalConfig) {
        const { belowThreshold, remaining, threshold } = checkQuotaThreshold(account, modelId, globalConfig);
        if (belowThreshold) {
            logger.debug(`[AccountManager] Skipping ${account.email} for ${modelId}: quota ${Math.round(remaining * 100)}% < threshold ${Math.round(threshold * 100)}%`);
            return false;
        }
    }

    return true;
}

/**
 * Find the account with highest remaining quota for a model.
 * Used as fallback when all accounts are below threshold.
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check
 * @returns {{account: Object|null, index: number, remaining: number}}
 */
function findHighestQuotaAccount(accounts, modelId) {
    let best = { account: null, index: -1, remaining: -1 };

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        // Skip invalid, disabled, or rate-limited accounts
        if (!account || account.isInvalid || account.enabled === false) continue;
        if (modelId && account.modelRateLimits?.[modelId]?.isRateLimited &&
            account.modelRateLimits[modelId].resetTime > Date.now()) {
            continue;
        }

        const remaining = account.quota?.models?.[modelId]?.remainingFraction ?? -1;
        if (remaining > best.remaining) {
            best = { account, index: i, remaining };
        }
    }

    return best;
}

/**
 * Pick the next available account (fallback when current is unavailable).
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @param {Object} [globalConfig] - Global config object for quota threshold
 * @returns {{account: Object|null, newIndex: number}} The next available account and new index
 */
export function pickNext(accounts, currentIndex, onSave, modelId = null, globalConfig = null) {
    clearExpiredLimits(accounts);

    const available = getAvailableAccounts(accounts, modelId);
    if (available.length === 0) {
        return { account: null, newIndex: currentIndex };
    }

    // Clamp index to valid range
    let index = currentIndex;
    if (index >= accounts.length) {
        index = 0;
    }

    // Find next available account starting from index AFTER current
    for (let i = 1; i <= accounts.length; i++) {
        const idx = (index + i) % accounts.length;
        const account = accounts[idx];

        if (isAccountUsable(account, modelId, globalConfig)) {
            account.lastUsed = Date.now();

            const position = idx + 1;
            const total = accounts.length;
            logger.info(`[AccountManager] Using account: ${account.email} (${position}/${total})`);

            // Trigger save (don't await to avoid blocking)
            if (onSave) onSave();

            return { account, newIndex: idx };
        }
    }

    // All accounts are below threshold - fallback to highest remaining quota
    if (modelId && globalConfig?.quotaThreshold > 0) {
        const { account: fallbackAccount, index: fallbackIdx, remaining } = findHighestQuotaAccount(accounts, modelId);
        if (fallbackAccount) {
            logger.warn(`[AccountManager] All accounts below ${Math.round(globalConfig.quotaThreshold * 100)}% threshold for ${modelId}. Using ${fallbackAccount.email} with ${remaining >= 0 ? Math.round(remaining * 100) + '%' : 'unknown'} quota.`);
            fallbackAccount.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: fallbackAccount, newIndex: fallbackIdx };
        }
    }

    return { account: null, newIndex: currentIndex };
}

/**
 * Get the current account without advancing the index (sticky selection).
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @param {Object} [globalConfig] - Global config object for quota threshold
 * @returns {{account: Object|null, newIndex: number}} The current account and index
 */
export function getCurrentStickyAccount(accounts, currentIndex, onSave, modelId = null, globalConfig = null) {
    clearExpiredLimits(accounts);

    if (accounts.length === 0) {
        return { account: null, newIndex: currentIndex };
    }

    // Clamp index to valid range
    let index = currentIndex;
    if (index >= accounts.length) {
        index = 0;
    }

    // Get current account directly (activeIndex = current account)
    const account = accounts[index];

    if (isAccountUsable(account, modelId, globalConfig)) {
        account.lastUsed = Date.now();
        // Trigger save (don't await to avoid blocking)
        if (onSave) onSave();
        return { account, newIndex: index };
    }

    return { account: null, newIndex: index };
}

/**
 * Check if we should wait for the current account's rate limit to reset.
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {string} [modelId] - Model ID to check rate limits for
 * @returns {{shouldWait: boolean, waitMs: number, account: Object|null}}
 */
export function shouldWaitForCurrentAccount(accounts, currentIndex, modelId = null) {
    if (accounts.length === 0) {
        return { shouldWait: false, waitMs: 0, account: null };
    }

    // Clamp index to valid range
    let index = currentIndex;
    if (index >= accounts.length) {
        index = 0;
    }

    // Get current account directly (activeIndex = current account)
    const account = accounts[index];

    if (!account || account.isInvalid) {
        return { shouldWait: false, waitMs: 0, account: null };
    }

    let waitMs = 0;

    // Check model-specific limit
    if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
        const limit = account.modelRateLimits[modelId];
        if (limit.isRateLimited && limit.resetTime) {
            waitMs = limit.resetTime - Date.now();
        }
    }

    // If wait time is within threshold, recommend waiting
    if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
        return { shouldWait: true, waitMs, account };
    }

    return { shouldWait: false, waitMs: 0, account };
}

/**
 * Pick an account with sticky selection preference.
 * Prefers the current account for cache continuity.
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @param {Object} [globalConfig] - Global config object for quota threshold
 * @returns {{account: Object|null, waitMs: number, newIndex: number}}
 */
export function pickStickyAccount(accounts, currentIndex, onSave, modelId = null, globalConfig = null) {
    // First try to get the current sticky account
    const { account: stickyAccount, newIndex: stickyIndex } = getCurrentStickyAccount(accounts, currentIndex, onSave, modelId, globalConfig);
    if (stickyAccount) {
        return { account: stickyAccount, waitMs: 0, newIndex: stickyIndex };
    }

    // Current account is rate-limited, below threshold, or invalid.
    // CHECK IF OTHERS ARE AVAILABLE before deciding to wait.
    const available = getAvailableAccounts(accounts, modelId);
    if (available.length > 0) {
        // Found a free account! Switch immediately.
        const { account: nextAccount, newIndex } = pickNext(accounts, currentIndex, onSave, modelId, globalConfig);
        if (nextAccount) {
            logger.info(`[AccountManager] Switched to new account (failover): ${nextAccount.email}`);
            return { account: nextAccount, waitMs: 0, newIndex };
        }
    }

    // No other accounts available. Now checking if we should wait for current account.
    const waitInfo = shouldWaitForCurrentAccount(accounts, currentIndex, modelId);
    if (waitInfo.shouldWait) {
        logger.info(`[AccountManager] Waiting ${formatDuration(waitInfo.waitMs)} for sticky account: ${waitInfo.account.email}`);
        return { account: null, waitMs: waitInfo.waitMs, newIndex: currentIndex };
    }

    // Current account unavailable for too long/invalid, and no others available?
    const { account: nextAccount, newIndex } = pickNext(accounts, currentIndex, onSave, modelId, globalConfig);
    if (nextAccount) {
        logger.info(`[AccountManager] Switched to new account for cache: ${nextAccount.email}`);
    }
    return { account: nextAccount, waitMs: 0, newIndex };
}
