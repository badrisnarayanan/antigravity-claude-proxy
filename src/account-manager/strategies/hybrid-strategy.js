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
        const { candidates, fallbackLevel } = this.#getCandidates(accounts, modelId);

        if (candidates.length === 0) {
            // Diagnose why no candidates are available and compute wait time
            const { reason, waitMs } = this.#diagnoseNoCandidates(accounts, modelId);
            logger.warn(`[HybridStrategy] No candidates available: ${reason}`);
            return { account: null, index: 0, waitMs };
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

        // Consume a token from the bucket (unless in lastResort mode where we bypassed token check)
        if (fallbackLevel !== 'lastResort') {
            this.#tokenBucketTracker.consume(best.account.email);
        }

        if (onSave) onSave();

        // Calculate throttle wait time based on fallback level
        // This prevents overwhelming the API when all accounts are stressed
        let waitMs = 0;
        if (fallbackLevel === 'lastResort') {
            // All accounts exhausted - add significant delay to allow rate limits to clear
            waitMs = 500;
        } else if (fallbackLevel === 'emergency') {
            // All accounts unhealthy - add moderate delay
            waitMs = 250;
        }

        const position = best.index + 1;
        const total = accounts.length;
        const fallbackInfo = fallbackLevel !== 'normal' ? `, fallback: ${fallbackLevel}` : '';
        logger.info(`[HybridStrategy] Using account: ${best.account.email} (${position}/${total}, score: ${best.score.toFixed(1)}${fallbackInfo})`);

        return { account: best.account, index: best.index, waitMs };
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
     * @returns {{candidates: Array, fallbackLevel: string}} Candidates and fallback level used
     *   fallbackLevel: 'normal' | 'quota' | 'emergency' | 'lastResort'
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

        if (candidates.length > 0) {
            return { candidates, fallbackLevel: 'normal' };
        }

        // If no candidates after quota filter, fall back to all usable accounts
        // (better to use critical quota than fail entirely)
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
            return { candidates: fallback, fallbackLevel: 'quota' };
        }

        // Emergency fallback: bypass health check when ALL accounts are unhealthy
        // This prevents "Max retries exceeded" when health scores are too low
        const emergency = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                if (!this.isAccountUsable(account, modelId)) return false;
                if (!this.#tokenBucketTracker.hasTokens(account.email)) return false;
                // Skip health check - use "least bad" account
                return true;
            });
        if (emergency.length > 0) {
            logger.warn('[HybridStrategy] EMERGENCY: All accounts unhealthy, using least bad account');
            return { candidates: emergency, fallbackLevel: 'emergency' };
        }

        // Last resort: bypass BOTH health AND token bucket checks
        // Only check basic usability (not rate-limited, not disabled)
        const lastResort = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                // Only check if account is usable (not rate-limited, not disabled)
                if (!this.isAccountUsable(account, modelId)) return false;
                // Skip health and token bucket checks entirely
                return true;
            });
        if (lastResort.length > 0) {
            logger.warn('[HybridStrategy] LAST RESORT: All accounts exhausted, using any usable account');
            return { candidates: lastResort, fallbackLevel: 'lastResort' };
        }

        return { candidates: [], fallbackLevel: 'normal' };
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
        // Use time since last use in seconds, capped at 1 hour (matches opencode-antigravity-auth)
        const lastUsed = account.lastUsed || 0;
        const timeSinceLastUse = Math.min(Date.now() - lastUsed, 3600000); // Cap at 1 hour
        const lruSeconds = timeSinceLastUse / 1000;
        const lruComponent = lruSeconds * this.#weights.lru; // 0-3600 * 0.1 = 0-360 max

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

    /**
     * Diagnose why no candidates are available and compute wait time
     * @private
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID
     * @returns {{reason: string, waitMs: number}} Diagnosis result
     */
    #diagnoseNoCandidates(accounts, modelId) {
        let unusableCount = 0;
        let unhealthyCount = 0;
        let noTokensCount = 0;
        let criticalQuotaCount = 0;
        const accountsWithoutTokens = [];

        for (const account of accounts) {
            if (!this.isAccountUsable(account, modelId)) {
                unusableCount++;
                continue;
            }
            if (!this.#healthTracker.isUsable(account.email)) {
                unhealthyCount++;
                continue;
            }
            if (!this.#tokenBucketTracker.hasTokens(account.email)) {
                noTokensCount++;
                accountsWithoutTokens.push(account.email);
                continue;
            }
            if (this.#quotaTracker.isQuotaCritical(account, modelId)) {
                criticalQuotaCount++;
                continue;
            }
        }

        // If all accounts are blocked by token bucket, calculate wait time
        if (noTokensCount > 0 && unusableCount === 0 && unhealthyCount === 0) {
            const waitMs = this.#tokenBucketTracker.getMinTimeUntilToken(accountsWithoutTokens);
            const reason = `all ${noTokensCount} account(s) exhausted token bucket, waiting for refill`;
            return { reason, waitMs };
        }

        // Build reason string
        const parts = [];
        if (unusableCount > 0) parts.push(`${unusableCount} unusable/disabled`);
        if (unhealthyCount > 0) parts.push(`${unhealthyCount} unhealthy`);
        if (noTokensCount > 0) parts.push(`${noTokensCount} no tokens`);
        if (criticalQuotaCount > 0) parts.push(`${criticalQuotaCount} critical quota`);

        const reason = parts.length > 0 ? parts.join(', ') : 'unknown';
        return { reason, waitMs: 0 };
    }
}

export default HybridStrategy;
