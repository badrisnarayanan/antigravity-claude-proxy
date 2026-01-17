/**
 * Issue Detector
 *
 * Analyzes events and health data to detect issue patterns and generate
 * actionable suggestions. Persists detected issues for dashboard display.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import eventManager, { EventType } from './event-manager.js';

// Persistence paths
const DATA_DIR = path.join(homedir(), '.config/antigravity-proxy');
const ISSUES_FILE = path.join(DATA_DIR, 'issues.json');

/**
 * Issue types
 */
export const IssueType = {
    RATE_LIMIT_STREAK: 'rate_limit_streak',
    AUTH_FAILURE: 'auth_failure',
    MODEL_EXHAUSTED: 'model_exhausted',
    ACCOUNT_DISABLED: 'account_disabled',
    HEALTH_DEGRADED: 'health_degraded'
};

/**
 * Issue severity levels
 */
export const IssueSeverity = {
    CRITICAL: 'critical',
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low'
};

/**
 * Issue status
 */
export const IssueStatus = {
    ACTIVE: 'active',
    ACKNOWLEDGED: 'acknowledged',
    RESOLVED: 'resolved'
};

/**
 * Get detection thresholds from config or defaults
 */
function getThresholds() {
    const healthConfig = config?.health || {};
    return {
        rateLimitStreak: {
            count: 3,           // 3+ rate limits
            windowMs: 10 * 60 * 1000  // within 10 minutes
        },
        highRetryRate: {
            rate: 0.3,          // 30% retry rate
            minSamples: 10,     // minimum 10 requests
            windowMs: 60 * 60 * 1000  // within 1 hour
        },
        healthDegraded: {
            threshold: healthConfig.healthThresholdWarn || 70,
            criticalThreshold: healthConfig.healthThresholdCritical || 50
        }
    };
}

// Initialize thresholds
// const THRESHOLDS = getThresholds(); // Removed static initialization

// In-memory storage
let issues = [];
let isDirty = false;

// Rate limit tracking for streak detection
const rateLimitHistory = new Map(); // account:model -> [timestamps]

/**
 * Generate a unique issue ID based on type and affected resources
 * @param {string} type - Issue type
 * @param {string} account - Account email (optional)
 * @param {string} model - Model ID (optional)
 * @returns {string} Issue ID
 */
function generateIssueId(type, account = null, model = null) {
    const parts = [type];
    if (account) parts.push(account);
    if (model) parts.push(model);
    return parts.join(':');
}

/**
 * Ensure data directory exists and load issues
 */
function load() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(ISSUES_FILE)) {
            const data = fs.readFileSync(ISSUES_FILE, 'utf8');
            issues = JSON.parse(data);
            logger.info(`[IssueDetector] Loaded ${issues.length} issues from disk`);
        }
    } catch (err) {
        logger.error('[IssueDetector] Failed to load issues:', err.message);
        issues = [];
    }
}

/**
 * Save issues to disk
 */
