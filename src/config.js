import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './utils/logger.js';

// Default config
const DEFAULT_CONFIG = {
    webuiPassword: '',
    debug: false,
    logLevel: 'info',
    maxRetries: 5,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    persistTokenCache: false,
    defaultCooldownMs: 60000,  // 1 minute
    maxWaitBeforeErrorMs: 120000, // 2 minutes
    maxContextTokens: 30000, // Default to 30k tokens for context window
    modelMapping: {}
};

// Env Var Mapping (Env Name -> Config Key)
const ENV_MAPPING = {
    'WEBUI_PASSWORD': 'webuiPassword',
    'DEBUG': 'debug',
    'LOG_LEVEL': 'logLevel',
    'MAX_RETRIES': 'maxRetries',
    'RETRY_BASE_MS': 'retryBaseMs',
    'RETRY_MAX_MS': 'retryMaxMs',
    'PERSIST_TOKEN_CACHE': 'persistTokenCache',
    'DEFAULT_COOLDOWN_MS': 'defaultCooldownMs',
    'MAX_WAIT_BEFORE_ERROR_MS': 'maxWaitBeforeErrorMs',
    'MAX_CONTEXT_TOKENS': 'maxContextTokens'
};

// Config locations
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config', 'antigravity-proxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Ensure config dir exists
if (!fs.existsSync(CONFIG_DIR)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (err) {
        // Ignore
    }
}

let config = { ...DEFAULT_CONFIG };

/**
 * Type conversion for env vars
 */
function parseEnvValue(key, value, currentValue) {
    if (typeof currentValue === 'boolean') {
        return value === 'true' || value === '1';
    }
    if (typeof currentValue === 'number') {
        const parsed = Number(value);
        return isNaN(parsed) ? currentValue : parsed;
    }
    return value;
}

/**
 * Validate configuration values
 * Logs warnings for invalid values and resets them to defaults
 * @param {Object} cfg - Configuration object to validate
 * @returns {Object} Validated configuration
 */
function validateConfig(cfg) {
    const validated = { ...cfg };
    const warnings = [];

    // Validate numeric values with ranges
    const numericRanges = {
        maxRetries: { min: 1, max: 20, default: DEFAULT_CONFIG.maxRetries },
        retryBaseMs: { min: 100, max: 60000, default: DEFAULT_CONFIG.retryBaseMs },
        retryMaxMs: { min: 1000, max: 300000, default: DEFAULT_CONFIG.retryMaxMs },
        defaultCooldownMs: { min: 1000, max: 600000, default: DEFAULT_CONFIG.defaultCooldownMs },
        maxWaitBeforeErrorMs: { min: 5000, max: 600000, default: DEFAULT_CONFIG.maxWaitBeforeErrorMs },
    };

    for (const [key, range] of Object.entries(numericRanges)) {
        if (validated[key] !== undefined) {
            const value = Number(validated[key]);
            if (isNaN(value) || value < range.min || value > range.max) {
                warnings.push(`${key} must be between ${range.min} and ${range.max}, got ${validated[key]}`);
                validated[key] = range.default;
            } else {
                validated[key] = value;
            }
        }
    }

    // Validate boolean fields
    const booleanFields = ['debug', 'persistTokenCache'];
    for (const key of booleanFields) {
        if (validated[key] !== undefined && typeof validated[key] !== 'boolean') {
            validated[key] = String(validated[key]) === 'true';
        }
    }

    // Validate logLevel
    const validLogLevels = ['debug', 'info', 'warn', 'error'];
    if (validated.logLevel && !validLogLevels.includes(validated.logLevel)) {
        warnings.push(`logLevel must be one of ${validLogLevels.join(', ')}, got ${validated.logLevel}`);
        validated.logLevel = DEFAULT_CONFIG.logLevel;
    }

    // Validate modelMapping is an object
    if (validated.modelMapping !== undefined && typeof validated.modelMapping !== 'object') {
        warnings.push('modelMapping must be an object');
        validated.modelMapping = {};
    }

    // Log warnings
    for (const warning of warnings) {
        console.warn(`[Config] Warning: ${warning}`);
    }

    return validated;
}

function loadConfig() {
    try {
        let loadedConfig = { ...DEFAULT_CONFIG };

        // 1. Load File Config
        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const userConfig = JSON.parse(fileContent);
            loadedConfig = { ...loadedConfig, ...userConfig };
        } else {
             // Fallback to local config.json
             const localConfigPath = path.resolve('config.json');
             if (fs.existsSync(localConfigPath)) {
                 const fileContent = fs.readFileSync(localConfigPath, 'utf8');
                 const userConfig = JSON.parse(fileContent);
                 loadedConfig = { ...loadedConfig, ...userConfig };
             }
        }

        // 2. Apply Environment Overrides
        for (const [envName, configKey] of Object.entries(ENV_MAPPING)) {
            if (process.env[envName] !== undefined) {
                loadedConfig[configKey] = parseEnvValue(configKey, process.env[envName], DEFAULT_CONFIG[configKey]);
            }
        }

        // 3. Validate final config
        config = validateConfig(loadedConfig);

    } catch (error) {
        console.error('[Config] Error loading config:', error);
        // Fallback to defaults on catastrophic failure
        config = validateConfig(DEFAULT_CONFIG);
    }
}

// Initial load
loadConfig();

export function getPublicConfig() {
    return { ...config };
}

export function saveConfig(updates) {
    try {
        // Validate updates before applying
        const validatedUpdates = validateConfig({ ...config, ...updates });
        config = validatedUpdates;

        // Save to disk
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('[Config] Failed to save config:', error);
        return false;
    }
}

export { config };
