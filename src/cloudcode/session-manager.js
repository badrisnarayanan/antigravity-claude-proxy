/**
 * Session Management for Cloud Code
 *
 * Session IDs give the Cloud Code backend a cache-affinity namespace.
 * A per-conversation ID (stable hash of the first user message) keeps every
 * conversation in its own namespace so interleaved conversations on the same
 * account stop evicting each other's implicit-cache KV blocks. Requests
 * without any user text fall back to a per-account process-lifetime ID.
 */

import crypto from 'crypto';


// Runtime fallback storage for session IDs (per account)
// Key: accountEmail, Value: sessionId
const runtimeSessionStore = new Map();

/** Cap on the first-user-text fed to the session hash. */
const MAX_SESSION_HASH_TEXT_CHARS = 4096;

/**
 * Extract the first meaningful user text from an Anthropic request.
 * Returns null when no user message carries text.
 */
function extractFirstUserText(anthropicRequest) {
    const messages = anthropicRequest?.messages;
    if (!Array.isArray(messages)) return null;
    for (const msg of messages) {
        if (!msg || msg.role !== 'user') continue;
        const content = msg.content;
        let text = null;
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            const parts = [];
            for (const block of content) {
                if (block && block.type === 'text' && typeof block.text === 'string') {
                    parts.push(block.text);
                }
            }
            if (parts.length > 0) text = parts.join('\n');
        }
        if (text && text.trim().length > 0) {
            return text.slice(0, MAX_SESSION_HASH_TEXT_CHARS);
        }
    }
    return null;
}

/**
 * Derive a deterministic per-conversation session ID shaped like the binary's
 * `uuid + Date.now()` format. The same conversation (same first user text,
 * same account) always maps to the same ID across turns and proxy restarts.
 */
function deriveConversationSessionId(anthropicRequest, accountEmail) {
    const firstUserText = extractFirstUserText(anthropicRequest);
    if (!firstUserText) return null;
    const digest = crypto
        .createHash('sha256')
        .update(`${accountEmail || 'anonymous'}\u0000${firstUserText}`)
        .digest('hex');
    const uuid =
        `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-` +
        `${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const tail = BigInt(`0x${digest.slice(32, 45)}`).toString();
    return `${uuid}${tail}`;
}

/**
 * Get or create a session ID for a request.
 *
 * Priority:
 *   1. Per-conversation deterministic ID from the first user message —
 *      restores cache continuity per conversation and isolates concurrent
 *      conversations from each other's cache pressure.
 *   2. Per-account process-lifetime ID when the request carries no user
 *      text at all (previous behavior).
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} accountEmail - The account email to scope fallback IDs
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    const conversationId = deriveConversationSessionId(anthropicRequest, accountEmail);
    if (conversationId) {
        return conversationId;
    }

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
