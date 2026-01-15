/**
 * Account Storage
 *
 * Handles loading and saving account configuration to disk.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/encryption.js';

/**
 * Load accounts from the config file
 *
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}>}
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    try {
        // Check if config file exists using async access
        await access(configPath, fsConstants.F_OK);
        const configData = await readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);

        const accounts = (config.accounts || []).map(acc => {
            // Decrypt sensitive credentials
            const decryptedRefreshToken = acc.refreshToken ? decrypt(acc.refreshToken) : undefined;
            const decryptedApiKey = acc.apiKey ? decrypt(acc.apiKey) : undefined;

            // Check if decryption failed (returns null on failure)
            const hasInvalidToken = (acc.refreshToken && decryptedRefreshToken === null) ||
                                   (acc.apiKey && decryptedApiKey === null);

            // Determine invalid state - preserve existing or set from decryption failure
            const isInvalid = hasInvalidToken || acc.isInvalid || false;
            let invalidReason = null;
            if (hasInvalidToken) {
                invalidReason = 'Token decryption failed - re-authentication required';
            } else if (acc.invalidReason) {
                invalidReason = acc.invalidReason;
            }

            return {
                ...acc,
                refreshToken: decryptedRefreshToken,
                apiKey: decryptedApiKey,
                lastUsed: acc.lastUsed || null,
                enabled: acc.enabled !== false,
                isInvalid,
                invalidReason,
                modelRateLimits: acc.modelRateLimits || {},
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null }
            };
        });

        const settings = config.settings || {};
        let activeIndex = config.activeIndex || 0;

        // Clamp activeIndex to valid range
        if (activeIndex >= accounts.length) {
            activeIndex = 0;
        }

        logger.info(`[AccountManager] Loaded ${accounts.length} account(s) from config`);

        return { accounts, settings, activeIndex };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // No config file - return empty
            logger.info('[AccountManager] No config file found. Using Antigravity database (single account mode)');
        } else {
            logger.error('[AccountManager] Failed to load config:', error.message);
        }
        return { accounts: [], settings: {}, activeIndex: 0 };
    }
}

/**
 * Load the default account from Antigravity's database
 *
 * @param {string} dbPath - Optional path to the database
 * @returns {{accounts: Array, tokenCache: Map}}
 */
export function loadDefaultAccount(dbPath) {
    try {
        const authData = getAuthStatus(dbPath);
        if (authData?.apiKey) {
            const account = {
                email: authData.email || 'default@antigravity',
                source: 'database',
                lastUsed: null,
                modelRateLimits: {}
            };

            const tokenCache = new Map();
            tokenCache.set(account.email, {
                token: authData.apiKey,
                extractedAt: Date.now()
            });

            logger.info(`[AccountManager] Loaded default account: ${account.email}`);

            return { accounts: [account], tokenCache };
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to load default account:', error.message);
    }

    return { accounts: [], tokenCache: new Map() };
}

/**
 * Save account configuration to disk
 *
 * @param {string} configPath - Path to the config file
 * @param {Array} accounts - Array of account objects
 * @param {Object} settings - Settings object
 * @param {number} activeIndex - Current active account index
 */
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    try {
        // Ensure directory exists
        const dir = dirname(configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                source: acc.source,
                enabled: acc.enabled !== false,
                dbPath: acc.dbPath || null,
                // Encrypt sensitive credentials before saving
                refreshToken: acc.source === 'oauth' && acc.refreshToken ? encrypt(acc.refreshToken) : undefined,
                apiKey: acc.source === 'manual' && acc.apiKey ? encrypt(acc.apiKey) : undefined,
                projectId: acc.projectId || undefined,
                addedAt: acc.addedAt || undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed,
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null }
            })),
            settings: settings,
            activeIndex: activeIndex
        };

        await writeFile(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
        logger.error('[AccountManager] Failed to save config:', error.message);
    }
}
