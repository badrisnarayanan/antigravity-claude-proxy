/**
 * Base Strategy
 *
 * Abstract base class defining the interface for account selection strategies.
 * All strategies must implement the selectAccount method.
 */

/**
 * @typedef {Object} SelectionResult
 * @property {Object|null} account - The selected account or null if none available
 * @property {number} index - The index of the selected account
 * @property {number} [waitMs] - Optional wait time before account becomes available
 */

export class BaseStrategy {
    /**
     * Create a new BaseStrategy
     * @param {Object} config - Strategy configuration
     */
    constructor(config = {}) {
        if (new.target === BaseStrategy) {
            throw new Error('BaseStrategy is abstract and cannot be instantiated directly');
        }
        this.config = config;
    }

    /**
     * Select an account for a request
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options
     * @param {number} options.currentIndex - Current account index
     * @param {string} [options.sessionId] - Session ID for cache continuity
     * @param {Function} [options.onSave] - Callback to save changes
     * @returns {SelectionResult} The selected account and index
     */
    selectAccount(accounts, modelId, options = {}) {
        throw new Error('selectAccount must be implemented by subclass');
    }

    /**
     * Called after a successful request
     * @param {Object} account - The account that was used
     * @param {string} modelId - The model ID that was used
     * @param {Object} [options] - Additional options including onSave callback
     */
    onSuccess(account, modelId, options = {}) {
        // Default: no-op, override in subclass if needed
    }

    /**
     * Called when a request is rate-limited
     * @param {Object} account - The account that was rate-limited
     * @param {string} modelId - The model ID that was rate-limited
     * @param {Object} [options] - Additional options including onSave callback
     */
    onRateLimit(account, modelId, options = {}) {
        // Default: no-op, override in subclass if needed
    }

    /**
     * Called when a request fails (non-rate-limit error)
     * @param {Object} account - The account that failed
     * @param {string} modelId - The model ID that failed
     * @param {Object} [options] - Additional options including onSave callback
     */
    onFailure(account, modelId, options = {}) {
        // Default: no-op, override in subclass if needed
    }

    /**
     * Check if an account is usable for a specific model
     * @param {Object} account - Account object
     * @param {string} modelId - Model ID to check
     * @returns {boolean} True if account is usable
     */
    isAccountUsable(account, modelId) {
        if (!account || account.isInvalid) return false;

        // Skip disabled accounts
        if (account.enabled === false) return false;

        // Check model-specific rate limit
        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime > Date.now()) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get all usable accounts for a model
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - Model ID to check
     * @returns {Array} Array of usable accounts with their original indices
     */
    getUsableAccounts(accounts, modelId) {
        return accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => this.isAccountUsable(account, modelId));
    }
}

export default BaseStrategy;
