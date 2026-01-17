/**
 * Request Tracer
 *
 * Tracks the full lifecycle of each request, including multiple attempts
 * across different accounts and endpoints. Useful for debugging and
 * understanding request routing decisions.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// Persistence paths
const DATA_DIR = path.join(homedir(), '.config/antigravity-proxy');
const TRACES_FILE = path.join(DATA_DIR, 'traces.json');

// Retention limits
const MAX_TRACES = 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACTIVE_TRACE_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL for active traces

// Request status constants
export const TraceStatus = {
    PENDING: 'pending',
    SUCCESS: 'success',
    FAILED: 'failed'
};

// Attempt status constants
export const AttemptStatus = {
    SUCCESS: 'success',
    RATE_LIMITED: 'rate_limited',
    AUTH_FAILED: 'auth_failed',
    SERVER_ERROR: 'server_error',
    NETWORK_ERROR: 'network_error',
    TIMEOUT: 'timeout',
    ERROR: 'error'
};

// In-memory storage
// Using Map for quick lookup by requestId
const activeTraces = new Map();
let completedTraces = [];
let isDirty = false;

/**
 * Generate a unique request ID
 * @returns {string} Request ID in format req_<timestamp>_<random>
 */
export function generateRequestId() {
    return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Ensure data directory exists and load traces
 */
function load() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(TRACES_FILE)) {
            const data = fs.readFileSync(TRACES_FILE, 'utf8');
            completedTraces = JSON.parse(data);
            logger.info(`[RequestTracer] Loaded ${completedTraces.length} traces from disk`);
        }
    } catch (err) {
        logger.error('[RequestTracer] Failed to load traces:', err.message);
        completedTraces = [];
    }
}

/**
 * Save traces to disk
 */
