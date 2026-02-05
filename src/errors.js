/**
 * Custom Error Classes
 *
 * Provides structured error types for better error handling and classification.
 * Replaces string-based error detection with proper error class checking.
 */

/**
 * Base error class for Antigravity proxy errors
 */
export class AntigravityError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} code - Error code for programmatic handling
     * @param {boolean} retryable - Whether the error is retryable
     * @param {Object} metadata - Additional error metadata
     */
    constructor(message, code, retryable = false, metadata = {}) {
        super(message);
        this.name = 'AntigravityError';
        this.code = code;
        this.retryable = retryable;
        this.metadata = metadata;
    }

    /**
     * Convert to JSON for API responses
     */
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...this.metadata
        };
    }
}

/**
 * Rate limit error (429 / RESOURCE_EXHAUSTED)
 */
export class RateLimitError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {number|null} resetMs - Time in ms until rate limit resets
     * @param {string} accountEmail - Email of the rate-limited account
     */
    constructor(message, resetMs = null, accountEmail = null) {
        super(message, 'RATE_LIMITED', true, { resetMs, accountEmail });
        this.name = 'RateLimitError';
        this.resetMs = resetMs;
        this.accountEmail = accountEmail;
    }
}

/**
 * Authentication error (invalid credentials, token expired, etc.)
 */
export class AuthError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {string} accountEmail - Email of the account with auth issues
     * @param {string} reason - Specific reason for auth failure
     */
    constructor(message, accountEmail = null, reason = null) {
        super(message, 'AUTH_INVALID', false, { accountEmail, reason });
        this.name = 'AuthError';
        this.accountEmail = accountEmail;
        this.reason = reason;
    }
}

/**
 * No accounts available error
 */
export class NoAccountsError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {boolean} allRateLimited - Whether all accounts are rate limited
     */
    constructor(message = 'No accounts available', allRateLimited = false) {
        super(message, 'NO_ACCOUNTS', allRateLimited, { allRateLimited });
        this.name = 'NoAccountsError';
        this.allRateLimited = allRateLimited;
    }
}

/**
 * Max retries exceeded error
 */
export class MaxRetriesError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {number} attempts - Number of attempts made
     */
    constructor(message = 'Max retries exceeded', attempts = 0) {
        super(message, 'MAX_RETRIES', false, { attempts });
        this.name = 'MaxRetriesError';
        this.attempts = attempts;
    }
}

/**
 * API error from upstream service
 */
export class ApiError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {number} statusCode - HTTP status code
     * @param {string} errorType - Type of API error
     */
    constructor(message, statusCode = 500, errorType = 'api_error') {
        super(message, errorType.toUpperCase(), statusCode >= 500, { statusCode, errorType });
        this.name = 'ApiError';
        this.statusCode = statusCode;
        this.errorType = errorType;
    }
}

/**
 * Native module error (version mismatch, rebuild required)
 */
export class NativeModuleError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {boolean} rebuildSucceeded - Whether auto-rebuild succeeded
     * @param {boolean} restartRequired - Whether server restart is needed
     */
    constructor(message, rebuildSucceeded = false, restartRequired = false) {
        super(message, 'NATIVE_MODULE_ERROR', false, { rebuildSucceeded, restartRequired });
        this.name = 'NativeModuleError';
        this.rebuildSucceeded = rebuildSucceeded;
        this.restartRequired = restartRequired;
    }
}

/**
 * Empty response error - thrown when API returns no content
 * Used to trigger retry logic in streaming handler
 */
export class EmptyResponseError extends AntigravityError {
    /**
     * @param {string} message - Error message
     */
    constructor(message = 'No content received from API') {
        super(message, 'EMPTY_RESPONSE', true, {});
        this.name = 'EmptyResponseError';
    }
}

/**
 * Capacity exhausted error - Google's model is at capacity (not user quota)
 * Should retry on same account with shorter delay, not switch accounts immediately
 * Different from QUOTA_EXHAUSTED which indicates user's daily/hourly limit
 */
export class CapacityExhaustedError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {number|null} retryAfterMs - Suggested retry delay in ms
     */
    constructor(message = 'Model capacity exhausted', retryAfterMs = null) {
        super(message, 'CAPACITY_EXHAUSTED', true, { retryAfterMs });
        this.name = 'CapacityExhaustedError';
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Check if an error is a rate limit error
 * Works with both custom error classes and legacy string-based errors
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isRateLimitError(error) {
    if (error instanceof RateLimitError) return true;
    const msg = (error.message || '').toLowerCase();
    return msg.includes('429') ||
        msg.includes('resource_exhausted') ||
        msg.includes('quota_exhausted') ||
        msg.includes('rate limit');
}

/**
 * Check if an error is an authentication error
 * Works with both custom error classes and legacy string-based errors
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isAuthError(error) {
    if (error instanceof AuthError) return true;
    const msg = (error.message || '').toUpperCase();
    return msg.includes('AUTH_INVALID') ||
        msg.includes('AUTH_VALIDATION_REQUIRED') ||
        msg.includes('INVALID_GRANT') ||
        msg.includes('TOKEN REFRESH FAILED') ||
        // 403 PERMISSION_DENIED with VALIDATION_REQUIRED means account needs re-verification
        // This should trigger account rotation, not endpoint cycling
        (msg.includes('PERMISSION_DENIED') && msg.includes('VALIDATION_REQUIRED'));
}

/**
 * Check if an error is an empty response error
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isEmptyResponseError(error) {
    return error instanceof EmptyResponseError ||
        error?.name === 'EmptyResponseError';
}

/**
 * Check if an error is a capacity exhausted error (model overload, not user quota)
 * This is different from quota exhaustion - capacity issues are temporary infrastructure
 * limits that should be retried on the SAME account with shorter delays
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isCapacityExhaustedError(error) {
    if (error instanceof CapacityExhaustedError) return true;
    const msg = (error.message || '').toLowerCase();
    return msg.includes('model_capacity_exhausted') ||
        msg.includes('capacity_exhausted') ||
        msg.includes('model is currently overloaded') ||
        msg.includes('service temporarily unavailable');
}

export default {
    AntigravityError,
    RateLimitError,
    AuthError,
    NoAccountsError,
    MaxRetriesError,
    ApiError,
    NativeModuleError,
    EmptyResponseError,
    CapacityExhaustedError,
    isRateLimitError,
    isAuthError,
    isEmptyResponseError,
    isCapacityExhaustedError
};
