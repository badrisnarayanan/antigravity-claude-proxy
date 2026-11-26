/**
 * Signature Cache — persistent, LRU-bounded
 *
 * Gemini models require thoughtSignature on tool calls and thinking blocks,
 * but Anthropic-protocol clients strip non-standard fields. This cache stores
 * signatures by tool_use_id so they can be restored in subsequent requests.
 *
 * Signatures have no fixed time-based expiry — they stay valid for the lifetime
 * of active conversations, and dropping them mid-conversation silently rewrites
 * conversation history on replay, which busts the upstream implicit-cache prefix
 * and drops thinking blocks. The store is persisted to disk and reloaded at boot,
 * bounded by an LRU cap so memory and on-disk size stay bounded over months of use.
 *
 * Also caches thinking block signatures with model family for cross-model
 * compatibility checking, and Gemini signatures that arrive on the final text
 * part of a reply (keyed to the conversation history and the reply text).
 *
 * Persistence: JSON file, atomic tmp+rename writes, mode 0600, debounced
 * async writes (plus a periodic safety flush and synchronous flush on SIGTERM/SIGINT/
 * exit). All persistence failures fail open: the in-memory cache keeps
 * working and the proxy never errors because of store I/O.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';

const toolSignatureCache = new Map();      // toolUseId -> signature (insertion-ordered LRU)
const thinkingSignatureCache = new Map();   // signature -> modelFamily (insertion-ordered LRU)
const textSignatureCache = new Map();       // history+text key -> signature (insertion-ordered LRU)

const STORE_VERSION = 1;
const DEFAULT_MAX_TOOL_SIGNATURES = 20_000;
const DEFAULT_MAX_THINKING_SIGNATURES = 10_000;
const DEFAULT_MAX_TEXT_SIGNATURES = 10_000;
const FLUSH_DEBOUNCE_MS = 5000;
const PERIODIC_FLUSH_MS = 30_000;
const MAX_SILENT_STORE_ERRORS = 20;

function parsePositiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const maxToolSignatures = parsePositiveIntEnv('ANTIGRAVITY_SIGNATURE_CACHE_MAX_TOOL', DEFAULT_MAX_TOOL_SIGNATURES);
const maxThinkingSignatures = parsePositiveIntEnv('ANTIGRAVITY_SIGNATURE_CACHE_MAX_THINK', DEFAULT_MAX_THINKING_SIGNATURES);
const maxTextSignatures = parsePositiveIntEnv('ANTIGRAVITY_SIGNATURE_CACHE_MAX_TEXT', DEFAULT_MAX_TEXT_SIGNATURES);

function lruSet(map, key, value, maxEntries) {
    if (map.has(key)) {
        map.delete(key);
    }
    map.set(key, value);
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function lruGet(map, key) {
    if (!map.has(key)) return null;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
}

function resolveStorePath() {
    const fromEnv = process.env.ANTIGRAVITY_SIGNATURE_STORE;
    if (fromEnv && fromEnv.trim()) return fromEnv;
    return path.join(os.homedir(), '.config', 'antigravity-proxy', 'signature-store.json');
}

let storePath = resolveStorePath();
let flushTimer = null;
let periodicTimer = null;
let dirty = false;
let storeErrorCount = 0;
let writeInFlight = null;
let storeGeneration = 0;

function reportStoreError(context, error) {
    if (storeErrorCount < MAX_SILENT_STORE_ERRORS) {
        storeErrorCount++;
        // Console only: this module is imported before the logger is configured.
        console.warn(`[SignatureCache] ${context} failed: ${error?.message ?? error}`);
    }
}

function loadFromDisk() {
    try {
        const raw = fs.readFileSync(storePath, 'utf8');
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw);
        if (parsed?.version !== STORE_VERSION) return;
        let prunedOnLoad = false;
        if (parsed.tool && typeof parsed.tool === 'object') {
            const entries = Object.entries(parsed.tool);
            if (entries.length > maxToolSignatures) prunedOnLoad = true;
            for (const [id, sig] of entries) {
                if (typeof id === 'string' && typeof sig === 'string') {
                    lruSet(toolSignatureCache, id, sig, maxToolSignatures);
                }
            }
        }
        if (parsed.think && typeof parsed.think === 'object') {
            const entries = Object.entries(parsed.think);
            if (entries.length > maxThinkingSignatures) prunedOnLoad = true;
            for (const [sig, family] of entries) {
                if (typeof sig === 'string' && typeof family === 'string') {
                    lruSet(thinkingSignatureCache, sig, family, maxThinkingSignatures);
                }
            }
        }
        if (parsed.text && typeof parsed.text === 'object') {
            const entries = Object.entries(parsed.text);
            if (entries.length > maxTextSignatures) prunedOnLoad = true;
            for (const [key, sig] of entries) {
                if (typeof key === 'string' && typeof sig === 'string') {
                    lruSet(textSignatureCache, key, sig, maxTextSignatures);
                }
            }
        }
        if (prunedOnLoad) {
            scheduleFlush();
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            reportStoreError('load', error);
        }
        // Corrupt or unreadable store: start empty rather than failing boot.
    }
}

function serializeStore() {
    return JSON.stringify({
        version: STORE_VERSION,
        tool: Object.fromEntries(toolSignatureCache),
        think: Object.fromEntries(thinkingSignatureCache),
        text: Object.fromEntries(textSignatureCache),
    });
}

/**
 * Synchronous flush, used only on process exit/signals where async I/O
 * would never complete. Bumps the store generation so any async write still
 * in flight discards its (older) snapshot instead of renaming over this one.
 */
