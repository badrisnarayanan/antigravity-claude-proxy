/**
 * Account Manager
 * Manages multiple Antigravity accounts with configurable selection strategies,
 * automatic failover, and smart cooldown for rate-limited accounts.
 */

import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { loadAccounts, loadDefaultAccount, saveAccounts } from './storage.js';
import {
    isAllRateLimited as checkAllRateLimited,
    getAvailableAccounts as getAvailable,
    getInvalidAccounts as getInvalid,
    clearExpiredLimits as clearLimits,
    resetAllRateLimits as resetLimits,
    markRateLimited as markLimited,
    markInvalid as markAccountInvalid,
    getMinWaitTimeMs as getMinWait,
    getRateLimitInfo as getLimitInfo
} from './rate-limits.js';
import {
    getTokenForAccount as fetchToken,
    getProjectForAccount as fetchProject,
    clearProjectCache as clearProject,
    clearTokenCache as clearToken
} from './credentials.js';
import { createStrategy, getStrategyLabel, DEFAULT_STRATEGY } from './strategies/index.js';
import {
    recordResult as recordHealthResult,
    isModelUsable as checkModelUsable,
    toggleModel as toggleModelHealth,
    resetHealth as resetModelHealth,
    getAccountHealth as getAccHealth,
    getModelHealth as getModHealth,
    buildHealthMatrix as buildMatrix,
    getHealthConfig as getHConfig,
    setHealthConfig as setHConfig,
    getHealthSummary as getHSummary,
    checkQuotaThreshold as checkQuota,
    checkAccountQuotas as checkAccQuotas
} from './health.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #initialized = false;
    #strategy = null;
    #strategyName = DEFAULT_STRATEGY;

    // Per-account caches
    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    constructor(configPath = ACCOUNT_CONFIG_PATH, strategyName = null) {
        this.#configPath = configPath;
        // Strategy name can be set at construction or later via initialize
        if (strategyName) {
            this.#strategyName = strategyName;
        }
    }

    /**
     * Initialize the account manager by loading config
     * @param {string} [strategyOverride] - Override strategy name (from CLI flag or env var)
     */
    async initialize(strategyOverride = null) {
        if (this.#initialized) return;

        const { accounts, settings, activeIndex } = await loadAccounts(this.#configPath);

        this.#accounts = accounts;
        this.#settings = settings;
        this.#currentIndex = activeIndex;

        // If config exists but has no accounts, fall back to Antigravity database
        if (this.#accounts.length === 0) {
            logger.warn('[AccountManager] No accounts in config. Falling back to Antigravity database');
            const { accounts: defaultAccounts, tokenCache } = loadDefaultAccount();
            this.#accounts = defaultAccounts;
            this.#tokenCache = tokenCache;
        }

        // Determine strategy: CLI override > env var > config file > default
        const configStrategy = config?.accountSelection?.strategy;
        const envStrategy = process.env.ACCOUNT_STRATEGY;
        this.#strategyName = strategyOverride || envStrategy || configStrategy || this.#strategyName;

        // Create the strategy instance
        const strategyConfig = config?.accountSelection || {};
        this.#strategy = createStrategy(this.#strategyName, strategyConfig);
        logger.info(`[AccountManager] Using ${getStrategyLabel(this.#strategyName)} selection strategy`);

        // Clear any expired rate limits
        this.clearExpiredLimits();

        this.#initialized = true;
    }

    /**
     * Reload accounts from disk (force re-initialization)
     * Useful when accounts.json is modified externally (e.g., by WebUI)
     */
    async reload() {
        this.#initialized = false;
        await this.initialize();
        logger.info('[AccountManager] Accounts reloaded from disk');
    }

    /**
     * Get the number of accounts
     * @returns {number} Number of configured accounts
     */
    getAccountCount() {
        return this.#accounts.length;
    }

    /**
     * Check if all accounts are rate-limited
     * @param {string} [modelId] - Optional model ID
     * @returns {boolean} True if all accounts are rate-limited
     */
    isAllRateLimited(modelId = null) {
        return checkAllRateLimited(this.#accounts, modelId);
    }

    /**
     * Get list of available (non-rate-limited, non-invalid) accounts
     * @param {string} [modelId] - Optional model ID
     * @returns {Array<Object>} Array of available account objects
     */
    getAvailableAccounts(modelId = null) {
        return getAvailable(this.#accounts, modelId);
    }

    /**
     * Get list of invalid accounts
     * @returns {Array<Object>} Array of invalid account objects
     */
    getInvalidAccounts() {
        return getInvalid(this.#accounts);
    }

    /**
     * Clear expired rate limits
     * @returns {number} Number of rate limits cleared
     */
    clearExpiredLimits() {
        const cleared = clearLimits(this.#accounts);
        if (cleared > 0) {
            this.saveToDisk();
        }
        return cleared;
    }

    /**
     * Clear all rate limits to force a fresh check
     * (Optimistic retry strategy)
     * @returns {void}
     */
    resetAllRateLimits() {
        resetLimits(this.#accounts);
    }

    /**
     * Select an account using the configured strategy.
     * This is the main method to use for account selection.
     * @param {string} [modelId] - Model ID for the request
     * @param {Object} [options] - Additional options
     * @param {string} [options.sessionId] - Session ID for cache continuity
     * @returns {{account: Object|null, waitMs: number}} Account to use and optional wait time
     */
    selectAccount(modelId = null, options = {}) {
        if (!this.#strategy) {
            throw new Error('AccountManager not initialized. Call initialize() first.');
        }

        const result = this.#strategy.selectAccount(this.#accounts, modelId, {
            currentIndex: this.#currentIndex,
            onSave: () => this.saveToDisk(),
            ...options
        });

        this.#currentIndex = result.index;
        return { account: result.account, waitMs: result.waitMs || 0 };
    }

    /**
     * Notify the strategy of a successful request
     * @param {Object} account - The account that was used
     * @param {string} modelId - The model ID that was used
     */
    notifySuccess(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onSuccess(account, modelId);
        }
    }

    /**
     * Notify the strategy of a rate limit
     * @param {Object} account - The account that was rate-limited
     * @param {string} modelId - The model ID that was rate-limited
     */
    notifyRateLimit(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onRateLimit(account, modelId);
        }
    }

    /**
     * Notify the strategy of a failure
     * @param {Object} account - The account that failed
     * @param {string} modelId - The model ID that failed
     */
    notifyFailure(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onFailure(account, modelId);
        }
    }

    /**
     * Get the current strategy name
     * @returns {string} Strategy name
     */
    getStrategyName() {
        return this.#strategyName;
    }

    /**
     * Get the strategy display label
     * @returns {string} Strategy display label
     */
    getStrategyLabel() {
        return getStrategyLabel(this.#strategyName);
    }

    /**
     * Get the health tracker from the current strategy (if available)
     * Used by handlers for consecutive failure tracking
     * Only available when using hybrid strategy
     * @returns {Object|null} Health tracker instance or null if not available
     */
    getHealthTracker() {
        if (this.#strategy && typeof this.#strategy.getHealthTracker === 'function') {
            return this.#strategy.getHealthTracker();
        }
        return null;
    }

    /**
     * Mark an account as rate-limited
     * @param {string} email - Email of the account to mark
     * @param {number|null} resetMs - Time in ms until rate limit resets (optional)
     * @param {string} [modelId] - Optional model ID to mark specific limit
     */
    markRateLimited(email, resetMs = null, modelId = null) {
        markLimited(this.#accounts, email, resetMs, modelId);
        this.saveToDisk();
    }

    /**
     * Mark an account as invalid (credentials need re-authentication)
     * @param {string} email - Email of the account to mark
     * @param {string} reason - Reason for marking as invalid
     */
    markInvalid(email, reason = 'Unknown error') {
        markAccountInvalid(this.#accounts, email, reason);
        this.saveToDisk();
    }

    /**
     * Get the minimum wait time until any account becomes available
     * @param {string} [modelId] - Optional model ID
     * @returns {number} Wait time in milliseconds
     */
    getMinWaitTimeMs(modelId = null) {
        return getMinWait(this.#accounts, modelId);
    }

    /**
     * Get rate limit info for a specific account and model
     * @param {string} email - Email of the account
     * @param {string} modelId - Model ID to check
     * @returns {{isRateLimited: boolean, actualResetMs: number|null, waitMs: number}} Rate limit info
     */
    getRateLimitInfo(email, modelId) {
        return getLimitInfo(this.#accounts, email, modelId);
    }

    /**
     * Get OAuth token for an account
     * @param {Object} account - Account object with email and credentials
     * @returns {Promise<string>} OAuth access token
     * @throws {Error} If token refresh fails
     */
    async getTokenForAccount(account) {
        return fetchToken(
            account,
            this.#tokenCache,
            (email, reason) => this.markInvalid(email, reason),
            () => this.saveToDisk()
        );
    }

    /**
     * Get project ID for an account
     * @param {Object} account - Account object
     * @param {string} token - OAuth access token
     * @returns {Promise<string>} Project ID
     */
    async getProjectForAccount(account, token) {
        // Pass onSave callback to persist managedProjectId in refresh token
        return fetchProject(account, token, this.#projectCache, () => this.saveToDisk());
    }

    /**
     * Clear project cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearProjectCache(email = null) {
        clearProject(this.#projectCache, email);
    }

    /**
     * Clear token cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearTokenCache(email = null) {
        clearToken(this.#tokenCache, email);
    }

    /**
     * Save current state to disk (async)
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        await saveAccounts(this.#configPath, this.#accounts, this.#settings, this.#currentIndex);
    }

    /**
     * Get status object for logging/API
     * @returns {{accounts: Array, settings: Object}} Status object with accounts and settings
     */
    getStatus() {
        const available = this.getAvailableAccounts();
        const invalid = this.getInvalidAccounts();

        // Count accounts that have any active model-specific rate limits
        const rateLimited = this.#accounts.filter(a => {
            if (!a.modelRateLimits) return false;
            return Object.values(a.modelRateLimits).some(
                limit => limit.isRateLimited && limit.resetTime > Date.now()
            );
        });

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            invalid: invalid.length,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => ({
                email: a.email,
                source: a.source,
                enabled: a.enabled !== false,  // Default to true if undefined
                projectId: a.projectId || null,
                modelRateLimits: a.modelRateLimits || {},
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                lastUsed: a.lastUsed
            }))
        };
    }

    /**
     * Get settings
     * @returns {Object} Current settings object
     */
    getSettings() {
        return { ...this.#settings };
    }

    /**
     * Get all accounts (internal use for quota fetching)
     * Returns the full account objects including credentials
     * @returns {Array<Object>} Array of account objects
     */
    getAllAccounts() {
        return this.#accounts;
    }

    // ==================== Health Management ====================

    /**
     * Record the result of a request for health tracking
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @param {boolean} success - Whether the request was successful
     * @param {Object|null} error - Error object if failed
     * @returns {Object|null} Updated health object
     */
    recordHealth(email, modelId, success, error = null) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return null;
        const result = recordHealthResult(account, modelId, success, error);
        this.saveToDisk();
        return result;
    }

    /**
     * Check if a model is usable for an account (not disabled by health)
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @returns {boolean} True if model is usable
     */
    isModelHealthy(email, modelId) {
        const account = this.#accounts.find(a => a.email === email);
        return checkModelUsable(account, modelId);
    }

    /**
     * Toggle manual enable/disable for an account × model combination
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @param {boolean} enabled - Whether to enable or disable
     * @returns {Object|null} Updated health object
     */
    toggleModelHealth(email, modelId, enabled) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return null;
        const result = toggleModelHealth(account, modelId, enabled);
        this.saveToDisk();
        return result;
    }

    /**
     * Reset health tracking for an account
     * @param {string} email - Account email
     * @param {string|null} modelId - Model ID (or null to reset all)
     * @returns {boolean} True if reset was successful
     */
    resetHealth(email, modelId = null) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return false;
        const result = resetModelHealth(account, modelId);
        this.saveToDisk();
        return result;
    }

    /**
     * Get health data for an account
     * @param {string} email - Account email
     * @returns {Object} Health data for all models
     */
    getAccountHealth(email) {
        const account = this.#accounts.find(a => a.email === email);
        return getAccHealth(account);
    }

    /**
     * Get health data for a specific account × model combination
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @returns {Object|null} Health data or null if not tracked
     */
    getModelHealth(email, modelId) {
        const account = this.#accounts.find(a => a.email === email);
        return getModHealth(account, modelId);
    }

    /**
     * Build health matrix data for all accounts
     * @param {Array} modelIds - Array of model IDs to include
     * @returns {Object} Matrix data
     */
    buildHealthMatrix(modelIds) {
        return buildMatrix(this.#accounts, modelIds);
    }

    /**
     * Get health configuration
     * @returns {Object} Health configuration
     */
    getHealthConfig() {
        return getHConfig();
    }

    /**
     * Update health configuration
     * @param {Object} newConfig - New configuration values
     * @returns {Object} Updated configuration
     */
    setHealthConfig(newConfig) {
        return setHConfig(newConfig);
    }

    /**
     * Get health summary statistics
     * @returns {Object} Summary statistics
     */
    getHealthSummary() {
        return getHSummary(this.#accounts);
    }

    /**
     * Check quota threshold for a specific account × model
     * Disables combination if quota is below threshold
     *
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @param {number} remainingFraction - Remaining quota (0-1)
     * @param {string|null} resetTime - ISO timestamp when quota resets
     * @returns {Object|null} Updated health object or null
     */
    checkQuotaThreshold(email, modelId, remainingFraction, resetTime = null) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return null;

        const result = checkQuota(account, modelId, remainingFraction, resetTime);
        if (result) {
            // Save if there was a change
            this.saveToDisk();
        }
        return result;
    }

    /**
     * Check all quotas for an account
     * Called when quota data is refreshed from API
     *
     * @param {string} email - Account email
     * @param {Object} quotas - Map of modelId -> { remainingFraction, resetTime }
     * @returns {Array} List of models that were disabled or enabled
     */
    checkAccountQuotas(email, quotas) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return [];

        const changes = checkAccQuotas(account, quotas);
        if (changes.length > 0) {
            // Save if there were changes
            this.saveToDisk();
        }
        return changes;
    }
}

export default AccountManager;
