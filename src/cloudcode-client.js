/**
 * Cloud Code Client for Antigravity
 *
 * Communicates with Google's Cloud Code internal API using the
 * v1internal:streamGenerateContent endpoint with proper request wrapping.
 *
 * Supports multi-account load balancing with automatic failover.
 *
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    MIN_SIGNATURE_LENGTH,
    getModelFamily,
    isThinkingModel
} from './constants.js';
import {
    convertAnthropicToGoogle,
    convertGoogleToAnthropic
} from './format/index.js';
import { cacheSignature } from './format/signature-cache.js';
import { formatDuration, sleep } from './utils/helpers.js';
import { isRateLimitError, isAuthError } from './errors.js';

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
 * Derive a stable session ID from the first user message in the conversation.
 * This ensures the same conversation uses the same session ID across turns,
 * enabling prompt caching (cache is scoped to session + organization).
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @returns {string} A stable session ID (32 hex characters) or random UUID if no user message
 */
function deriveSessionId(anthropicRequest) {
    const messages = anthropicRequest.messages || [];

    // Find the first user message
    for (const msg of messages) {
        if (msg.role === 'user') {
            let content = '';

            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Extract text from content blocks
                content = msg.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n');
            }

            if (content) {
                // Hash the content with SHA256, return first 32 hex chars
                const hash = crypto.createHash('sha256').update(content).digest('hex');
                return hash.substring(0, 32);
            }
        }
    }

    // Fallback to random UUID if no user message found
    return crypto.randomUUID();
}

/**
 * Parse reset time from HTTP response or error
 * Checks headers first, then error message body
 * Returns milliseconds or null if not found
 *
 * @param {Response|Error} responseOrError - HTTP Response object or Error
 * @param {string} errorText - Optional error body text
 */
function parseResetTime(responseOrError, errorText = '') {
    let resetMs = null;

    // If it's a Response object, check headers first
    if (responseOrError && typeof responseOrError.headers?.get === 'function') {
        const headers = responseOrError.headers;

        // Standard Retry-After header (seconds or HTTP date)
        const retryAfter = headers.get('retry-after');
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
                resetMs = seconds * 1000;
                console.log(`[CloudCode] Retry-After header: ${seconds}s`);
            } else {
                // Try parsing as HTTP date
                const date = new Date(retryAfter);
                if (!isNaN(date.getTime())) {
                    resetMs = date.getTime() - Date.now();
                    if (resetMs > 0) {
                        console.log(`[CloudCode] Retry-After date: ${retryAfter}`);
                    } else {
                        resetMs = null;
                    }
                }
            }
        }

        // x-ratelimit-reset (Unix timestamp in seconds)
        if (!resetMs) {
            const ratelimitReset = headers.get('x-ratelimit-reset');
            if (ratelimitReset) {
                const resetTimestamp = parseInt(ratelimitReset, 10) * 1000;
                resetMs = resetTimestamp - Date.now();
                if (resetMs > 0) {
                    console.log(`[CloudCode] x-ratelimit-reset: ${new Date(resetTimestamp).toISOString()}`);
                } else {
                    resetMs = null;
                }
            }
        }

        // x-ratelimit-reset-after (seconds)
        if (!resetMs) {
            const resetAfter = headers.get('x-ratelimit-reset-after');
            if (resetAfter) {
                const seconds = parseInt(resetAfter, 10);
                if (!isNaN(seconds) && seconds > 0) {
                    resetMs = seconds * 1000;
                    console.log(`[CloudCode] x-ratelimit-reset-after: ${seconds}s`);
                }
            }
        }
    }

    // If no header found, try parsing from error message/body
    if (!resetMs) {
        const msg = (responseOrError instanceof Error ? responseOrError.message : errorText) || '';

        // Try to extract "retry-after-ms" or "retryDelay" - check seconds format first (e.g. "7739.23s")
        const secMatch = msg.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+([\d\.]+)(?:s\b|s")/i);
        if (secMatch) {
            resetMs = Math.ceil(parseFloat(secMatch[1]) * 1000);
            console.log(`[CloudCode] Parsed retry seconds from body (precise): ${resetMs}ms`);
        }

        if (!resetMs) {
            // Check for ms (explicit "ms" suffix or implicit if no suffix)
            // Rejects "s" suffix or floats (handled above)
            const msMatch = msg.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+(\d+)(?:\s*ms)?(?![\w.])/i);
            if (msMatch) {
                resetMs = parseInt(msMatch[1], 10);
                console.log(`[CloudCode] Parsed retry-after-ms from body: ${resetMs}ms`);
            }
        }

        // Try to extract seconds value like "retry after 60 seconds"
        if (!resetMs) {
            const secMatch = msg.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i);
            if (secMatch) {
                resetMs = parseInt(secMatch[1], 10) * 1000;
                console.log(`[CloudCode] Parsed retry seconds from body: ${secMatch[1]}s`);
            }
        }

        // Try to extract duration like "1h23m45s" or "23m45s" or "45s"
        if (!resetMs) {
            const durationMatch = msg.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
            if (durationMatch) {
                if (durationMatch[1]) {
                    const hours = parseInt(durationMatch[1], 10);
                    const minutes = parseInt(durationMatch[2], 10);
                    const seconds = parseInt(durationMatch[3], 10);
                    resetMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
                } else if (durationMatch[4]) {
                    const minutes = parseInt(durationMatch[4], 10);
                    const seconds = parseInt(durationMatch[5], 10);
                    resetMs = (minutes * 60 + seconds) * 1000;
                } else if (durationMatch[6]) {
                    resetMs = parseInt(durationMatch[6], 10) * 1000;
                }
                if (resetMs) {
                    console.log(`[CloudCode] Parsed duration from body: ${formatDuration(resetMs)}`);
                }
            }
        }

        // Try to extract ISO timestamp or Unix timestamp
        if (!resetMs) {
            const isoMatch = msg.match(/reset[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
            if (isoMatch) {
                const resetTime = new Date(isoMatch[1]).getTime();
                if (!isNaN(resetTime)) {
                    resetMs = resetTime - Date.now();
                    if (resetMs > 0) {
                        console.log(`[CloudCode] Parsed ISO reset time: ${isoMatch[1]}`);
                    } else {
                        resetMs = null;
                    }
                }
            }
        }
    }

    return resetMs;
}

