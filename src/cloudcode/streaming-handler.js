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
    DEFAULT_COOLDOWN_MS
} from '../constants.js';
import { isRateLimitError, isAuthError, isEmptyResponseError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getFallbackModel } from '../fallback-config.js';
import crypto from 'crypto';
import eventManager from '../modules/event-manager.js';

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
                            eventManager.recordFallback(model, fallbackModel, 'All accounts exhausted', { waitMs: minWaitMs, streaming: true });
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

        // Pick sticky account (prefers current for cache continuity)
        let account = accountManager.getCurrentStickyAccount(model);
        if (!account) {
            account = accountManager.pickNext(model);
        }

        if (!account) {
            continue; // Shouldn't happen, but safety check
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            logger.debug(`[CloudCode] Starting stream for model: ${model}`);

            // Try each endpoint for streaming
            let lastError = null;
            let retriedOnce = false; // Track if we've already retried for short rate limit

            for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
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
                            // Auth error - clear caches and retry
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            continue;
                        }

                        if (response.status === 429) {
                            const resetMs = parseResetTime(response, errorText);

                            // Decision: wait and retry OR switch account
                            if (resetMs && resetMs > DEFAULT_COOLDOWN_MS) {
                                // Long-term quota exhaustion (> 10s) - switch to next account
                                logger.info(`[CloudCode] Quota exhausted for ${account.email} (${formatDuration(resetMs)}), switching account...`);
                                accountManager.markRateLimited(account.email, resetMs, model);
                                eventManager.recordRateLimit(account.email, model, { resetMs, statusCode: 429, streaming: true });
                                throw new Error(`QUOTA_EXHAUSTED: ${errorText}`);
                            } else {
                                // Short-term rate limit (<= 10s) - wait and retry once
                                const waitMs = resetMs || DEFAULT_COOLDOWN_MS;

                                if (!retriedOnce) {
                                    retriedOnce = true;
                                    logger.info(`[CloudCode] Short rate limit (${formatDuration(waitMs)}), waiting and retrying...`);
                                    await sleep(waitMs);
                                    // Retry same endpoint
                                    const retryResponse = await fetch(url, {
                                        method: 'POST',
                                        headers: buildHeaders(token, model, 'text/event-stream'),
                                        body: JSON.stringify(payload)
                                    });

                                    if (retryResponse.ok) {
                                        // Stream the retry response
                                        yield* streamSSEResponse(retryResponse, anthropicRequest.model);
                                        logger.debug('[CloudCode] Stream completed after retry');
                                        // Record successful health after retry
                                        accountManager.recordHealth(account.email, model, true);
                                        return;
                                    }

                                    // Retry also failed - parse new reset time
                                    const retryErrorText = await retryResponse.text();
                                    const retryResetMs = parseResetTime(retryResponse, retryErrorText);
                                    logger.warn(`[CloudCode] Retry also failed, marking and switching...`);
                                    accountManager.markRateLimited(account.email, retryResetMs || waitMs, model);
                                    eventManager.recordRateLimit(account.email, model, { resetMs: retryResetMs || waitMs, statusCode: 429, afterRetry: true, streaming: true });
                                    throw new Error(`RATE_LIMITED_AFTER_RETRY: ${retryErrorText}`);
                                } else {
                                    // Already retried once, mark and switch
                                    accountManager.markRateLimited(account.email, waitMs, model);
                                    eventManager.recordRateLimit(account.email, model, { resetMs: waitMs, statusCode: 429, streaming: true });
                                    throw new Error(`RATE_LIMITED: ${errorText}`);
                                }
                            }
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);

                        // If it's a 5xx error, wait a bit before trying the next endpoint
                        if (response.status >= 500) {
                            logger.warn(`[CloudCode] ${response.status} stream error, waiting 1s before retry...`);
                            await sleep(1000);
                        }

                        continue;
                    }

                    // Stream the response with retry logic for empty responses
                    let currentResponse = response;

                    for (let emptyRetries = 0; emptyRetries <= MAX_EMPTY_RESPONSE_RETRIES; emptyRetries++) {
                        try {
                            yield* streamSSEResponse(currentResponse, anthropicRequest.model);
                            logger.debug('[CloudCode] Stream completed');
                            // Record successful health
                            accountManager.recordHealth(account.email, model, true);
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

                                // Auth error - clear caches and throw with recognizable message
                                if (currentResponse.status === 401) {
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
                // Rate limited - already marked, record health failure and continue to next account
                accountManager.recordHealth(account.email, model, false, { message: 'Rate limited', code: 429 });
                logger.info(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthError(error)) {
                // Auth invalid - already marked, record health failure and continue to next account
                accountManager.recordHealth(account.email, model, false, { message: 'Auth error', code: 401 });
                eventManager.recordAuthFailure(account.email, model, { error: error.message, streaming: true });
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Handle 5xx errors
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                accountManager.recordHealth(account.email, model, false, { message: 'Server error', code: 500 });
                logger.warn(`[CloudCode] Account ${account.email} failed with 5xx stream error, trying next...`);
                accountManager.pickNext(model);
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.recordHealth(account.email, model, false, { message: 'Network error', code: 'NETWORK' });
                logger.warn(`[CloudCode] Network error for ${account.email} (stream), trying next account... (${error.message})`);
                await sleep(1000);
                accountManager.pickNext(model);
                continue;
            }

            // Record health failure for other errors
            accountManager.recordHealth(account.email, model, false, error);
            throw error;
        }
    }

    // All retries exhausted - try fallback model if enabled
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(`[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel} (streaming)`);
            eventManager.recordFallback(model, fallbackModel, 'All retries exhausted', { streaming: true });
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
