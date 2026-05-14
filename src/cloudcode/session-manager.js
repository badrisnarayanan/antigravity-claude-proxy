/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import crypto from 'crypto';


// Runtime storage for session IDs (per account)
// This mimics the behavior of the binary which generates a session ID at startup
// and keeps it for the process lifetime.
// Key: accountEmail, Value: sessionId
const runtimeSessionStore = new Map();

/**
 * Get or create a session ID for the given account.
 * 
 * The binary generates a session ID once at startup: `p.sessionID = rs() + Date.now()`.
 * Since our proxy is long-running, we simulate this "per-launch" behavior by storing
 * a generated ID in memory for each account.
 *
 * - If the proxy restarts, the ID changes (matching binary/VS Code restart behavior).
 * - Within a running proxy instance, the ID is stable for that account.
 * - This enables prompt caching while using the EXACT random logic of the binary.
 *
 * @param {Object} anthropicRequest - The Anthropic-format request (unused for ID generation now)
 * @param {string} accountEmail - The account email to scope the session ID
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    if (!accountEmail) {
        // Fallback for requests without an account (should differ every time)
        return generateBinaryStyleId();
    }

    // Check if we already have a session ID for this account in this process run
    if (runtimeSessionStore.has(accountEmail)) {
        return runtimeSessionStore.get(accountEmail);
    }

    // Generate a new ID using the binary's exact logic
    const newSessionId = generateBinaryStyleId();

    // Store it for future requests from this account
    runtimeSessionStore.set(accountEmail, newSessionId);

    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * logic: `rs() + Date.now()` where `rs()` is randomUUID
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
}