function save() {
    if (!isDirty) return;
    try {
        fs.writeFileSync(ISSUES_FILE, JSON.stringify(issues, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[IssueDetector] Failed to save issues:', err.message);
    }
}

/**
 * Create or update an issue
 * @param {Object} issueData - Issue data
 * @returns {Object} The issue object
 */
function createOrUpdateIssue(issueData) {
    const id = issueData.id || generateIssueId(issueData.type, issueData.account, issueData.model);

    // Find existing issue
    let issue = issues.find(i => i.id === id);

    if (issue) {
        // Update existing issue
        issue.lastSeen = new Date().toISOString();
        issue.occurrences = (issue.occurrences || 1) + 1;
        if (issueData.details) {
            issue.details = { ...issue.details, ...issueData.details };
        }
        // Reactivate if was resolved
        if (issue.status === IssueStatus.RESOLVED) {
            issue.status = IssueStatus.ACTIVE;
        }
    } else {
        // Create new issue
        issue = {
            id,
            type: issueData.type,
            severity: issueData.severity || IssueSeverity.MEDIUM,
            status: IssueStatus.ACTIVE,
            title: issueData.title,
            description: issueData.description,
            suggestion: issueData.suggestion,
            account: issueData.account || null,
            model: issueData.model || null,
            firstDetected: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            occurrences: 1,
            details: issueData.details || {}
        };
        issues.push(issue);
        logger.warn(`[IssueDetector] New issue detected: ${issue.title}`);
    }

    isDirty = true;
    return issue;
}

/**
 * Handle rate limit events and detect streaks
 * @param {Object} event - Rate limit event
 */
function handleRateLimitEvent(event) {
    const key = `${event.account}:${event.model}`;
    const now = Date.now();
    const thresholds = getThresholds();

    // Initialize history for this key
    if (!rateLimitHistory.has(key)) {
        rateLimitHistory.set(key, []);
    }

    const history = rateLimitHistory.get(key);
    history.push(now);

    // Clean old entries outside window
    const cutoff = now - thresholds.rateLimitStreak.windowMs;
    while (history.length > 0 && history[0] < cutoff) {
        history.shift();
    }

    // Check for streak
    if (history.length >= thresholds.rateLimitStreak.count) {
        createOrUpdateIssue({
            type: IssueType.RATE_LIMIT_STREAK,
            severity: IssueSeverity.HIGH,
            account: event.account,
            model: event.model,
            title: 'Frequent rate limiting',
            description: `Account ${event.account} hit rate limits ${history.length} times on ${event.model} in the last 10 minutes`,
            suggestion: 'Consider temporarily disabling this account for this model, or add more accounts',
            details: {
                count: history.length,
                windowMinutes: 10,
                lastResetMs: event.details?.resetMs
            }
        });
    }
}

/**
 * Handle auth failure events
 * @param {Object} event - Auth failure event
 */
function handleAuthFailureEvent(event) {
    createOrUpdateIssue({
        type: IssueType.AUTH_FAILURE,
        severity: IssueSeverity.CRITICAL,
        account: event.account,
        model: event.model,
        title: 'Authentication failure',
        description: `Account ${event.account} failed authentication`,
        suggestion: 'Re-authorize this account via OAuth or check credentials',
        details: {
            error: event.details?.error
        }
    });
}

/**
 * Handle fallback events (indicates model exhaustion)
 * @param {Object} event - Fallback event
 */
function handleFallbackEvent(event) {
    const fromModel = event.details?.fromModel || event.model;
    const toModel = event.details?.toModel;

    createOrUpdateIssue({
        type: IssueType.MODEL_EXHAUSTED,
        severity: IssueSeverity.HIGH,
        model: fromModel,
        title: 'Model quota exhausted',
        description: `All accounts exhausted for ${fromModel}, fell back to ${toModel}`,
        suggestion: 'Add more accounts or wait for quota reset',
        details: {
            fromModel,
            toModel,
            reason: event.details?.reason
        }
    });
}

/**
 * Handle health change events
 * @param {Object} event - Health change event
 */
function handleHealthChangeEvent(event) {
    if (event.details?.change === 'disabled') {
        createOrUpdateIssue({
            type: IssueType.ACCOUNT_DISABLED,
            severity: IssueSeverity.HIGH,
            account: event.account,
            model: event.model,
            title: 'Account×model auto-disabled',
            description: `${event.account} was auto-disabled for ${event.model} due to consecutive failures`,
            suggestion: 'Check account status and re-enable if the issue is resolved',
            details: event.details
        });
    }
}

/**
 * Process an event and check for issues
 * @param {Object} event - Event to process
 */
function processEvent(event) {
    switch (event.type) {
        case EventType.RATE_LIMIT:
            handleRateLimitEvent(event);
            break;
        case EventType.AUTH_FAILURE:
            handleAuthFailureEvent(event);
            break;
        case EventType.FALLBACK:
            handleFallbackEvent(event);
            break;
        case EventType.HEALTH_CHANGE:
            handleHealthChangeEvent(event);
            break;
    }
}

/**
 * Check health data for degraded accounts
 * @param {Object} accountManager - Account manager instance
 */
export function checkHealthDegradation(accountManager) {
    const accounts = accountManager.getAllAccounts();
    const thresholds = getThresholds();

    for (const account of accounts) {
        if (!account.health) continue;

        for (const [modelId, health] of Object.entries(account.health)) {
            if (health.healthScore && health.healthScore < thresholds.healthDegraded.threshold) {
                createOrUpdateIssue({
                    type: IssueType.HEALTH_DEGRADED,
                    severity: health.healthScore < thresholds.healthDegraded.criticalThreshold ? IssueSeverity.HIGH : IssueSeverity.MEDIUM,
                    account: account.email,
                    model: modelId,
                    title: 'Health score degraded',
                    description: `${account.email} health on ${modelId} is at ${health.healthScore.toFixed(1)}%`,
                    suggestion: 'Review recent errors and consider disabling this combination',
                    details: {
                        healthScore: health.healthScore,
                        successCount: health.successCount,
                        failCount: health.failCount,
                        consecutiveFailures: health.consecutiveFailures
                    }
                });
            }
        }
    }
}

/**
 * Get all issues with optional filters
 * @param {Object} [filters] - Filter options
 * @param {string} [filters.type] - Filter by issue type
 * @param {string} [filters.status] - Filter by status
 * @param {string} [filters.severity] - Filter by severity
 * @param {string} [filters.account] - Filter by account
 * @param {string} [filters.model] - Filter by model
 * @returns {Array} Filtered issues
 */
export function getIssues(filters = {}) {
    let filtered = [...issues];

    if (filters.type) {
        filtered = filtered.filter(i => i.type === filters.type);
    }
    if (filters.status) {
        filtered = filtered.filter(i => i.status === filters.status);
    }
    if (filters.severity) {
        filtered = filtered.filter(i => i.severity === filters.severity);
    }
    if (filters.account) {
        filtered = filtered.filter(i => i.account === filters.account);
    }
    if (filters.model) {
        filtered = filtered.filter(i => i.model === filters.model);
    }

    // Sort by severity (critical first) then by lastSeen (newest first)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    filtered.sort((a, b) => {
        const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (severityDiff !== 0) return severityDiff;
        return new Date(b.lastSeen) - new Date(a.lastSeen);
    });

    return filtered;
}

