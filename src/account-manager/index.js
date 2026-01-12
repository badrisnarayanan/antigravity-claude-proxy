/**
 * Account Manager
 * Manages multiple Antigravity accounts with sticky selection,
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
    getMinWaitTimeMs as getMinWait
} from './rate-limits.js';
import {
    getTokenForAccount as fetchToken,
    getProjectForAccount as fetchProject,
    clearProjectCache as clearProject,
    clearTokenCache as clearToken
} from './credentials.js';
import {
    pickNext as selectNext,
    getCurrentStickyAccount as getSticky,
    shouldWaitForCurrentAccount as shouldWait,
    pickStickyAccount as selectSticky
} from './selection.js';
import { logger } from '../utils/logger.js';

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #initialized = false;

    // Per-account caches
    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    constructor(configPath = ACCOUNT_CONFIG_PATH) {
        this.#configPath = configPath;
    }

    /**
     * Initialize the account manager by loading config
     */
    async initialize() {
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
     * Pick the next available account (fallback when current is unavailable).
     * Sets activeIndex to the selected account's index.
     * @param {string} [modelId] - Optional model ID
     * @returns {Object|null} The next available account or null if none available
     */
    pickNext(modelId = null) {
        const { account, newIndex } = selectNext(this.#accounts, this.#currentIndex, () => this.saveToDisk(), modelId);
        this.#currentIndex = newIndex;
        return account;
    }

    /**
     * Get the current account without advancing the index (sticky selection).
     * Used for cache continuity - sticks to the same account until rate-limited.
     * @param {string} [modelId] - Optional model ID
     * @returns {Object|null} The current account or null if unavailable/rate-limited
     */
    getCurrentStickyAccount(modelId = null) {
        const { account, newIndex } = getSticky(this.#accounts, this.#currentIndex, () => this.saveToDisk(), modelId);
        this.#currentIndex = newIndex;
        return account;
    }

    /**
     * Check if we should wait for the current account's rate limit to reset.
     * Used for sticky account selection - wait if rate limit is short (≤ threshold).
     * @param {string} [modelId] - Optional model ID
     * @returns {{shouldWait: boolean, waitMs: number, account: Object|null}}
     */
    shouldWaitForCurrentAccount(modelId = null) {
        return shouldWait(this.#accounts, this.#currentIndex, modelId);
    }

    /**
     * Pick an account with sticky selection preference.
     * Prefers the current account for cache continuity, only switches when:
     * - Current account is rate-limited for > 2 minutes
     * - Current account is invalid
     * @param {string} [modelId] - Optional model ID
     * @returns {{account: Object|null, waitMs: number}} Account to use and optional wait time
     */
    pickStickyAccount(modelId = null) {
        const { account, waitMs, newIndex } = selectSticky(this.#accounts, this.#currentIndex, () => this.saveToDisk(), modelId);
        this.#currentIndex = newIndex;
        return { account, waitMs };
    }

    /**
     * Mark an account as rate-limited
     * @param {string} email - Email of the account to mark
     * @param {number|null} resetMs - Time in ms until rate limit resets (optional)
     * @param {string} [modelId] - Optional model ID to mark specific limit
     */
    markRateLimited(email, resetMs = null, modelId = null) {
        markLimited(this.#accounts, email, resetMs, this.#settings, modelId);
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
        return fetchProject(account, token, this.#projectCache);
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
     * Add or update an account
     * @param {Object} accountData - Account data to add/update
     * @returns {Promise<void>}
     */
    async addAccount(accountData) {
        if (!accountData.email) {
            throw new Error('Account email is required');
        }

        const existingIndex = this.#accounts.findIndex(a => a.email === accountData.email);

        if (existingIndex !== -1) {
            // Update existing account
            this.#accounts[existingIndex] = {
                ...this.#accounts[existingIndex],
                ...accountData,
                // Preserve critical state unless explicitly overwritten
                enabled: accountData.enabled !== undefined ? accountData.enabled : this.#accounts[existingIndex].enabled,
                isInvalid: false, // Reset invalid state on update
                invalidReason: null,
                addedAt: this.#accounts[existingIndex].addedAt || new Date().toISOString()
            };
            logger.info(`[AccountManager] Account updated: ${accountData.email}`);
        } else {
            // Add new account
            this.#accounts.push({
                ...accountData,
                enabled: true,
                isInvalid: false,
                invalidReason: null,
                modelRateLimits: {},
                lastUsed: null,
                addedAt: new Date().toISOString(),
                subscription: { tier: 'unknown', projectId: null, detectedAt: null },
                quota: { models: {}, lastChecked: null }
            });
            logger.info(`[AccountManager] Account added: ${accountData.email}`);
        }

        await this.saveToDisk();
    }

    /**
     * Remove an account
     * @param {string} email - Email of the account to remove
     * @returns {Promise<boolean>} True if account was removed, false if not found
     */
    async removeAccount(email) {
        const index = this.#accounts.findIndex(a => a.email === email);
        if (index === -1) {
            return false;
        }

        this.#accounts.splice(index, 1);

        // Adjust active index if needed
        if (this.#currentIndex >= this.#accounts.length) {
            this.#currentIndex = Math.max(0, this.#accounts.length - 1);
        }

        // Clear caches
        this.#tokenCache.delete(email);
        this.#projectCache.delete(email);

        logger.info(`[AccountManager] Account removed: ${email}`);
        await this.saveToDisk();
        return true;
    }

    /**
     * Enable or disable an account
     * @param {string} email - Email of the account
     * @param {boolean} enabled - New enabled state
     * @returns {Promise<boolean>} True if updated, false if not found
     */
    async toggleAccount(email, enabled) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) {
            return false;
        }

        account.enabled = enabled;
        logger.info(`[AccountManager] Account ${email} ${enabled ? 'enabled' : 'disabled'}`);
        await this.saveToDisk();
        return true;
    }

    /**
     * Get all accounts (internal use for quota fetching)
     * Returns the full account objects including credentials
     * @returns {Array<Object>} Array of account objects
     */
    getAllAccounts() {
        return this.#accounts;
    }
}

export default AccountManager;
