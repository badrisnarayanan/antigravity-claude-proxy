import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './utils/logger.js';

// Default config
const DEFAULT_CONFIG = {
    apiKey: '',
    webuiPassword: '',
    debug: false,
    devMode: false,
    logLevel: 'info',
    maxRetries: 5,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    persistTokenCache: false,
    defaultCooldownMs: 10000,  // 10 seconds
    maxWaitBeforeErrorMs: 120000, // 2 minutes
    maxAccounts: 10, // Maximum number of accounts allowed
    globalQuotaThreshold: 0, // 0 = disabled, 0.01-0.99 = minimum quota fraction before switching accounts
    // Rate limit handling (matches opencode-antigravity-auth)
    rateLimitDedupWindowMs: 2000,  // 2 seconds - prevents concurrent retry storms
    maxConsecutiveFailures: 3,     // Before applying extended cooldown
    extendedCooldownMs: 60000,     // 1 minute extended cooldown
    maxCapacityRetries: 5,         // Max retries for capacity exhaustion
    modelMapping: {},
    // Account selection strategy configuration
    accountSelection: {
        strategy: 'hybrid',           // 'sticky' | 'round-robin' | 'hybrid'
        // Hybrid strategy tuning (optional - sensible defaults)
        healthScore: {
            initial: 70,              // Starting score for new accounts
            successReward: 1,         // Points on successful request
            rateLimitPenalty: -10,    // Points on rate limit
            failurePenalty: -20,      // Points on other failures
            recoveryPerHour: 2,       // Passive recovery rate
            minUsable: 50,            // Minimum score to be selected
            maxScore: 100             // Maximum score cap
        },
        tokenBucket: {
            maxTokens: 50,            // Maximum token capacity
            tokensPerMinute: 6,       // Regeneration rate
            initialTokens: 50         // Starting tokens
        },
        quota: {
            lowThreshold: 0.10,       // 10% - reduce score
            criticalThreshold: 0.05,  // 5% - exclude from candidates
            staleMs: 300000           // 5 min - max age of quota data to trust
        }
    }
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

// Load config
let config = { ...DEFAULT_CONFIG };

function isReadableFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}

function loadConfig() {
    try {
        // Env vars take precedence for initial defaults, but file overrides them if present?
        // Usually Env > File > Default.

        if (fs.existsSync(CONFIG_FILE)) {
            if (isReadableFile(CONFIG_FILE)) {
                const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
                const userConfig = JSON.parse(fileContent);
                config = { ...DEFAULT_CONFIG, ...userConfig };
            } else {
                logger.warn(
                    `[Config] Config path exists but is not a file (did you mount a directory?): ${CONFIG_FILE}. Skipping file config.`
                );
            }
        } else {
             // Try looking in current dir for config.json as fallback
             const localConfigPath = path.resolve('config.json');
             if (fs.existsSync(localConfigPath)) {
                 if (isReadableFile(localConfigPath)) {
                     const fileContent = fs.readFileSync(localConfigPath, 'utf8');
                     const userConfig = JSON.parse(fileContent);
                     config = { ...DEFAULT_CONFIG, ...userConfig };
                 } else {
                     logger.warn(
                         `[Config] Local config path exists but is not a file: ${localConfigPath}. Skipping file config.`
                     );
                 }
             }
        }

        // Environment overrides
        if (process.env.API_KEY) config.apiKey = process.env.API_KEY;
        if (process.env.WEBUI_PASSWORD) config.webuiPassword = process.env.WEBUI_PASSWORD;
        if (process.env.DEBUG === 'true') config.debug = true;
        if (process.env.DEV_MODE === 'true') config.devMode = true;

        // Backward compat: debug implies devMode
        if (config.debug && !config.devMode) config.devMode = true;

    } catch (error) {
        logger.error('[Config] Error loading config:', error);
    }
}

// Initial load
loadConfig();

export function getPublicConfig() {
    // Create a deep copy and redact sensitive fields
    const publicConfig = JSON.parse(JSON.stringify(config));

    // Redact sensitive values
    if (publicConfig.webuiPassword) publicConfig.webuiPassword = '********';
    if (publicConfig.apiKey) publicConfig.apiKey = '********';

    return publicConfig;
}

export function saveConfig(updates) {
    try {
        // Apply updates
        config = { ...config, ...updates };

        // Save to disk
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('[Config] Failed to save config:', error);
        return false;
    }
}

export { config };