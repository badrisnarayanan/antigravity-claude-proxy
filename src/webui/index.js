/**
 * WebUI Module - Optional web interface for account management
 *
 * This module provides a web-based UI for:
 * - Dashboard with real-time model quota visualization
 * - Account management (add via OAuth, enable/disable, refresh, remove)
 * - Live server log streaming with filtering
 * - Claude CLI configuration editor
 *
 * Usage in server.js:
 *   import { mountWebUI } from './webui/index.js';
 *   mountWebUI(app, __dirname, accountManager);
 */

import path from 'path';
import express from 'express';
import { getPublicConfig, saveConfig, config } from '../config.js';
import { DEFAULT_PORT, ACCOUNT_CONFIG_PATH, MAX_ACCOUNTS, DEFAULT_PRESETS, DEFAULT_SERVER_PRESETS } from '../constants.js';
import { readClaudeConfig, updateClaudeConfig, replaceClaudeConfig, getClaudeConfigPath, readPresets, savePreset, deletePreset } from '../utils/claude-config.js';
import { readServerPresets, saveServerPreset, updateServerPreset, deleteServerPreset } from '../utils/server-presets.js';
import { logger } from '../utils/logger.js';
import { getAuthorizationUrl, completeOAuthFlow, startCallbackServer } from '../auth/oauth.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import { getPackageVersion } from '../utils/helpers.js';

// Get package version
const packageVersion = getPackageVersion();

// OAuth state storage (state -> { server, verifier, state, timestamp })
// Maps state ID to active OAuth flow data
const pendingOAuthFlows = new Map();

/**
 * WebUI Helper Functions - Direct account manipulation
 * These functions work around AccountManager's limited API by directly
 * manipulating the accounts.json config file (non-invasive approach for PR)
 */

/**
 * Set account enabled/disabled state
 */
