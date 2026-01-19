/**
 * Sticky Strategy
 *
 * Keeps using the same account until it becomes unavailable (rate-limited or invalid).
 * Best for prompt caching as it maintains cache continuity across requests.
 */

import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';
import { formatDuration } from '../../utils/helpers.js';
import { MAX_WAIT_BEFORE_ERROR_MS } from '../../constants.js';

export class StickyStrategy extends BaseStrategy {
    /**
     * Create a new StickyStrategy
     * @param {Object} config - Strategy configuration
     */
    constructor(config = {}) {
        super(config);
    }

    /**
     * Select an account with sticky preference
     * Prefers the current account for cache continuity, only switches when:
     * - Current account is rate-limited for > 2 minutes
     * - Current account is invalid
     * - Current account is disabled
     *
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options
     * @returns {SelectionResult} The selected account and index
     */
    selectAccount(accounts, modelId, options = {}) {
        const { currentIndex = 0, onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        // Clamp index to valid range
        let index = currentIndex >= accounts.length ? 0 : currentIndex;
        const currentAccount = accounts[index];

        // Check if current account is usable
        if (this.isAccountUsable(currentAccount, modelId)) {
            currentAccount.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: currentAccount, index, waitMs: 0 };
        }

        // Current account is not usable - check if others are available
        const usableAccounts = this.getUsableAccounts(accounts, modelId);

        if (usableAccounts.length > 0) {
            // Found a free account - switch immediately
            const { account: nextAccount, index: nextIndex } = this.#pickNext(
                accounts,
                index,
                modelId,
                onSave
            );
            if (nextAccount) {
                logger.info(`[StickyStrategy] Switched to new account (failover): ${nextAccount.email}`);
                return { account: nextAccount, index: nextIndex, waitMs: 0 };
            }
        }

        // No other accounts available - check if we should wait for current
        const waitInfo = this.#shouldWaitForAccount(currentAccount, modelId);
        if (waitInfo.shouldWait) {
            logger.info(`[StickyStrategy] Waiting ${formatDuration(waitInfo.waitMs)} for sticky account: ${currentAccount.email}`);
            return { account: null, index, waitMs: waitInfo.waitMs };
        }

        // Current account unavailable for too long, try to find any other
        const { account: nextAccount, index: nextIndex } = this.#pickNext(
            accounts,
            index,
            modelId,
            onSave
        );

        return { account: nextAccount, index: nextIndex, waitMs: 0 };
    }

    /**
     * Pick the next available account starting from after the current index
     * @private
     */
    #pickNext(accounts, currentIndex, modelId, onSave) {
        for (let i = 1; i <= accounts.length; i++) {
            const idx = (currentIndex + i) % accounts.length;
            const account = accounts[idx];

            if (this.isAccountUsable(account, modelId)) {
                account.lastUsed = Date.now();
                if (onSave) onSave();

                const position = idx + 1;
                const total = accounts.length;
                logger.info(`[StickyStrategy] Using account: ${account.email} (${position}/${total})`);

                return { account, index: idx };
            }
        }

        return { account: null, index: currentIndex };
    }

    /**
     * Check if we should wait for an account's rate limit to reset
     * @private
     */
    #shouldWaitForAccount(account, modelId) {
        if (!account || account.isInvalid || account.enabled === false) {
            return { shouldWait: false, waitMs: 0 };
        }

        let waitMs = 0;

        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime) {
                waitMs = limit.resetTime - Date.now();
            }
        }

        // Wait if within threshold
        if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
            return { shouldWait: true, waitMs };
        }

        return { shouldWait: false, waitMs: 0 };
    }
}

export default StickyStrategy;
