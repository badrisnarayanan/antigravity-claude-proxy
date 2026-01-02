/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import { sendMessage, sendMessageStream, listModels, getModelQuotas } from './cloudcode/index.js';
import { 
    convertOpenAIToAnthropic, 
    convertAnthropicToOpenAI, 
    convertAnthropicStreamToOpenAI 
} from './format/index.js';
import { forceRefresh } from './auth/token-extractor.js';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './account-manager/index.js';
import { formatDuration } from './utils/helpers.js';
import { logger } from './utils/logger.js';

// Import fallback flag (set by command line args in index.js)
let FALLBACK_ENABLED = false;
try {
    // Dynamic import to avoid circular dependency
    const indexModule = await import('./index.js');
    FALLBACK_ENABLED = indexModule.FALLBACK_ENABLED || false;
} catch (e) {
    // If index.js hasn't exported it yet, fallback is disabled
}

const app = express();

// Initialize account manager (will be fully initialized on first request or startup)
const accountManager = new AccountManager();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize();
            isInitialized = true;
            const status = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error) {
            initError = error;
            initPromise = null; // Allow retry on failure
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';  // Use invalid_request_error to force client to purge/stop
        statusCode = 400;  // Use 400 to ensure client does not retry (429 and 529 trigger retries)

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after (\d+h\d+m\d+s|\d+m\d+s|\d+s)/i);
        const modelMatch = error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your Antigravity license.';
    }

    return { errorType, statusCode, errorMessage };
}

// Request logging middleware
app.use((req, res, next) => {
    // Skip logging for event logging batch unless in debug mode
    if (req.path === '/api/event_logging/batch') {
        if (logger.isDebugEnabled) {
             logger.debug(`[${req.method}] ${req.path}`);
        }
    } else {
        logger.info(`[${req.method}] ${req.path}`);
    }
    next();
});

/**
 * Health check endpoint - Detailed status
 * Returns status of all accounts including rate limits and model quotas
 */
