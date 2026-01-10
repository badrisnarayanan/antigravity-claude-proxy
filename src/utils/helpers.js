/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

// Re-export fetch utilities
export { fetchWithTimeout, isTimeoutError } from './fetch-with-timeout.js';

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
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    // Check for timeout errors first
    if (error?.isTimeout === true || error?.code === 'ETIMEDOUT') {
        return true;
    }

    const msg = (error?.message || '').toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('econnrefused') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout')
    );
}

/**
 * Check if an error is an authentication error (permanent until fixed)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is an auth error
 */
export function isAuthError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('401') ||
        msg.includes('unauthenticated') ||
        msg.includes('invalid_grant') ||
        msg.includes('invalid_client')
    );
}

/**
 * Check if an error is a rate limit error
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a rate limit error
 */
export function isRateLimitError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('429') ||
        msg.includes('resource_exhausted') ||
        msg.includes('quota_exhausted')
    );
}