async function setAccountEnabled(email, enabled) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const account = accounts.find(a => a.email === email);
    if (!account) {
        throw new Error(`Account ${email} not found`);
    }
    account.enabled = enabled;
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
    logger.info(`[WebUI] Account ${email} ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Remove account from config
 */
async function removeAccount(email) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const index = accounts.findIndex(a => a.email === email);
    if (index === -1) {
        throw new Error(`Account ${email} not found`);
    }
    accounts.splice(index, 1);
    // Adjust activeIndex if needed
    const newActiveIndex = activeIndex >= accounts.length ? Math.max(0, accounts.length - 1) : activeIndex;
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, newActiveIndex);
    logger.info(`[WebUI] Account ${email} removed`);
}

/**
 * Add new account to config
 * @throws {Error} If MAX_ACCOUNTS limit is reached (for new accounts only)
 */
async function addAccount(accountData) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

    // Check if account already exists
    const existingIndex = accounts.findIndex(a => a.email === accountData.email);
    if (existingIndex !== -1) {
        // Update existing account
        accounts[existingIndex] = {
            ...accounts[existingIndex],
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            addedAt: accounts[existingIndex].addedAt || new Date().toISOString()
        };
        logger.info(`[WebUI] Account ${accountData.email} updated`);
    } else {
        // Check MAX_ACCOUNTS limit before adding new account
        if (accounts.length >= MAX_ACCOUNTS) {
            throw new Error(`Maximum of ${MAX_ACCOUNTS} accounts reached. Update maxAccounts in config to increase the limit.`);
        }
        // Add new account
        accounts.push({
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            modelRateLimits: {},
            lastUsed: null,
            addedAt: new Date().toISOString()
        });
        logger.info(`[WebUI] Account ${accountData.email} added`);
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
}

/**
 * Auth Middleware - Optional password protection for WebUI
 * Password can be set via WEBUI_PASSWORD env var or config.json
 */
function createAuthMiddleware() {
    return (req, res, next) => {
        const password = config.webuiPassword;
        if (!password) return next();

        // Determine if this path should be protected
        const isApiRoute = req.path.startsWith('/api/');
        const isAuthUrl = req.path === '/api/auth/url';
        const isConfigGet = req.path === '/api/config' && req.method === 'GET';
        const isProtected = (isApiRoute && !isAuthUrl && !isConfigGet) || req.path === '/account-limits' || req.path === '/health';

        if (isProtected) {
            const providedPassword = req.headers['x-webui-password'] || req.query.password;
            if (providedPassword !== password) {
                return res.status(401).json({ status: 'error', error: 'Unauthorized: Password required' });
            }
        }
        next();
    };
}

/**
 * Validate server config fields from user input.
 * Shared by POST /api/config and PATCH /api/server/presets/:name.
 * @param {Object} input - Raw config fields to validate
 * @returns {Object} Validated updates object (only valid fields included)
 */
function validateConfigFields(input) {
    const updates = {};
    const { maxRetries, retryBaseMs, retryMaxMs, defaultCooldownMs, maxWaitBeforeErrorMs, maxAccounts, globalQuotaThreshold, accountSelection, rateLimitDedupWindowMs, maxConsecutiveFailures, extendedCooldownMs, maxCapacityRetries, switchAccountDelayMs, capacityBackoffTiersMs } = input;

    if (typeof maxRetries === 'number' && maxRetries >= 1 && maxRetries <= 20) {
        updates.maxRetries = maxRetries;
    }
    if (typeof retryBaseMs === 'number' && retryBaseMs >= 100 && retryBaseMs <= 10000) {
        updates.retryBaseMs = retryBaseMs;
    }
    if (typeof retryMaxMs === 'number' && retryMaxMs >= 1000 && retryMaxMs <= 120000) {
        updates.retryMaxMs = retryMaxMs;
    }
    if (typeof defaultCooldownMs === 'number' && defaultCooldownMs >= 1000 && defaultCooldownMs <= 300000) {
        updates.defaultCooldownMs = defaultCooldownMs;
    }
    if (typeof maxWaitBeforeErrorMs === 'number' && maxWaitBeforeErrorMs >= 0 && maxWaitBeforeErrorMs <= 600000) {
        updates.maxWaitBeforeErrorMs = maxWaitBeforeErrorMs;
    }
    if (typeof maxAccounts === 'number' && maxAccounts >= 1 && maxAccounts <= 100) {
        updates.maxAccounts = maxAccounts;
    }
    if (typeof globalQuotaThreshold === 'number' && globalQuotaThreshold >= 0 && globalQuotaThreshold < 1) {
        updates.globalQuotaThreshold = globalQuotaThreshold;
    }
    if (typeof rateLimitDedupWindowMs === 'number' && rateLimitDedupWindowMs >= 1000 && rateLimitDedupWindowMs <= 30000) {
        updates.rateLimitDedupWindowMs = rateLimitDedupWindowMs;
    }
    if (typeof maxConsecutiveFailures === 'number' && maxConsecutiveFailures >= 1 && maxConsecutiveFailures <= 10) {
        updates.maxConsecutiveFailures = maxConsecutiveFailures;
    }
    if (typeof extendedCooldownMs === 'number' && extendedCooldownMs >= 10000 && extendedCooldownMs <= 300000) {
        updates.extendedCooldownMs = extendedCooldownMs;
    }
    if (typeof maxCapacityRetries === 'number' && maxCapacityRetries >= 1 && maxCapacityRetries <= 10) {
        updates.maxCapacityRetries = maxCapacityRetries;
    }
    if (typeof switchAccountDelayMs === 'number' && switchAccountDelayMs >= 1000 && switchAccountDelayMs <= 60000) {
        updates.switchAccountDelayMs = switchAccountDelayMs;
    }
    if (Array.isArray(capacityBackoffTiersMs) && capacityBackoffTiersMs.length >= 1 && capacityBackoffTiersMs.length <= 10) {
        const allValid = capacityBackoffTiersMs.every(v => typeof v === 'number' && v >= 1000 && v <= 300000);
        if (allValid) {
            updates.capacityBackoffTiersMs = [...capacityBackoffTiersMs];
        }
    }
    // Account selection strategy and tuning validation
    if (accountSelection && typeof accountSelection === 'object') {
        const validStrategies = ['sticky', 'round-robin', 'hybrid'];
        const acctUpdate = {};

        if (accountSelection.strategy && validStrategies.includes(accountSelection.strategy)) {
            acctUpdate.strategy = accountSelection.strategy;
        }

        // Health score tuning
        if (accountSelection.healthScore && typeof accountSelection.healthScore === 'object') {
            const hs = accountSelection.healthScore;
            const hsUpdate = {};
            if (typeof hs.initial === 'number' && hs.initial >= 0 && hs.initial <= 100) hsUpdate.initial = hs.initial;
            if (typeof hs.successReward === 'number' && hs.successReward >= 0 && hs.successReward <= 20) hsUpdate.successReward = hs.successReward;
            if (typeof hs.rateLimitPenalty === 'number' && hs.rateLimitPenalty >= -50 && hs.rateLimitPenalty <= 0) hsUpdate.rateLimitPenalty = hs.rateLimitPenalty;
            if (typeof hs.failurePenalty === 'number' && hs.failurePenalty >= -50 && hs.failurePenalty <= 0) hsUpdate.failurePenalty = hs.failurePenalty;
            if (typeof hs.recoveryPerHour === 'number' && hs.recoveryPerHour >= 0 && hs.recoveryPerHour <= 20) hsUpdate.recoveryPerHour = hs.recoveryPerHour;
            if (typeof hs.minUsable === 'number' && hs.minUsable >= 0 && hs.minUsable <= 100) hsUpdate.minUsable = hs.minUsable;
            if (typeof hs.maxScore === 'number' && hs.maxScore >= 1 && hs.maxScore <= 200) hsUpdate.maxScore = hs.maxScore;
            if (Object.keys(hsUpdate).length > 0) acctUpdate.healthScore = hsUpdate;
        }

        // Token bucket tuning
        if (accountSelection.tokenBucket && typeof accountSelection.tokenBucket === 'object') {
            const tb = accountSelection.tokenBucket;
            const tbUpdate = {};
            if (typeof tb.maxTokens === 'number' && tb.maxTokens >= 5 && tb.maxTokens <= 200) tbUpdate.maxTokens = tb.maxTokens;
            if (typeof tb.tokensPerMinute === 'number' && tb.tokensPerMinute >= 1 && tb.tokensPerMinute <= 60) tbUpdate.tokensPerMinute = tb.tokensPerMinute;
            if (typeof tb.initialTokens === 'number' && tb.initialTokens >= 1 && tb.initialTokens <= 200) tbUpdate.initialTokens = tb.initialTokens;
            if (Object.keys(tbUpdate).length > 0) acctUpdate.tokenBucket = tbUpdate;
        }

        // Quota tuning
        if (accountSelection.quota && typeof accountSelection.quota === 'object') {
            const q = accountSelection.quota;
            const qUpdate = {};
            if (typeof q.lowThreshold === 'number' && q.lowThreshold >= 0 && q.lowThreshold < 1) qUpdate.lowThreshold = q.lowThreshold;
            if (typeof q.criticalThreshold === 'number' && q.criticalThreshold >= 0 && q.criticalThreshold < 1) qUpdate.criticalThreshold = q.criticalThreshold;
            if (typeof q.staleMs === 'number' && q.staleMs >= 30000 && q.staleMs <= 3600000) qUpdate.staleMs = q.staleMs;
            if (Object.keys(qUpdate).length > 0) acctUpdate.quota = qUpdate;
        }

        // Weights tuning
        if (accountSelection.weights && typeof accountSelection.weights === 'object') {
            const w = accountSelection.weights;
            const wUpdate = {};
            if (typeof w.health === 'number' && w.health >= 0 && w.health <= 20) wUpdate.health = w.health;
            if (typeof w.tokens === 'number' && w.tokens >= 0 && w.tokens <= 20) wUpdate.tokens = w.tokens;
            if (typeof w.quota === 'number' && w.quota >= 0 && w.quota <= 20) wUpdate.quota = w.quota;
            if (typeof w.lru === 'number' && w.lru >= 0 && w.lru <= 5) wUpdate.lru = w.lru;
            if (Object.keys(wUpdate).length > 0) acctUpdate.weights = wUpdate;
        }

        if (Object.keys(acctUpdate).length > 0) {
            updates.accountSelection = acctUpdate;
        }
    }

    return updates;
}

/**
 * Mount WebUI routes and middleware on Express app
 * @param {Express} app - Express application instance
 * @param {string} dirname - __dirname of the calling module (for static file path)
 * @param {AccountManager} accountManager - Account manager instance
 */
export function mountWebUI(app, dirname, accountManager) {
    // Apply auth middleware
    app.use(createAuthMiddleware());

    // Serve static files from public directory
    app.use(express.static(path.join(dirname, '../public')));

    // ==========================================
    // Account Management API
    // ==========================================

    /**
     * GET /api/accounts - List all accounts with status
     */
    app.get('/api/accounts', async (req, res) => {
        try {
            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                accounts: status.accounts,
                summary: {
                    total: status.total,
                    available: status.available,
                    rateLimited: status.rateLimited,
                    invalid: status.invalid
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/refresh - Refresh specific account token
     */
    app.post('/api/accounts/:email/refresh', async (req, res) => {
        try {
            const { email } = req.params;
            accountManager.clearTokenCache(email);
            accountManager.clearProjectCache(email);
            res.json({
                status: 'ok',
                message: `Token cache cleared for ${email}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/toggle - Enable/disable account
     */
    app.post('/api/accounts/:email/toggle', async (req, res) => {
        try {
            const { email } = req.params;
            const { enabled } = req.body;

            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ status: 'error', error: 'enabled must be a boolean' });
            }

            await setAccountEnabled(email, enabled);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} ${enabled ? 'enabled' : 'disabled'}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/accounts/:email - Remove account
     */
    app.delete('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            await removeAccount(email);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} removed`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/accounts/:email - Update account settings (thresholds)
     */
    app.patch('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            const { quotaThreshold, modelQuotaThresholds } = req.body;

            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const account = accounts.find(a => a.email === email);

            if (!account) {
                return res.status(404).json({ status: 'error', error: `Account ${email} not found` });
            }

            // Validate and update quotaThreshold (0-0.99 or null/undefined to clear)
            if (quotaThreshold !== undefined) {
                if (quotaThreshold === null) {
                    delete account.quotaThreshold;
                } else if (typeof quotaThreshold === 'number' && quotaThreshold >= 0 && quotaThreshold < 1) {
                    account.quotaThreshold = quotaThreshold;
                } else {
                    return res.status(400).json({ status: 'error', error: 'quotaThreshold must be 0-0.99 or null' });
                }
            }

            // Validate and update modelQuotaThresholds (full replacement, not merge)
            if (modelQuotaThresholds !== undefined) {
                if (modelQuotaThresholds === null || (typeof modelQuotaThresholds === 'object' && Object.keys(modelQuotaThresholds).length === 0)) {
                    // Clear all model thresholds
                    delete account.modelQuotaThresholds;
                } else if (typeof modelQuotaThresholds === 'object') {
                    // Validate all thresholds first
                    for (const [modelId, threshold] of Object.entries(modelQuotaThresholds)) {
                        if (typeof threshold !== 'number' || threshold < 0 || threshold >= 1) {
                            return res.status(400).json({
                                status: 'error',
                                error: `Invalid threshold for model ${modelId}: must be 0-0.99`
                            });
                        }
                    }
                    // Replace entire object (not merge)
                    account.modelQuotaThresholds = { ...modelQuotaThresholds };
                } else {
                    return res.status(400).json({ status: 'error', error: 'modelQuotaThresholds must be an object or null' });
                }
            }

            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            logger.info(`[WebUI] Account ${email} thresholds updated`);

            res.json({
                status: 'ok',
                message: `Account ${email} thresholds updated`,
                account: {
                    email: account.email,
                    quotaThreshold: account.quotaThreshold,
                    modelQuotaThresholds: account.modelQuotaThresholds || {}
                }
            });
        } catch (error) {
            logger.error('[WebUI] Error updating account thresholds:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/reload - Reload accounts from disk
     */
    app.post('/api/accounts/reload', async (req, res) => {
        try {
            // Reload AccountManager from disk
            await accountManager.reload();

            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                message: 'Accounts reloaded from disk',
                summary: status.summary
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/accounts/export - Export accounts
     */
    app.get('/api/accounts/export', async (req, res) => {
        try {
            const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);

            // Export only essential fields for portability
            const exportData = accounts
                .filter(acc => acc.source !== 'database')
                .map(acc => {
                    const essential = { email: acc.email };
                    // Use snake_case for compatibility
                    if (acc.refreshToken) {
                        essential.refresh_token = acc.refreshToken;
                    }
                    if (acc.apiKey) {
                        essential.api_key = acc.apiKey;
                    }
                    return essential;
                });

            // Return plain array for simpler format
            res.json(exportData);
        } catch (error) {
            logger.error('[WebUI] Export accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/import - Batch import accounts
     */
    app.post('/api/accounts/import', async (req, res) => {
        try {
            // Support both wrapped format { accounts: [...] } and plain array [...]
            let importAccounts = req.body;
            if (req.body.accounts && Array.isArray(req.body.accounts)) {
                importAccounts = req.body.accounts;
            }

            if (!Array.isArray(importAccounts) || importAccounts.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'accounts must be a non-empty array'
                });
            }

            const results = { added: [], updated: [], failed: [] };

            // Load existing accounts once before the loop
            const { accounts: existingAccounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const existingEmails = new Set(existingAccounts.map(a => a.email));

            for (const acc of importAccounts) {
                try {
                    // Validate required fields
                    if (!acc.email) {
                        results.failed.push({ email: acc.email || 'unknown', reason: 'Missing email' });
                        continue;
                    }

                    // Support both snake_case and camelCase
                    const refreshToken = acc.refresh_token || acc.refreshToken;
                    const apiKey = acc.api_key || acc.apiKey;

                    // Must have at least one credential
                    if (!refreshToken && !apiKey) {
                        results.failed.push({ email: acc.email, reason: 'Missing refresh_token or api_key' });
                        continue;
                    }

                    // Check if account already exists
                    const exists = existingEmails.has(acc.email);

                    // Add account
                    await addAccount({
                        email: acc.email,
                        source: apiKey ? 'manual' : 'oauth',
                        refreshToken: refreshToken,
                        apiKey: apiKey
                    });

                    if (exists) {
                        results.updated.push(acc.email);
                    } else {
                        results.added.push(acc.email);
                    }
                } catch (err) {
                    results.failed.push({ email: acc.email, reason: err.message });
                }
            }

            // Reload AccountManager
            await accountManager.reload();

            logger.info(`[WebUI] Import complete: ${results.added.length} added, ${results.updated.length} updated, ${results.failed.length} failed`);

            res.json({
                status: 'ok',
                results,
                message: `Imported ${results.added.length + results.updated.length} accounts`
            });
        } catch (error) {
            logger.error('[WebUI] Import accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Configuration API
    // ==========================================

    /**
     * GET /api/config - Get server configuration
     */
    app.get('/api/config', (req, res) => {
        try {
            const publicConfig = getPublicConfig();
            res.json({
                status: 'ok',
                config: publicConfig,
                version: packageVersion,
                note: 'Edit ~/.config/antigravity-proxy/config.json or use env vars to change these values'
            });
        } catch (error) {
            logger.error('[WebUI] Error getting config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config - Update server configuration
     */
    app.post('/api/config', (req, res) => {
        try {
            const { debug, devMode, logLevel, persistTokenCache } = req.body;

            // Validate tunable config fields via shared helper
            const updates = validateConfigFields(req.body);

            // Handle fields not covered by the shared helper
            if (typeof devMode === 'boolean') {
                updates.devMode = devMode;
                updates.debug = devMode;
                logger.setDebug(devMode);
            } else if (typeof debug === 'boolean') {
                updates.debug = debug;
                updates.devMode = debug;
                logger.setDebug(debug);
            }
            if (logLevel && ['info', 'warn', 'error', 'debug'].includes(logLevel)) {
                updates.logLevel = logLevel;
            }
            if (typeof persistTokenCache === 'boolean') {
                updates.persistTokenCache = persistTokenCache;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No valid configuration updates provided'
                });
            }

            const success = saveConfig(updates);

            if (success) {
                res.json({
                    status: 'ok',
                    message: 'Configuration saved. Restart server to apply some changes.',
                    updates: updates,
                    config: getPublicConfig()
                });
            } else {
                res.status(500).json({
                    status: 'error',
                    error: 'Failed to save configuration file'
                });
            }
        } catch (error) {
            logger.error('[WebUI] Error updating config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config/password - Change WebUI password
     */
    app.post('/api/config/password', (req, res) => {
        try {
            const { oldPassword, newPassword } = req.body;

            // Validate input
            if (!newPassword || typeof newPassword !== 'string') {
                return res.status(400).json({
                    status: 'error',
                    error: 'New password is required'
                });
            }

            // If current password exists, verify old password
            if (config.webuiPassword && config.webuiPassword !== oldPassword) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Invalid current password'
                });
            }

            // Save new password
            const success = saveConfig({ webuiPassword: newPassword });

            if (success) {
                // Update in-memory config
                config.webuiPassword = newPassword;
                res.json({
                    status: 'ok',
                    message: 'Password changed successfully'
                });
            } else {
                throw new Error('Failed to save password to config file');
            }
        } catch (error) {
            logger.error('[WebUI] Error changing password:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/settings - Get runtime settings
     */
    app.get('/api/settings', async (req, res) => {
        try {
            const settings = accountManager.getSettings ? accountManager.getSettings() : {};
            res.json({
                status: 'ok',
                settings: {
                    ...settings,
                    port: process.env.PORT || DEFAULT_PORT
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Configuration API
    // ==========================================

    /**
     * GET /api/claude/config - Get Claude CLI configuration
     */
    app.get('/api/claude/config', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            res.json({
                status: 'ok',
                config: claudeConfig,
                path: getClaudeConfigPath()
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config - Update Claude CLI configuration
     */
    app.post('/api/claude/config', async (req, res) => {
        try {
            const updates = req.body;
            if (!updates || typeof updates !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid config updates' });
            }

            const newConfig = await updateClaudeConfig(updates);
            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude configuration updated'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config/restore - Restore Claude CLI to default (remove proxy settings)
     */
    app.post('/api/claude/config/restore', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();

            // Proxy-related environment variables to remove when restoring defaults
            const PROXY_ENV_VARS = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_MODEL',
                'CLAUDE_CODE_SUBAGENT_MODEL',
                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'ENABLE_EXPERIMENTAL_MCP_CLI'
            ];

            // Remove proxy-related environment variables to restore defaults
            if (claudeConfig.env) {
                for (const key of PROXY_ENV_VARS) {
                    delete claudeConfig.env[key];
                }
                // Remove env entirely if empty to truly restore defaults
                if (Object.keys(claudeConfig.env).length === 0) {
                    delete claudeConfig.env;
                }
            }

            // Use replaceClaudeConfig to completely overwrite the config (not merge)
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Restored Claude CLI config to defaults at ${getClaudeConfigPath()}`);

            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude CLI configuration restored to defaults'
            });
        } catch (error) {
            logger.error('[WebUI] Error restoring Claude config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Mode Toggle API (Proxy/Paid)
    // ==========================================

    /**
     * GET /api/claude/mode - Get current mode (proxy or paid)
     * Returns 'proxy' if ANTHROPIC_BASE_URL is set to localhost, 'paid' otherwise
     */
    app.get('/api/claude/mode', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            const baseUrl = claudeConfig.env?.ANTHROPIC_BASE_URL || '';

            // Determine mode based on ANTHROPIC_BASE_URL
            const isProxy = baseUrl && (
                baseUrl.includes('localhost') ||
                baseUrl.includes('127.0.0.1') ||
                baseUrl.includes('::1') ||
                baseUrl.includes('0.0.0.0')
            );

            res.json({
                status: 'ok',
                mode: isProxy ? 'proxy' : 'paid'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/mode - Switch between proxy and paid mode
     * Body: { mode: 'proxy' | 'paid' }
     * 
     * When switching to 'paid' mode:
     * - Removes the entire 'env' object from settings.json
     * - Claude CLI uses its built-in defaults (official Anthropic API)
     * 
     * When switching to 'proxy' mode:
     * - Sets 'env' to the first default preset config (from constants.js)
     */
    app.post('/api/claude/mode', async (req, res) => {
        try {
            const { mode } = req.body;

            if (!mode || !['proxy', 'paid'].includes(mode)) {
                return res.status(400).json({
                    status: 'error',
                    error: 'mode must be "proxy" or "paid"'
                });
            }

            const claudeConfig = await readClaudeConfig();

            if (mode === 'proxy') {
                // Switch to proxy mode - use first default preset config (e.g., "Claude Thinking")
                claudeConfig.env = { ...DEFAULT_PRESETS[0].config };
            } else {
                // Switch to paid mode - remove env entirely
                delete claudeConfig.env;
            }

            // Save the updated config
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Switched Claude CLI to ${mode} mode`);

            res.json({
                status: 'ok',
                mode,
                config: newConfig,
                message: `Switched to ${mode === 'proxy' ? 'Proxy' : 'Paid (Anthropic API)'} mode. Restart Claude CLI to apply.`
            });
        } catch (error) {
            logger.error('[WebUI] Error switching mode:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Presets API
    // ==========================================


    /**
     * GET /api/claude/presets - Get all saved presets
     */
    app.get('/api/claude/presets', async (req, res) => {
        try {
            const presets = await readPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/presets - Save a new preset
     */
    app.post('/api/claude/presets', async (req, res) => {
        try {
            const { name, config: presetConfig } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (!presetConfig || typeof presetConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const presets = await savePreset(name.trim(), presetConfig);
            res.json({ status: 'ok', presets, message: `Preset "${name}" saved` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/claude/presets/:name - Delete a preset
     */
    app.delete('/api/claude/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deletePreset(name);
            res.json({ status: 'ok', presets, message: `Preset "${name}" deleted` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Server Configuration Presets API
    // ==========================================

    /**
     * GET /api/server/presets - List all server config presets
     */
    app.get('/api/server/presets', async (req, res) => {
        try {
            const presets = await readServerPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            logger.error('[WebUI] Error reading server presets:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/server/presets - Save a custom server config preset
     */
    app.post('/api/server/presets', async (req, res) => {
        try {
            const { name, config: presetConfig, description } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (!presetConfig || typeof presetConfig !== 'object' || Array.isArray(presetConfig)) {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const validatedConfig = validateConfigFields(presetConfig);
            if (Object.keys(validatedConfig).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No valid config fields provided' });
            }

            const presets = await saveServerPreset(name.trim(), validatedConfig, description);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" saved` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/server/presets/:name - Update custom preset metadata and/or config
     */
    app.patch('/api/server/presets/:name', async (req, res) => {
        try {
            const { name: currentName } = req.params;
            if (!currentName) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const { name: newName, description, config: configInput } = req.body;
            const updates = {};
            if (newName !== undefined) updates.name = newName;
            if (description !== undefined) updates.description = description;

            // Validate and include config updates if provided
            if (configInput && typeof configInput === 'object') {
                const validatedConfig = validateConfigFields(configInput);
                if (Object.keys(validatedConfig).length > 0) {
                    updates.config = validatedConfig;
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No updates provided' });
            }

            const presets = await updateServerPreset(currentName, updates);
            res.json({ status: 'ok', presets, message: `Server preset "${currentName}" updated` });
        } catch (error) {
            const status = error.message.includes('built-in') || error.message.includes('not found') || error.message.includes('already exists') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/server/presets/:name - Delete a custom server config preset
     */
    app.delete('/api/server/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deleteServerPreset(name);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" deleted` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/models/config - Update model configuration (hidden/pinned/alias)
     */
    app.post('/api/models/config', (req, res) => {
        try {
            const { modelId, config: newModelConfig } = req.body;

            if (!modelId || typeof newModelConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid parameters' });
            }

            // Load current config
            const currentMapping = config.modelMapping || {};

            // Update specific model config
            currentMapping[modelId] = {
                ...currentMapping[modelId],
                ...newModelConfig
            };

            // Save back to main config
            const success = saveConfig({ modelMapping: currentMapping });

            if (success) {
                // Update in-memory config reference
                config.modelMapping = currentMapping;
                res.json({ status: 'ok', modelConfig: currentMapping[modelId] });
            } else {
                throw new Error('Failed to save configuration');
            }
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Logs API
    // ==========================================

    /**
     * GET /api/logs - Get log history
     */
    app.get('/api/logs', (req, res) => {
        res.json({
            status: 'ok',
            logs: logger.getHistory ? logger.getHistory() : []
        });
    });

    /**
     * GET /api/logs/stream - Stream logs via SSE
     */
    app.get('/api/logs/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendLog = (log) => {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
        };

        // Send recent history if requested
        if (req.query.history === 'true' && logger.getHistory) {
            const history = logger.getHistory();
            history.forEach(log => sendLog(log));
        }

        // Subscribe to new logs
        if (logger.on) {
            logger.on('log', sendLog);
        }

        // Cleanup on disconnect
        req.on('close', () => {
            if (logger.off) {
                logger.off('log', sendLog);
            }
        });
    });

    // ==========================================
    // Strategy Health API (Developer Mode)
    // ==========================================

    /**
     * GET /api/strategy/health - Get strategy health data for the inspector panel
     * Only available when devMode is enabled
     */
    app.get('/api/strategy/health', (req, res) => {
        try {
            if (!config.devMode) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Developer mode is not enabled'
                });
            }

            const healthData = accountManager.getStrategyHealthData();
            res.json({
                status: 'ok',
                ...healthData
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching strategy health:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // OAuth API
    // ==========================================

    /**
     * GET /api/auth/url - Get OAuth URL to start the flow
     * Uses CLI's OAuth flow (localhost:51121) instead of WebUI's port
     * to match Google OAuth Console's authorized redirect URIs
     */
    app.get('/api/auth/url', async (req, res) => {
        try {
            // Clean up old flows (> 10 mins)
            const now = Date.now();
            for (const [key, val] of pendingOAuthFlows.entries()) {
                if (now - val.timestamp > 10 * 60 * 1000) {
                    pendingOAuthFlows.delete(key);
                }
            }

            // Generate OAuth URL using default redirect URI (localhost:51121)
            const { url, verifier, state } = getAuthorizationUrl();

            // Start callback server on port 51121 (same as CLI)
            const { promise: serverPromise, abort: abortServer } = startCallbackServer(state, 120000); // 2 min timeout

            // Store the flow data
            pendingOAuthFlows.set(state, {
                serverPromise,
                abortServer,
                verifier,
                state,
                timestamp: Date.now()
            });

            // Start async handler for the OAuth callback
            serverPromise
                .then(async (code) => {
                    try {
                        logger.info('[WebUI] Received OAuth callback, completing flow...');
                        const accountData = await completeOAuthFlow(code, verifier);

                        // Add or update the account
                        // Note: Don't set projectId here - it will be discovered and stored
                        // in the refresh token via getProjectForAccount() on first use
                        await addAccount({
                            email: accountData.email,
                            refreshToken: accountData.refreshToken,
                            source: 'oauth'
                        });

                        // Reload AccountManager to pick up the new account
                        await accountManager.reload();

                        logger.success(`[WebUI] Account ${accountData.email} added successfully`);
                    } catch (err) {
                        logger.error('[WebUI] OAuth flow completion error:', err);
                    } finally {
                        pendingOAuthFlows.delete(state);
                    }
                })
                .catch((err) => {
                    // Only log if not aborted (manual completion causes this)
                    if (!err.message?.includes('aborted')) {
                        logger.error('[WebUI] OAuth callback server error:', err);
                    }
                    pendingOAuthFlows.delete(state);
                });

            res.json({ status: 'ok', url, state });
        } catch (error) {
            logger.error('[WebUI] Error generating auth URL:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/complete - Complete OAuth with manually submitted callback URL/code
     * Used when auto-callback cannot reach the local server
     */
    app.post('/api/auth/complete', async (req, res) => {
        try {
            const { callbackInput, state } = req.body;

            if (!callbackInput || !state) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing callbackInput or state'
                });
            }

            // Find the pending flow
            const flowData = pendingOAuthFlows.get(state);
            if (!flowData) {
                return res.status(400).json({
                    status: 'error',
                    error: 'OAuth flow not found. The account may have been already added via auto-callback. Please refresh the account list.'
                });
            }

            const { verifier, abortServer } = flowData;

            // Extract code from input (URL or raw code)
            const { extractCodeFromInput, completeOAuthFlow } = await import('../auth/oauth.js');
            const { code } = extractCodeFromInput(callbackInput);

            // Complete the OAuth flow
            const accountData = await completeOAuthFlow(code, verifier);

            // Add or update the account
            await addAccount({
                email: accountData.email,
                refreshToken: accountData.refreshToken,
                projectId: accountData.projectId,
                source: 'oauth'
            });

            // Reload AccountManager to pick up the new account
            await accountManager.reload();

            // Abort the callback server since manual completion succeeded
            if (abortServer) {
                abortServer();
            }

            // Clean up
            pendingOAuthFlows.delete(state);

            logger.success(`[WebUI] Account ${accountData.email} added via manual callback`);

            res.json({
                status: 'ok',
                email: accountData.email,
                message: `Account ${accountData.email} added successfully`
            });
        } catch (error) {
            logger.error('[WebUI] Manual OAuth completion error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * Note: /oauth/callback route removed
     * OAuth callbacks are now handled by the temporary server on port 51121
     * (same as CLI) to match Google OAuth Console's authorized redirect URIs
     */

    logger.info('[WebUI] Mounted at /');
}
