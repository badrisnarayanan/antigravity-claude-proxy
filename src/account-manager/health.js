/**
 * Account Health Management
 *
 * Tracks health status for each account × model combination.
 * Provides automatic disabling of unhealthy combinations and
 * supports manual enable/disable and health reset.
 */

import { logger } from '../utils/logger.js';
import { config, saveConfig } from '../config.js';
import eventManager from '../modules/event-manager.js';

// Default configuration values
const DEFAULT_CONFIG = {
    // Number of consecutive failures before auto-disabling
    consecutiveFailureThreshold: 5,
    // Health score threshold for warnings (percentage)
    warningThreshold: 70,
    // Health score threshold for critical (percentage)
    criticalThreshold: 50,
    // Enable automatic disabling
    autoDisableEnabled: true,
    // Auto-recovery time in ms (24 hours)
    autoRecoveryMs: 24 * 60 * 60 * 1000,
    // Event retention: max number of events to keep
    eventMaxCount: 10000,
    // Event retention: max age in days
    eventRetentionDays: 7
};

// Initialize config from main config.js or defaults
let healthConfig = {
    ...DEFAULT_CONFIG,
    ...((config && config.health) || {})
};

/**
 * Initialize health object for a model
 * @returns {Object} Fresh health tracking object
 */
function initHealth() {
    return {
        successCount: 0,
        failCount: 0,
        consecutiveFailures: 0,
        lastSuccess: null,
        lastError: null,
        healthScore: 100,
        disabled: false,
        manualDisabled: false,
        disabledReason: null,
        disabledAt: null
    };
}

/**
 * Calculate health score based on success/failure counts
 * Uses a weighted formula that penalizes recent consecutive failures
 *
 * @param {Object} health - Health tracking object
 * @returns {number} Health score (0-100)
 */
function calculateScore(health) {
    const total = health.successCount + health.failCount;
    if (total === 0) return 100;

    // Base score from success rate
    const baseScore = (health.successCount / total) * 100;

    // Penalty for consecutive failures (max 30 points)
    const consecutivePenalty = Math.min(health.consecutiveFailures * 6, 30);

    // Final score, clamped to 0-100
    return Math.max(0, Math.min(100, baseScore - consecutivePenalty));
}

/**
 * Record the result of a request for an account × model combination
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID
 * @param {boolean} success - Whether the request was successful
 * @param {Object|null} error - Error object if failed
 * @returns {Object} Updated health object
 */
export function recordResult(account, modelId, success, error = null) {
    if (!account) return null;

    // Initialize health tracking if not exists
    if (!account.health) {
        account.health = {};
    }
    if (!account.health[modelId]) {
        account.health[modelId] = initHealth();
    }

    const health = account.health[modelId];

    if (success) {
        health.successCount++;
        health.consecutiveFailures = 0;
        health.lastSuccess = new Date().toISOString();

        // Check for auto-recovery of disabled combination
        if (health.disabled && !health.manualDisabled) {
            health.disabled = false;
            health.disabledReason = null;
            health.disabledAt = null;
            logger.success(`[Health] Auto-recovered: ${account.email} × ${modelId}`);
            // Record health change event
            eventManager.recordHealthChange(account.email, modelId, 'recovered', {
                previousState: 'disabled',
                trigger: 'successful_request'
            });
        }
    } else {
        health.failCount++;
        health.consecutiveFailures++;
        health.lastError = {
            message: error?.message || 'Unknown error',
            code: error?.code || error?.statusCode || null,
            timestamp: new Date().toISOString()
        };

        // Check auto-disable threshold
        if (
            healthConfig.autoDisableEnabled &&
            !health.disabled &&
            !health.manualDisabled &&
            health.consecutiveFailures >= healthConfig.consecutiveFailureThreshold
        ) {
            health.disabled = true;
            health.disabledReason = `Auto: ${health.consecutiveFailures} consecutive failures`;
            health.disabledAt = new Date().toISOString();
            logger.warn(`[Health] Auto-disabled: ${account.email} × ${modelId} (${health.consecutiveFailures} consecutive failures)`);
            // Record health change event
            eventManager.recordHealthChange(account.email, modelId, 'disabled', {
                reason: health.disabledReason,
                consecutiveFailures: health.consecutiveFailures,
                lastError: health.lastError
            });
        }
    }

    // Recalculate health score
    health.healthScore = calculateScore(health);

    // Log health score changes for monitoring
    if (health.healthScore < healthConfig.criticalThreshold) {
        logger.error(`[Health] Critical: ${account.email} × ${modelId} score=${health.healthScore.toFixed(1)}%`);
    } else if (health.healthScore < healthConfig.warningThreshold) {
        logger.warn(`[Health] Warning: ${account.email} × ${modelId} score=${health.healthScore.toFixed(1)}%`);
    }

    return health;
}

