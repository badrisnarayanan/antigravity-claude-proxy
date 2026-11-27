import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../config.js';
import { fetch as undiciFetch } from 'undici';
import { getProxyDispatcher } from './proxy.js';

/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Get the package version from package.json
 * @param {string} [defaultVersion='1.0.0'] - Default version if package.json cannot be read
 * @returns {string} The package version
 */
export function getPackageVersion(defaultVersion = '1.0.0') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || defaultVersion;
    } catch {
        return defaultVersion;
    }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}


/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @param {AbortSignal} [signal] - Optional; when it fires, the sleep ends early by
 *   rejecting with signal.reason (used to stop waiting once the client has gone)
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms, signal) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

// Error codes Node and undici use when the connection itself fails (#384)
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENETUNREACH',
    'ENETDOWN',
    'EHOSTUNREACH',
    'EHOSTDOWN',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED'
]);

/**
 * Check if an error is a network error (transient)
 * Looks at the message and at the error codes on the error and its causes, since
 * fetch only says "fetch failed" and keeps the real reason (e.g. ETIMEDOUT) in error.cause.
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    if (!error) return false;
    const msg = String(error.message || '').toLowerCase();
    // Google answered with a 400: a bad request, not a network problem, even when
    // its text happens to say "timeout" (e.g. a tool with a `timeout` parameter)
    if (msg.startsWith('invalid_request_error')) return false;
    if (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout')
    ) {
        return true;
    }
    // Walk error.cause (and AggregateError.errors, used when every address failed)
    const seen = new Set();
    const queue = [error];
    while (queue.length > 0) {
        const err = queue.shift();
        if (!err || typeof err !== 'object' || seen.has(err)) continue;
        seen.add(err);
        if (err.code && NETWORK_ERROR_CODES.has(err.code)) return true;
        if (err.cause) queue.push(err.cause);
        if (Array.isArray(err.errors)) queue.push(...err.errors);
    }
    return false;
}

/**
 * Short description of a network error, including the underlying cause
 * (fetch's own message is only "fetch failed")
 * @param {Error} error - The error
 * @returns {string} e.g. "fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)"
 */
export function describeNetworkError(error) {
    const message = error?.message || String(error);
    const cause = error?.cause;
    if (!cause || typeof cause !== 'object') return message;
    const detail = [cause.code, cause.message].filter(Boolean).join(': ');
    return detail && detail !== message ? `${message} (${detail})` : message;
}

/**
 * Throttled fetch that applies a configurable delay before each request
 * Only applies delay when requestThrottlingEnabled is true
 * @param {string|URL} url - The URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function throttledFetch(url, options) {
    if (config.requestThrottlingEnabled) {
        const delayMs = config.requestDelayMs || 200;
        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }
    const dispatcher = getProxyDispatcher();
    if (dispatcher) {
        // Use undici's own fetch so the proxy dispatcher is honoured whatever undici
        // version Node bundles for the built-in fetch (see src/utils/proxy.js).
        return undiciFetch(url, { ...options, dispatcher });
    }
    return fetch(url, options);
}

/**
 * Generate random jitter for backoff timing (Thundering Herd Prevention)
 * Prevents all clients from retrying at the exact same moment after errors.
 * @param {number} maxJitterMs - Maximum jitter range (result will be ±maxJitterMs/2)
 * @returns {number} Random jitter value between -maxJitterMs/2 and +maxJitterMs/2
 */
export function generateJitter(maxJitterMs) {
    return Math.random() * maxJitterMs - (maxJitterMs / 2);
}
