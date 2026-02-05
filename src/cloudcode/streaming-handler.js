/**
 * Streaming Handler for Cloud Code
 *
 * Handles streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_EMPTY_RESPONSE_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    DEFAULT_COOLDOWN_MS,
    RATE_LIMIT_DEDUP_WINDOW_MS,
    RATE_LIMIT_STATE_RESET_MS,
    FIRST_RETRY_DELAY_MS,
    SWITCH_ACCOUNT_DELAY_MS,
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_BACKOFF_TIERS_MS,
    MAX_CAPACITY_RETRIES,
    BACKOFF_BY_ERROR_TYPE,
    QUOTA_EXHAUSTED_BACKOFF_TIERS_MS,
    MIN_BACKOFF_MS
} from '../constants.js';
import { isRateLimitError, isAuthError, isEmptyResponseError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime, parseRateLimitReason } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getFallbackModel } from '../fallback-config.js';
import crypto from 'crypto';

/**
 * Rate limit deduplication - prevents thundering herd on concurrent rate limits.
 * Tracks rate limit state per account+model including consecutive429 count and timestamps.
 */
const rateLimitStateByAccountModel = new Map(); // `${email}:${model}` -> { consecutive429, lastAt }

/**
 * Get deduplication key for rate limit tracking
 * @param {string} email - Account email
 * @param {string} model - Model ID
 * @returns {string} Dedup key
 */
function getDedupKey(email, model) {
    return `${email}:${model}`;
}

/**
 * Get rate limit backoff with deduplication and exponential backoff (matches opencode-antigravity-auth)
 * @param {string} email - Account email
 * @param {string} model - Model ID
 * @param {number|null} serverRetryAfterMs - Server-provided retry time
 * @returns {{attempt: number, delayMs: number, isDuplicate: boolean}} Backoff info
 */
