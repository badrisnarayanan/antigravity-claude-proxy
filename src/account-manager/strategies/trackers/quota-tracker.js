/**
 * Quota Tracker
 *
 * Tracks per-account quota levels to prioritize accounts with available quota.
 * Uses quota data from account.quota.models[modelId].remainingFraction.
 * Accounts below critical threshold are excluded from selection.
 */

// Default configuration
const DEFAULT_CONFIG = {
    lowThreshold: 0.10,       // 10% - reduce score
    criticalThreshold: 0.05,  // 5% - exclude from candidates
    staleMs: 300000,          // 5 min - max age of quota data to trust
    unknownScore: 50          // Score for accounts with unknown quota
};

export class QuotaTracker {
    #config;

    /**
     * Create a new QuotaTracker
     * @param {Object} config - Quota tracker configuration
     */
    constructor(config = {}) {
        this.#config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Get the quota fraction for an account and model
     * @param {Object} account - Account object
     * @param {string} modelId - Model ID to check
     * @returns {number|null} Remaining fraction (0-1) or null if unknown
     */
    getQuotaFraction(account, modelId) {
        if (!account?.quota?.models?.[modelId]) return null;
        const fraction = account.quota.models[modelId].remainingFraction;
        return typeof fraction === 'number' ? fraction : null;
    }

    /**
     * Check if quota data is fresh enough to be trusted
     * @param {Object} account - Account object
     * @returns {boolean} True if quota data is fresh
     */
    isQuotaFresh(account) {
        if (!account?.quota?.lastChecked) return false;
        return (Date.now() - account.quota.lastChecked) < this.#config.staleMs;
    }

    /**
     * Check if an account has critically low quota for a model
     * @param {Object} account - Account object
     * @param {string} modelId - Model ID to check
     * @param {number} [thresholdOverride] - Optional threshold to use instead of default criticalThreshold
     * @returns {boolean} True if quota is at or below critical threshold
     */
    isQuotaCritical(account, modelId, thresholdOverride) {
        const fraction = this.getQuotaFraction(account, modelId);
        // Unknown quota = not critical (assume OK)
        if (fraction === null) return false;
        // Only apply critical check if data is fresh
        if (!this.isQuotaFresh(account)) return false;
        const threshold = (typeof thresholdOverride === 'number' && thresholdOverride > 0)
            ? thresholdOverride
            : this.#config.criticalThreshold;
        return fraction <= threshold;
    }

    /**
     * Check if an account has low (but not critical) quota for a model
     * @param {Object} account - Account object
     * @param {string} modelId - Model ID to check
     * @returns {boolean} True if quota is below low threshold but above critical
     */
    isQuotaLow(account, modelId) {
        const fraction = this.getQuotaFraction(account, modelId);
        if (fraction === null) return false;
        return fraction <= this.#config.lowThreshold && fraction > this.#config.criticalThreshold;
    }

    /**
     * Get a score (0-100) for an account based on quota
     * Higher score = more quota available
     * @param {Object} account - Account object
     * @param {string} modelId - Model ID to check
     * @returns {number} Score from 0-100
     */
    getScore(account, modelId) {
        const fraction = this.getQuotaFraction(account, modelId);

        // Unknown quota = middle score
        if (fraction === null) {
            return this.#config.unknownScore;
        }

        // Convert fraction (0-1) to score (0-100)
        let score = fraction * 100;

        // Apply small penalty for stale data (reduce confidence)
        if (!this.isQuotaFresh(account)) {
            score *= 0.9; // 10% penalty for stale data
        }

        return score;
    }

    /**
     * Get the critical threshold
     * @returns {number} Critical threshold (0-1)
     */
    getCriticalThreshold() {
        return this.#config.criticalThreshold;
    }

    /**
     * Get the low threshold
     * @returns {number} Low threshold (0-1)
     */
    getLowThreshold() {
        return this.#config.lowThreshold;
    }
}

export default QuotaTracker;
