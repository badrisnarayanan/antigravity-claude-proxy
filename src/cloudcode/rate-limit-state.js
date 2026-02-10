/**
 * Rate Limit State Management
 *
 * Shared utilities for rate limit tracking, backoff calculation,
 * and error classification. Used by both streaming and non-streaming handlers.
 */

import {
    RATE_LIMIT_DEDUP_WINDOW_MS,
    RATE_LIMIT_STATE_RESET_MS,
    FIRST_RETRY_DELAY_MS,
    BACKOFF_BY_ERROR_TYPE,
    QUOTA_EXHAUSTED_BACKOFF_TIERS_MS,
    MIN_BACKOFF_MS,
    CAPACITY_JITTER_MAX_MS
} from '../constants.js';
import { generateJitter } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseRateLimitReason } from './rate-limit-parser.js';

/**
 * Rate limit deduplication - prevents thundering herd on concurrent rate limits.
 * Tracks rate limit state per account+model including consecutive429 count and timestamps.
 *
 * This is a singleton Map shared across all handlers (streaming and non-streaming).
 */
const rateLimitStateByAccountModel = new Map(); // `${email}:${model}` -> { consecutive429, lastAt }

/**
 * Get deduplication key for rate limit tracking
 * @param {string} email - Account email
 * @param {string} model - Model ID
 * @returns {string} Dedup key
 */
export function getDedupKey(email, model) {
    return `${email}:${model}`;
}

/**
 * Get rate limit backoff with deduplication and exponential backoff (matches opencode-antigravity-auth)
 * @param {string} email - Account email
 * @param {string} model - Model ID
 * @param {number|null} serverRetryAfterMs - Server-provided retry time
 * @returns {{attempt: number, delayMs: number, isDuplicate: boolean}} Backoff info
 */
export function getRateLimitBackoff(email, model, serverRetryAfterMs) {
    const now = Date.now();
    const stateKey = getDedupKey(email, model);
    const previous = rateLimitStateByAccountModel.get(stateKey);

    // Check if within dedup window - return duplicate status
    if (previous && (now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS)) {
        const baseDelay = serverRetryAfterMs ?? FIRST_RETRY_DELAY_MS;
        const backoffDelay = Math.min(baseDelay * Math.pow(2, previous.consecutive429 - 1), 60000);
        logger.debug(`[CloudCode] Rate limit on ${email}:${model} within dedup window, attempt=${previous.consecutive429}, isDuplicate=true`);
        return { attempt: previous.consecutive429, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: true };
    }

    // Determine attempt number - reset after RATE_LIMIT_STATE_RESET_MS of inactivity
    const attempt = previous && (now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS)
        ? previous.consecutive429 + 1
        : 1;

    // Update state
    rateLimitStateByAccountModel.set(stateKey, { consecutive429: attempt, lastAt: now });

    // Calculate exponential backoff
    const baseDelay = serverRetryAfterMs ?? FIRST_RETRY_DELAY_MS;
    const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), 60000);

    logger.debug(`[CloudCode] Rate limit backoff for ${email}:${model}: attempt=${attempt}, delayMs=${Math.max(baseDelay, backoffDelay)}`);
    return { attempt, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: false };
}

/**
 * Clear rate limit state after successful request
 * @param {string} email - Account email
 * @param {string} model - Model ID
 */
export function clearRateLimitState(email, model) {
    const key = getDedupKey(email, model);
    rateLimitStateByAccountModel.delete(key);
}

/**
 * Detect permanent authentication failures that require re-authentication.
 * These should mark the account as invalid rather than just clearing cache.
 * @param {string} errorText - Error message from API
 * @returns {boolean} True if permanent auth failure
 */
export function isPermanentAuthFailure(errorText) {
    const lower = (errorText || '').toLowerCase();
    return lower.includes('invalid_grant') ||
        lower.includes('token revoked') ||
        lower.includes('token has been expired or revoked') ||
        lower.includes('token_revoked') ||
        lower.includes('invalid_client') ||
        lower.includes('credentials are invalid');
}

/**
 * Detect if 403 error is due to VALIDATION_REQUIRED or PERMISSION_DENIED.
 * These are account-level errors that should trigger account rotation,
 * not just endpoint rotation. The account needs validation (e.g., captcha,
 * terms acceptance) which cannot be resolved by trying different endpoints.
 * @param {string} errorText - Error message from API
 * @returns {boolean} True if validation/permission error requiring account rotation
 */
export function isValidationRequired(errorText) {
    const lower = (errorText || '').toLowerCase();
    return lower.includes('validation_required') ||
        lower.includes('account_disabled') ||
        lower.includes('user_disabled');
}

/**
 * Extract the Google verification URL from an error message.
 * The 403 VALIDATION_REQUIRED error contains a URL the user must visit.
 * @param {string} errorText - Error message from the API
 * @returns {string|null} The verification URL, or null if not found
 */
export function extractVerificationUrl(errorText) {
    if (!errorText) return null;
    const match = errorText.match(/https:\/\/accounts\.google\.com\/signin\/continue\?[^\s"\\,.)\]}>]+/);
    return match ? match[0] : null;
}

/**
 * Detect if 429 error is due to model capacity (not user quota).
 * Capacity issues should retry on same account with shorter delay.
 * @param {string} errorText - Error message from API
 * @returns {boolean} True if capacity exhausted (not quota)
 */
export function isModelCapacityExhausted(errorText) {
    const lower = (errorText || '').toLowerCase();
    return lower.includes('model_capacity_exhausted') ||
        lower.includes('capacity_exhausted') ||
        lower.includes('model is currently overloaded') ||
        lower.includes('service temporarily unavailable');
}

/**
 * Calculate smart backoff based on error type (matches opencode-antigravity-auth)
 * @param {string} errorText - Error message
 * @param {number|null} serverResetMs - Reset time from server
 * @param {number} consecutiveFailures - Number of consecutive failures
 * @returns {number} Backoff time in milliseconds
 */
export function calculateSmartBackoff(errorText, serverResetMs, consecutiveFailures = 0) {
    // If server provides a reset time, use it (with minimum floor to prevent loops)
    if (serverResetMs && serverResetMs > 0) {
        return Math.max(serverResetMs, MIN_BACKOFF_MS);
    }

    const reason = parseRateLimitReason(errorText);

    switch (reason) {
        case 'QUOTA_EXHAUSTED':
            // Progressive backoff: [60s, 5m, 30m, 2h]
            const tierIndex = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFF_TIERS_MS.length - 1);
            return QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[tierIndex];
        case 'RATE_LIMIT_EXCEEDED':
            return BACKOFF_BY_ERROR_TYPE.RATE_LIMIT_EXCEEDED;
        case 'MODEL_CAPACITY_EXHAUSTED':
            // Apply jitter to prevent thundering herd - clients retry at staggered times
            return BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED + generateJitter(CAPACITY_JITTER_MAX_MS);
        case 'SERVER_ERROR':
            return BACKOFF_BY_ERROR_TYPE.SERVER_ERROR;
        default:
            return BACKOFF_BY_ERROR_TYPE.UNKNOWN;
    }
}

// Periodically clean up stale rate limit state (every 60 seconds)
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_STATE_RESET_MS;
    for (const [key, state] of rateLimitStateByAccountModel.entries()) {
        if (state.lastAt < cutoff) {
            rateLimitStateByAccountModel.delete(key);
        }
    }
}, 60000);
