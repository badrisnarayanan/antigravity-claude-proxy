/**
 * Hybrid Strategy
 *
 * Smart selection based on health score, token bucket, quota, and LRU freshness.
 * Combines multiple signals for optimal account distribution.
 *
 * Scoring formula:
 *   score = (Health × 2) + ((Tokens / MaxTokens × 100) × 5) + (Quota × 3) + (LRU × 0.1)
 *
 * Filters accounts that are:
 * - Not rate-limited
 * - Not invalid or disabled
 * - Health score >= minUsable
 * - Has tokens available
 * - Quota not critically low (< 5%)
 */

import { BaseStrategy } from './base-strategy.js';
import { HealthTracker, TokenBucketTracker, QuotaTracker } from './trackers/index.js';
import { logger } from '../../utils/logger.js';

// Default weights for scoring
const DEFAULT_WEIGHTS = {
    health: 2,
    tokens: 5,
    quota: 3,
    lru: 0.1
};

export class HybridStrategy extends BaseStrategy {
    #healthTracker;
    #tokenBucketTracker;
    #quotaTracker;
    #weights;

    /**
     * Create a new HybridStrategy
     * @param {Object} config - Strategy configuration
     * @param {Object} [config.healthScore] - Health tracker configuration
     * @param {Object} [config.tokenBucket] - Token bucket configuration
     * @param {Object} [config.quota] - Quota tracker configuration
     * @param {Object} [config.weights] - Scoring weights
     */
    constructor(config = {}) {
        super(config);
        this.#healthTracker = new HealthTracker(config.healthScore || {});
        this.#tokenBucketTracker = new TokenBucketTracker(config.tokenBucket || {});
        this.#quotaTracker = new QuotaTracker(config.quota || {});
        this.#weights = { ...DEFAULT_WEIGHTS, ...config.weights };
    }

    /**
     * Select an account based on combined health, tokens, and LRU score
     *
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options
     * @returns {SelectionResult} The selected account and index
     */
    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        // Get candidates that pass all filters
        const candidates = this.#getCandidates(accounts, modelId);

        if (candidates.length === 0) {
            logger.debug('[HybridStrategy] No candidates available');
            return { account: null, index: 0, waitMs: 0 };
        }

        // Score and sort candidates
        const scored = candidates.map(({ account, index }) => ({
            account,
            index,
            score: this.#calculateScore(account, modelId)
        }));

        scored.sort((a, b) => b.score - a.score);

        // Select the best candidate
        const best = scored[0];
        best.account.lastUsed = Date.now();

        // Consume a token from the bucket
        this.#tokenBucketTracker.consume(best.account.email);

        if (onSave) onSave();

        const position = best.index + 1;
        const total = accounts.length;
        logger.info(`[HybridStrategy] Using account: ${best.account.email} (${position}/${total}, score: ${best.score.toFixed(1)})`);

        return { account: best.account, index: best.index, waitMs: 0 };
    }

    /**
     * Called after a successful request
     */
    onSuccess(account, modelId) {
        if (account && account.email) {
            this.#healthTracker.recordSuccess(account.email);
        }
    }

    /**
     * Called when a request is rate-limited
     */
    onRateLimit(account, modelId) {
        if (account && account.email) {
            this.#healthTracker.recordRateLimit(account.email);
        }
    }

    /**
     * Called when a request fails
     */
    onFailure(account, modelId) {
        if (account && account.email) {
            this.#healthTracker.recordFailure(account.email);
            // Refund the token since the request didn't complete
            this.#tokenBucketTracker.refund(account.email);
        }
    }

    /**
     * Get candidates that pass all filters
     * @private
     */
    #getCandidates(accounts, modelId) {
        const candidates = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                // Basic usability check
                if (!this.isAccountUsable(account, modelId)) {
                    return false;
                }

                // Health score check
                if (!this.#healthTracker.isUsable(account.email)) {
                    return false;
                }

                // Token availability check
                if (!this.#tokenBucketTracker.hasTokens(account.email)) {
                    return false;
                }

                // Quota availability check (exclude critically low quota)
                if (this.#quotaTracker.isQuotaCritical(account, modelId)) {
                    logger.debug(`[HybridStrategy] Excluding ${account.email}: quota critically low for ${modelId}`);
                    return false;
                }

                return true;
            });

        // If no candidates after quota filter, fall back to all usable accounts
        // (better to use critical quota than fail entirely)
        if (candidates.length === 0) {
            const fallback = accounts
                .map((account, index) => ({ account, index }))
                .filter(({ account }) => {
                    if (!this.isAccountUsable(account, modelId)) return false;
                    if (!this.#healthTracker.isUsable(account.email)) return false;
                    if (!this.#tokenBucketTracker.hasTokens(account.email)) return false;
                    return true;
                });
            if (fallback.length > 0) {
                logger.warn('[HybridStrategy] All accounts have critical quota, using fallback');
                return fallback;
            }
        }

        return candidates;
    }

    /**
     * Calculate the combined score for an account
     * @private
     */
    #calculateScore(account, modelId) {
        const email = account.email;

        // Health component (0-100 scaled by weight)
        const health = this.#healthTracker.getScore(email);
        const healthComponent = health * this.#weights.health;

        // Token component (0-100 scaled by weight)
        const tokens = this.#tokenBucketTracker.getTokens(email);
        const maxTokens = this.#tokenBucketTracker.getMaxTokens();
        const tokenRatio = tokens / maxTokens;
        const tokenComponent = (tokenRatio * 100) * this.#weights.tokens;

        // Quota component (0-100 scaled by weight)
        const quotaScore = this.#quotaTracker.getScore(account, modelId);
        const quotaComponent = quotaScore * this.#weights.quota;

        // LRU component (older = higher score)
        // Use time since last use, capped at 1 hour for scoring
        const lastUsed = account.lastUsed || 0;
        const timeSinceLastUse = Math.min(Date.now() - lastUsed, 3600000); // Cap at 1 hour
        const lruMinutes = timeSinceLastUse / 60000;
        const lruComponent = lruMinutes * this.#weights.lru;

        return healthComponent + tokenComponent + quotaComponent + lruComponent;
    }

    /**
     * Get the health tracker (for testing/debugging)
     * @returns {HealthTracker} The health tracker instance
     */
    getHealthTracker() {
        return this.#healthTracker;
    }

    /**
     * Get the token bucket tracker (for testing/debugging)
     * @returns {TokenBucketTracker} The token bucket tracker instance
     */
    getTokenBucketTracker() {
        return this.#tokenBucketTracker;
    }

    /**
     * Get the quota tracker (for testing/debugging)
     * @returns {QuotaTracker} The quota tracker instance
     */
    getQuotaTracker() {
        return this.#quotaTracker;
    }
}

export default HybridStrategy;
