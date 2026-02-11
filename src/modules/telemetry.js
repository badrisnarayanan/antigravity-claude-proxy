/**
 * Telemetry Module
 *
 * Implements periodic telemetry calls to match Antigravity's behavioral fingerprint.
 * Runs in the background and sends heartbeat/analytics data for active accounts.
 */

import { gotScraping } from 'got-scraping';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { sleep, getGotScrapingOptions } from '../utils/helpers.js';
import { ANTIGRAVITY_HEADERS, CLIENT_METADATA } from '../constants.js';

// Configuration
const TELEMETRY_INTERVAL_MS = 45000; // 45 seconds average
const TELEMETRY_JITTER_MS = 15000; // +/- 15 seconds -> 30-60s range
const ACTIVE_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Endpoints
const BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const FALLBACK_URL = 'https://cloudcode-pa.googleapis.com';

const ENDPOINTS = {
    FETCH_USER_INFO: '/v1internal:fetchUserInfo',
    RECORD_TRAJECTORY: '/v1internal:recordTrajectoryAnalytics',
    RECORD_CODE_ASSIST: '/v1internal:recordCodeAssistMetrics',
    LIST_EXPERIMENTS: '/v1internal:listExperiments'
};

// State
let lastActivityTime = 0;
let telemetryLoopRunning = false;
let _accountManager = null;
let _fetcher = gotScraping;
const sessionIds = new Map(); // email -> sessionId

// Headers template (dynamic based on constants)
const HEADERS_TEMPLATE = {
    'User-Agent': ANTIGRAVITY_HEADERS['User-Agent'],
    'Client-Metadata': JSON.stringify(CLIENT_METADATA)
};

/**
 * Initialize the telemetry service
 * @param {Object} accountManager - The account manager instance
 * @param {Function} [fetcher] - Optional fetcher function for testing
 */
export function initialize(accountManager, fetcher = null) {
    _accountManager = accountManager;
    if (fetcher) {
        _fetcher = fetcher;
    }
    startTelemetryLoop();
}

/**
 * Get current status for monitoring
 */
export function getStatus() {
    return {
        running: telemetryLoopRunning,
        lastActivity: lastActivityTime > 0 ? new Date(lastActivityTime).toISOString() : null,
        activeAccounts: _accountManager ? _accountManager.getAllAccounts().filter(acc =>
            !acc.isInvalid && acc.enabled !== false &&
            acc.lastUsed && (Date.now() - new Date(acc.lastUsed).getTime() < ACTIVE_SESSION_TIMEOUT_MS)
        ).length : 0
    };
}

/**
 * Notify the service of user activity
 */
export function notifyActivity() {
    lastActivityTime = Date.now();
    if (!telemetryLoopRunning && _accountManager) {
        startTelemetryLoop();
    }
}

/**
 * Start the background telemetry loop
 */
async function startTelemetryLoop() {
    if (telemetryLoopRunning) return;
    telemetryLoopRunning = true;

    // Initial delay to let server start up
    await sleep(5000);

    logger.info('[Telemetry] Background service started');

    while (true) {
        try {
            const now = Date.now();

            // Check if session is active
            if (now - lastActivityTime < ACTIVE_SESSION_TIMEOUT_MS) {
                await sendTelemetryForActiveAccounts();
            } else {
                // If inactive, we just wait. The loop continues to check periodically.
                // We could stop the loop, but it's simpler to keep it running with low overhead.
            }

            // Calculate next run time
            // 30-60s: base 45s +/- 15s
            const jitter = (Math.random() * 2 - 1) * TELEMETRY_JITTER_MS;
            const delay = Math.max(5000, TELEMETRY_INTERVAL_MS + jitter);
            await sleep(delay);

        } catch (error) {
            logger.error('[Telemetry] Loop error:', error);
            await sleep(60000); // Wait 1 min on error
        }
    }
}

/**
 * Send telemetry for all active accounts
 */
async function sendTelemetryForActiveAccounts() {
    if (!_accountManager) return;

    try {
        const accounts = _accountManager.getAllAccounts();

        // Filter active accounts
        const activeAccounts = accounts.filter(acc => {
             // Skip invalid/disabled
             if (acc.isInvalid || acc.enabled === false) return false;

             if (!acc.lastUsed) return false;
             const lastUsedTime = new Date(acc.lastUsed).getTime();
             return (Date.now() - lastUsedTime) < ACTIVE_SESSION_TIMEOUT_MS;
        });

        if (activeAccounts.length === 0) {
            return;
        }

        logger.debug(`[Telemetry] Processing ${activeAccounts.length} active accounts`);

        for (const account of activeAccounts) {
            await sendTelemetry(account);
            // Add small delay between accounts to avoid burst
            await sleep(2000 + Math.random() * 3000);
        }
    } catch (error) {
        logger.error('[Telemetry] Error processing active accounts:', error);
    }
}

/**
 * Send telemetry for a specific account
 * @param {Object} account
 */
