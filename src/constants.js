/**
 * Constants for Antigravity Cloud Code API integration
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import { homedir, platform, arch } from "os";
import { join } from "path";
import { config } from "./config.js";

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
    case "darwin":
      return join(
        home,
        "Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
      );
    case "win32":
      return join(
        home,
        "AppData/Roaming/Antigravity/User/globalStorage/state.vscdb"
      );
    default: // linux, freebsd, etc.
      return join(home, ".config/Antigravity/User/globalStorage/state.vscdb");
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
export const ANTIGRAVITY_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

// Endpoint fallback order (daily → prod) - used for Antigravity mode
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
];

// CLI mode uses prod first, then daily
export const GEMINI_CLI_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
];

/**
 * Get endpoints in correct order based on header mode
 * CLI mode: prod first (more stable for gemini-cli headers)
 * Antigravity mode: daily first (sandbox for antigravity headers)
 * @param {string} headerMode - 'cli' or 'antigravity'
 * @returns {string[]} Endpoints in fallback order
 */
export function getEndpointsForHeaderMode(headerMode) {
  return headerMode === "cli"
    ? GEMINI_CLI_ENDPOINT_FALLBACKS
    : ANTIGRAVITY_ENDPOINT_FALLBACKS;
}

// Required headers for Antigravity API requests
export const ANTIGRAVITY_HEADERS = {
  "User-Agent": getPlatformUserAgent(),
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": JSON.stringify({
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  }),
};

// Headers for Gemini CLI models (mimicking google-api-nodejs-client)
export const GEMINI_CLI_HEADERS = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata":
    "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

// Default project ID if none can be discovered
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

// Configurable constants - values from config.json take precedence
export const TOKEN_REFRESH_INTERVAL_MS =
  config?.tokenCacheTtlMs || 5 * 60 * 1000; // From config or 5 minutes
export const REQUEST_BODY_LIMIT = config?.requestBodyLimit || "50mb";
export const ANTIGRAVITY_AUTH_PORT = 9092;
export const DEFAULT_PORT = config?.port || 8672;

// Multi-account configuration
export const ACCOUNT_CONFIG_PATH =
  config?.accountConfigPath ||
  join(homedir(), ".config/antigravity-proxy/accounts.json");

// Usage history persistence path
export const USAGE_HISTORY_PATH = join(
  homedir(),
  ".config/antigravity-proxy/usage-history.json"
);

// Antigravity app database path (for legacy single-account token extraction)
// Uses platform-specific path detection
export const ANTIGRAVITY_DB_PATH = getAntigravityDbPath();

export const DEFAULT_COOLDOWN_MS = config?.defaultCooldownMs || 10 * 1000; // From config or 10 seconds
export const MAX_RETRIES = config?.maxRetries || 5; // From config or 5
export const MAX_EMPTY_RESPONSE_RETRIES = 2; // Max retries for empty API responses (from upstream)
export const MAX_ACCOUNTS = config?.maxAccounts || 10; // From config or 10

// Rate limit wait thresholds
export const MAX_WAIT_BEFORE_ERROR_MS = config?.maxWaitBeforeErrorMs || 120000; // From config or 2 minutes
export const STICKY_COOLDOWN_THRESHOLD_MS = 15000; // 15 seconds - wait for sticky account if reset is within this time, even if others are available
export const MAX_CONCURRENT_REQUESTS = 2; // Maximum concurrent requests per account

// Thinking model constants
export const MIN_SIGNATURE_LENGTH = 50; // Minimum valid thinking signature length

// Gemini-specific limits
export const GEMINI_MAX_OUTPUT_TOKENS = 16384;

// Default max tokens for requests if not specified
export const DEFAULT_MAX_TOKENS = config?.defaultMaxTokens || 4096;

// Default max context tokens (0 = unlimited/disabled)
// Set to 30k as requested to balance context retention and cost savings
export const DEFAULT_MAX_CONTEXT_TOKENS = config?.maxContextTokens || 60000;

// Gemini signature handling
// Sentinel value to skip thought signature validation when Claude Code strips the field
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

// Cache TTL for Gemini thoughtSignatures (2 hours)
export const GEMINI_SIGNATURE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Get the model family from model name (dynamic detection, no hardcoded list).
 * @param {string} modelName - The model name from the request
 * @returns {'claude' | 'gemini' | 'unknown'} The model family
 */
export function getModelFamily(modelName) {
  const lower = (modelName || "").toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("gpt")) return "gpt";
  return "unknown";
}

/**
 * Check if a model supports thinking/reasoning output.
 * @param {string} modelName - The model name from the request
 * @returns {boolean} True if the model supports thinking blocks
 */
export function isThinkingModel(modelName) {
  const lower = (modelName || "").toLowerCase();
  // Claude thinking models have "thinking" in the name
  if (lower.includes("claude") && lower.includes("thinking")) return true;
  // Gemini thinking models: explicit "thinking" in name, OR gemini version 3+
  if (lower.includes("gemini")) {
    if (lower.includes("thinking")) return true;
    // Check for gemini-3 or higher (e.g., gemini-3, gemini-3.5, gemini-4, etc.)
    const versionMatch = lower.match(/gemini-(\d+)/);
    if (versionMatch && parseInt(versionMatch[1], 10) >= 3) return true;
  }
  return false;
}

// Google OAuth configuration (from opencode-antigravity-auth)
// Client ID and Secret can be overridden via environment variables
export const OAUTH_CONFIG = {
  clientId:
    process.env.OAUTH_CLIENT_ID ||
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret:
    process.env.OAUTH_CLIENT_SECRET || "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",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  callbackPort: parseInt(process.env.OAUTH_CALLBACK_PORT) || 51121,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
};
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;

// Minimal Antigravity system instruction (from CLIProxyAPI)
// Only includes the essential identity portion to reduce token usage and improve response quality
// Reference: GitHub issue #76, CLIProxyAPI, gcli2api
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**`;

// Model fallback mapping - maps primary model to fallback when quota exhausted
export const MODEL_FALLBACK_MAP = {
  "gemini-3-pro-high": "claude-opus-4-5-thinking",
  "gemini-3-pro-low": "claude-sonnet-4-5",
  "gemini-3-flash": "claude-sonnet-4-5-thinking",
  "claude-opus-4-5-thinking": "gemini-3-pro-high",
  "claude-sonnet-4-5-thinking": "gemini-3-flash",
  "claude-sonnet-4-5": "gemini-3-flash",
};

export default {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  DEFAULT_PROJECT_ID,
  TOKEN_REFRESH_INTERVAL_MS,
  REQUEST_BODY_LIMIT,
  ANTIGRAVITY_AUTH_PORT,
  DEFAULT_PORT,
  ACCOUNT_CONFIG_PATH,
  ANTIGRAVITY_DB_PATH,
  DEFAULT_COOLDOWN_MS,
  MAX_RETRIES,
  MAX_EMPTY_RESPONSE_RETRIES,
  MAX_ACCOUNTS,
  MAX_WAIT_BEFORE_ERROR_MS,
  MIN_SIGNATURE_LENGTH,
  GEMINI_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOKENS,
  GEMINI_SKIP_SIGNATURE,
  GEMINI_SIGNATURE_CACHE_TTL_MS,
  getModelFamily,
  isThinkingModel,
  OAUTH_CONFIG,
  OAUTH_REDIRECT_URI,
  MODEL_FALLBACK_MAP,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
};
