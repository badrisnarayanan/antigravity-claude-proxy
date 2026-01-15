/**
 * Simple In-Memory Rate Limiter
 *
 * Provides basic rate limiting for Express routes without external dependencies.
 * Uses a sliding window approach with automatic cleanup.
 */

/**
 * Create a rate limiter middleware
 *
 * @param {Object} options - Rate limiter options
 * @param {number} options.windowMs - Time window in milliseconds (default: 15 minutes)
 * @param {number} options.maxAttempts - Maximum attempts per window (default: 5)
 * @param {string} options.message - Error message to return (default: 'Too many attempts')
 * @param {Function} options.keyGenerator - Function to generate key from request (default: req.ip)
 * @returns {Function} Express middleware
 */
export function createRateLimiter(options = {}) {
    const {
        windowMs = 15 * 60 * 1000,  // 15 minutes
        maxAttempts = 5,
        message = 'Too many attempts, please try again later',
        keyGenerator = (req) => req.ip || 'unknown'
    } = options;

    // Store: key -> { count, windowStart }
    const attempts = new Map();

    // Cleanup old entries periodically
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, data] of attempts.entries()) {
            if (now - data.windowStart > windowMs) {
                attempts.delete(key);
            }
        }
    }, windowMs);

    // Don't prevent process exit
    cleanupInterval.unref();

    return (req, res, next) => {
        const key = keyGenerator(req);
        const now = Date.now();

        let data = attempts.get(key);

        // Reset window if expired
        if (!data || now - data.windowStart > windowMs) {
            data = { count: 0, windowStart: now };
        }

        data.count++;
        attempts.set(key, data);

        if (data.count > maxAttempts) {
            const retryAfter = Math.ceil((data.windowStart + windowMs - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                status: 'error',
                error: message,
                retryAfter
            });
        }

        next();
    };
}

/**
 * Reset rate limit for a specific key (e.g., after successful auth)
 * Note: This requires access to the internal map, so it returns a resetter function
 *
 * @param {Object} options - Same options as createRateLimiter
 * @returns {{ middleware: Function, reset: Function }} Middleware and reset function
 */
export function createRateLimiterWithReset(options = {}) {
    const {
        windowMs = 15 * 60 * 1000,
        maxAttempts = 5,
        message = 'Too many attempts, please try again later',
        keyGenerator = (req) => req.ip || 'unknown'
    } = options;

    const attempts = new Map();

    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, data] of attempts.entries()) {
            if (now - data.windowStart > windowMs) {
                attempts.delete(key);
            }
        }
    }, windowMs);

    cleanupInterval.unref();

    const middleware = (req, res, next) => {
        const key = keyGenerator(req);
        const now = Date.now();

        let data = attempts.get(key);

        if (!data || now - data.windowStart > windowMs) {
            data = { count: 0, windowStart: now };
        }

        data.count++;
        attempts.set(key, data);

        // Attach reset function to request for use after successful operation
        req.resetRateLimit = () => attempts.delete(key);

        if (data.count > maxAttempts) {
            const retryAfter = Math.ceil((data.windowStart + windowMs - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                status: 'error',
                error: message,
                retryAfter
            });
        }

        next();
    };

    const reset = (key) => attempts.delete(key);

    return { middleware, reset };
}

export default { createRateLimiter, createRateLimiterWithReset };
