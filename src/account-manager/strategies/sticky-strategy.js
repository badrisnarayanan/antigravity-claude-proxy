/**
 * Sticky Strategy
 *
 * Keeps using the same account until it becomes unavailable (rate-limited or invalid).
 * Best for prompt caching as it maintains cache continuity across requests.
 */

import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';
import { formatDuration } from '../../utils/helpers.js';
import { getModelFamily, MAX_WAIT_BEFORE_ERROR_MS } from '../../constants.js';

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
        const { currentIndex = 0, activeIndexByFamily = {}, onSave, onUpdateFamilyIndex } = options;

        if (accounts.length === 0) {
            return { account: null, index: currentIndex, waitMs: 0 };
        }

        // Determine which index to use based on model family
        const family = getModelFamily(modelId);
        let targetIndex;

        if ((family === 'claude' || family === 'gemini') && activeIndexByFamily[family] !== null && activeIndexByFamily[family] !== undefined) {
            // Use family-specific pinned index
            targetIndex = activeIndexByFamily[family];
        } else {
            // Fall back to global index for unknown families or unpinned
            targetIndex = currentIndex;
        }

        // Clamp index to valid range
        let index = targetIndex >= accounts.length ? 0 : targetIndex;
        const currentAccount = accounts[index];

        // Check if current account is usable
        if (this.isAccountUsable(currentAccount, modelId)) {
            currentAccount.lastUsed = Date.now();
            if (onSave) onSave();
            return { account: currentAccount, index, waitMs: 0 };
        }

        // Current account is not usable - find best alternative
        const bestAlternative = this.#findBestAlternative(accounts, modelId, index);

        if (bestAlternative) {
            bestAlternative.account.lastUsed = Date.now();
            if (onSave) onSave();

            // Update the family-specific index
            if ((family === 'claude' || family === 'gemini') && onUpdateFamilyIndex) {
                onUpdateFamilyIndex(family, bestAlternative.index);
                logger.info(`[StickyStrategy] Auto-switched ${family} sticky: ${currentAccount.email} → ${bestAlternative.account.email}`);
            }

            return { account: bestAlternative.account, index: bestAlternative.index, waitMs: 0 };
        }

        // No alternatives - check if we should wait for current
        const waitInfo = this.#shouldWaitForAccount(currentAccount, modelId);
        if (waitInfo.shouldWait) {
            logger.info(`[StickyStrategy] Waiting ${formatDuration(waitInfo.waitMs)} for sticky account: ${currentAccount.email}`);
            return { account: null, index, waitMs: waitInfo.waitMs };
        }

        return { account: null, index, waitMs: 0 };
    }

    /**
     * Find the best alternative account based on quota and cooldown
     * @private
     * @param {Array} accounts - All accounts
     * @param {string} modelId - Model ID
     * @param {number} excludeIndex - Index to exclude (current stuck account)
     * @returns {{account: Object, index: number}|null}
     */
    #findBestAlternative(accounts, modelId, excludeIndex) {
        const candidates = [];

        for (let i = 0; i < accounts.length; i++) {
            if (i === excludeIndex) continue;

            const account = accounts[i];
            if (!this.isAccountUsable(account, modelId)) continue;

            // Calculate score: higher quota + shorter cooldown = better
            const quota = this.#getAccountQuota(account, modelId);
            const cooldownMs = this.#getCooldownRemaining(account, modelId);

            candidates.push({
                account,
                index: i,
                quota,
                cooldownMs
            });
        }

        if (candidates.length === 0) return null;

        // Sort by: highest quota first, then shortest cooldown
        candidates.sort((a, b) => {
            if (b.quota !== a.quota) return b.quota - a.quota;
            return a.cooldownMs - b.cooldownMs;
        });

        return candidates[0];
    }

    /**
     * Get quota fraction for an account/model
     * @private
     */
    #getAccountQuota(account, modelId) {
        if (!account.quota?.models?.[modelId]) return 0;
        return account.quota.models[modelId].remainingFraction || 0;
    }

    /**
     * Get cooldown remaining in ms
     * @private
     */
    #getCooldownRemaining(account, modelId) {
        if (!account.modelRateLimits?.[modelId]) return 0;
        const limit = account.modelRateLimits[modelId];
        if (!limit.isRateLimited || !limit.resetTime) return 0;
        return Math.max(0, limit.resetTime - Date.now());
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
