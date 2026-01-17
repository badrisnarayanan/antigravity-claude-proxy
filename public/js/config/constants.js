/**
 * Application Constants
 * Centralized configuration values and magic numbers
 */
window.AppConstants = window.AppConstants || {};

/**
 * Time intervals (in milliseconds)
 */
window.AppConstants.INTERVALS = {
    // Dashboard refresh interval (5 minutes)
    DASHBOARD_REFRESH: 300000,

    // OAuth message handler timeout (5 minutes)
    OAUTH_MESSAGE_TIMEOUT: 300000,

    // Server config debounce delay
    CONFIG_DEBOUNCE: 500,

    // General short delay (for UI transitions)
    SHORT_DELAY: 2000
};

/**
 * Data limits and quotas
 */
window.AppConstants.LIMITS = {
    // Default log limit
    DEFAULT_LOG_LIMIT: 2000,

    // Minimum quota value
    MIN_QUOTA: 100,

    // Percentage base (for calculations)
    PERCENTAGE_BASE: 100
};

/**
 * Validation ranges
 */
window.AppConstants.VALIDATION = {
    // Port range
    PORT_MIN: 1,
    PORT_MAX: 65535,

    // Timeout range (0 - 5 minutes)
    TIMEOUT_MIN: 0,
    TIMEOUT_MAX: 300000,

    // Log limit range
    LOG_LIMIT_MIN: 100,
    LOG_LIMIT_MAX: 10000,

    // Retry configuration ranges
    MAX_RETRIES_MIN: 0,
    MAX_RETRIES_MAX: 20,

    RETRY_BASE_MS_MIN: 100,
    RETRY_BASE_MS_MAX: 10000,

    RETRY_MAX_MS_MIN: 1000,
    RETRY_MAX_MS_MAX: 60000,

    // Cooldown range (0 - 10 minutes)
    DEFAULT_COOLDOWN_MIN: 0,
    DEFAULT_COOLDOWN_MAX: 600000,

    // Max wait threshold (1 - 30 minutes)
    MAX_WAIT_MIN: 60000,
    MAX_WAIT_MAX: 1800000,

    // Health Management validation ranges
    HEALTH_THRESHOLD_MIN: 1,
    HEALTH_THRESHOLD_MAX: 20, // Changed: max consecutive failures

    RECOVERY_HOURS_MIN: 1,
    RECOVERY_HOURS_MAX: 72, // 3 days max, matches slider

    HEALTH_SCORE_MIN: 1,
    HEALTH_SCORE_MAX: 100,

    RETENTION_DAYS_MIN: 1,
    RETENTION_DAYS_MAX: 30, // Matches slider max

    MAX_EVENTS_MIN: 1000,  // Matches slider and backend validation
    MAX_EVENTS_MAX: 50000  // Matches slider max
};

/**
 * UI Constants
 */
window.AppConstants.UI = {
    // Toast auto-dismiss duration
    TOAST_DURATION: 3000,

    // Loading spinner delay
    LOADING_DELAY: 200
};
