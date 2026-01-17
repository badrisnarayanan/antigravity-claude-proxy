/**
 * Event Manager
 *
 * Manages structured event recording, persistence, and real-time streaming.
 * Events capture system activity including rate limits, auth failures,
 * fallbacks, and request completions.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// Persistence paths
const DATA_DIR = path.join(homedir(), '.config/antigravity-proxy');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

/**
 * Get retention limits from config or defaults
 */
function getRetentionLimits() {
    const healthConfig = config?.health || {};
    return {
        maxEvents: healthConfig.eventMaxCount || 10000,
        maxAgeMs: (healthConfig.eventRetentionDays || 7) * 24 * 60 * 60 * 1000
    };
}

// Event types
export const EventType = {
    REQUEST: 'request',           // Request completed (success or failure)
    RATE_LIMIT: 'rate_limit',     // Rate limit encountered
    AUTH_FAILURE: 'auth_failure', // Authentication failed
    FALLBACK: 'fallback',         // Model fallback triggered
    ACCOUNT_SWITCH: 'account_switch', // Account switched due to error
    HEALTH_CHANGE: 'health_change',   // Account×model health status changed
    SYSTEM: 'system'              // System-level events
};

// Severity levels
export const Severity = {
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error'
};

// In-memory storage
let events = [];
let isDirty = false;

// SSE clients for real-time streaming
const sseClients = new Set();

/**
 * Generate a unique event ID
 * @returns {string} Event ID
 */
