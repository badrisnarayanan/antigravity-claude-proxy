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
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_RETRY_DELAY_MS,
    MAX_CAPACITY_RETRIES,
    isThinkingModel
} from '../constants.js';
import { isRateLimitError, isAuthError, isEmptyResponseError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getFallbackModel } from '../fallback-config.js';
import crypto from 'crypto';

/**
 * Gap 1: Rate limit deduplication - prevents thundering herd on concurrent rate limits
 * Tracks last rate limit timestamp per model to skip duplicate retries
 */
const lastRateLimitTimestamps = new Map(); // modelId -> timestamp

/**
 * Check if we should skip retry due to recent rate limit on this model
 * @param {string} model - Model ID
 * @returns {boolean} True if retry should be skipped (within dedup window)
 */
function shouldSkipRetryDueToDedup(model) {
    const lastTimestamp = lastRateLimitTimestamps.get(model);
    if (!lastTimestamp) return false;

    const elapsed = Date.now() - lastTimestamp;
    if (elapsed < RATE_LIMIT_DEDUP_WINDOW_MS) {
        logger.debug(`[CloudCode] Rate limit on ${model} within dedup window (${elapsed}ms ago), skipping retry`);
        return true;
    }
    return false;
}

/**
 * Record rate limit timestamp for deduplication
 * @param {string} model - Model ID
 */
function recordRateLimitTimestamp(model) {
    lastRateLimitTimestamps.set(model, Date.now());
}

/**
 * Clear rate limit timestamp after successful retry
 * @param {string} model - Model ID
 */
function clearRateLimitTimestamp(model) {
    lastRateLimitTimestamps.delete(model);
}

/**
 * Gap 3: Detect permanent authentication failures that require re-authentication
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
 * Gap 4: Detect if 429 error is due to model capacity (not user quota)
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

// Periodically clean up stale dedup timestamps (every 60 seconds)
setInterval(() => {
    const cutoff = Date.now() - 60000; // 1 minute
    for (const [model, timestamp] of lastRateLimitTimestamps.entries()) {
        if (timestamp < cutoff) {
            lastRateLimitTimestamps.delete(model);
        }
    }
}, 60000);

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
                continue; // Retry the loop
            }

            // No accounts available and not rate-limited (shouldn't happen normally)
            throw new Error('No accounts available');
        }

        // Select account using configured strategy
        const { account, waitMs } = accountManager.selectAccount(model);

        // If strategy returns a wait time, sleep and retry
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for account...`);
            await sleep(waitMs + 500);
            continue;
        }

        if (!account) {
            continue; // Shouldn't happen, but safety check
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            // Check if thinking is enabled for this model request
            const isThinking = isThinkingModel(model) && anthropicRequest.thinking !== false;

            logger.debug(`[CloudCode] Starting stream for model: ${model}`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let retriedOnce = false; // Track if we've already retried for short rate limit
            let retriedWithoutThinking = false; // Track if we've retried without thinking
            let capacityRetryCount = 0; // Gap 4: Track capacity exhaustion retries
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

                        // Use info level for 429s to reduce noise during normal failover
                        if (response.status === 429) {
                            logger.info(`[CloudCode] Stream rate limit at ${endpoint}: ${response.status} - ${errorText}`);
                        } else {
                            logger.warn(`[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`);
                        }

                        if (response.status === 401) {
                            // Gap 3: Check for permanent auth failures
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

                            // Gap 4: Check if capacity issue (NOT quota) - retry SAME endpoint
                            if (isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    capacityRetryCount++;
                                    const waitMs = resetMs || CAPACITY_RETRY_DELAY_MS;
                                    logger.info(`[CloudCode] Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                }
                                // Max capacity retries exceeded for this endpoint
                                logger.warn(`[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded for endpoint ${endpoint}, trying next endpoint...`);

                                // Set last error so if all endpoints fail we have a record
                                lastError = new Error(`Capacity exhausted: ${errorText}`);
                                lastError.is429 = true;
                                lastError.resetMs = resetMs;
                                lastError.errorText = errorText;

                                endpointIndex++;
                                capacityRetryCount = 0; // Reset for next endpoint
                                continue;
                            }

                            // Gap 1: Check deduplication window to prevent thundering herd
                            if (shouldSkipRetryDueToDedup(model)) {
                                logger.info(`[CloudCode] Skipping retry due to recent rate limit, switching account...`);
                                accountManager.markRateLimited(account.email, resetMs || DEFAULT_COOLDOWN_MS, model);
                                throw new Error(`RATE_LIMITED_DEDUP: ${errorText}`);
                            }

                            // Decision: wait and retry OR switch account
                            if (resetMs && resetMs > DEFAULT_COOLDOWN_MS) {
                                // Long-term quota exhaustion (> 10s) - switch to next account
                                logger.info(`[CloudCode] Quota exhausted for ${account.email} (${formatDuration(resetMs)}), switching account...`);
                                accountManager.markRateLimited(account.email, resetMs, model);
                                throw new Error(`QUOTA_EXHAUSTED: ${errorText}`);
                            } else {
                                // Short-term rate limit (<= 10s) - wait and retry once
                                const waitMs = resetMs || DEFAULT_COOLDOWN_MS;

                                if (!retriedOnce) {
                                    retriedOnce = true;
                                    recordRateLimitTimestamp(model); // Gap 1: Record before retry
                                    logger.info(`[CloudCode] Short rate limit (${formatDuration(waitMs)}), waiting and retrying...`);
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                } else {
                                    // Already retried once, mark and switch
                                    accountManager.markRateLimited(account.email, waitMs, model);
                                    throw new Error(`RATE_LIMITED: ${errorText}`);
                                }
                            }
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);

                        // Check for invalid signature errors (400) when thinking is enabled
                        // Retry once with thinking disabled to recover the session
                        if (response.status === 400 && isThinking && !retriedWithoutThinking) {
                            const lowerError = errorText.toLowerCase();
                            if (lowerError.includes('signature') || lowerError.includes('invalid argument')) {
                                logger.warn(`[CloudCode] Invalid signature error detected during stream, retrying without thinking... (${errorText})`);
                                retriedWithoutThinking = true;

                                // Disable thinking for this retry
                                anthropicRequest.thinking = false;

                                // Recursive call with modified request
                                yield* sendMessageStream(anthropicRequest, accountManager, fallbackEnabled);
                                return;
                            }
                        }

                        // If it's a 5xx error, wait a bit before trying the next endpoint
                        if (response.status >= 500) {
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
                            // Gap 1: Clear timestamp on success
                            clearRateLimitTimestamp(model);
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

                // Gap 2: Check consecutive failures for extended cooldown
                const consecutiveFailures = accountManager.getHealthTracker()?.getConsecutiveFailures(account.email) || 0;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${consecutiveFailures} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    logger.warn(`[CloudCode] Account ${account.email} failed with 5xx stream error, trying next...`);
                }
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.notifyFailure(account, model);

                // Gap 2: Check consecutive failures for extended cooldown
                const consecutiveFailures = accountManager.getHealthTracker()?.getConsecutiveFailures(account.email) || 0;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${consecutiveFailures} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    logger.warn(`[CloudCode] Network error for ${account.email} (stream), trying next account... (${error.message})`);
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
