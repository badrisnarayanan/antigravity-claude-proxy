/**
 * Fetch with Timeout Utility
 * Wrapper around fetch() that adds timeout support
 */

// Default timeout in milliseconds (30 seconds)
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Fetch with timeout support
 * Wraps the native fetch with an AbortController timeout
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options (same as native fetch)
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<Response>} The fetch response
 * @throws {Error} If timeout is reached or fetch fails
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();

    // Set up the timeout
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (error) {
        // Convert AbortError to a more descriptive timeout error
        if (error.name === 'AbortError') {
            const timeoutError = new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
            timeoutError.code = 'ETIMEDOUT';
            timeoutError.isTimeout = true;
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Check if an error is a timeout error
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is a timeout error
 */
export function isTimeoutError(error) {
    return error?.isTimeout === true || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError';
}

export default fetchWithTimeout;
