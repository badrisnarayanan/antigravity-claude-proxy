/**
 * Signature Cache — persistent, no TTL
 *
 * Gemini models require thoughtSignature on tool calls and thinking blocks,
 * but Anthropic-protocol clients strip non-standard fields. This cache stores
 * signatures by tool_use_id so they can be restored in subsequent requests.
 *
 * Signatures are kept forever — they stay valid for the lifetime of the
 * conversation they belong to, and dropping them (e.g. after a fixed TTL or
 * a proxy restart) silently rewrites conversation history on replay, which
 * busts the upstream implicit-cache prefix and drops thinking blocks. The
 * store is therefore also persisted to disk and reloaded at boot.
 *
 * Also caches thinking block signatures with model family for cross-model
 * compatibility checking.
 *
 * Persistence: JSON file, atomic tmp+rename writes, mode 0600, debounced
 * (plus a periodic safety flush and synchronous flush on SIGTERM/SIGINT/
 * exit). All persistence failures fail open: the in-memory cache keeps
 * working and the proxy never errors because of store I/O.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_SIGNATURE_LENGTH } from '../constants.js';

const toolSignatureCache = new Map();      // toolUseId -> signature
const thinkingSignatureCache = new Map();   // signature -> modelFamily

const STORE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 1000;
const PERIODIC_FLUSH_MS = 30_000;
const MAX_SILENT_STORE_ERRORS = 20;

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
        if (parsed.tool && typeof parsed.tool === 'object') {
            for (const [id, sig] of Object.entries(parsed.tool)) {
                if (typeof id === 'string' && typeof sig === 'string') {
                    toolSignatureCache.set(id, sig);
                }
            }
        }
        if (parsed.think && typeof parsed.think === 'object') {
            for (const [sig, family] of Object.entries(parsed.think)) {
                if (typeof sig === 'string' && typeof family === 'string') {
                    thinkingSignatureCache.set(sig, family);
                }
            }
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            reportStoreError('load', error);
        }
        // Corrupt or unreadable store: start empty rather than failing boot.
    }
}

function writeStoreSync() {
    if (!dirty) return;
    try {
        const payload = {
            version: STORE_VERSION,
            tool: Object.fromEntries(toolSignatureCache),
            think: Object.fromEntries(thinkingSignatureCache),
        };
        const dir = path.dirname(storePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${storePath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
        fs.renameSync(tmp, storePath);
        dirty = false;
    } catch (error) {
        reportStoreError('flush', error);
    }
}

function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        writeStoreSync();
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

periodicTimer = setInterval(() => writeStoreSync(), PERIODIC_FLUSH_MS);
if (typeof periodicTimer.unref === 'function') periodicTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT', 'exit']) {
    process.on(signal, () => writeStoreSync());
}

/**
 * Store a signature for a tool_use_id. Kept forever (no TTL): replayed
 * signatures must stay byte-stable for the whole conversation lifetime.
 * @param {string} toolUseId - The tool use ID
 * @param {string} signature - The thoughtSignature to cache
 */
export function cacheSignature(toolUseId, signature) {
    if (!toolUseId || !signature) return;
    const prev = toolSignatureCache.get(toolUseId);
    if (prev === signature) return;
    toolSignatureCache.set(toolUseId, signature);
    scheduleFlush();
}

/**
 * Get a cached signature for a tool_use_id.
 * @param {string} toolUseId - The tool use ID
 * @returns {string|null} The cached signature or null if never seen
 */
export function getCachedSignature(toolUseId) {
    if (!toolUseId) return null;
    return toolSignatureCache.get(toolUseId) ?? null;
}

/**
 * Cache a thinking block signature with its model family. Kept forever.
 * @param {string} signature - The thinking signature to cache
 * @param {string} modelFamily - The model family ('claude' or 'gemini')
 */
export function cacheThinkingSignature(signature, modelFamily) {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    const prev = thinkingSignatureCache.get(signature);
    if (prev === modelFamily) return;
    thinkingSignatureCache.set(signature, modelFamily);
    scheduleFlush();
}

/**
 * Get the cached model family for a thinking signature.
 * @param {string} signature - The signature to look up
 * @returns {string|null} 'claude', 'gemini', or null if never seen
 */
export function getCachedSignatureFamily(signature) {
    if (!signature) return null;
    return thinkingSignatureCache.get(signature) ?? null;
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
    removeStoreFile();
}
