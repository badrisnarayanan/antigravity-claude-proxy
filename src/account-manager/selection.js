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
import { isModelUsable as isModelHealthy } from './health.js';

/**
 * Check if an account is usable for a specific model
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if account is usable
 */
function isAccountUsable(account, modelId) {
    if (!account || account.isInvalid) return false;

    // WebUI: Skip disabled accounts
    if (account.enabled === false) return false;

    // Health check: Skip disabled account×model combinations
    if (modelId && !isModelHealthy(account, modelId)) {
        return false;
    }

    if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
        const limit = account.modelRateLimits[modelId];
        if (limit.isRateLimited && limit.resetTime > Date.now()) {
            return false;
        }
    }

    return true;
}

/**
 * Pick the next available account (fallback when current is unavailable).
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @returns {{account: Object|null, newIndex: number}} The next available account and new index
 */
export function pickNext(accounts, currentIndex, onSave, modelId = null) {
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

        if (isAccountUsable(account, modelId)) {
            account.lastUsed = Date.now();

            const position = idx + 1;
            const total = accounts.length;
            logger.info(`[AccountManager] Using account: ${account.email} (${position}/${total})`);

            // Trigger save (don't await to avoid blocking)
            if (onSave) onSave();

            return { account, newIndex: idx };
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
 * @returns {{account: Object|null, newIndex: number}} The current account and index
 */
export function getCurrentStickyAccount(accounts, currentIndex, onSave, modelId = null) {
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

    if (isAccountUsable(account, modelId)) {
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
 * @returns {{account: Object|null, waitMs: number, newIndex: number}}
 */
export function pickStickyAccount(accounts, currentIndex, onSave, modelId = null) {
    // First try to get the current sticky account
    const { account: stickyAccount, newIndex: stickyIndex } = getCurrentStickyAccount(accounts, currentIndex, onSave, modelId);
    if (stickyAccount) {
        return { account: stickyAccount, waitMs: 0, newIndex: stickyIndex };
    }

    // Current account is rate-limited or invalid.
    // CHECK IF OTHERS ARE AVAILABLE before deciding to wait.
    const available = getAvailableAccounts(accounts, modelId);
    if (available.length > 0) {
        // Found a free account! Switch immediately.
        const { account: nextAccount, newIndex } = pickNext(accounts, currentIndex, onSave, modelId);
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
    const { account: nextAccount, newIndex } = pickNext(accounts, currentIndex, onSave, modelId);
    if (nextAccount) {
        logger.info(`[AccountManager] Switched to new account for cache: ${nextAccount.email}`);
    }
    return { account: nextAccount, waitMs: 0, newIndex };
}