/**
 * Get active issues only
 * @returns {Array} Active issues
 */
export function getActiveIssues() {
    return getIssues({ status: IssueStatus.ACTIVE });
}

/**
 * Resolve an issue
 * @param {string} issueId - Issue ID to resolve
 * @returns {Object|null} Updated issue or null if not found
 */
export function resolveIssue(issueId) {
    const issue = issues.find(i => i.id === issueId);
    if (!issue) return null;

    issue.status = IssueStatus.RESOLVED;
    issue.resolvedAt = new Date().toISOString();
    isDirty = true;

    logger.info(`[IssueDetector] Issue resolved: ${issue.title}`);
    return issue;
}

/**
 * Acknowledge an issue (user has seen it but not resolved)
 * @param {string} issueId - Issue ID to acknowledge
 * @returns {Object|null} Updated issue or null if not found
 */
export function acknowledgeIssue(issueId) {
    const issue = issues.find(i => i.id === issueId);
    if (!issue) return null;

    issue.status = IssueStatus.ACKNOWLEDGED;
    issue.acknowledgedAt = new Date().toISOString();
    isDirty = true;

    return issue;
}

/**
 * Get issue statistics
 * @returns {Object} Statistics object
 */
export function getStats() {
    const active = issues.filter(i => i.status === IssueStatus.ACTIVE);
    const acknowledged = issues.filter(i => i.status === IssueStatus.ACKNOWLEDGED);
    const resolved = issues.filter(i => i.status === IssueStatus.RESOLVED);

    // Count by severity (active only)
    const bySeverity = {
        critical: active.filter(i => i.severity === IssueSeverity.CRITICAL).length,
        high: active.filter(i => i.severity === IssueSeverity.HIGH).length,
        medium: active.filter(i => i.severity === IssueSeverity.MEDIUM).length,
        low: active.filter(i => i.severity === IssueSeverity.LOW).length
    };

    // Count by type (active only)
    const byType = {};
    for (const type of Object.values(IssueType)) {
        byType[type] = active.filter(i => i.type === type).length;
    }

    return {
        total: issues.length,
        active: active.length,
        acknowledged: acknowledged.length,
        resolved: resolved.length,
        bySeverity,
        byType
    };
}

