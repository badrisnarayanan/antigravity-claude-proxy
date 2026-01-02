/**
 * Streaming Handler for Cloud Code
 *
 * Handles streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS
} from '../constants.js';
import { isRateLimitError, isAuthError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getFallbackModel } from '../fallback-config.js';

/**
 * Check if an error is a rate limit error (429 or RESOURCE_EXHAUSTED)
 * @deprecated Use isRateLimitError from errors.js instead
 */
function is429Error(error) {
    return isRateLimitError(error);
}

/**
 * Check if an error is an auth-invalid error (credentials need re-authentication)
 * @deprecated Use isAuthError from errors.js instead
 */
function isAuthInvalidError(error) {
    return isAuthError(error);
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
    // +1 to ensure we hit the "all accounts rate-limited" check at the start of the next loop
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Use sticky account selection for cache continuity
        const { account: stickyAccount, waitMs } = accountManager.pickStickyAccount(model);
        let account = stickyAccount;

        // Handle waiting for sticky account
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for sticky account...`);
            await sleep(waitMs);
            accountManager.clearExpiredLimits();
            account = accountManager.getCurrentStickyAccount();
        }

        // Handle all accounts rate-limited
        if (!account) {
            if (accountManager.isAllRateLimited(model)) {
                const allWaitMs = accountManager.getMinWaitTimeMs();
                const resetTime = new Date(Date.now() + allWaitMs).toISOString();

                // If wait time is too long (> 2 minutes), throw error immediately
                if (allWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited. Quota will reset after ${formatDuration(allWaitMs)}. Next available: ${resetTime}`
                    );
                }

                // Wait for reset (applies to both single and multi-account modes)
                const accountCount = accountManager.getAccountCount();
                logger.warn(`[CloudCode] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(allWaitMs)}...`);
                await sleep(allWaitMs);
                accountManager.clearExpiredLimits();
                account = accountManager.pickNext(model);
            }

            if (!account) {
                // Check if fallback is enabled and available
                if (fallbackEnabled) {
                    const fallbackModel = getFallbackModel(model);
                    if (fallbackModel) {
                        logger.warn(`[CloudCode] All accounts exhausted for ${model}. Attempting fallback to ${fallbackModel} (streaming)`);
                        // Retry with fallback model
                        const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                        yield* sendMessageStream(fallbackRequest, accountManager, false); // Disable fallback for recursive call
                        return;
                    }
                }
                throw new Error('No accounts available');
            }
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            logger.debug(`[CloudCode] Starting stream for model: ${model}`);

            // Try each endpoint for streaming
            let lastError = null;
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
                            // Rate limited on this endpoint - try next endpoint first (DAILY → PROD)
                            logger.debug(`[CloudCode] Stream rate limited at ${endpoint}, trying next endpoint...`);
                            const resetMs = parseResetTime(response, errorText);
                            // Keep minimum reset time across all 429 responses
                            if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                lastError = { is429: true, response, errorText, resetMs };
                            }
                            continue;
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);

                        // If it's a 5xx error, wait a bit before trying the next endpoint
                        if (response.status >= 500) {
                            logger.warn(`[CloudCode] ${response.status} stream error, waiting 1s before retry...`);
                            await sleep(1000);
                        }

                        continue;
                    }

                    // Stream the response - yield events as they arrive
                    yield* streamSSEResponse(response, anthropicRequest.model);

                    logger.debug('[CloudCode] Stream completed');
                    return;

                } catch (endpointError) {
                    if (is429Error(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    logger.warn(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                // If all endpoints returned 429, mark account as rate-limited
                if (lastError.is429) {
                    logger.warn(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs, model);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (is429Error(error)) {
                // Rate limited - already marked, continue to next account
                logger.info(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthInvalidError(error)) {
                // Auth invalid - already marked, continue to next account
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Non-rate-limit error: throw immediately
            // UNLESS it's a 500 error, then we treat it as a "soft" failure for this account and try the next one
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                logger.warn(`[CloudCode] Account ${account.email} failed with 5xx stream error, trying next...`);
                accountManager.pickNext(model); // Force advance to next account
                continue;
            }

            if (isNetworkError(error)) {
                 logger.warn(`[CloudCode] Network error for ${account.email} (stream), trying next account... (${error.message})`);
                 await sleep(1000); // Brief pause before retry
                 accountManager.pickNext(model); // Advance to next account
                 continue;
            }

            throw error;
        }
    }

    throw new Error('Max retries exceeded');
}
