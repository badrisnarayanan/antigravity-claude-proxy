/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Balances two goals:
 * 1. Cache continuity - same conversation should use same account
 * 2. Load distribution - new conversations should rotate accounts
 */

import crypto from 'crypto';

// Track active sessions: contentHash -> { sessionId, messageCount, lastSeen }
const activeSessionMap = new Map();
const MAX_SESSIONS = 500;
const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * Derive a session ID for account selection and caching.
 *
 * Strategy:
 * - Track conversations by their first user message + approximate message count
 * - Generate unique session ID for each new conversation
 * - Reuse session ID for same conversation across turns
 * - Expire old sessions to trigger rotation for new conversations with same first message
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @returns {string} A session ID (32 hex characters)
 */
export function deriveSessionId(anthropicRequest) {
    const messages = anthropicRequest.messages || [];
    const messageCount = messages.length;

    // Find the first user message content
    let firstUserContent = '';
    for (const msg of messages) {
        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                firstUserContent = msg.content;
            } else if (Array.isArray(msg.content)) {
                firstUserContent = msg.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n');
            }
            if (firstUserContent) break;
        }
    }

    if (!firstUserContent) {
        return crypto.randomUUID();
    }

    // Create a signature for this conversation
    const contentHash = crypto.createHash('sha256')
        .update(firstUserContent)
        .digest('hex')
        .substring(0, 16);

    const now = Date.now();

    // Check for existing session
    const existing = activeSessionMap.get(contentHash);

    if (existing) {
        // Check if this is the same conversation continuing
        // A conversation "continues" if message count is >= what we've seen
        // and it hasn't been too long since last request
        const timeSinceLastSeen = now - existing.lastSeen;
        const isContinuation = messageCount >= existing.messageCount &&
                               timeSinceLastSeen < SESSION_EXPIRY_MS;

        if (isContinuation) {
            // Update tracking
            existing.messageCount = Math.max(existing.messageCount, messageCount);
            existing.lastSeen = now;
            return existing.sessionId;
        }

        // This is a NEW conversation with same first message - generate new session
        // (Either messageCount went backwards or session expired)
    }

    // New conversation - generate unique session ID
    const uniqueInput = `${contentHash}:${now}:${crypto.randomBytes(8).toString('hex')}`;
    const sessionId = crypto.createHash('sha256')
        .update(uniqueInput)
        .digest('hex')
        .substring(0, 32);

    // Store in map
    activeSessionMap.set(contentHash, {
        sessionId,
        messageCount,
        lastSeen: now
    });

    // Cleanup if too many sessions
    if (activeSessionMap.size > MAX_SESSIONS) {
        const entries = [...activeSessionMap.entries()];
        // Sort by lastSeen, remove oldest
        entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        for (let i = 0; i < entries.length / 2; i++) {
            activeSessionMap.delete(entries[i][0]);
        }
    }

    return sessionId;
}

/**
 * Clear all session tracking (useful for testing)
 */
export function clearAllSessions() {
    activeSessionMap.clear();
}

/**
 * Get session tracking stats (for debugging)
 */
export function getSessionStats() {
    return {
        activeCount: activeSessionMap.size,
        maxSessions: MAX_SESSIONS
    };
}