/**
 * Clear resolved issues older than specified age
 * @param {number} [maxAgeMs] - Maximum age in milliseconds (default: 24 hours)
 * @returns {number} Number of issues cleared
 */
export function clearOldResolved(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const originalLength = issues.length;

    issues = issues.filter(i => {
        if (i.status !== IssueStatus.RESOLVED) return true;
        const resolvedTime = new Date(i.resolvedAt || i.lastSeen).getTime();
        return resolvedTime > cutoff;
    });

    const cleared = originalLength - issues.length;
    if (cleared > 0) {
        isDirty = true;
        logger.info(`[IssueDetector] Cleared ${cleared} old resolved issues`);
    }

    return cleared;
}

/**
 * Initialize the issue detector
 */
export function initialize() {
    load();

    // Subscribe to events from event manager
    // Note: This requires event manager to support event subscriptions
    // For now, we'll process events when they're retrieved

    // Auto-save every minute
    setInterval(() => {
        save();
        clearOldResolved();
    }, 60 * 1000);

    // Save on exit
    process.on('SIGINT', () => { save(); });
    process.on('SIGTERM', () => { save(); });

    logger.info('[IssueDetector] Initialized');
}

/**
 * Manually trigger issue detection from recent events
 * @param {number} [sinceMs] - Check events since this many ms ago (default: 1 hour)
 */
export function detectFromRecentEvents(sinceMs = 60 * 60 * 1000) {
    const since = Date.now() - sinceMs;
    const { events } = eventManager.getEvents({ since, limit: 1000 });

    for (const event of events) {
        processEvent(event);
    }
}

/**
 * Setup API routes for issue management
 * @param {import('express').Router} router - Express router
 */
export function setupRoutes(router) {
    // Get all issues with filters
    router.get('/api/issues', (req, res) => {
        const filters = {
            type: req.query.type,
            status: req.query.status,
            severity: req.query.severity,
            account: req.query.account,
            model: req.query.model
        };
        res.json({ status: 'ok', issues: getIssues(filters) });
    });

    // Get active issues only
    router.get('/api/issues/active', (req, res) => {
        res.json({ status: 'ok', issues: getActiveIssues() });
    });

    // Get issue statistics
    router.get('/api/issues/stats', (req, res) => {
        res.json({ status: 'ok', stats: getStats() });
    });

    // Resolve an issue
    router.post('/api/issues/:id/resolve', (req, res) => {
        const issue = resolveIssue(req.params.id);
        if (issue) {
            res.json({ status: 'ok', issue });
        } else {
            res.status(404).json({ status: 'error', error: 'Issue not found' });
        }
    });

    // Acknowledge an issue
    router.post('/api/issues/:id/acknowledge', (req, res) => {
        const issue = acknowledgeIssue(req.params.id);
        if (issue) {
            res.json({ status: 'ok', issue });
        } else {
            res.status(404).json({ status: 'error', error: 'Issue not found' });
        }
    });

    // Manually trigger detection
    router.post('/api/issues/detect', (req, res) => {
        const sinceMs = req.body.sinceMs || 60 * 60 * 1000;
        detectFromRecentEvents(sinceMs);
        res.json({ status: 'ok', issues: getActiveIssues() });
    });
}

export default {
    IssueType,
    IssueSeverity,
    IssueStatus,
    initialize,
    setupRoutes,
    processEvent,
    checkHealthDegradation,
    getIssues,
    getActiveIssues,
    resolveIssue,
    acknowledgeIssue,
    getStats,
    clearOldResolved,
    detectFromRecentEvents
};