app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const start = Date.now();
        
        // Get high-level status first
        const status = accountManager.getStatus();
        const allAccounts = accountManager.getAllAccounts();
        
        // Fetch quotas for each account in parallel to get detailed model info
        const accountDetails = await Promise.allSettled(
            allAccounts.map(async (account) => {
                const baseInfo = {
                    email: account.email,
                    lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                    isRateLimited: account.isRateLimited,
                    rateLimitResetTime: account.rateLimitResetTime ? new Date(account.rateLimitResetTime).toISOString() : null,
                    rateLimitCooldownRemaining: account.rateLimitResetTime ? Math.max(0, account.rateLimitResetTime - Date.now()) : 0
                };

                // Skip invalid accounts for quota check
                if (account.isInvalid) {
                    return {
                        ...baseInfo,
                        status: 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const quotas = await getModelQuotas(token);

                    // Format quotas for readability
                    const formattedQuotas = {};
                    for (const [modelId, info] of Object.entries(quotas)) {
                        formattedQuotas[modelId] = {
                            remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                            remainingFraction: info.remainingFraction,
                            resetTime: info.resetTime || null
                        };
                    }

                    return {
                        ...baseInfo,
                        status: account.isRateLimited ? 'rate-limited' : 'ok',
                        models: formattedQuotas
                    };
                } catch (error) {
                    return {
                        ...baseInfo,
                        status: 'error',
                        error: error.message,
                        models: {}
                    };
                }
            })
        );

        // Process results
        const detailedAccounts = accountDetails.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                const acc = allAccounts[index];
                return {
                    email: acc.email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    isRateLimited: acc.isRateLimited
                };
            }
        });

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            latencyMs: Date.now() - start,
            summary: status.summary,
            counts: {
                total: status.total,
                available: status.available,
                rateLimited: status.rateLimited,
                invalid: status.invalid
            },
            accounts: detailedAccounts
        });

    } catch (error) {
        logger.error('[API] Health check failed:', error);
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts × all models
 * Returns a table showing remaining quota and reset time for each combination
 * Use ?format=table for ASCII table output, default is JSON
 */
app.get('/account-limits', async (req, res) => {
    try {
        await ensureInitialized();
        const allAccounts = accountManager.getAllAccounts();
        const format = req.query.format || 'json';

        // Fetch quotas for each account in parallel
        const results = await Promise.allSettled(
            allAccounts.map(async (account) => {
                // Skip invalid accounts
                if (account.isInvalid) {
                    return {
                        email: account.email,
                        status: 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const quotas = await getModelQuotas(token);

                    return {
                        email: account.email,
                        status: 'ok',
                        models: quotas
                    };
                } catch (error) {
                    return {
                        email: account.email,
                        status: 'error',
                        error: error.message,
                        models: {}
                    };
                }
            })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    email: allAccounts[index].email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    models: {}
                };
            }
        });

        // Collect all unique model IDs
        const allModelIds = new Set();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === 'table') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            // Build table
            const lines = [];
            const timestamp = new Date().toLocaleString();
            lines.push(`Account Limits (${timestamp})`);

            // Get account status info
            const status = accountManager.getStatus();
            lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
            lines.push('');

            // Table 1: Account status
            const accColWidth = 25;
            const statusColWidth = 15;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

            for (const acc of status.accounts) {
                const shortEmail = acc.email.split('@')[0].slice(0, 22);
                const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.isInvalid) {
                    accStatus = 'invalid';
                } else if (acc.isRateLimited) {
                    const remaining = acc.rateLimitResetTime ? acc.rateLimitResetTime - Date.now() : 0;
                    accStatus = remaining > 0 ? `limited (${formatDuration(remaining)})` : 'rate-limited';
                } else {
                    accStatus = accLimit?.status || 'ok';
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find(m => m.includes('claude'));
                const quota = claudeModel && accLimit?.models?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths
            const modelColWidth = Math.max(25, ...sortedModels.map(m => m.length)) + 2;
            const accountColWidth = 22;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 18);
                header += shortEmail.padEnd(accountColWidth);
            }
            lines.push(header);
            lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

            // Data rows
            for (const modelId of sortedModels) {
                let row = modelId.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const quota = acc.models?.[modelId];
                    let cell;
                    if (acc.status !== 'ok') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === null) {
                        cell = '0% (exhausted)';
                    } else {
                        const pct = Math.round(quota.remainingFraction * 100);
                        cell = `${pct}%`;
                    }
                    row += cell.padEnd(accountColWidth);
                }
                lines.push(row);
            }

            return res.send(lines.join('\n'));
        }

        // Default: JSON format
        res.json({
            timestamp: new Date().toLocaleString(),
            totalAccounts: allAccounts.length,
            models: sortedModels,
            accounts: accountLimits.map(acc => ({
                email: acc.email,
                status: acc.status,
                error: acc.error || null,
                limits: Object.fromEntries(
                    sortedModels.map(modelId => {
                        const quota = acc.models?.[modelId];
                        if (!quota) {
                            return [modelId, null];
                        }
                        return [modelId, {
                            remaining: quota.remainingFraction !== null
                                ? `${Math.round(quota.remainingFraction * 100)}%`
                                : 'N/A',
                            remainingFraction: quota.remainingFraction,
                            resetTime: quota.resetTime || null
                        }];
                    })
                )
            }))
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * Force token refresh endpoint
 */
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get('/v1/models', async (req, res) => {
    try {
        await ensureInitialized();
        const account = accountManager.pickNext();
        if (!account) {
            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: 'No accounts available'
                }
            });
        }
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);
        res.json(models);
    } catch (error) {
        logger.error('[API] Error listing models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
        });
    }
});

/**
 * Count tokens endpoint (not supported)
 */
app.post('/v1/messages/count_tokens', (req, res) => {
    res.status(501).json({
        type: 'error',
        error: {
            type: 'not_implemented',
            message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
        }
    });
});

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */


/**
 * Anthropic-compatible Messages API
 * POST /v1/messages
 */
