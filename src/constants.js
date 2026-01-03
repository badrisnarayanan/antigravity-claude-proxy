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

// Endpoint fallback order (daily → prod)
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_PROD
];

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

// Gemini signature handling
// Sentinel value to skip thought signature validation when Claude Code strips the field
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

// Cache TTL for Gemini thoughtSignatures (2 hours)
export const GEMINI_SIGNATURE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Get the model family from model name (dynamic detection, no hardcoded list).
 * @param {string} modelName - The model name from the request
 * @returns {'claude' | 'gemini' | 'unknown'} The model family
 */
export function getModelFamily(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gpt-oss')) return 'claude';  // GPT-OSS shares Claude quota group
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

// Model fallback mapping - maps primary model to fallback when quota exhausted
export const MODEL_FALLBACK_MAP = {
    'gemini-3-pro-high': 'claude-opus-4-5-thinking',
    'gemini-3-pro-low': 'claude-sonnet-4-5',
    'gemini-3-flash': 'claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking': 'gemini-3-pro-high',
    'claude-sonnet-4-5-thinking': 'gemini-3-flash',
    'claude-sonnet-4-5': 'gemini-3-flash'
};

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
    MIN_SIGNATURE_LENGTH,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_SKIP_SIGNATURE,
    GEMINI_SIGNATURE_CACHE_TTL_MS,
    getModelFamily,
    isThinkingModel,
    OAUTH_CONFIG,
    OAUTH_REDIRECT_URI,
    MODEL_FALLBACK_MAP
};
