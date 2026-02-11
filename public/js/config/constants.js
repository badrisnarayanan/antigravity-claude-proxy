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
    PERCENTAGE_BASE: 100,

    // Max per-account breakdown rows before showing "+N more" toggle
    ACCOUNT_BREAKDOWN_LIMIT: 10
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
    MAX_RETRIES_MIN: 1,
    MAX_RETRIES_MAX: 20,

    RETRY_BASE_MS_MIN: 100,
    RETRY_BASE_MS_MAX: 10000,

    RETRY_MAX_MS_MIN: 1000,
    RETRY_MAX_MS_MAX: 120000,

    // Cooldown range (1s - 5 minutes)
    DEFAULT_COOLDOWN_MIN: 1000,
    DEFAULT_COOLDOWN_MAX: 300000,

    // Max wait threshold (0 - 10 minutes)
    MAX_WAIT_MIN: 0,
    MAX_WAIT_MAX: 600000,

    // Max accounts range (1 - 100)
    MAX_ACCOUNTS_MIN: 1,
    MAX_ACCOUNTS_MAX: 100,

    // Rate limit dedup window (1 - 30 seconds)
    RATE_LIMIT_DEDUP_MIN: 1000,
    RATE_LIMIT_DEDUP_MAX: 30000,

    // Consecutive failures (1 - 10)
    MAX_CONSECUTIVE_FAILURES_MIN: 1,
    MAX_CONSECUTIVE_FAILURES_MAX: 10,

    // Extended cooldown (10 seconds - 5 minutes)
    EXTENDED_COOLDOWN_MIN: 10000,
    EXTENDED_COOLDOWN_MAX: 300000,

    // Capacity retries (1 - 10)
    MAX_CAPACITY_RETRIES_MIN: 1,
    MAX_CAPACITY_RETRIES_MAX: 10,

    // Global quota threshold (0 - 99%)
    GLOBAL_QUOTA_THRESHOLD_MIN: 0,
    GLOBAL_QUOTA_THRESHOLD_MAX: 99,

    // Request delay (100 - 5000ms)
    REQUEST_DELAY_MIN: 100,
    REQUEST_DELAY_MAX: 5000,

    // Switch account delay (1s - 60s)
    SWITCH_ACCOUNT_DELAY_MIN: 1000,
    SWITCH_ACCOUNT_DELAY_MAX: 60000,

    // Capacity backoff tiers
    CAPACITY_BACKOFF_TIER_MIN: 1000,
    CAPACITY_BACKOFF_TIER_MAX: 300000,
    CAPACITY_BACKOFF_TIERS_MIN_LENGTH: 1,
    CAPACITY_BACKOFF_TIERS_MAX_LENGTH: 10,

    // Health score fields
    HS_INITIAL_MIN: 0,
    HS_INITIAL_MAX: 100,
    HS_SUCCESS_REWARD_MIN: 0,
    HS_SUCCESS_REWARD_MAX: 20,
    HS_RATE_LIMIT_PENALTY_MIN: -50,
    HS_RATE_LIMIT_PENALTY_MAX: 0,
    HS_FAILURE_PENALTY_MIN: -50,
    HS_FAILURE_PENALTY_MAX: 0,
    HS_RECOVERY_PER_HOUR_MIN: 0,
    HS_RECOVERY_PER_HOUR_MAX: 20,
    HS_MIN_USABLE_MIN: 0,
    HS_MIN_USABLE_MAX: 100,
    HS_MAX_SCORE_MIN: 1,
    HS_MAX_SCORE_MAX: 200,

    // Token bucket fields
    TB_MAX_TOKENS_MIN: 5,
    TB_MAX_TOKENS_MAX: 200,
    TB_TOKENS_PER_MINUTE_MIN: 1,
    TB_TOKENS_PER_MINUTE_MAX: 60,
    TB_INITIAL_TOKENS_MIN: 1,
    TB_INITIAL_TOKENS_MAX: 200,

    // Quota awareness fields (displayed as 0-99% in UI)
    Q_LOW_THRESHOLD_MIN: 0,
    Q_LOW_THRESHOLD_MAX: 99,
    Q_CRITICAL_THRESHOLD_MIN: 0,
    Q_CRITICAL_THRESHOLD_MAX: 99,
    Q_STALE_MS_MIN: 30000,
    Q_STALE_MS_MAX: 3600000,

    // Weights fields
    W_HEALTH_MIN: 0,
    W_HEALTH_MAX: 20,
    W_TOKENS_MIN: 0,
    W_TOKENS_MAX: 20,
    W_QUOTA_MIN: 0,
    W_QUOTA_MAX: 20,
    W_LRU_MIN: 0,
    W_LRU_MAX: 5
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