/**
 * Check if a model is usable for a given account
 * Returns false if the combination is disabled (auto or manual)
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID
 * @returns {boolean} True if model is usable for this account
 */
export function isModelUsable(account, modelId) {
    if (!account?.health?.[modelId]) {
        return true; // No health data = usable
    }

    const health = account.health[modelId];

    // Check auto-recovery for disabled combinations
    if (health.disabled && !health.manualDisabled && health.disabledAt) {
        const disabledTime = Date.now() - new Date(health.disabledAt).getTime();
        if (disabledTime > healthConfig.autoRecoveryMs) {
            // Auto-recover: reset consecutive failures and enable
            health.disabled = false;
            health.consecutiveFailures = 0;
            health.disabledReason = null;
            health.disabledAt = null;
            logger.info(`[Health] Auto-recovery triggered: ${account.email} × ${modelId}`);
            // Record health change event
            eventManager.recordHealthChange(account.email, modelId, 'recovered', {
                previousState: 'disabled',
                trigger: 'auto_recovery_timeout',
                disabledDurationMs: disabledTime
            });
            return true;
        }
    }

    return !health.disabled && !health.manualDisabled;
}

/**
 * Toggle manual enable/disable for an account × model combination
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID
 * @param {boolean} enabled - Whether to enable or disable
 * @returns {Object} Updated health object
 */
export function toggleModel(account, modelId, enabled) {
    if (!account) return null;

    if (!account.health) {
        account.health = {};
    }
    if (!account.health[modelId]) {
        account.health[modelId] = initHealth();
    }

    const health = account.health[modelId];
    health.manualDisabled = !enabled;

    if (enabled) {
        // When manually enabling, also clear auto-disable
        health.disabled = false;
        health.disabledReason = null;
        health.disabledAt = null;
        logger.info(`[Health] Manually enabled: ${account.email} × ${modelId}`);
    } else {
        health.disabledReason = 'Manually disabled';
        health.disabledAt = new Date().toISOString();
        logger.info(`[Health] Manually disabled: ${account.email} × ${modelId}`);
    }

    return health;
}

/**
 * Reset health tracking for an account × model combination
 * Clears all counters and enables the combination
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID (or null to reset all models)
 * @returns {boolean} True if reset was successful
 */
export function resetHealth(account, modelId = null) {
    if (!account) return false;

    if (modelId) {
        // Reset single model
        if (account.health?.[modelId]) {
            account.health[modelId] = initHealth();
            logger.info(`[Health] Reset: ${account.email} × ${modelId}`);
        }
    } else {
        // Reset all models
        account.health = {};
        logger.info(`[Health] Reset all: ${account.email}`);
    }

    return true;
}

/**
 * Get health data for an account
 *
 * @param {Object} account - Account object
 * @returns {Object} Health data for all models
 */
export function getAccountHealth(account) {
    if (!account) return {};
    return account.health || {};
}

/**
 * Get health data for a specific account × model combination
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID
 * @returns {Object|null} Health data or null if not tracked
 */
export function getModelHealth(account, modelId) {
    if (!account?.health?.[modelId]) return null;
    return { ...account.health[modelId] };
}

/**
 * Build health matrix data for all accounts × models
 *
 * @param {Array} accounts - Array of account objects
 * @param {Array} modelIds - Array of model IDs to include
 * @returns {Object} Matrix data with accounts and their model health
 */
export function buildHealthMatrix(accounts, modelIds) {
    const matrix = {
        accounts: [],
        models: modelIds,
        generated: new Date().toISOString()
    };

    for (const account of accounts) {
        const accountData = {
            email: account.email,
            enabled: account.enabled !== false,
            models: {}
        };

        for (const modelId of modelIds) {
            const health = account.health?.[modelId];
            if (health) {
                accountData.models[modelId] = {
                    healthScore: health.healthScore,
                    successCount: health.successCount,
                    failCount: health.failCount,
                    consecutiveFailures: health.consecutiveFailures,
                    disabled: health.disabled || health.manualDisabled,
                    manualDisabled: health.manualDisabled,
                    lastError: health.lastError,
                    lastSuccess: health.lastSuccess
                };
            } else {
                // No data - show as healthy with no activity
                accountData.models[modelId] = {
                    healthScore: 100,
                    successCount: 0,
                    failCount: 0,
                    consecutiveFailures: 0,
                    disabled: false,
                    manualDisabled: false,
                    lastError: null,
                    lastSuccess: null
                };
            }
        }

        matrix.accounts.push(accountData);
    }

    return matrix;
}

