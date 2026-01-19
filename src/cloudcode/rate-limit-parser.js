/**
 * Rate Limit Parser for Cloud Code
 *
 * Parses reset times from HTTP headers and error messages.
 * Supports various formats: Retry-After, x-ratelimit-reset,
 * quotaResetDelay, quotaResetTimeStamp, and duration strings.
 */

import { formatDuration } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * Parse reset time from HTTP response or error
 * Checks headers first, then error message body
 * Returns milliseconds or null if not found
 *
 * @param {Response|Error} responseOrError - HTTP Response object or Error
 * @param {string} errorText - Optional error body text
 */
export function parseResetTime(responseOrError, errorText = '') {
    let resetMs = null;

    // If it's a Response object, check headers first
    if (responseOrError && typeof responseOrError.headers?.get === 'function') {
        const headers = responseOrError.headers;

        // Standard Retry-After header (seconds or HTTP date)
        const retryAfter = headers.get('retry-after');
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
                resetMs = seconds * 1000;
                logger.debug(`[CloudCode] Retry-After header: ${seconds}s`);
            } else {
                // Try parsing as HTTP date
                const date = new Date(retryAfter);
                if (!isNaN(date.getTime())) {
                    resetMs = date.getTime() - Date.now();
                    if (resetMs > 0) {
                        logger.debug(`[CloudCode] Retry-After date: ${retryAfter}`);
                    } else {
                        resetMs = null;
                    }
                }
            }
        }

        // x-ratelimit-reset (Unix timestamp in seconds)
        if (!resetMs) {
            const ratelimitReset = headers.get('x-ratelimit-reset');
            if (ratelimitReset) {
                const resetTimestamp = parseInt(ratelimitReset, 10) * 1000;
                resetMs = resetTimestamp - Date.now();
                if (resetMs > 0) {
                    logger.debug(`[CloudCode] x-ratelimit-reset: ${new Date(resetTimestamp).toISOString()}`);
                } else {
                    resetMs = null;
                }
            }
        }

        // x-ratelimit-reset-after (seconds)
        if (!resetMs) {
            const resetAfter = headers.get('x-ratelimit-reset-after');
            if (resetAfter) {
                const seconds = parseInt(resetAfter, 10);
                if (!isNaN(seconds) && seconds > 0) {
                    resetMs = seconds * 1000;
                    logger.debug(`[CloudCode] x-ratelimit-reset-after: ${seconds}s`);
                }
            }
        }
    }

    // If no header found, try parsing from error message/body
    if (!resetMs) {
        const msg = (responseOrError instanceof Error ? responseOrError.message : errorText) || '';

        // Try to extract "quotaResetDelay" first (e.g. "754.431528ms" or "1.5s")
        // This is Google's preferred format for rate limit reset delay
        const quotaDelayMatch = msg.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i);
        if (quotaDelayMatch) {
            const value = parseFloat(quotaDelayMatch[1]);
            const unit = quotaDelayMatch[2].toLowerCase();
            resetMs = unit === 's' ? Math.ceil(value * 1000) : Math.ceil(value);
            logger.debug(`[CloudCode] Parsed quotaResetDelay from body: ${resetMs}ms`);
        }

        // Try to extract "quotaResetTimeStamp" (ISO format like "2025-12-31T07:00:47Z")
        if (!resetMs) {
            const quotaTimestampMatch = msg.match(/quotaResetTimeStamp[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
            if (quotaTimestampMatch) {
                const resetTime = new Date(quotaTimestampMatch[1]).getTime();
                if (!isNaN(resetTime)) {
                    resetMs = resetTime - Date.now();
                    // Even if expired or 0, we found a timestamp, so rely on it.
                    // But if it's negative, it means "now", so treat as small wait.
                    logger.debug(`[CloudCode] Parsed quotaResetTimeStamp: ${quotaTimestampMatch[1]} (Delta: ${resetMs}ms)`);
                }
            }
        }

        // Try to extract "retry-after-ms" or "retryDelay" - check seconds format first (e.g. "7739.23s")
        // Added stricter regex to avoid partial matches
        if (!resetMs) {
             const secMatch = msg.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+([\d.]+)(?:s\b|s")/i);
             if (secMatch) {
                 resetMs = Math.ceil(parseFloat(secMatch[1]) * 1000);
                 logger.debug(`[CloudCode] Parsed retry seconds from body (precise): ${resetMs}ms`);
             }
        }

        if (!resetMs) {
            // Check for ms (explicit "ms" suffix or implicit if no suffix)
            const msMatch = msg.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+(\d+)(?:\s*ms)?(?![\w.])/i);
            if (msMatch) {
                resetMs = parseInt(msMatch[1], 10);
                logger.debug(`[CloudCode] Parsed retry-after-ms from body: ${resetMs}ms`);
            }
        }

        // Try to extract seconds value like "retry after 60 seconds"
        if (!resetMs) {
            const secMatch = msg.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i);
            if (secMatch) {
                resetMs = parseInt(secMatch[1], 10) * 1000;
                logger.debug(`[CloudCode] Parsed retry seconds from body: ${secMatch[1]}s`);
            }
        }

        // Try to extract duration like "1h23m45s" or "23m45s" or "45s"
        if (!resetMs) {
            const durationMatch = msg.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
            if (durationMatch) {
                if (durationMatch[1]) {
                    const hours = parseInt(durationMatch[1], 10);
                    const minutes = parseInt(durationMatch[2], 10);
                    const seconds = parseInt(durationMatch[3], 10);
                    resetMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
                } else if (durationMatch[4]) {
                    const minutes = parseInt(durationMatch[4], 10);
                    const seconds = parseInt(durationMatch[5], 10);
                    resetMs = (minutes * 60 + seconds) * 1000;
                } else if (durationMatch[6]) {
                    resetMs = parseInt(durationMatch[6], 10) * 1000;
                }
                if (resetMs) {
                    logger.debug(`[CloudCode] Parsed duration from body: ${formatDuration(resetMs)}`);
                }
            }
        }

        // Try to extract ISO timestamp or Unix timestamp
        if (!resetMs) {
            const isoMatch = msg.match(/reset[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
            if (isoMatch) {
                const resetTime = new Date(isoMatch[1]).getTime();
                if (!isNaN(resetTime)) {
                    resetMs = resetTime - Date.now();
                    if (resetMs > 0) {
                        logger.debug(`[CloudCode] Parsed ISO reset time: ${isoMatch[1]}`);
                    } else {
                        resetMs = null;
                    }
                }
            }
        }
    }

    // SANITY CHECK: Enforce strict minimums for found rate limits
    // If we found a reset time, but it's very small (e.g. < 1s) or negative,
    // explicitly bump it up to avoid "Available in 0s" loops.
    if (resetMs !== null) {
        if (resetMs < 1000) {
            logger.debug(`[CloudCode] Reset time too small (${resetMs}ms), enforcing 2s buffer`);
            resetMs = 2000;
        }
    }

    return resetMs;
}