function writeStoreSync() {
    if (!dirty) return;
    storeGeneration++;
    try {
        const data = serializeStore();
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        const tmp = `${storePath}.tmp-sync-${process.pid}`;
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, storePath);
        dirty = false;
    } catch (error) {
        reportStoreError('flush', error);
    }
}

/**
 * Normal-operation flush. File I/O runs asynchronously so a store near the
 * LRU cap (tens of MB) never blocks the event loop on disk writes; only the
 * JSON serialization stays synchronous. At most one write is in flight.
 */
function writeStoreAsync() {
    if (!dirty || writeInFlight) return;
    let data;
    try {
        data = serializeStore();
    } catch (error) {
        reportStoreError('flush', error);
        return;
    }
    dirty = false;
    const generation = storeGeneration;
    const targetPath = storePath;
    const tmp = `${targetPath}.tmp-${process.pid}`;
    let failed = false;
    writeInFlight = (async () => {
        try {
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.writeFile(tmp, data, { mode: 0o600 });
            if (generation !== storeGeneration) {
                // Cache was cleared or flushed synchronously meanwhile.
                await fs.promises.rm(tmp, { force: true });
                return;
            }
            await fs.promises.rename(tmp, targetPath);
        } catch (error) {
            failed = true;
            dirty = true;
            reportStoreError('flush', error);
        }
    })().finally(() => {
        writeInFlight = null;
        // Changes made during the write get flushed promptly; after a failed
        // write, leave the retry to the periodic flush instead of spinning.
        if (dirty && !failed) scheduleFlush();
    });
}

function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        writeStoreAsync();
    }, FLUSH_DEBOUNCE_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function removeStoreFile() {
    try {
        fs.rmSync(storePath, { force: true });
    } catch (error) {
        reportStoreError('remove', error);
    }
}

loadFromDisk();

periodicTimer = setInterval(() => writeStoreAsync(), PERIODIC_FLUSH_MS);
if (typeof periodicTimer.unref === 'function') periodicTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT', 'exit']) {
    process.on(signal, () => writeStoreSync());
}

/**
 * Store a signature for a tool_use_id. Bounded by an LRU cap (no fixed TTL):
 * replayed signatures stay byte-stable for active conversations.
 * @param {string} toolUseId - The tool use ID
 * @param {string} signature - The thoughtSignature to cache
 */
export function cacheSignature(toolUseId, signature) {
    if (!toolUseId || !signature) return;
    const prev = toolSignatureCache.get(toolUseId);
    lruSet(toolSignatureCache, toolUseId, signature, maxToolSignatures);
    if (prev === signature) return;
    scheduleFlush();
}

/**
 * Get a cached signature for a tool_use_id.
 * @param {string} toolUseId - The tool use ID
 * @returns {string|null} The cached signature or null if never seen
 */
export function getCachedSignature(toolUseId) {
    if (!toolUseId) return null;
    return lruGet(toolSignatureCache, toolUseId);
}

/**
 * Cache a thinking block signature with its model family. Bounded by an LRU cap.
 * @param {string} signature - The thinking signature to cache
 * @param {string} modelFamily - The model family ('claude' or 'gemini')
 */
export function cacheThinkingSignature(signature, modelFamily) {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    const prev = thinkingSignatureCache.get(signature);
    lruSet(thinkingSignatureCache, signature, modelFamily, maxThinkingSignatures);
    if (prev === modelFamily) return;
    scheduleFlush();
}

/**
 * Get the cached model family for a thinking signature.
 * @param {string} signature - The signature to look up
 * @returns {string|null} 'claude', 'gemini', or null if never seen
 */
