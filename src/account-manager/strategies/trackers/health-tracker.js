/**
 * Health Tracker
 *
 * Tracks per-account health scores to prioritize healthy accounts.
 * Scores increase on success and decrease on failures/rate limits.
 * Passive recovery over time helps accounts recover from temporary issues.
 */

// Default configuration (matches opencode-antigravity-auth)
const DEFAULT_CONFIG = {
    initial: 70,           // Starting score for new accounts
    successReward: 1,      // Points on successful request
    rateLimitPenalty: -10, // Points on rate limit
    failurePenalty: -20,   // Points on other failures
    recoveryPerHour: 10,   // Passive recovery rate (increased from 2 for faster recovery)
    minUsable: 50,         // Minimum score to be selected
    maxScore: 100          // Maximum score cap
};

export class HealthTracker {
    #scores = new Map(); // email -> { score, lastUpdated, consecutiveFailures }
    #config;

    /**
     * Create a new HealthTracker
     * @param {Object} config - Health score configuration
     */
    constructor(config = {}) {
        this.#config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Get the health score for an account
     * @param {string} email - Account email
     * @returns {number} Current health score (with passive recovery applied)
     */
    getScore(email) {
        const record = this.#scores.get(email);
        if (!record) {
            return this.#config.initial;
        }

        // Apply passive recovery based on time elapsed
        const now = Date.now();
        const hoursElapsed = (now - record.lastUpdated) / (1000 * 60 * 60);
        const recovery = hoursElapsed * this.#config.recoveryPerHour;
        const recoveredScore = Math.min(
            this.#config.maxScore,
            record.score + recovery
        );

        return recoveredScore;
    }

    /**
     * Record a successful request for an account
     * @param {string} email - Account email
     */
    recordSuccess(email) {
        const currentScore = this.getScore(email);
        const newScore = Math.min(
            this.#config.maxScore,
            currentScore + this.#config.successReward
        );
        this.#scores.set(email, {
            score: newScore,
            lastUpdated: Date.now(),
            consecutiveFailures: 0 // Reset on success
        });
    }

    /**
     * Record a rate limit for an account
     * @param {string} email - Account email
     */
    recordRateLimit(email) {
        const record = this.#scores.get(email);
        const currentScore = this.getScore(email);
        const newScore = Math.max(
            0,
            currentScore + this.#config.rateLimitPenalty
        );
        this.#scores.set(email, {
            score: newScore,
            lastUpdated: Date.now(),
            consecutiveFailures: (record?.consecutiveFailures ?? 0) + 1
        });
    }

    /**
     * Record a failure for an account
     * @param {string} email - Account email
     */
    recordFailure(email) {
        const record = this.#scores.get(email);
        const currentScore = this.getScore(email);
        const newScore = Math.max(
            0,
            currentScore + this.#config.failurePenalty
        );
        this.#scores.set(email, {
            score: newScore,
            lastUpdated: Date.now(),
            consecutiveFailures: (record?.consecutiveFailures ?? 0) + 1
        });
    }

    /**
     * Check if an account is usable based on health score
     * @param {string} email - Account email
     * @returns {boolean} True if account health score is above minimum threshold
     */
    isUsable(email) {
        return this.getScore(email) >= this.#config.minUsable;
    }

    /**
     * Get the minimum usable score threshold
     * @returns {number} Minimum score for an account to be usable
     */
    getMinUsable() {
        return this.#config.minUsable;
    }

    /**
     * Get the maximum score cap
     * @returns {number} Maximum health score
     */
    getMaxScore() {
        return this.#config.maxScore;
    }

    /**
     * Reset the score for an account (e.g., after re-authentication)
     * @param {string} email - Account email
     */
    reset(email) {
        this.#scores.set(email, {
            score: this.#config.initial,
            lastUpdated: Date.now(),
            consecutiveFailures: 0
        });
    }

    /**
     * Get the consecutive failure count for an account
     * @param {string} email - Account email
     * @returns {number} Number of consecutive failures
     */
    getConsecutiveFailures(email) {
        return this.#scores.get(email)?.consecutiveFailures ?? 0;
    }

    /**
     * Clear all tracked scores
     */
    clear() {
        this.#scores.clear();
    }
}

export default HealthTracker;
