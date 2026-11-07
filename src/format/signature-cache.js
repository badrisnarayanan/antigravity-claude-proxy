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
 * compatibility checking.
 *
 * Persistence: JSON file, atomic tmp+rename writes, mode 0600, debounced
 * async writes (plus a periodic safety flush and synchronous flush on SIGTERM/SIGINT/
 * exit). All persistence failures fail open: the in-memory cache keeps
 * working and the proxy never errors because of store I/O.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_SIGNATURE_LENGTH } from '../constants.js';

const toolSignatureCache = new Map();      // toolUseId -> signature (insertion-ordered LRU)
const thinkingSignatureCache = new Map();   // signature -> modelFamily (insertion-ordered LRU)

const STORE_VERSION = 1;
const DEFAULT_MAX_TOOL_SIGNATURES = 20_000;
const DEFAULT_MAX_THINKING_SIGNATURES = 10_000;
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
 * Clear both signature caches and delete the persisted store.
 */
export function clearAllSignatureCaches() {
    toolSignatureCache.clear();
    thinkingSignatureCache.clear();
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    dirty = false;
    storeGeneration++; // any in-flight async write must not resurrect the store
    removeStoreFile();
}
