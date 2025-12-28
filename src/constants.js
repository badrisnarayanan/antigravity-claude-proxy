/**
 * Constants for Antigravity Cloud Code API integration
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import { homedir, platform, arch } from 'os';
import { join } from 'path';

/**
 * Get the Antigravity database path based on the current platform.
 * - macOS: ~/Library/Application Support/Antigravity/...
 * - Windows: ~/AppData/Roaming/Antigravity/...
 * - Linux/other: ~/.config/Antigravity/...
 * @returns {string} Full path to the Antigravity state database
 */
function getAntigravityDbPath() {
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
        case 'win32':
            return join(home, 'AppData/Roaming/Antigravity/User/globalStorage/state.vscdb');
        default: // linux, freebsd, etc.
            return join(home, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

/**
 * Generate platform-specific User-Agent string.
 * @returns {string} User-Agent in format "antigravity/version os/arch"
 */
function getPlatformUserAgent() {
    const os = platform();
    const architecture = arch();
    return `antigravity/1.11.5 ${os}/${architecture}`;
}

// Cloud Code API endpoints (in fallback order)
const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';

function isTruthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function parseEndpointList(envValue) {
    if (!envValue) return [];
    return envValue
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
}

function getEndpointFallbacks() {
    const fromEnv = parseEndpointList(process.env.ANTIGRAVITY_ENDPOINTS);
    let endpoints = fromEnv.length > 0 ? fromEnv : [ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_PROD];

    if (isTruthy(process.env.ANTIGRAVITY_DISABLE_DAILY)) {
        endpoints = endpoints.filter(endpoint => endpoint !== ANTIGRAVITY_ENDPOINT_DAILY);
    }

    if (endpoints.length === 0) {
        endpoints = [ANTIGRAVITY_ENDPOINT_PROD];
    }

    return endpoints;
}

// Endpoint fallback order (daily → prod by default)
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = getEndpointFallbacks();

// Required headers for Antigravity API requests
export const ANTIGRAVITY_HEADERS = {
    'User-Agent': getPlatformUserAgent(),
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
    })
};

// Default project ID if none can be discovered
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const TOKEN_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const REQUEST_BODY_LIMIT = '50mb';
export const ANTIGRAVITY_AUTH_PORT = 9092;
export const DEFAULT_PORT = 8080;
export const MODEL_CACHE_TTL_MS = parseInt(process.env.ANTIGRAVITY_MODEL_CACHE_TTL_MS || '300000', 10);
export const ENDPOINT_404_SKIP_THRESHOLD = parseInt(process.env.ANTIGRAVITY_ENDPOINT_404_SKIP_THRESHOLD || '0', 10);
export const ENDPOINT_404_SKIP_COOLDOWN_MS = parseInt(process.env.ANTIGRAVITY_ENDPOINT_404_SKIP_COOLDOWN_MS || '60000', 10);
export const MODEL_VALIDATION_ENABLED = !isTruthy(process.env.ANTIGRAVITY_DISABLE_MODEL_VALIDATION);

// Multi-account configuration
export const ACCOUNT_CONFIG_PATH = join(
    homedir(),
    '.config/antigravity-proxy/accounts.json'
);

// Antigravity app database path (for legacy single-account token extraction)
// Uses platform-specific path detection
export const ANTIGRAVITY_DB_PATH = getAntigravityDbPath();

export const DEFAULT_COOLDOWN_MS = 60 * 1000; // 1 minute default cooldown
export const MAX_RETRIES = 5; // Max retry attempts across accounts
export const MAX_ACCOUNTS = 10; // Maximum number of accounts allowed

// Rate limit wait thresholds
export const MAX_WAIT_BEFORE_ERROR_MS = 120000; // 2 minutes - throw error if wait exceeds this

// Thinking model constants
export const MIN_SIGNATURE_LENGTH = 50; // Minimum valid thinking signature length

// Gemini-specific limits
export const GEMINI_MAX_OUTPUT_TOKENS = 16384;
export const MODEL_ALIASES = parseModelAliases(
    process.env.ANTIGRAVITY_MODEL_ALIASES
    || process.env.ANTHROPIC_MODEL_ALIASES
    || process.env.MODEL_ALIASES
);

function parseModelAliases(input = '') {
    const raw = String(input || '').trim();
    if (!raw) return {};

    if (raw.startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return Object.fromEntries(
                    Object.entries(parsed).map(([key, value]) => [String(key).toLowerCase(), String(value)])
                );
            }
        } catch (error) {
            console.log('[Constants] Failed to parse MODEL_ALIASES JSON:', error.message);
        }
    }

    const aliases = {};
    const pairs = raw.split(/[;,]/).map(value => value.trim()).filter(Boolean);
    for (const pair of pairs) {
        const [from, to] = pair.split(/[:=]/).map(value => value.trim());
        if (from && to) {
            aliases[from.toLowerCase()] = to;
        }
    }

    return aliases;
}

export function resolveModelAlias(modelName) {
    if (!modelName) return modelName;
    const direct = MODEL_ALIASES[modelName];
    if (direct) return direct;
    const lower = String(modelName).toLowerCase();
    return MODEL_ALIASES[lower] || modelName;
}

/**
 * Get the model family from model name (dynamic detection, no hardcoded list).
 * @param {string} modelName - The model name from the request
 * @returns {'claude' | 'gemini' | 'unknown'} The model family
 */
export function getModelFamily(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    return 'unknown';
}

/**
 * Check if a model supports thinking/reasoning output.
 * @param {string} modelName - The model name from the request
 * @returns {boolean} True if the model supports thinking blocks
 */
export function isThinkingModel(modelName) {
    const lower = (modelName || '').toLowerCase();
    // Claude thinking models have "thinking" in the name
    if (lower.includes('claude') && lower.includes('thinking')) return true;
    // Gemini thinking models: explicit "thinking" in name, OR gemini version 3+
    if (lower.includes('gemini')) {
        if (lower.includes('thinking')) return true;
        // Check for gemini-3 or higher (e.g., gemini-3, gemini-3.5, gemini-4, etc.)
        const versionMatch = lower.match(/gemini-(\d+)/);
        if (versionMatch && parseInt(versionMatch[1], 10) >= 3) return true;
    }
    return false;
}

// Google OAuth configuration (from opencode-antigravity-auth)
export const OAUTH_CONFIG = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    callbackPort: 51121,
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;

export default {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    DEFAULT_PROJECT_ID,
    TOKEN_REFRESH_INTERVAL_MS,
    REQUEST_BODY_LIMIT,
    ANTIGRAVITY_AUTH_PORT,
    DEFAULT_PORT,
    ACCOUNT_CONFIG_PATH,
    ANTIGRAVITY_DB_PATH,
    DEFAULT_COOLDOWN_MS,
    MAX_RETRIES,
    MAX_ACCOUNTS,
    MAX_WAIT_BEFORE_ERROR_MS,
    MODEL_CACHE_TTL_MS,
    ENDPOINT_404_SKIP_THRESHOLD,
    ENDPOINT_404_SKIP_COOLDOWN_MS,
    MODEL_VALIDATION_ENABLED,
    MIN_SIGNATURE_LENGTH,
    GEMINI_MAX_OUTPUT_TOKENS,
    MODEL_ALIASES,
    getModelFamily,
    isThinkingModel,
    resolveModelAlias,
    OAUTH_CONFIG,
    OAUTH_REDIRECT_URI
};
