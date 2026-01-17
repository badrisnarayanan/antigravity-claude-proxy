/**
 * Message Handler for Cloud Code
 *
 * Handles non-streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    DEFAULT_COOLDOWN_MS,
    isThinkingModel
} from '../constants.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import { isRateLimitError, isAuthError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { getFallbackModel } from '../fallback-config.js';
import eventManager from '../modules/event-manager.js';

/**
 * Send a non-streaming request to Cloud Code with multi-account support
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {Object} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @returns {Promise<Object>} Anthropic-format response object
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function sendMessage(anthropicRequest, accountManager, fallbackEnabled = false) {
    const model = anthropicRequest.model;
    const isThinking = isThinkingModel(model);

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
                            logger.warn(`[CloudCode] All accounts exhausted for ${model} (${formatDuration(minWaitMs)} wait). Attempting fallback to ${fallbackModel}`);
                            eventManager.recordFallback(model, fallbackModel, 'All accounts exhausted', { waitMs: minWaitMs });
                            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                            return await sendMessage(fallbackRequest, accountManager, false);
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

            logger.debug(`[CloudCode] Sending request for model: ${model}`);

            // Try each endpoint
            let lastError = null;
            let retriedOnce = false; // Track if we've already retried for short rate limit

            for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                try {
                    const url = isThinking
                        ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                        : `${endpoint}/v1internal:generateContent`;

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json'),
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.warn(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Auth error - clear caches and retry with fresh token
                            logger.warn('[CloudCode] Auth error, refreshing token...');
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
                                eventManager.recordRateLimit(account.email, model, { resetMs, statusCode: 429 });
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
                                        headers: buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json'),
                                        body: JSON.stringify(payload)
                                    });

                                    if (retryResponse.ok) {
                                        // Process retry response
                                        if (isThinking) {
                                            const result = await parseThinkingSSEResponse(retryResponse, anthropicRequest.model);
                                            // Record successful health after retry
                                            accountManager.recordHealth(account.email, model, true);
                                            return result;
                                        }
                                        const data = await retryResponse.json();
                                        logger.debug('[CloudCode] Response received after retry');
                                        // Record successful health after retry
                                        accountManager.recordHealth(account.email, model, true);
                                        return convertGoogleToAnthropic(data, anthropicRequest.model);
                                    }

                                    // Retry also failed - parse new reset time
                                    const retryErrorText = await retryResponse.text();
                                    const retryResetMs = parseResetTime(retryResponse, retryErrorText);
                                    logger.warn(`[CloudCode] Retry also failed, marking and switching...`);
                                    accountManager.markRateLimited(account.email, retryResetMs || waitMs, model);
                                    eventManager.recordRateLimit(account.email, model, { resetMs: retryResetMs || waitMs, statusCode: 429, afterRetry: true });
                                    throw new Error(`RATE_LIMITED_AFTER_RETRY: ${retryErrorText}`);
                                } else {
                                    // Already retried once, mark and switch
                                    accountManager.markRateLimited(account.email, waitMs, model);
                                    eventManager.recordRateLimit(account.email, model, { resetMs: waitMs, statusCode: 429 });
                                    throw new Error(`RATE_LIMITED: ${errorText}`);
                                }
                            }
                        }

                        if (response.status >= 400) {
                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            // If it's a 5xx error, wait a bit before trying the next endpoint
                            if (response.status >= 500) {
                                logger.warn(`[CloudCode] ${response.status} error, waiting 1s before retry...`);
                                await sleep(1000);
                            }
                            continue;
                        }
                    }

                    // For thinking models, parse SSE and accumulate all parts
                    if (isThinking) {
                        const result = await parseThinkingSSEResponse(response, anthropicRequest.model);
                        // Record successful health
                        accountManager.recordHealth(account.email, model, true);
                        return result;
                    }

                    // Non-thinking models use regular JSON
                    const data = await response.json();
                    logger.debug('[CloudCode] Response received');
                    // Record successful health
                    accountManager.recordHealth(account.email, model, true);
                    return convertGoogleToAnthropic(data, anthropicRequest.model);

                } catch (endpointError) {
                    if (isRateLimitError(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    logger.warn(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
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
                eventManager.recordAuthFailure(account.email, model, { error: error.message });
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Handle 5xx errors
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                accountManager.recordHealth(account.email, model, false, { message: 'Server error', code: 500 });
                logger.warn(`[CloudCode] Account ${account.email} failed with 5xx error, trying next...`);
                accountManager.pickNext(model);
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.recordHealth(account.email, model, false, { message: 'Network error', code: 'NETWORK' });
                logger.warn(`[CloudCode] Network error for ${account.email}, trying next account... (${error.message})`);
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
            logger.warn(`[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel}`);
            eventManager.recordFallback(model, fallbackModel, 'All retries exhausted');
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            return await sendMessage(fallbackRequest, accountManager, false);
        }
    }

    throw new Error('Max retries exceeded');
}