async function sendTelemetry(account) {
    try {
        // Get token
        const token = await _accountManager.getTokenForAccount(account);
        const projectId = account.subscription?.projectId || account.projectId;

        if (!projectId) {
            // Can't send telemetry without project ID
            return;
        }

        // Manage session ID
        let sessionId = sessionIds.get(account.email);
        if (!sessionId) {
            sessionId = crypto.randomUUID();
            sessionIds.set(account.email, sessionId);
        }

        // Construct common headers
        const headers = {
            ...HEADERS_TEMPLATE,
            'Authorization': `Bearer ${token}`
        };

        // Randomly select endpoints to call to mimic human behavior

        // 1. Fetch User Info (High probability - heartbeat)
        if (Math.random() > 0.1) {
            await callEndpoint(ENDPOINTS.FETCH_USER_INFO, { project: projectId }, headers);
            await sleep(500 + Math.random() * 1500); // 0.5s - 2s delay
        }

        // 2. List Experiments (Medium probability)
        if (Math.random() > 0.5) {
             await callEndpoint(ENDPOINTS.LIST_EXPERIMENTS, { project: projectId, parent: `projects/${projectId}` }, headers);
             await sleep(500 + Math.random() * 1500);
        }

        // 3. Record Metrics (Low probability, simulates action)
        if (Math.random() > 0.7) {
            // Context-aware interaction generation ("Liveness Gap" mitigation)
            const timeSinceActivity = Date.now() - lastActivityTime;
            const interactionEvents = [];

            // If recently active (< 15s), simulate typing leading up to now
            if (timeSinceActivity < 15000) {
                const numEvents = Math.floor(Math.random() * 5) + 3; // 3-8 typing bursts
                for (let i = 0; i < numEvents; i++) {
                    // Spread events over the last few seconds
                    const offset = Math.floor(Math.random() * 5000);
                    const eventTime = new Date(Date.now() - offset).toISOString();
                    interactionEvents.push({
                        event_time: eventTime,
                        interaction_type: 'TYPING',
                        ui_element: 'EDITOR_PANE'
                    });
                }
            } else {
                // Idle/Reading behavior: Simulate scrolling and mouse moves
                const numEvents = Math.floor(Math.random() * 3) + 1; // 1-3 events
                for (let i = 0; i < numEvents; i++) {
                    const offset = Math.floor(Math.random() * 10000);
                    const eventTime = new Date(Date.now() - offset).toISOString();
                    interactionEvents.push({
                        event_time: eventTime,
                        interaction_type: Math.random() > 0.6 ? 'SCROLL' : 'MOUSE_OVER',
                        ui_element: 'EDITOR_PANE'
                    });
                }

                // Occasional window focus change (10% chance)
                if (Math.random() > 0.9) {
                    interactionEvents.push({
                         event_time: new Date().toISOString(),
                         interaction_type: Math.random() > 0.5 ? 'WINDOW_FOCUS' : 'WINDOW_BLUR',
                         ui_element: 'IDE_WINDOW'
                    });
                }
            }

            // Trajectory Analytics
            await callEndpoint(ENDPOINTS.RECORD_TRAJECTORY, {
                project: projectId,
                session_id: sessionId,
                trajectory_metrics: {
                    interaction_events: interactionEvents,
                    latency_ms: Math.floor(50 + Math.random() * 150),
                    model_id: 'gemini-1.5-pro-002'
                }
            }, headers);
            await sleep(500 + Math.random() * 1500);
        }

        if (Math.random() > 0.8) {
             // Code Assist Metrics - randomize success rate to look human
             const shown = Math.floor(Math.random() * 3) + 1; // 1-3 completions
             const accepted = Math.random() > 0.3 ? 1 : 0; // 70% acceptance rate

             await callEndpoint(ENDPOINTS.RECORD_CODE_ASSIST, {
                project: projectId,
                session_id: sessionId,
                code_assist_metrics: {
                    completions_shown: shown,
                    completions_accepted: accepted,
                    accept_rate: accepted > 0 ? (accepted / shown) : 0.0,
                    latency_ms: Math.floor(100 + Math.random() * 600), // Variable latency
                    interaction_type: accepted > 0 ? 'ACCEPT' : 'DISMISS'
                }
             }, headers);
        }

    } catch (error) {
        // Log debug, don't spam error log for background telemetry failures
        logger.debug(`[Telemetry] Failed for ${account.email}: ${error.message}`);
    }
}

/**
 * Make a request to a telemetry endpoint
 * @param {string} path
 * @param {Object} body
 * @param {Object} headers
 */
async function callEndpoint(path, body, headers) {
    const url = `${BASE_URL}${path}`;

    // Use got-scraping to mimic Chrome
    const response = await _fetcher({
        url,
        method: 'POST',
        headers,
        json: body,
        responseType: 'json',
        throwHttpErrors: false,
        http2: true,
        headerGeneratorOptions: getGotScrapingOptions() // Use dynamic OS detection
    });

    if (response.statusCode >= 400) {
        throw new Error(`Status ${response.statusCode}`);
    }

    return response.body;
}
