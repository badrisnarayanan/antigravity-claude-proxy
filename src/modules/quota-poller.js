/**
 * Quota Poller Module
 *
 * Periodically polls account quotas and triggers health threshold checks.
 * Runs independently of the WebUI to ensure quota protection works
 * even when the frontend is not open.
 *
 * This module is designed to be modular and non-intrusive:
 * - Starts/stops based on quota protection configuration
 * - Does not modify existing logic, only adds periodic checks
 * - Uses existing AccountManager methods for quota fetching
 */

import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// Polling interval (5 minutes by default)
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

// Reference to interval timer
let pollInterval = null;

// Reference to account manager (injected)
let accountManager = null;

// Track if currently polling to prevent overlaps
let isPolling = false;

/**
 * Check if quota protection is enabled in config
 * @returns {boolean}
 */
function isQuotaProtectionEnabled() {
    return config?.health?.quotaThresholdEnabled === true;
}

/**
 * Get poll interval from config or default
 * @returns {number} Interval in milliseconds
 */
function getPollInterval() {
    return config?.health?.quotaPollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Poll quotas for all enabled accounts
 * Uses the existing getModelQuotas + checkAccountQuotas flow
 */
async function pollAllAccountQuotas() {
    if (isPolling) {
        logger.debug('[QuotaPoller] Skipping poll, previous poll still running');
        return;
    }

    if (!isQuotaProtectionEnabled()) {
        logger.debug('[QuotaPoller] Quota protection disabled, skipping poll');
        return;
    }

    if (!accountManager) {
        logger.warn('[QuotaPoller] AccountManager not initialized');
        return;
    }

    isPolling = true;
    const startTime = Date.now();

    try {
        const accounts = accountManager.getAccounts().filter(a => a.enabled);

        if (accounts.length === 0) {
            logger.debug('[QuotaPoller] No enabled accounts to poll');
            return;
        }

        logger.debug(`[QuotaPoller] Polling quotas for ${accounts.length} accounts`);

        let totalChanges = 0;

        for (const account of accounts) {
            try {
                // Use existing getModelQuotas method
                const quotas = await accountManager.getModelQuotas(account.email);

                if (quotas && Object.keys(quotas).length > 0) {
                    // Use existing checkAccountQuotas method
                    const changes = accountManager.checkAccountQuotas(account.email, quotas);
                    totalChanges += changes.length;
                }
            } catch (err) {
                // Log but don't fail the entire poll
                logger.debug(`[QuotaPoller] Failed to poll ${account.email}: ${err.message}`);
            }
        }

        const duration = Date.now() - startTime;
        if (totalChanges > 0) {
            logger.info(`[QuotaPoller] Poll complete: ${totalChanges} quota changes detected (${duration}ms)`);
        } else {
            logger.debug(`[QuotaPoller] Poll complete: no changes (${duration}ms)`);
        }
    } catch (err) {
        logger.error(`[QuotaPoller] Poll failed: ${err.message}`);
    } finally {
        isPolling = false;
    }
}

/**
 * Start the quota polling loop
 */
function startPolling() {
    if (pollInterval) {
        logger.debug('[QuotaPoller] Already running');
        return;
    }

    if (!isQuotaProtectionEnabled()) {
        logger.debug('[QuotaPoller] Quota protection disabled, not starting poller');
        return;
    }

    const interval = getPollInterval();
    logger.info(`[QuotaPoller] Starting with ${Math.round(interval / 60000)}min interval`);

    // Run initial poll after a short delay (let server fully start)
    setTimeout(() => {
        pollAllAccountQuotas();
    }, 10000); // 10 second initial delay

    // Start periodic polling
    pollInterval = setInterval(pollAllAccountQuotas, interval);
}

/**
 * Stop the quota polling loop
 */
function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        logger.info('[QuotaPoller] Stopped');
    }
}

/**
 * Restart polling (call when config changes)
 */
function restartPolling() {
    stopPolling();
    startPolling();
}

/**
 * Initialize the quota poller with account manager reference
 * @param {Object} am - AccountManager instance
 */
export function initialize(am) {
    accountManager = am;

    // Start if quota protection is enabled
    if (isQuotaProtectionEnabled()) {
        startPolling();
    }

    logger.info('[QuotaPoller] Initialized' + (isQuotaProtectionEnabled() ? ' (active)' : ' (inactive)'));
}

/**
 * Handle config change - restart or stop poller as needed
 * Should be called when health config is updated
 */
export function onConfigChange() {
    if (isQuotaProtectionEnabled()) {
        if (!pollInterval) {
            startPolling();
        }
    } else {
        stopPolling();
    }
}

/**
 * Force an immediate poll (useful for testing or manual trigger)
 */
export function pollNow() {
    return pollAllAccountQuotas();
}

/**
 * Get poller status
 * @returns {Object} Status info
 */
export function getStatus() {
    return {
        running: pollInterval !== null,
        quotaProtectionEnabled: isQuotaProtectionEnabled(),
        pollIntervalMs: getPollInterval(),
        isPolling
    };
}

export default {
    initialize,
    onConfigChange,
    pollNow,
    getStatus,
    startPolling,
    stopPolling,
    restartPolling
};