app.post('/v1/messages', async (req, res) => {
    try {
        // Ensure account manager is initialized
        await ensureInitialized();


        const {
            model,
            messages,
            max_tokens,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = req.body;

        // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
        // If we have some available accounts, we try them first.
        const modelId = model || 'claude-3-5-sonnet-20241022';
        if (accountManager.isAllRateLimited(modelId)) {
            logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
            accountManager.resetAllRateLimits();
        }

        // Validate required fields
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        // Build the request object
        const request = {
            model: model || 'claude-3-5-sonnet-20241022',
            messages,
            max_tokens: max_tokens || 4096,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        };

        logger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

        // Debug: Log message structure to diagnose tool_use/tool_result ordering
        if (logger.isDebugEnabled) {
            logger.debug('[API] Message structure:');
            messages.forEach((msg, i) => {
                const contentTypes = Array.isArray(msg.content)
                    ? msg.content.map(c => c.type || 'text').join(', ')
                    : (typeof msg.content === 'string' ? 'text' : 'unknown');
                logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
            });
        }

        if (stream) {
            // Handle streaming response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            // Flush headers immediately to start the stream
            res.flushHeaders();

            try {
                // Use the streaming generator with account manager
                for await (const event of sendMessageStream(request, accountManager, FALLBACK_ENABLED)) {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    // Flush after each event for real-time streaming
                    if (res.flush) res.flush();
                }
                res.end();

            } catch (streamError) {
                logger.error('[API] Stream error:', streamError);

                const { errorType, errorMessage } = parseError(streamError);

                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            }

        } else {
            // Handle non-streaming response
            const response = await sendMessage(request, accountManager, FALLBACK_ENABLED);
            res.json(response);
        }

    } catch (error) {
        logger.error('[API] Error:', error);

        let { errorType, statusCode, errorMessage } = parseError(error);

        // For auth errors, try to refresh token
        if (errorType === 'authentication_error') {
            logger.warn('[API] Token might be expired, attempting refresh...');
            try {
                accountManager.clearProjectCache();
                accountManager.clearTokenCache();
                await forceRefresh();
                errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
            } catch (refreshError) {
                errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
            }
        }

        logger.warn(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            logger.warn('[API] Headers already sent, writing error as SSE event');
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    }
});

/**
 * OpenAI Compatible API Endpoints
 */

/**
 * List models (OpenAI compatible)
 */
app.get('/openai/v1/models', async (req, res) => {
    try {
        await ensureInitialized();
        const account = accountManager.pickNext();
        if (!account) {
            return res.status(503).json({
                error: {
                    message: 'No accounts available',
                    type: 'server_error',
                    code: 503
                }
            });
        }
        
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);
        
        // Convert Anthropic models list to OpenAI format
        // Anthropic: { data: [{ id: "...", ... }] } (already quite similar, but let's ensure)
        const openAIModels = {
            object: 'list',
            data: models.data.map(m => ({
                id: m.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'google'
            }))
        };
        
        res.json(openAIModels);
    } catch (error) {
        logger.error('[API] Error listing models (OpenAI):', error);
        res.status(500).json({
            error: {
                message: error.message,
                type: 'server_error',
                code: 500
            }
        });
    }
});

/**
 * Chat Completions (OpenAI compatible)
 */
app.post('/openai/v1/chat/completions', async (req, res) => {
    try {
        await ensureInitialized();
        
        const openAIRequest = req.body;
        
        // Validate
        if (!openAIRequest.messages || !Array.isArray(openAIRequest.messages)) {
            return res.status(400).json({
                error: {
                    message: 'messages is required and must be an array',
                    type: 'invalid_request_error',
                    code: 'invalid_message'
                }
            });
        }
        
        // Convert to Anthropic format
        const anthropicRequest = convertOpenAIToAnthropic(openAIRequest);
        logger.info(`[API] OpenAI Request for model: ${openAIRequest.model} (mapped to ${anthropicRequest.model})`);

        // Handle streaming
        if (openAIRequest.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            try {
                const streamId = `chatcmpl-${Math.random().toString(36).substr(2, 9)}`;
                
                for await (const event of sendMessageStream(anthropicRequest, accountManager, FALLBACK_ENABLED)) {
                    // Convert Anthropic event to OpenAI event
                    const openAIEvent = convertAnthropicStreamToOpenAI(event, streamId, anthropicRequest.model);
                    
                    if (openAIEvent) {
                        res.write(`data: ${JSON.stringify(openAIEvent)}\n\n`);
                    }
                }
                
                res.write('data: [DONE]\n\n');
                res.end();
            } catch (error) {
                logger.error('[API] OpenAI Stream error:', error);
                
                // If headers sent, send error as event
                const { statusCode, errorMessage } = parseError(error); // Reuse existing parser
                res.write(`data: ${JSON.stringify({
                    error: {
                        message: errorMessage,
                        type: 'api_error',
                        code: statusCode
                    }
                })}\n\n`);
                res.end();
            }
        } else {
            // Handle non-streaming
            const anthropicResponse = await sendMessage(anthropicRequest, accountManager, FALLBACK_ENABLED);
            
            // Convert back to OpenAI format
            const openAIResponse = convertAnthropicToOpenAI(anthropicResponse, openAIRequest);
            res.json(openAIResponse);
        }

    } catch (error) {
        logger.error('[API] OpenAI Error:', error);
        const { statusCode, errorMessage, errorType } = parseError(error);
        
        res.status(statusCode).json({
            error: {
                message: errorMessage,
                type: errorType,
                code: statusCode
            }
        });
    }
});

/**
 * Catch-all for unsupported endpoints
 */
app.use('*', (req, res) => {
    if (logger.isDebugEnabled) {
        logger.debug(`[API] 404 Not Found: ${req.method} ${req.originalUrl}`);
    }
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;