/**
 * Build the wrapped request body for Cloud Code API
 */
function buildCloudCodeRequest(anthropicRequest, projectId) {
    const model = anthropicRequest.model;
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use stable session ID derived from first user message for cache continuity
    googleRequest.sessionId = deriveSessionId(anthropicRequest);

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: 'agent-' + crypto.randomUUID()
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 */
function buildHeaders(token, model, accept = 'application/json') {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    const modelFamily = getModelFamily(model);

    // Add interleaved thinking header only for Claude thinking models
    if (modelFamily === 'claude' && isThinkingModel(model)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}

/**
 * Send a non-streaming request to Cloud Code with multi-account support
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {Object} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('./account-manager.js').default} accountManager - The account manager instance
 * @returns {Promise<Object>} Anthropic-format response object
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function sendMessage(anthropicRequest, accountManager) {
    const model = anthropicRequest.model;
    const isThinking = isThinkingModel(model);

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    // +1 to ensure we hit the "all accounts rate-limited" check at the start of the next loop
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Use sticky account selection for cache continuity
        const { account: stickyAccount, waitMs } = accountManager.pickStickyAccount();
        let account = stickyAccount;

        // Handle waiting for sticky account
        if (!account && waitMs > 0) {
            console.log(`[CloudCode] Waiting ${formatDuration(waitMs)} for sticky account...`);
            await sleep(waitMs);
            accountManager.clearExpiredLimits();
            account = accountManager.getCurrentStickyAccount();
        }

        // Handle all accounts rate-limited
        if (!account) {
            if (accountManager.isAllRateLimited()) {
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
                console.log(`[CloudCode] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(allWaitMs)}...`);
                await sleep(allWaitMs);
                accountManager.clearExpiredLimits();
                account = accountManager.pickNext();
            }

            if (!account) {
                throw new Error('No accounts available');
            }
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            console.log(`[CloudCode] Sending request for model: ${model}`);

            // Try each endpoint
            let lastError = null;
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
                        console.log(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Auth error - clear caches and retry with fresh token
                            console.log('[CloudCode] Auth error, refreshing token...');
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            continue;
                        }

                        if (response.status === 429) {
                            // Rate limited on this endpoint - try next endpoint first (DAILY → PROD)
                            console.log(`[CloudCode] Rate limited at ${endpoint}, trying next endpoint...`);
                            const resetMs = parseResetTime(response, errorText);
                            // Keep minimum reset time across all 429 responses
                            if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                lastError = { is429: true, response, errorText, resetMs };
                            }
                            continue;
                        }

                        if (response.status >= 400) {
                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            continue;
                        }
                    }

                    // For thinking models, parse SSE and accumulate all parts
                    if (isThinking) {
                        return await parseThinkingSSEResponse(response, anthropicRequest.model);
                    }

                    // Non-thinking models use regular JSON
                    const data = await response.json();
                    console.log('[CloudCode] Response received');
                    return convertGoogleToAnthropic(data, anthropicRequest.model);

                } catch (endpointError) {
                    if (is429Error(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    console.log(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                // If all endpoints returned 429, mark account as rate-limited
                if (lastError.is429) {
                    console.log(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (is429Error(error)) {
                // Rate limited - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthInvalidError(error)) {
                // Auth invalid - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Non-rate-limit error: throw immediately
            throw error;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Parse SSE response for thinking models and accumulate all parts
 */
async function parseThinkingSSEResponse(response, originalModel) {
    let accumulatedText = '';
    const finalParts = [];
    let usageMetadata = {};
    let finishReason = 'STOP';

    const flushText = () => {
        if (accumulatedText) {
            finalParts.push({ text: accumulatedText });
            accumulatedText = '';
        }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                if (innerResponse.usageMetadata) {
                    usageMetadata = innerResponse.usageMetadata;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                if (firstCandidate.finishReason) {
                    finishReason = firstCandidate.finishReason;
                }

                const parts = firstCandidate.content?.parts || [];
                for (const part of parts) {
                    if (part.thought === true) {
                        flushText();
                        // Preserve each thought part with its own signature to avoid mismatches.
                        finalParts.push({
                            thought: true,
                            text: part.text || '',
                            thoughtSignature: part.thoughtSignature || ''
                        });
                    } else if (part.functionCall) {
                        flushText();
                        finalParts.push(part);
                    } else if (part.text !== undefined) {
                        if (!part.text) continue;
                        accumulatedText += part.text;
                    }
                }
            } catch (e) {
                    console.log('[CloudCode] SSE parse warning:', e.message, 'Raw:', jsonText.slice(0, 100));
                }
        }
    }

    flushText();

    const accumulatedResponse = {
        candidates: [{ content: { parts: finalParts }, finishReason }],
        usageMetadata
    };

    const partTypes = finalParts.map(p => p.thought ? 'thought' : (p.functionCall ? 'functionCall' : 'text'));
    console.log('[CloudCode] Response received (SSE), part types:', partTypes);
    if (finalParts.some(p => p.thought)) {
        const thinkingPart = finalParts.find(p => p.thought);
        console.log('[CloudCode] Thinking signature length:', thinkingPart?.thoughtSignature?.length || 0);
    }

    return convertGoogleToAnthropic(accumulatedResponse, originalModel);
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
 * @param {import('./account-manager.js').default} accountManager - The account manager instance
 * @yields {Object} Anthropic-format SSE events (message_start, content_block_start, content_block_delta, etc.)
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function* sendMessageStream(anthropicRequest, accountManager) {
    const model = anthropicRequest.model;

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    // +1 to ensure we hit the "all accounts rate-limited" check at the start of the next loop
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Use sticky account selection for cache continuity
        const { account: stickyAccount, waitMs } = accountManager.pickStickyAccount();
        let account = stickyAccount;

        // Handle waiting for sticky account
        if (!account && waitMs > 0) {
            console.log(`[CloudCode] Waiting ${formatDuration(waitMs)} for sticky account...`);
            await sleep(waitMs);
            accountManager.clearExpiredLimits();
            account = accountManager.getCurrentStickyAccount();
        }

        // Handle all accounts rate-limited
        if (!account) {
            if (accountManager.isAllRateLimited()) {
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
                console.log(`[CloudCode] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(allWaitMs)}...`);
                await sleep(allWaitMs);
                accountManager.clearExpiredLimits();
                account = accountManager.pickNext();
            }

            if (!account) {
                throw new Error('No accounts available');
            }
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            console.log(`[CloudCode] Starting stream for model: ${model}`);

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
                        console.log(`[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Auth error - clear caches and retry
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            continue;
                        }

                        if (response.status === 429) {
                            // Rate limited on this endpoint - try next endpoint first (DAILY → PROD)
                            console.log(`[CloudCode] Stream rate limited at ${endpoint}, trying next endpoint...`);
                            const resetMs = parseResetTime(response, errorText);
                            // Keep minimum reset time across all 429 responses
                            if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                lastError = { is429: true, response, errorText, resetMs };
                            }
                            continue;
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);
                        continue;
                    }

                    // Stream the response - yield events as they arrive
                    yield* streamSSEResponse(response, anthropicRequest.model);

                    console.log('[CloudCode] Stream completed');
                    return;

                } catch (endpointError) {
                    if (is429Error(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    console.log(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                // If all endpoints returned 429, mark account as rate-limited
                if (lastError.is429) {
                    console.log(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (is429Error(error)) {
                // Rate limited - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthInvalidError(error)) {
                // Auth invalid - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Non-rate-limit error: throw immediately
            throw error;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Stream SSE response and yield Anthropic-format events
 */
async function* streamSSEResponse(response, originalModel) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let stopReason = 'end_turn';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;

            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                // Extract usage metadata (including cache tokens)
                const usage = innerResponse.usageMetadata;
                if (usage) {
                    inputTokens = usage.promptTokenCount || inputTokens;
                    outputTokens = usage.candidatesTokenCount || outputTokens;
                    cacheReadTokens = usage.cachedContentTokenCount || cacheReadTokens;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const content = firstCandidate.content || {};
                const parts = content.parts || [];

                // Emit message_start on first data
                // Note: input_tokens = promptTokenCount - cachedContentTokenCount (Antigravity includes cached in total)
                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;
                    yield {
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: originalModel,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: {
                                input_tokens: inputTokens - cacheReadTokens,
                                output_tokens: 0,
                                cache_read_input_tokens: cacheReadTokens,
                                cache_creation_input_tokens: 0
                            }
                        }
                    };
                }

                // Process each part
                for (const part of parts) {
                    if (part.thought === true) {
                        // Handle thinking block
                        const text = part.text || '';
                        const signature = part.thoughtSignature || '';

                        if (currentBlockType !== 'thinking') {
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'thinking';
                            currentThinkingSignature = '';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'thinking', thinking: '' }
                            };
                        }

                        if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                            currentThinkingSignature = signature;
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'thinking_delta', thinking: text }
                        };

                    } else if (part.text !== undefined) {
                        // Skip empty text parts
                        if (!part.text || part.text.trim().length === 0) {
                            continue;
                        }

                        // Handle regular text
                        if (currentBlockType !== 'text') {
                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                yield {
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                };
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'text';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'text', text: '' }
                            };
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text: part.text }
                        };

                    } else if (part.functionCall) {
                        // Handle tool use
                        // For Gemini 3+, capture thoughtSignature from the functionCall part
                        // The signature is a sibling to functionCall, not inside it
                        const functionCallSignature = part.thoughtSignature || '';

                        if (currentBlockType === 'thinking' && currentThinkingSignature) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'signature_delta', signature: currentThinkingSignature }
                            };
                            currentThinkingSignature = '';
                        }
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'tool_use';
                        stopReason = 'tool_use';

                        const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;

                        // For Gemini, include the thoughtSignature in the tool_use block
                        // so it can be sent back in subsequent requests
                        const toolUseBlock = {
                            type: 'tool_use',
                            id: toolId,
                            name: part.functionCall.name,
                            input: {}
                        };

                        // Store the signature in the tool_use block for later retrieval
                        if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
                            toolUseBlock.thoughtSignature = functionCallSignature;
                            // Cache for future requests (Claude Code may strip this field)
                            cacheSignature(toolId, functionCallSignature);
                        }

                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: toolUseBlock
                        };

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: JSON.stringify(part.functionCall.args || {})
                            }
                        };
                    }
                }

                // Check finish reason
                if (firstCandidate.finishReason) {
                    if (firstCandidate.finishReason === 'MAX_TOKENS') {
                        stopReason = 'max_tokens';
                    } else if (firstCandidate.finishReason === 'STOP') {
                        stopReason = 'end_turn';
                    }
                }

            } catch (parseError) {
                console.log('[CloudCode] SSE parse error:', parseError.message);
            }
        }
    }

    // Handle no content received
    if (!hasEmittedStart) {
        console.log('[CloudCode] WARNING: No content parts received, emitting empty message');
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: originalModel,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens - cacheReadTokens,
                    output_tokens: 0,
                    cache_read_input_tokens: cacheReadTokens,
                    cache_creation_input_tokens: 0
                }
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
            delta: { type: 'text_delta', text: '[No response received from API]' }
        };
        yield { type: 'content_block_stop', index: 0 };
    } else {
        // Close any open block
        if (currentBlockType !== null) {
            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                };
            }
            yield { type: 'content_block_stop', index: blockIndex };
        }
    }

    // Emit message_delta and message_stop
    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 0
        }
    };

    yield { type: 'message_stop' };
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) {
        return { object: 'list', data: [] };
    }

    const modelList = Object.entries(data.models).map(([modelId, modelData]) => ({
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
        description: modelData.displayName || modelId
    }));

    return {
        object: 'list',
        data: modelList
    };
}

/**
 * Fetch available models with quota info from Cloud Code API
 * Returns model quotas including remaining fraction and reset time
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({})
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.log(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                continue;
            }

            return await response.json();
        } catch (error) {
            console.log(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) return {};

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        if (modelData.quotaInfo) {
            quotas[modelId] = {
                remainingFraction: modelData.quotaInfo.remainingFraction ?? null,
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        }
    }

    return quotas;
}

export default {
    sendMessage,
    sendMessageStream,
    listModels,
    fetchAvailableModels,
    getModelQuotas
};
