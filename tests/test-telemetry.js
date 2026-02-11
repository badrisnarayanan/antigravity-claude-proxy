/**
 * Test Telemetry Module
 */

import { initialize, notifyActivity } from '../src/modules/telemetry.js';
import { logger } from '../src/utils/logger.js';
import assert from 'assert';

// Mock logger to avoid spam
logger.info = () => {};
logger.debug = () => {};
logger.error = (msg, err) => { console.error(msg, err); };

// Mock AccountManager
const mockAccountManager = {
    getAllAccounts: () => [
        {
            email: 'test@example.com',
            projectId: 'test-project',
            lastUsed: Date.now(), // Active
            enabled: true,
            isInvalid: false
        },
        {
            email: 'inactive@example.com',
            projectId: 'inactive-project',
            lastUsed: Date.now() - 24 * 60 * 60 * 1000, // Inactive
            enabled: true,
            isInvalid: false
        }
    ],
    getTokenForAccount: async (acc) => 'mock-token'
};

// Mock fetcher
let capturedRequests = [];
const mockFetcher = async (options) => {
    capturedRequests.push(options);
    return {
        statusCode: 200,
        body: { status: 'ok' }
    };
};

async function runTest() {
    console.log('Starting Telemetry Test...');

    // Initialize with mock fetcher
    initialize(mockAccountManager, mockFetcher);

    // Notify activity to trigger loop
    notifyActivity();

    // Wait for loop to process (it has initial 5s delay + some processing time)
    console.log('Waiting for telemetry loop (approx 6s)...');
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Check captured requests
    console.log(`Captured ${capturedRequests.length} requests`);

    assert(capturedRequests.length > 0, 'Should have sent telemetry requests');

    // Check that we only sent for active account
    const activeProjectRequests = capturedRequests.filter(req => req.json.project === 'test-project');
    const inactiveProjectRequests = capturedRequests.filter(req => req.json.project === 'inactive-project');

    assert(activeProjectRequests.length > 0, 'Should send telemetry for active account');
    assert(inactiveProjectRequests.length === 0, 'Should NOT send telemetry for inactive account');

    // Check request structure
    const req = activeProjectRequests[0];
    assert.strictEqual(req.method, 'POST');
    // User-Agent should be a browser UA now (Mozilla/...) not "antigravity"
    assert(req.headers['User-Agent'].includes('Mozilla'), 'User-Agent should be a browser-like string');
    assert(req.headers['Authorization'] === 'Bearer mock-token', 'Auth header should be correct');
    assert(req.headerGeneratorOptions.browsers[0].name === 'chrome', 'Should mimic Chrome');

    // Check interaction events for active account (should have TYPING)
    const trajectoryReq = activeProjectRequests.find(r => r.url.includes('recordTrajectoryAnalytics'));
    if (trajectoryReq) {
        const events = trajectoryReq.json.trajectory_metrics.interaction_events;
        const hasTyping = events.some(e => e.interaction_type === 'TYPING');
        assert(hasTyping, 'Active account should produce TYPING events');
        console.log(`Verified ${events.length} interaction events (Active: TYPING found)`);
    }

    console.log('Telemetry Test PASSED');
    process.exit(0);
}

runTest().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