function save() {
    if (!isDirty) return;
    try {
        fs.writeFileSync(TRACES_FILE, JSON.stringify(completedTraces, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[RequestTracer] Failed to save traces:', err.message);
    }
}

/**
 * Prune old traces (by count and age)
 * Also cleans up stale active traces that never completed
 */
function prune() {
    const now = Date.now();
    const cutoff = now - MAX_AGE_MS;
    const originalLength = completedTraces.length;

    // Remove traces older than MAX_AGE_MS
    completedTraces = completedTraces.filter(t => new Date(t.timestamp).getTime() > cutoff);

    // If still over limit, remove oldest
    if (completedTraces.length > MAX_TRACES) {
        completedTraces = completedTraces.slice(-MAX_TRACES);
    }

    if (completedTraces.length !== originalLength) {
        isDirty = true;
        logger.debug(`[RequestTracer] Pruned ${originalLength - completedTraces.length} old traces`);
    }

    // Clean up stale active traces (requests that never completed)
    const activeCutoff = now - ACTIVE_TRACE_TTL_MS;
    let staleCount = 0;
    for (const [requestId, trace] of activeTraces) {
        if (trace.startTime && trace.startTime < activeCutoff) {
            // Move stale trace to completed with FAILED status
            trace.status = TraceStatus.FAILED;
            trace.totalLatencyMs = now - trace.startTime;
            trace.error = 'Trace timed out (client disconnect or unhandled error)';
            delete trace.startTime;
            completedTraces.push(trace);
            activeTraces.delete(requestId);
            isDirty = true;
            staleCount++;
        }
    }

    if (staleCount > 0) {
        logger.warn(`[RequestTracer] Cleaned up ${staleCount} stale active traces`);
    }
}

/**
 * Start tracking a new request
 * @param {string} requestId - Unique request ID
 * @param {string} model - Model being requested
 * @param {boolean} [streaming=false] - Whether this is a streaming request
 * @returns {Object} The trace object
 */
export function startTrace(requestId, model, streaming = false) {
    const trace = {
        requestId,
        timestamp: new Date().toISOString(),
        model,
        streaming,
        status: TraceStatus.PENDING,
        totalLatencyMs: null,
        isFallback: false,
        fallbackModel: null,
        finalAccount: null,
        attempts: [],
        startTime: Date.now()
    };

    activeTraces.set(requestId, trace);
    logger.debug(`[RequestTracer] Started trace: ${requestId} for ${model}`);

    return trace;
}

/**
 * Record an attempt for a request
 * @param {string} requestId - Request ID
 * @param {Object} attemptData - Attempt data
 * @param {string} attemptData.account - Account email used
 * @param {string} attemptData.model - Model used (may differ from original if fallback)
 * @param {string} attemptData.endpoint - API endpoint URL
 * @param {string} attemptData.status - Attempt status (from AttemptStatus)
 * @param {number} [attemptData.latencyMs] - Latency in milliseconds
 * @param {string} [attemptData.error] - Error message if failed
 * @param {Object} [attemptData.details] - Additional details
 * @returns {Object|null} Updated trace or null if not found
 */
export function recordAttempt(requestId, attemptData) {
    const trace = activeTraces.get(requestId);
    if (!trace) {
        logger.warn(`[RequestTracer] Trace not found: ${requestId}`);
        return null;
    }

    const attempt = {
        index: trace.attempts.length,
        timestamp: new Date().toISOString(),
        account: attemptData.account,
        model: attemptData.model || trace.model,
        endpoint: attemptData.endpoint || null,
        status: attemptData.status,
        latencyMs: attemptData.latencyMs || null,
        error: attemptData.error || null,
        details: attemptData.details || {}
    };

    trace.attempts.push(attempt);

    // Track if this is a fallback
    if (attemptData.model && attemptData.model !== trace.model) {
        trace.isFallback = true;
        trace.fallbackModel = attemptData.model;
    }

    logger.debug(`[RequestTracer] Recorded attempt ${attempt.index} for ${requestId}: ${attempt.status}`);

    return trace;
}

/**
 * End tracing for a request
 * @param {string} requestId - Request ID
 * @param {string} status - Final status (from TraceStatus)
 * @param {Object} [finalData] - Additional final data
 * @param {string} [finalData.account] - Final account that succeeded
 * @param {string} [finalData.error] - Error message if failed
 * @returns {Object|null} Completed trace or null if not found
 */
export function endTrace(requestId, status, finalData = {}) {
    const trace = activeTraces.get(requestId);
    if (!trace) {
        logger.warn(`[RequestTracer] Cannot end trace, not found: ${requestId}`);
        return null;
    }

    trace.status = status;
    trace.totalLatencyMs = Date.now() - trace.startTime;
    trace.finalAccount = finalData.account || null;

    if (finalData.error) {
        trace.error = finalData.error;
    }

    // Clean up internal fields
    delete trace.startTime;

    // Move to completed
    activeTraces.delete(requestId);
    completedTraces.push(trace);
    isDirty = true;

    logger.debug(`[RequestTracer] Ended trace: ${requestId} (${status}, ${trace.totalLatencyMs}ms, ${trace.attempts.length} attempts)`);

    return trace;
}

/**
 * Get a trace by request ID
 * @param {string} requestId - Request ID
 * @returns {Object|null} Trace object or null
 */
export function getTrace(requestId) {
    // Check active first
    if (activeTraces.has(requestId)) {
        return activeTraces.get(requestId);
    }
    // Then check completed
    return completedTraces.find(t => t.requestId === requestId) || null;
}

/**
 * Get traces with optional filters
 * @param {Object} [filters] - Filter options
 * @param {string} [filters.model] - Filter by model
 * @param {string} [filters.account] - Filter by final account
 * @param {string} [filters.status] - Filter by status
 * @param {boolean} [filters.isFallback] - Filter by fallback status
 * @param {number} [filters.since] - Only traces after this timestamp (ms)
 * @param {number} [filters.limit] - Maximum number of traces to return
 * @param {number} [filters.offset] - Offset for pagination
 * @returns {Object} { traces: Array, total: number, active: number }
 */
export function getTraces(filters = {}) {
    // Combine active and completed traces
    let all = [...completedTraces, ...Array.from(activeTraces.values())];

    if (filters.model) {
        all = all.filter(t => t.model === filters.model || t.fallbackModel === filters.model);
    }
    if (filters.account) {
        all = all.filter(t => t.finalAccount === filters.account ||
            t.attempts.some(a => a.account === filters.account));
    }
    if (filters.status) {
        all = all.filter(t => t.status === filters.status);
    }
    if (typeof filters.isFallback === 'boolean') {
        all = all.filter(t => t.isFallback === filters.isFallback);
    }
    if (filters.since) {
        const sinceTime = typeof filters.since === 'number' ? filters.since : new Date(filters.since).getTime();
        all = all.filter(t => new Date(t.timestamp).getTime() > sinceTime);
    }

    const total = all.length;

    // Sort by timestamp descending (newest first)
    all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 50;
    all = all.slice(offset, offset + limit);

    return {
        traces: all,
        total,
        active: activeTraces.size
    };
}

/**
 * Get trace statistics
 * @param {Object} [options] - Options
 * @param {number} [options.since] - Start time (ms or ISO string), defaults to 1h ago
 * @returns {Object} Statistics object
 */
export function getStats(options = {}) {
    const since = options.since
        ? (typeof options.since === 'number' ? options.since : new Date(options.since).getTime())
        : Date.now() - 60 * 60 * 1000; // 1 hour ago

    const all = [...completedTraces, ...Array.from(activeTraces.values())];
    const filtered = all.filter(t => new Date(t.timestamp).getTime() > since);

    // Count by status
    const byStatus = {
        [TraceStatus.PENDING]: 0,
        [TraceStatus.SUCCESS]: 0,
        [TraceStatus.FAILED]: 0
    };
    for (const trace of filtered) {
        byStatus[trace.status] = (byStatus[trace.status] || 0) + 1;
    }

    // Calculate average latency for successful requests
    const successful = filtered.filter(t => t.status === TraceStatus.SUCCESS && t.totalLatencyMs);
    const avgLatencyMs = successful.length > 0
        ? Math.round(successful.reduce((sum, t) => sum + t.totalLatencyMs, 0) / successful.length)
        : 0;

    // Count fallbacks
    const fallbackCount = filtered.filter(t => t.isFallback).length;

    // Count retries (traces with more than 1 attempt)
    const retriedCount = filtered.filter(t => t.attempts.length > 1).length;

    // Average attempts per request
    const avgAttempts = filtered.length > 0
        ? Math.round(filtered.reduce((sum, t) => sum + t.attempts.length, 0) / filtered.length * 10) / 10
        : 0;

    // Success rate
    const completed = filtered.filter(t => t.status !== TraceStatus.PENDING);
    const successRate = completed.length > 0
        ? Math.round((byStatus[TraceStatus.SUCCESS] / completed.length) * 1000) / 10
        : 100;

    return {
        total: filtered.length,
        active: activeTraces.size,
        byStatus,
        avgLatencyMs,
        fallbackCount,
        retriedCount,
        avgAttempts,
        successRate,
        timeRange: {
            since: new Date(since).toISOString(),
            until: new Date().toISOString()
        }
    };
}

/**
 * Clear all traces
 * @returns {number} Number of traces cleared
 */
export function clear() {
    const count = completedTraces.length + activeTraces.size;
    completedTraces = [];
    activeTraces.clear();
    isDirty = true;
    save();
    logger.info(`[RequestTracer] Cleared ${count} traces`);
    return count;
}

/**
 * Initialize the request tracer
 */
export function initialize() {
    load();

    // Auto-save and prune every minute
    setInterval(() => {
        save();
        prune();
    }, 60 * 1000);

    // Save on exit
    process.on('SIGINT', () => { save(); });
    process.on('SIGTERM', () => { save(); });

    logger.info('[RequestTracer] Initialized');
}

/**
 * Setup API routes for request tracing
 * @param {import('express').Router} router - Express router
 */
export function setupRoutes(router) {
    // Get traces with filters
    router.get('/api/traces', (req, res) => {
        const filters = {
            model: req.query.model,
            account: req.query.account,
            status: req.query.status,
            isFallback: req.query.isFallback === 'true' ? true :
                        req.query.isFallback === 'false' ? false : undefined,
            since: req.query.since ? parseInt(req.query.since, 10) : undefined,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
            offset: req.query.offset ? parseInt(req.query.offset, 10) : 0
        };
        res.json(getTraces(filters));
    });

    // Get single trace by ID
    router.get('/api/traces/:requestId', (req, res) => {
        const trace = getTrace(req.params.requestId);
        if (trace) {
            res.json({ status: 'ok', trace });
        } else {
            res.status(404).json({ status: 'error', error: 'Trace not found' });
        }
    });

    // Get trace statistics
    router.get('/api/traces/stats', (req, res) => {
        const options = {
            since: req.query.since
        };
        res.json(getStats(options));
    });

    // Clear all traces (admin action)
    router.delete('/api/traces', (req, res) => {
        const count = clear();
        res.json({ success: true, cleared: count });
    });
}

export default {
    TraceStatus,
    AttemptStatus,
    generateRequestId,
    initialize,
    setupRoutes,
    startTrace,
    recordAttempt,
    endTrace,
    getTrace,
    getTraces,
    getStats,
    clear
};