function getRateLimitBackoff(email, model, serverRetryAfterMs) {
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
function clearRateLimitState(email, model) {
    const key = getDedupKey(email, model);
    rateLimitStateByAccountModel.delete(key);
}

/**
 * Detect permanent authentication failures that require re-authentication.
 * @param {string} errorText - Error message from API
 * @returns {boolean} True if permanent auth failure
 */
function isPermanentAuthFailure(errorText) {
    const lower = (errorText || '').toLowerCase();
    return lower.includes('invalid_grant') ||
        lower.includes('token revoked') ||
        lower.includes('token has been expired or revoked') ||
        lower.includes('token_revoked') ||
        lower.includes('invalid_client') ||
        lower.includes('credentials are invalid');
}

/**
 * Detect if 429 error is due to model capacity (not user quota).
 * @param {string} errorText - Error message from API
 * @returns {boolean} True if capacity exhausted (not quota)
 */
function isModelCapacityExhausted(errorText) {
    const lower = (errorText || '').toLowerCase();
    return lower.includes('model_capacity_exhausted') ||
        lower.includes('capacity_exhausted') ||
        lower.includes('model is currently overloaded') ||
        lower.includes('service temporarily unavailable');
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

/**
 * Calculate smart backoff based on error type (matches opencode-antigravity-auth)
 * @param {string} errorText - Error message
 * @param {number|null} serverResetMs - Reset time from server
 * @param {number} consecutiveFailures - Number of consecutive failures
 * @returns {number} Backoff time in milliseconds
 */
function calculateSmartBackoff(errorText, serverResetMs, consecutiveFailures = 0) {
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
            return BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED;
        case 'SERVER_ERROR':
            return BACKOFF_BY_ERROR_TYPE.SERVER_ERROR;
        default:
            return BACKOFF_BY_ERROR_TYPE.UNKNOWN;
    }
}

/**
 * Send a streaming request to Cloud Code with multi-account support
 * Streams events in real-time as they arrive from the server
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @yields {Object} Anthropic-format SSE events (message_start, content_block_start, content_block_delta, etc.)
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function* sendMessageStream(anthropicRequest, accountManager, fallbackEnabled = false) {
    const model = anthropicRequest.model;

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Clear any expired rate limits before picking
        accountManager.clearExpiredLimits();

        // Get available accounts for this model
        const availableAccounts = accountManager.getAvailableAccounts(model);

        // If no accounts available, check if we should wait or throw error
        if (availableAccounts.length === 0) {
            if (accountManager.isAllRateLimited(model)) {
                const minWaitMs = accountManager.getMinWaitTimeMs(model);
                const resetTime = new Date(Date.now() + minWaitMs).toISOString();

                // If wait time is too long (> 2 minutes), try fallback first, then throw error
                if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
                    // Check if fallback is enabled and available
                    if (fallbackEnabled) {
                        const fallbackModel = getFallbackModel(model);
                        if (fallbackModel) {
                            logger.warn(`[CloudCode] All accounts exhausted for ${model} (${formatDuration(minWaitMs)} wait). Attempting fallback to ${fallbackModel} (streaming)`);
                            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                            yield* sendMessageStream(fallbackRequest, accountManager, false);
                            return;
                        }
                    }
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}. Next available: ${resetTime}`
                    );
                }

                // Wait for shortest reset time
                const accountCount = accountManager.getAccountCount();
                logger.warn(`[CloudCode] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(minWaitMs)}...`);
                await sleep(minWaitMs + 500); // Add 500ms buffer
                accountManager.clearExpiredLimits();

                // CRITICAL FIX: Don't count waiting for rate limits as a failed attempt
                // This prevents "Max retries exceeded" when we are just patiently waiting
                attempt--;
                continue; // Retry the loop
            }

            // No accounts available and not rate-limited (shouldn't happen normally)
            throw new Error('No accounts available');
        }

        // Select account using configured strategy
        const { account, waitMs } = accountManager.selectAccount(model);

        // If strategy returns a wait time without an account, sleep and retry
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for account...`);
            await sleep(waitMs + 500);
            attempt--; // CRITICAL FIX: Don't count strategy wait as failure
            continue;
        }

        // If strategy returns an account with throttle wait (fallback mode), apply delay
        // This prevents overwhelming the API when using emergency/lastResort fallbacks
        if (account && waitMs > 0) {
            logger.debug(`[CloudCode] Throttling request (${waitMs}ms) - fallback mode active`);
            await sleep(waitMs);
        }

        if (!account) {
            logger.warn(`[CloudCode] Strategy returned no account for ${model} (attempt ${attempt + 1}/${maxAttempts})`);
            continue;
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            logger.debug(`[CloudCode] Starting stream for model: ${model}`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let capacityRetryCount = 0;
            let endpointIndex = 0;

            while (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
                const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
                try {
                    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token, model, 'text/event-stream'),
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.warn(`[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Check for permanent auth failures
                            if (isPermanentAuthFailure(errorText)) {
                                logger.error(`[CloudCode] Permanent auth failure for ${account.email}: ${errorText.substring(0, 100)}`);
                                accountManager.markInvalid(account.email, 'Token revoked - re-authentication required');
                                throw new Error(`AUTH_INVALID_PERMANENT: ${errorText}`);
                            }

                            // Transient auth error - clear caches and retry
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            endpointIndex++;
                            continue;
                        }

                        if (response.status === 429) {
                            const resetMs = parseResetTime(response, errorText);
                            const consecutiveFailures = accountManager.getConsecutiveFailures?.(account.email) || 0;

                            // Check if capacity issue (NOT quota) - retry same endpoint with progressive backoff
                            if (isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    // Progressive capacity backoff tiers
                                    const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                    const waitMs = resetMs || CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                    capacityRetryCount++;
                                    // Track failures for progressive backoff escalation (matches opencode-antigravity-auth)
                                    accountManager.incrementConsecutiveFailures(account.email);
                                    logger.info(`[CloudCode] Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                }
                                // Max capacity retries exceeded - treat as quota exhaustion
                                logger.warn(`[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded, switching account`);
                            }

                            // Get rate limit backoff with exponential backoff and state reset
                            const backoff = getRateLimitBackoff(account.email, model, resetMs);

                            // For very short rate limits (< 1 second), always wait and retry
                            // Switching accounts won't help when all accounts have per-second rate limits
                            if (resetMs !== null && resetMs < 1000) {
                                const waitMs = resetMs;
                                logger.info(`[CloudCode] Short rate limit on ${account.email} (${resetMs}ms), waiting and retrying...`);
                                await sleep(waitMs);
                                // Don't increment endpointIndex - retry same endpoint
                                continue;
                            }

                            // If within dedup window AND reset time is >= 1s, switch account
                            if (backoff.isDuplicate) {
                                const smartBackoffMs = calculateSmartBackoff(errorText, resetMs, consecutiveFailures);
                                logger.info(`[CloudCode] Skipping retry due to recent rate limit on ${account.email} (attempt ${backoff.attempt}), switching account...`);
                                accountManager.markRateLimited(account.email, smartBackoffMs, model);
                                throw new Error(`RATE_LIMITED_DEDUP: ${errorText}`);
                            }

                            // Calculate smart backoff based on error type
                            const smartBackoffMs = calculateSmartBackoff(errorText, resetMs, consecutiveFailures);

                            // Decision: wait and retry OR switch account
                            // First 429 gets a quick 1s retry (FIRST_RETRY_DELAY_MS)
                            if (backoff.attempt === 1 && smartBackoffMs <= DEFAULT_COOLDOWN_MS) {
                                // Quick 1s retry on first 429 (matches opencode-antigravity-auth)
                                const waitMs = backoff.delayMs;
                                // markRateLimited already increments consecutiveFailures internally
                                accountManager.markRateLimited(account.email, waitMs, model);
                                logger.info(`[CloudCode] First rate limit on ${account.email}, quick retry after ${formatDuration(waitMs)}...`);
                                await sleep(waitMs);
                                // Don't increment endpointIndex - retry same endpoint
                                continue;
                            } else if (smartBackoffMs > DEFAULT_COOLDOWN_MS) {
                                // Long-term quota exhaustion (> 10s) - wait SWITCH_ACCOUNT_DELAY_MS then switch
                                logger.info(`[CloudCode] Quota exhausted for ${account.email} (${formatDuration(smartBackoffMs)}), switching account after ${formatDuration(SWITCH_ACCOUNT_DELAY_MS)} delay...`);
                                await sleep(SWITCH_ACCOUNT_DELAY_MS);
                                accountManager.markRateLimited(account.email, smartBackoffMs, model);
                                throw new Error(`QUOTA_EXHAUSTED: ${errorText}`);
                            } else {
                                // Short-term rate limit but not first attempt - use exponential backoff delay
                                const waitMs = backoff.delayMs;
                                // markRateLimited already increments consecutiveFailures internally
                                accountManager.markRateLimited(account.email, waitMs, model);
                                logger.info(`[CloudCode] Rate limit on ${account.email} (attempt ${backoff.attempt}), waiting ${formatDuration(waitMs)}...`);
                                await sleep(waitMs);
                                // Don't increment endpointIndex - retry same endpoint
                                continue;
                            }
                        }

                        // Check for 503 MODEL_CAPACITY_EXHAUSTED - use progressive backoff like 429 capacity
                        if (response.status === 503 && isModelCapacityExhausted(errorText)) {
                            if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                // Progressive capacity backoff tiers (same as 429 capacity handling)
                                const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                const waitMs = CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                capacityRetryCount++;
                                accountManager.incrementConsecutiveFailures(account.email);
                                logger.info(`[CloudCode] 503 Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                await sleep(waitMs);
                                // Don't increment endpointIndex - retry same endpoint
                                continue;
                            }
                            // Max capacity retries exceeded - switch account
                            logger.warn(`[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded on 503, switching account`);
                            accountManager.markRateLimited(account.email, BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED, model);
                            throw new Error(`CAPACITY_EXHAUSTED: ${errorText}`);
                        }

                        // 400 errors are client errors - fail immediately, don't retry or switch accounts
                        // Examples: token limit exceeded, invalid schema, malformed request
                        if (response.status === 400) {
                            logger.error(`[CloudCode] Invalid request (400): ${errorText.substring(0, 200)}`);
                            throw new Error(`invalid_request_error: ${errorText}`);
                        }

                        // Check for 403 PERMISSION_DENIED with VALIDATION_REQUIRED
                        // This means the account needs re-verification via Google - rotate to next account
                        if (response.status === 403 && errorText.includes('VALIDATION_REQUIRED')) {
                            logger.warn(`[CloudCode] Account ${account.email} needs Google re-verification (VALIDATION_REQUIRED), marking invalid and switching...`);
                            accountManager.markInvalid(account.email, 'Google verification required - visit Google to re-verify');
                            throw new Error(`AUTH_VALIDATION_REQUIRED: ${errorText}`);
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);

                        // Try next endpoint for 403/404/5xx errors (matches opencode-antigravity-auth behavior)
                        if (response.status === 403 || response.status === 404) {
                            logger.warn(`[CloudCode] ${response.status} at ${endpoint}..`);
                        } else if (response.status >= 500) {
                            logger.warn(`[CloudCode] ${response.status} stream error, waiting 1s before retry...`);
                            await sleep(1000);
                        }

                        endpointIndex++;
                        continue;
                    }

                    // Stream the response with retry logic for empty responses
                    let currentResponse = response;

                    for (let emptyRetries = 0; emptyRetries <= MAX_EMPTY_RESPONSE_RETRIES; emptyRetries++) {
                        try {
                            yield* streamSSEResponse(currentResponse, anthropicRequest.model);
                            logger.debug('[CloudCode] Stream completed');
                            // Clear rate limit state on success
                            clearRateLimitState(account.email, model);
                            accountManager.notifySuccess(account, model);
                            return;
                        } catch (streamError) {
                            // Only retry on EmptyResponseError
                            if (!isEmptyResponseError(streamError)) {
                                throw streamError;
                            }

                            // Check if we have retries left
                            if (emptyRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
                                logger.error(`[CloudCode] Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} retries`);
                                yield* emitEmptyResponseFallback(anthropicRequest.model);
                                return;
                            }

                            // Exponential backoff: 500ms, 1000ms, 2000ms
                            const backoffMs = 500 * Math.pow(2, emptyRetries);
                            logger.warn(`[CloudCode] Empty response, retry ${emptyRetries + 1}/${MAX_EMPTY_RESPONSE_RETRIES} after ${backoffMs}ms...`);
                            await sleep(backoffMs);

                            // Refetch the response
                            currentResponse = await fetch(url, {
                                method: 'POST',
                                headers: buildHeaders(token, model, 'text/event-stream'),
                                body: JSON.stringify(payload)
                            });

                            // Handle specific error codes on retry
                            if (!currentResponse.ok) {
                                const retryErrorText = await currentResponse.text();

                                // Rate limit error - mark account and throw to trigger account switch
                                if (currentResponse.status === 429) {
                                    const resetMs = parseResetTime(currentResponse, retryErrorText);
                                    accountManager.markRateLimited(account.email, resetMs, model);
                                    throw new Error(`429 RESOURCE_EXHAUSTED during retry: ${retryErrorText}`);
                                }

                                // Auth error - check for permanent failure
                                if (currentResponse.status === 401) {
                                    if (isPermanentAuthFailure(retryErrorText)) {
                                        logger.error(`[CloudCode] Permanent auth failure during retry for ${account.email}`);
                                        accountManager.markInvalid(account.email, 'Token revoked - re-authentication required');
                                        throw new Error(`AUTH_INVALID_PERMANENT: ${retryErrorText}`);
                                    }
                                    accountManager.clearTokenCache(account.email);
                                    accountManager.clearProjectCache(account.email);
                                    throw new Error(`401 AUTH_INVALID during retry: ${retryErrorText}`);
                                }

                                // For 5xx errors, continue retrying
                                if (currentResponse.status >= 500) {
                                    logger.warn(`[CloudCode] Retry got ${currentResponse.status}, will retry...`);
                                    await sleep(1000);
                                    currentResponse = await fetch(url, {
                                        method: 'POST',
                                        headers: buildHeaders(token, model, 'text/event-stream'),
                                        body: JSON.stringify(payload)
                                    });
                                    if (currentResponse.ok) {
                                        continue;
                                    }
                                }

                                throw new Error(`Empty response retry failed: ${currentResponse.status} - ${retryErrorText}`);
                            }
                        }
                    }

                } catch (endpointError) {
                    if (isRateLimitError(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    if (isEmptyResponseError(endpointError)) {
                        throw endpointError;
                    }
                    // 400 errors are client errors - re-throw immediately, don't retry
                    if (endpointError.message?.includes('400')) {
                        throw endpointError;
                    }
                    logger.warn(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                    endpointIndex++;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                if (lastError.is429) {
                    logger.warn(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs, model);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (isRateLimitError(error)) {
                // Rate limited - already marked, notify strategy and continue to next account
                accountManager.notifyRateLimit(account, model);
                logger.info(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthError(error)) {
                // Auth invalid - already marked, continue to next account
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Handle 5xx errors
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                accountManager.notifyFailure(account, model);

                // Track 5xx errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Account ${account.email} failed with 5xx stream error (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next...`);
                }
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.notifyFailure(account, model);

                // Track network errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Network error for ${account.email} (stream) (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next account... (${error.message})`);
                }
                await sleep(1000);
                continue;
            }

            throw error;
        }
    }

    // All retries exhausted - try fallback model if enabled
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(`[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel} (streaming)`);
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            yield* sendMessageStream(fallbackRequest, accountManager, false);
            return;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Emit a fallback message when all retry attempts fail with empty response
 * @param {string} model - The model name
 * @yields {Object} Anthropic-format SSE events for empty response fallback
 */
function* emitEmptyResponseFallback(model) {
    // Use proper message ID format consistent with Anthropic API
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;

    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    };

    yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    };

    yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '[No response after retries - please try again]' }
    };

    yield { type: 'content_block_stop', index: 0 };

    yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 }
    };

    yield { type: 'message_stop' };
}
