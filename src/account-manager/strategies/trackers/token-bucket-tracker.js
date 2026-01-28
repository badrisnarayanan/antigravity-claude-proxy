/**
 * Token Bucket Tracker
 *
 * Client-side rate limiting using the token bucket algorithm.
 * Each account has a bucket of tokens that regenerate over time.
 * Requests consume tokens; accounts without tokens are deprioritized.
 */

// Default configuration (matches opencode-antigravity-auth)
const DEFAULT_CONFIG = {
    maxTokens: 50,        // Maximum token capacity
    tokensPerMinute: 6,   // Regeneration rate
    initialTokens: 50     // Starting tokens
};

export class TokenBucketTracker {
    #buckets = new Map(); // email -> { tokens, lastUpdated }
    #config;

    /**
     * Create a new TokenBucketTracker
     * @param {Object} config - Token bucket configuration
     */
    constructor(config = {}) {
        this.#config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Get the current token count for an account
     * @param {string} email - Account email
     * @returns {number} Current token count (with regeneration applied)
     */
    getTokens(email) {
        const bucket = this.#buckets.get(email);
        if (!bucket) {
            return this.#config.initialTokens;
        }

        // Apply token regeneration based on time elapsed
        const now = Date.now();
        const minutesElapsed = (now - bucket.lastUpdated) / (1000 * 60);
        const regenerated = minutesElapsed * this.#config.tokensPerMinute;
        const currentTokens = Math.min(
            this.#config.maxTokens,
            bucket.tokens + regenerated
        );

        return currentTokens;
    }

    /**
     * Check if an account has tokens available
     * @param {string} email - Account email
     * @returns {boolean} True if account has at least 1 token
     */
    hasTokens(email) {
        return this.getTokens(email) >= 1;
    }

    /**
     * Consume a token from an account's bucket
     * @param {string} email - Account email
     * @returns {boolean} True if token was consumed, false if no tokens available
     */
    consume(email) {
        const currentTokens = this.getTokens(email);
        if (currentTokens < 1) {
            return false;
        }

        this.#buckets.set(email, {
            tokens: currentTokens - 1,
            lastUpdated: Date.now()
        });
        return true;
    }

    /**
     * Refund a token to an account's bucket (e.g., on request failure before processing)
     * @param {string} email - Account email
     */
    refund(email) {
        const currentTokens = this.getTokens(email);
        const newTokens = Math.min(
            this.#config.maxTokens,
            currentTokens + 1
        );
        this.#buckets.set(email, {
            tokens: newTokens,
            lastUpdated: Date.now()
        });
    }

    /**
     * Get the maximum token capacity
     * @returns {number} Maximum tokens per bucket
     */
    getMaxTokens() {
        return this.#config.maxTokens;
    }

    /**
     * Reset the bucket for an account
     * @param {string} email - Account email
     */
    reset(email) {
        this.#buckets.set(email, {
            tokens: this.#config.initialTokens,
            lastUpdated: Date.now()
        });
    }

    /**
     * Clear all tracked buckets
     */
    clear() {
        this.#buckets.clear();
    }

    /**
     * Get time in milliseconds until next token is available for an account
     * @param {string} email - Account email
     * @returns {number} Milliseconds until next token, 0 if tokens available now
     */
    getTimeUntilNextToken(email) {
        const currentTokens = this.getTokens(email);
        if (currentTokens >= 1) {
            return 0;
        }

        // Calculate time to regenerate 1 token
        const tokensNeeded = 1 - currentTokens;
        const minutesNeeded = tokensNeeded / this.#config.tokensPerMinute;
        return Math.ceil(minutesNeeded * 60 * 1000);
    }

    /**
     * Get the minimum time until any account in the list has a token
     * @param {Array<string>} emails - List of account emails
     * @returns {number} Minimum milliseconds until any account has a token
     */
    getMinTimeUntilToken(emails) {
        if (emails.length === 0) return 0;

        let minWait = Infinity;
        for (const email of emails) {
            const wait = this.getTimeUntilNextToken(email);
            if (wait === 0) return 0;
            minWait = Math.min(minWait, wait);
        }
        return minWait === Infinity ? 0 : minWait;
    }
}

export default TokenBucketTracker;
