/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import { sendMessage, sendMessageStream, listModels, getModelQuotas } from './cloudcode/index.js';
import { forceRefresh } from './auth/token-extractor.js';
import { REQUEST_BODY_LIMIT, MAX_CONCURRENT_REQUESTS, MODEL_FALLBACK_MAP } from './constants.js';
import { AccountManager } from './account-manager/index.js';
import { formatDuration } from './utils/helpers.js';
import { logger } from './utils/logger.js';
import {
    requestIdMiddleware,
    contentTypeMiddleware,
    messagesValidationMiddleware
} from './middleware/validation.js';

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);
const FALLBACK_ENABLED = args.includes('--fallback') || process.env.FALLBACK === 'true';

const app = express();

// Initialize account manager (will be fully initialized on first request or startup)
const accountManager = new AccountManager();

// Track initialization - use only the promise for proper synchronization
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 * Uses a single promise pattern to ensure initialization only runs once
 * and all callers wait for the same promise.
 */
async function ensureInitialized() {
    // If already initialized, return immediately
    if (initPromise) {
        return initPromise;
    }

    // Create the initialization promise
    initPromise = (async () => {
        try {
            await accountManager.initialize();
            const status = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error) {
            // Reset promise on failure to allow retry
            initPromise = null;
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

/**
 * Validate the fallback map for cycles at startup
 * Throws an error if a cycle is detected
 */
function validateFallbackMap() {
    for (const [model, fallback] of Object.entries(MODEL_FALLBACK_MAP)) {
        const visited = new Set([model]);
        let current = fallback;

        while (current && MODEL_FALLBACK_MAP[current]) {
            if (visited.has(current)) {
                const cycle = [...visited, current].join(' -> ');
                throw new Error(`Fallback cycle detected: ${cycle}`);
            }
            visited.add(current);
            current = MODEL_FALLBACK_MAP[current];
        }
    }
    logger.debug('[Server] Fallback map validated - no cycles detected');
}

// Validate fallback map at module load time
try {
    validateFallbackMap();
} catch (error) {
    logger.error(`[Server] ${error.message}`);
    process.exit(1);
}

// Middleware
app.use(requestIdMiddleware); // Add request ID to all requests

// CORS configuration - restrict to localhost by default for security
// Can be overridden via CORS_ORIGIN environment variable
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:*';
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        // Allow localhost origins
        if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
            return callback(null, true);
        }

        // Allow if CORS_ORIGIN is set to '*'
        if (corsOrigin === '*') {
            return callback(null, true);
        }

        // Allow if origin matches configured CORS_ORIGIN
        if (origin === corsOrigin) {
            return callback(null, true);
        }

        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use('/v1/messages', contentTypeMiddleware); // Validate Content-Type for messages endpoint

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
        const resetMatch = error.message.match(/quota will reset after ([\dh\dm\ds]+)/i);
        // Try to extract model from our error format "Rate limited on <model>" or JSON format
        const modelMatch = error.message.match(/Rate limited on ([^.]+)\./) || error.message.match(/"model":\s*"([^"]+)"/);
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
             logger.debug(`[${req.requestId}] ${req.method} ${req.path}`);
        }
    } else {
        logger.info(`[${req.requestId}] ${req.method} ${req.path}`);
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
                // Check model-specific rate limits
                const activeModelLimits = Object.entries(account.modelRateLimits || {})
                    .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
                const isRateLimited = activeModelLimits.length > 0;
                const soonestReset = activeModelLimits.length > 0
                    ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                    : null;

                const baseInfo = {
                    email: account.email,
                    lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                    modelRateLimits: account.modelRateLimits || {},
                    rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0
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

                    // Merge local rate limit tracking with API quotas
                    // Local tracking takes precedence when rate-limited
                    const now = Date.now();
                    const localLimits = account.modelRateLimits || {};

                    // Format quotas for readability
                    const formattedQuotas = {};
                    for (const [modelId, info] of Object.entries(quotas)) {
                        // Check if locally rate-limited for this model
                        const localLimit = localLimits[modelId];
                        if (localLimit?.isRateLimited && localLimit.resetTime > now) {
                            // Override with local rate limit data
                            formattedQuotas[modelId] = {
                                remaining: '0%',
                                remainingFraction: 0,
                                resetTime: new Date(localLimit.resetTime).toISOString()
                            };
                        } else {
                            formattedQuotas[modelId] = {
                                remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                                remainingFraction: info.remainingFraction,
                                resetTime: info.resetTime || null
                            };
                        }
                    }

                    // Add models that are locally rate-limited but not in API response
                    for (const [modelId, limit] of Object.entries(localLimits)) {
                        if (limit.isRateLimited && limit.resetTime > now && !formattedQuotas[modelId]) {
                            formattedQuotas[modelId] = {
                                remaining: '0%',
                                remainingFraction: 0,
                                resetTime: new Date(limit.resetTime).toISOString()
                            };
                        }
                    }

                    return {
                        ...baseInfo,
                        status: isRateLimited ? 'rate-limited' : 'ok',
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
                    modelRateLimits: acc.modelRateLimits || {}
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
                        models: {},
                        localRateLimits: account.modelRateLimits || {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const quotas = await getModelQuotas(token);

                    // Merge local rate limit tracking with API quotas
                    // Local tracking takes precedence when rate-limited
                    const now = Date.now();
                    const localLimits = account.modelRateLimits || {};
                    const mergedQuotas = { ...quotas };

                    for (const [modelId, limit] of Object.entries(localLimits)) {
                        if (limit.isRateLimited && limit.resetTime > now) {
                            // Override API quota with local rate limit
                            mergedQuotas[modelId] = {
                                remainingFraction: 0,
                                resetTime: new Date(limit.resetTime).toISOString()
                            };
                        }
                    }

                    return {
                        email: account.email,
                        status: 'ok',
                        models: mergedQuotas,
                        localRateLimits: localLimits
                    };
                } catch (error) {
                    return {
                        email: account.email,
                        status: 'error',
                        error: error.message,
                        models: {},
                        localRateLimits: account.modelRateLimits || {}
                    };
                }
            })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                const acc = allAccounts[index];
                return {
                    email: acc.email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    models: {},
                    localRateLimits: acc.modelRateLimits || {}
                };
            }
        });

        // Collect all unique model IDs (from both API and local rate limits)
        const allModelIds = new Set();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
            // Also include models from local rate limits that might not be in API response
            for (const modelId of Object.keys(account.localRateLimits || {})) {
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
            const activeColWidth = 12;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Active'.padEnd(activeColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + activeColWidth + lastUsedColWidth + resetColWidth));

            for (const acc of status.accounts) {
                const shortEmail = acc.email.split('@')[0].slice(0, 22);
                const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';
                const activeStr = `${acc.activeRequests || 0}/${MAX_CONCURRENT_REQUESTS}`;

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.isInvalid) {
                    accStatus = 'invalid';
                } else if (accLimit?.status === 'error') {
                    accStatus = 'error';
                } else {
                    // Count exhausted models (0% or null remaining)
                    const models = accLimit?.models || {};
                    const modelCount = Object.keys(models).length;
                    const exhaustedCount = Object.values(models).filter(
                        q => q.remainingFraction === 0 || q.remainingFraction === null
                    ).length;

                    if (exhaustedCount === 0) {
                        accStatus = 'ok';
                    } else {
                        accStatus = `(${exhaustedCount}/${modelCount}) limited`;
                    }
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find(m => m.includes('claude'));
                const quota = claudeModel && accLimit?.models?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + activeStr.padEnd(activeColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths - need more space for reset time info
            const modelColWidth = Math.max(28, ...sortedModels.map(m => m.length)) + 2;
            const accountColWidth = 30;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 26);
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
                    if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
                        // Show reset time for exhausted models
                        if (quota.resetTime) {
                            const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                            if (resetMs > 0) {
                                cell = `0% (wait ${formatDuration(resetMs)})`;
                            } else {
                                cell = '0% (resetting...)';
                            }
                        } else {
                            cell = '0% (exhausted)';
                        }
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
        const status = accountManager.getStatus();

        res.json({
            timestamp: new Date().toLocaleString(),
            totalAccounts: allAccounts.length,
            models: sortedModels,
            accounts: accountLimits.map(acc => {
                const statusAcc = status.accounts.find(a => a.email === acc.email);
                return {
                    email: acc.email,
                    activeRequests: statusAcc?.activeRequests || 0,
                    maxConcurrency: MAX_CONCURRENT_REQUESTS,
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
                };
            })
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
app.post('/v1/messages', messagesValidationMiddleware, async (req, res) => {
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
            logger.warn(`[${req.requestId}] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
            accountManager.resetAllRateLimits();
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
            temperature,
            _requestId: req.requestId // Internal: for logging correlation
        };

        logger.info(`[${req.requestId}] Request for model: ${request.model}, stream: ${!!stream}`);

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