export function getCachedSignatureFamily(signature) {
    if (!signature) return null;
    return lruGet(thinkingSignatureCache, signature);
}

// ---------------------------------------------------------------------------
// Trailing text signatures
//
// Gemini 3.8 / Gemini 4 often put the reply's thoughtSignature on the last
// text part (the chunk with finishReason STOP) instead of on a thought part.
// Anthropic clients have nowhere to keep it, so it is cached here, keyed to the
// model, system prompt, prior history and exact reply text, and put back on
// that assistant turn's last text part when the next request replays it.
// Like the tool cache this has no TTL: once restored, a signature stays in
// the replayed history so the upstream implicit-cache prefix stays stable.
// ---------------------------------------------------------------------------

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter(key => key !== 'cache_control').sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// Clients replay the same turn in different shapes: Claude Code sends the
// newest turn as [{ type: 'text', text, cache_control }] and the same turn as a
// plain string once the cache marker moves on. Key on one shape.
function normalizeForKey(message) {
    if (!message || typeof message.content !== 'string') return message;
    return { ...message, content: [{ type: 'text', text: message.content }] };
}

// Running hash over the history, so restoring every turn of a long
// conversation costs one pass over it instead of one pass per turn.
function extendHistoryHash(prevHash, message) {
    return sha256(`${prevHash}\n${stableSerialize(normalizeForKey(message))}`);
}

function textSignatureKey(model, system, historyHash, text) {
    return sha256(stableSerialize([model, system ?? null, historyHash, text]));
}

function assistantText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(block => block?.type === 'text').map(block => block.text || '').join('');
}

/**
 * Cache a Gemini signature that arrived on a reply's final text part.
 * @param {string} model - The request model
 * @param {{messages?: Array, system?: any}} context - The request that produced the reply
 * @param {string} text - The full reply text
 * @param {string} signature - The thoughtSignature
 */
export function cacheTrailingTextSignature(model, context, text, signature) {
    if (!model || getModelFamily(model) !== 'gemini') return;
    if (!text || !signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    let historyHash = '';
    for (const message of context?.messages || []) {
        historyHash = extendHistoryHash(historyHash, message);
    }
    const key = textSignatureKey(model, context?.system, historyHash, text);
    const prev = textSignatureCache.get(key);
    lruSet(textSignatureCache, key, signature, maxTextSignatures);
    if (prev === signature) return;
    scheduleFlush();
}

/**
 * Put cached trailing signatures back on the assistant turns they came from.
 * @param {Array} messages - Messages to restore (same order as contextMessages)
 * @param {string} model - The request model
 * @param {any} system - The request system prompt
 * @param {Array} [contextMessages] - Raw request messages used for the history key
 * @returns {Array} messages, or a copy with thoughtSignature set on matching text blocks
 */
export function restoreTrailingTextSignatures(messages, model, system, contextMessages = messages) {
    if (!Array.isArray(messages) || !model || textSignatureCache.size === 0) return messages;
    let changed = false;
    let historyHash = '';
    const restored = messages.map((message, index) => {
        const prefixHash = historyHash;
        historyHash = extendHistoryHash(historyHash, contextMessages[index]);
        if (message?.role !== 'assistant') return message;
        const text = assistantText(message.content);
        if (!text) return message;

        const signature = lruGet(textSignatureCache, textSignatureKey(model, system, prefixHash, text));
        if (!signature) return message;

        changed = true;
        if (typeof message.content === 'string') {
            return { ...message, content: [{ type: 'text', text: message.content, thoughtSignature: signature }] };
        }
        const blocks = [...message.content];
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i]?.type === 'text') {
                blocks[i] = { ...blocks[i], thoughtSignature: signature };
                break;
            }
        }
        return { ...message, content: blocks };
    });
    return changed ? restored : messages;
}

/**
 * Clear all entries from the thinking signature cache.
 * Used for testing cold cache scenarios.
 */
export function clearThinkingSignatureCache() {
    thinkingSignatureCache.clear();
    scheduleFlush();
}

/**
 * Flush pending changes to disk now and wait for the write to finish.
 * The debounced flush normally does this; exported for tests and callers
 * that need the store on disk at a known point.
 * @returns {Promise<void>}
 */
export async function flushSignatureStore() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (writeInFlight) await writeInFlight;
    writeStoreAsync();
    if (writeInFlight) await writeInFlight;
}

/**
 * Clear all signature caches and delete the persisted store.
 */
export function clearAllSignatureCaches() {
    toolSignatureCache.clear();
    thinkingSignatureCache.clear();
    textSignatureCache.clear();
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    dirty = false;
    storeGeneration++; // any in-flight async write must not resurrect the store
    removeStoreFile();
}