function generateEventId() {
    return `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Ensure data directory exists and load events
 */
function load() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(EVENTS_FILE)) {
            const data = fs.readFileSync(EVENTS_FILE, 'utf8');
            events = JSON.parse(data);
            logger.info(`[EventManager] Loaded ${events.length} events from disk`);
        }
    } catch (err) {
        logger.error('[EventManager] Failed to load events:', err.message);
        events = [];
    }
}

/**
 * Save events to disk
 */
function save() {
    if (!isDirty) return;
    try {
        fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[EventManager] Failed to save events:', err.message);
    }
}

/**
 * Prune old events (by count and age)
 */
function prune() {
    const now = Date.now();
    const { maxEvents, maxAgeMs } = getRetentionLimits();
    const cutoff = now - maxAgeMs;
    const originalLength = events.length;

    // Remove events older than maxAgeMs
    events = events.filter(e => new Date(e.timestamp).getTime() > cutoff);

    // If still over limit, remove oldest
    if (events.length > maxEvents) {
        events = events.slice(-maxEvents);
    }

    if (events.length !== originalLength) {
        isDirty = true;
        logger.debug(`[EventManager] Pruned ${originalLength - events.length} old events`);
    }
}

/**
 * Broadcast event to all SSE clients
 * @param {Object} event - Event to broadcast
 */
function broadcast(event) {
    const data = JSON.stringify(event);
    const deadClients = [];

    for (const client of sseClients) {
        try {
            client.write(`data: ${data}\n\n`);
        } catch (err) {
            deadClients.push(client);
        }
    }

    // Clean up dead clients
    for (const client of deadClients) {
        sseClients.delete(client);
    }
}

/**
 * Record a structured event
 * @param {Object} eventData - Event data
 * @param {string} eventData.type - Event type (from EventType)
 * @param {string} [eventData.requestId] - Associated request ID
 * @param {string} [eventData.account] - Account email
 * @param {string} [eventData.model] - Model ID
 * @param {string} [eventData.severity] - Severity level (from Severity)
 * @param {string} eventData.message - Human-readable message
 * @param {Object} [eventData.details] - Additional details
 * @returns {Object} The recorded event
 */
export function record(eventData) {
    const event = {
        id: generateEventId(),
        timestamp: new Date().toISOString(),
        type: eventData.type || EventType.SYSTEM,
        requestId: eventData.requestId || null,
        account: eventData.account || null,
        model: eventData.model || null,
        severity: eventData.severity || Severity.INFO,
        message: eventData.message || '',
        details: eventData.details || {}
    };

    events.push(event);
    isDirty = true;

    // Broadcast to SSE clients
    broadcast(event);

    // Log based on severity
    const logPrefix = `[Event:${event.type}]`;
    const logMsg = `${logPrefix} ${event.message}`;
    switch (event.severity) {
        case Severity.ERROR:
            logger.error(logMsg);
            break;
        case Severity.WARN:
            logger.warn(logMsg);
            break;
        default:
            logger.debug(logMsg);
    }

    return event;
}

/**
 * Get events with optional filters
 * @param {Object} [filters] - Filter options
 * @param {string} [filters.type] - Filter by event type
 * @param {string} [filters.account] - Filter by account email
 * @param {string} [filters.model] - Filter by model
 * @param {string} [filters.severity] - Filter by severity
 * @param {string} [filters.requestId] - Filter by request ID
 * @param {number} [filters.since] - Only events after this timestamp (ms)
 * @param {number} [filters.limit] - Maximum number of events to return
 * @param {number} [filters.offset] - Offset for pagination
 * @returns {Object} { events: Array, total: number }
 */
export function getEvents(filters = {}) {
    let filtered = [...events];

    if (filters.type) {
        filtered = filtered.filter(e => e.type === filters.type);
    }
    if (filters.account) {
        filtered = filtered.filter(e => e.account === filters.account);
    }
    if (filters.model) {
        filtered = filtered.filter(e => e.model === filters.model);
    }
    if (filters.severity) {
        filtered = filtered.filter(e => e.severity === filters.severity);
    }
    if (filters.requestId) {
        filtered = filtered.filter(e => e.requestId === filters.requestId);
    }
    if (filters.since) {
        const sinceTime = typeof filters.since === 'number' ? filters.since : new Date(filters.since).getTime();
        filtered = filtered.filter(e => new Date(e.timestamp).getTime() > sinceTime);
    }

    const total = filtered.length;

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 100;
    filtered = filtered.slice(offset, offset + limit);

    return { events: filtered, total };
}

/**
 * Get event statistics for a time range
 * @param {Object} [options] - Options
 * @param {number} [options.since] - Start time (ms or ISO string), defaults to 24h ago
 * @param {string} [options.account] - Filter by account
 * @param {string} [options.model] - Filter by model
 * @returns {Object} Statistics object
 */
export function getStats(options = {}) {
    const since = options.since
        ? (typeof options.since === 'number' ? options.since : new Date(options.since).getTime())
        : Date.now() - 24 * 60 * 60 * 1000;

    let filtered = events.filter(e => new Date(e.timestamp).getTime() > since);

    if (options.account) {
        filtered = filtered.filter(e => e.account === options.account);
    }
    if (options.model) {
        filtered = filtered.filter(e => e.model === options.model);
    }

    // Count by type
    const byType = {};
    for (const type of Object.values(EventType)) {
        byType[type] = 0;
    }
    for (const event of filtered) {
        byType[event.type] = (byType[event.type] || 0) + 1;
    }

    // Count by severity
    const bySeverity = {
        [Severity.INFO]: 0,
        [Severity.WARN]: 0,
        [Severity.ERROR]: 0
    };
    for (const event of filtered) {
        bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
    }

    // Count by account
    const byAccount = {};
    for (const event of filtered) {
        if (event.account) {
            byAccount[event.account] = (byAccount[event.account] || 0) + 1;
        }
    }

    // Count by model
    const byModel = {};
    for (const event of filtered) {
        if (event.model) {
            byModel[event.model] = (byModel[event.model] || 0) + 1;
        }
    }

    // Calculate success rate from request events
    const requestEvents = filtered.filter(e => e.type === EventType.REQUEST);
    const successCount = requestEvents.filter(e => e.details?.success).length;
    const failCount = requestEvents.filter(e => e.details?.success === false).length;
    const successRate = requestEvents.length > 0
        ? Math.round((successCount / requestEvents.length) * 1000) / 10
        : 100;

    return {
        total: filtered.length,
        byType,
        bySeverity,
        byAccount,
        byModel,
        requests: {
            total: requestEvents.length,
            success: successCount,
            failed: failCount,
            successRate
        },
        timeRange: {
            since: new Date(since).toISOString(),
            until: new Date().toISOString()
        }
    };
}

/**
 * Clear all events
 * @returns {number} Number of events cleared
 */
export function clear() {
    const count = events.length;
    events = [];
    isDirty = true;
    save();
    logger.info(`[EventManager] Cleared ${count} events`);
    return count;
}

/**
 * Register an SSE client for real-time events
 * @param {Object} res - Express response object
 * @param {Object} [options] - Options
 * @param {boolean} [options.history=false] - Whether to send historical events
 * @param {number} [options.historyLimit=100] - Max number of history events to send
 */
export function registerSSEClient(res, options = {}) {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    // Send historical events if requested
    if (options.history) {
        const limit = options.historyLimit || 100;
        // Get recent events (newest first, then reverse to send oldest first)
        const historyEvents = events.slice(-limit);
        if (historyEvents.length > 0) {
            // Send as a batch for efficiency
            res.write(`data: ${JSON.stringify(historyEvents)}\n\n`);
        }
    }

    // Add to clients set
    sseClients.add(res);

    // Remove on close
    res.on('close', () => {
        sseClients.delete(res);
    });
}

/**
 * Get SSE client count
 * @returns {number} Number of connected SSE clients
 */
export function getSSEClientCount() {
    return sseClients.size;
}

/**
 * Initialize the event manager
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

    logger.info('[EventManager] Initialized');
}

/**
 * Setup API routes for event management
 * @param {import('express').Router} router - Express router
 */
export function setupRoutes(router) {
    // Get events with filters
    router.get('/api/events', (req, res) => {
        const filters = {
            type: req.query.type,
            account: req.query.account,
            model: req.query.model,
            severity: req.query.severity,
            requestId: req.query.requestId,
            since: req.query.since ? parseInt(req.query.since, 10) : undefined,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
            offset: req.query.offset ? parseInt(req.query.offset, 10) : 0
        };
        res.json(getEvents(filters));
    });

    // Get event statistics
    router.get('/api/events/stats', (req, res) => {
        const options = {
            since: req.query.since,
            account: req.query.account,
            model: req.query.model
        };
        res.json(getStats(options));
    });

    // SSE stream for real-time events
    router.get('/api/events/stream', (req, res) => {
        const options = {
            history: req.query.history === 'true',
            historyLimit: req.query.limit ? parseInt(req.query.limit, 10) : 100
        };
        registerSSEClient(res, options);
    });

    // Clear all events (admin action)
    router.delete('/api/events', (req, res) => {
        const count = clear();
        res.json({ success: true, cleared: count });
    });
}

// Convenience functions for common event types

/**
 * Record a rate limit event
 */
export function recordRateLimit(account, model, details = {}) {
    return record({
        type: EventType.RATE_LIMIT,
        account,
        model,
        severity: Severity.WARN,
        message: `Rate limit hit for ${account} on ${model}`,
        details
    });
}

/**
 * Record an auth failure event
 */
export function recordAuthFailure(account, model, details = {}) {
    return record({
        type: EventType.AUTH_FAILURE,
        account,
        model,
        severity: Severity.ERROR,
        message: `Auth failure for ${account}`,
        details
    });
}

/**
 * Record a fallback event
 */
export function recordFallback(fromModel, toModel, reason, details = {}) {
    return record({
        type: EventType.FALLBACK,
        model: fromModel,
        severity: Severity.WARN,
        message: `Fallback from ${fromModel} to ${toModel}: ${reason}`,
        details: { ...details, fromModel, toModel, reason }
    });
}

/**
 * Record an account switch event
 */
export function recordAccountSwitch(fromAccount, toAccount, model, reason, details = {}) {
    return record({
        type: EventType.ACCOUNT_SWITCH,
        account: toAccount,
        model,
        severity: Severity.INFO,
        message: `Switched from ${fromAccount} to ${toAccount} on ${model}: ${reason}`,
        details: { ...details, fromAccount, toAccount, reason }
    });
}

/**
 * Record a health change event
 */
export function recordHealthChange(account, model, change, details = {}) {
    const severity = change === 'disabled' ? Severity.ERROR : Severity.INFO;
    return record({
        type: EventType.HEALTH_CHANGE,
        account,
        model,
        severity,
        message: `Health ${change} for ${account} on ${model}`,
        details: { ...details, change }
    });
}

/**
 * Record a request completion event
 */
export function recordRequest(requestId, account, model, success, latencyMs, details = {}) {
    return record({
        type: EventType.REQUEST,
        requestId,
        account,
        model,
        severity: success ? Severity.INFO : Severity.WARN,
        message: success
            ? `Request ${requestId} completed in ${latencyMs}ms`
            : `Request ${requestId} failed after ${latencyMs}ms`,
        details: { ...details, success, latencyMs }
    });
}

export default {
    EventType,
    Severity,
    initialize,
    setupRoutes,
    record,
    getEvents,
    getStats,
    clear,
    registerSSEClient,
    getSSEClientCount,
    recordRateLimit,
    recordAuthFailure,
    recordFallback,
    recordAccountSwitch,
    recordHealthChange,
    recordRequest
};
