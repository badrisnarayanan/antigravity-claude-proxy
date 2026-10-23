/**
 * Signature Cache
 * In-memory cache for Gemini thoughtSignatures
 *
 * Gemini models require thoughtSignature on tool calls, but Claude Code
 * strips non-standard fields. This cache stores signatures by tool_use_id
 * so they can be restored in subsequent requests.
 *
 * Also caches thinking block signatures with model family for cross-model
 * compatibility checking.
 */

import { GEMINI_SIGNATURE_CACHE_TTL_MS, MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import crypto from 'crypto';

const signatureCache = new Map();
const thinkingSignatureCache = new Map();
const trailingTextSignatureCache = new Map();
const MAX_TRAILING_TEXT_SIGNATURES = 500;

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter(key => key !== 'cache_control').sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function trailingTextSignatureKey(model, context, text) {
    const payload = stableSerialize({
        model,
        system: context?.system ?? null,
        messages: context?.messages || [],
        text
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Cache a Gemini signature that arrived on a final text part, keyed to the
 * request history and exact assistant text so another conversation cannot
 * accidentally reuse it.
 */
export function cacheTrailingTextSignature(model, context, text, signature) {
    if (!model || getModelFamily(model) !== 'gemini' || !text || !signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    const key = trailingTextSignatureKey(model, context, text);
    trailingTextSignatureCache.delete(key);
    trailingTextSignatureCache.set(key, { signature, timestamp: Date.now() });
    while (trailingTextSignatureCache.size > MAX_TRAILING_TEXT_SIGNATURES) {
        trailingTextSignatureCache.delete(trailingTextSignatureCache.keys().next().value);
    }
}

/** Restore a cached trailing signature to matching prior Gemini text turns. */
export function restoreTrailingTextSignatures(messages, model, system, contextMessages = messages) {
    if (!Array.isArray(messages) || !model) return messages;
    let changed = false;
    const restored = messages.map((message, index) => {
        if (message?.role !== 'assistant') return message;
        const content = message.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('')
                : '';
        if (!text) return message;

        const context = { system, messages: contextMessages.slice(0, index) };
        const key = trailingTextSignatureKey(model, context, text);
        const entry = trailingTextSignatureCache.get(key);
        if (!entry) return message;
        if (Date.now() - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
            trailingTextSignatureCache.delete(key);
            return message;
        }

        changed = true;
        if (typeof content === 'string') {
            return { ...message, content: [{ type: 'text', text: content, thoughtSignature: entry.signature }] };
        }
        const blocks = [...content];
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i]?.type === 'text') {
                blocks[i] = { ...blocks[i], thoughtSignature: entry.signature };
                break;
            }
        }
        return { ...message, content: blocks };
    });
    return changed ? restored : messages;
}

/**
 * Store a signature for a tool_use_id
 * @param {string} toolUseId - The tool use ID
 * @param {string} signature - The thoughtSignature to cache
 */
export function cacheSignature(toolUseId, signature) {
    if (!toolUseId || !signature) return;
    signatureCache.set(toolUseId, {
        signature,
        timestamp: Date.now()
    });
}

/**
 * Get a cached signature for a tool_use_id
 * @param {string} toolUseId - The tool use ID
 * @returns {string|null} The cached signature or null if not found/expired
 */
export function getCachedSignature(toolUseId) {
    if (!toolUseId) return null;
    const entry = signatureCache.get(toolUseId);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
        signatureCache.delete(toolUseId);
        return null;
    }

    return entry.signature;
}

/**
 * Cache a thinking block signature with its model family
 * @param {string} signature - The thinking signature to cache
 * @param {string} modelFamily - The model family ('claude' or 'gemini')
 */
export function cacheThinkingSignature(signature, modelFamily) {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    thinkingSignatureCache.set(signature, {
        modelFamily,
        timestamp: Date.now()
    });
}

/**
 * Get the cached model family for a thinking signature
 * @param {string} signature - The signature to look up
 * @returns {string|null} 'claude', 'gemini', or null if not found/expired
 */
export function getCachedSignatureFamily(signature) {
    if (!signature) return null;
    const entry = thinkingSignatureCache.get(signature);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
        thinkingSignatureCache.delete(signature);
        return null;
    }

    return entry.modelFamily;
}

/**
 * Clear all entries from the thinking signature cache.
 * Used for testing cold cache scenarios.
 */
export function clearThinkingSignatureCache() {
    thinkingSignatureCache.clear();
}