/**
 * Get current health configuration
 * @returns {Object} Health configuration
 */
export function getHealthConfig() {
    return { ...healthConfig };
}

/**
 * Validate health configuration values
 * @param {Object} config - Configuration to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateHealthConfig(config) {
    const errors = [];

    // Validate consecutiveFailureThreshold (must be positive integer)
    if (config.consecutiveFailureThreshold !== undefined) {
        const val = config.consecutiveFailureThreshold;
        if (!Number.isInteger(val) || val < 1) {
            errors.push('consecutiveFailureThreshold must be a positive integer (>= 1)');
        }
    }

    // Validate warningThreshold (0-100 percentage)
    if (config.warningThreshold !== undefined) {
        const val = config.warningThreshold;
        if (typeof val !== 'number' || val < 0 || val > 100) {
            errors.push('warningThreshold must be a number between 0 and 100');
        }
    }

    // Validate criticalThreshold (0-100 percentage)
    if (config.criticalThreshold !== undefined) {
        const val = config.criticalThreshold;
        if (typeof val !== 'number' || val < 0 || val > 100) {
            errors.push('criticalThreshold must be a number between 0 and 100');
        }
    }

    // Validate thresholds relationship (warning should be >= critical)
    const warning = config.warningThreshold ?? healthConfig.warningThreshold;
    const critical = config.criticalThreshold ?? healthConfig.criticalThreshold;
    if (warning < critical) {
        errors.push('warningThreshold must be greater than or equal to criticalThreshold');
    }

    // Validate autoRecoveryMs (must be positive)
    if (config.autoRecoveryMs !== undefined) {
        const val = config.autoRecoveryMs;
        if (typeof val !== 'number' || val <= 0) {
            errors.push('autoRecoveryMs must be a positive number');
        }
    }

    // Validate autoDisableEnabled (must be boolean)
    if (config.autoDisableEnabled !== undefined) {
        if (typeof config.autoDisableEnabled !== 'boolean') {
            errors.push('autoDisableEnabled must be a boolean');
        }
    }

    // Validate eventMaxCount (must be positive integer, 1000-50000)
    if (config.eventMaxCount !== undefined) {
        const val = config.eventMaxCount;
        if (!Number.isInteger(val) || val < 1000 || val > 50000) {
            errors.push('eventMaxCount must be an integer between 1000 and 50000');
        }
    }

    // Validate eventRetentionDays (must be positive integer, 1-30)
    if (config.eventRetentionDays !== undefined) {
        const val = config.eventRetentionDays;
        if (!Number.isInteger(val) || val < 1 || val > 30) {
            errors.push('eventRetentionDays must be an integer between 1 and 30');
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Update health configuration
 * @param {Object} newConfig - New configuration values
 * @returns {Object} Updated configuration or error object
 */
export function setHealthConfig(newConfig) {
    // Validate the new configuration
    const validation = validateHealthConfig(newConfig);
    if (!validation.valid) {
        logger.warn(`[Health] Invalid configuration: ${validation.errors.join(', ')}`);
        return { error: true, errors: validation.errors };
    }

    healthConfig = {
        ...healthConfig,
        ...newConfig
    };

    // Persist to main config file
    saveConfig({ health: healthConfig });

    logger.info('[Health] Configuration updated and persisted');
    return { ...healthConfig };
}

/**
 * Get summary statistics for all accounts
 *
 * @param {Array} accounts - Array of account objects
 * @returns {Object} Summary statistics
 */
export function getHealthSummary(accounts) {
    let totalCombinations = 0;
    let healthyCombinations = 0;
    let warningCombinations = 0;
    let criticalCombinations = 0;
    let disabledCombinations = 0;

    for (const account of accounts) {
        if (!account.health) continue;

        for (const [, health] of Object.entries(account.health)) {
            totalCombinations++;

            if (health.disabled || health.manualDisabled) {
                disabledCombinations++;
            } else if (health.healthScore < healthConfig.criticalThreshold) {
                criticalCombinations++;
            } else if (health.healthScore < healthConfig.warningThreshold) {
                warningCombinations++;
            } else {
                healthyCombinations++;
            }
        }
    }

    return {
        total: totalCombinations,
        healthy: healthyCombinations,
        warning: warningCombinations,
        critical: criticalCombinations,
        disabled: disabledCombinations,
        config: healthConfig
    };
}
