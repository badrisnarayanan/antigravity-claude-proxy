/**
 * UI Logger Utility
 * Provides conditional logging for the web UI to reduce console spam in production.
 * Wraps console methods and only outputs when debug mode is enabled.
 *
 * Usage:
 *   window.UILogger.debug('message')  - Only logs if debug mode enabled
 *   window.UILogger.info('message')   - Only logs if debug mode enabled
 *   window.UILogger.warn('message')   - Always logs (important warnings)
 *   window.UILogger.error('message')  - Always logs (errors should always be visible)
 *
 * Enable debug mode:
 *   - Set localStorage.setItem('ag_debug', 'true') in browser console
 *   - Or pass ?debug=true in URL
 */

(function() {
    'use strict';

    // Check if debug mode is enabled
    function isDebugEnabled() {
        // Check URL parameter
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('debug') === 'true') {
            return true;
        }

        // Check localStorage
        try {
            return localStorage.getItem('ag_debug') === 'true';
        } catch (e) {
            return false;
        }
    }

    // Cache debug state (can be refreshed)
    let debugEnabled = isDebugEnabled();

    window.UILogger = {
        /**
         * Refresh debug state (call after changing localStorage)
         */
        refresh() {
            debugEnabled = isDebugEnabled();
        },

        /**
         * Enable debug mode
         */
        enableDebug() {
            try {
                localStorage.setItem('ag_debug', 'true');
                debugEnabled = true;
                console.info('[UILogger] Debug mode enabled. Refresh page to see all logs.');
            } catch (e) {
                console.warn('[UILogger] Could not save debug preference');
            }
        },

        /**
         * Disable debug mode
         */
        disableDebug() {
            try {
                localStorage.removeItem('ag_debug');
                debugEnabled = false;
                console.info('[UILogger] Debug mode disabled.');
            } catch (e) {
                // Ignore
            }
        },

        /**
         * Check if debug mode is enabled
         * @returns {boolean}
         */
        isDebug() {
            return debugEnabled;
        },

        /**
         * Debug level - only logs if debug mode enabled
         * Use for verbose debugging info (chart updates, cache operations, etc.)
         */
        debug(...args) {
            if (debugEnabled) {
                console.log('[DEBUG]', ...args);
            }
        },

        /**
         * Info level - only logs if debug mode enabled
         * Use for informational messages that aren't errors
         */
        info(...args) {
            if (debugEnabled) {
                console.info('[INFO]', ...args);
            }
        },

        /**
         * Log level - alias for debug
         */
        log(...args) {
            if (debugEnabled) {
                console.log(...args);
            }
        },

        /**
         * Warn level - always logs
         * Use for important warnings that users should see
         * But suppress noisy/expected warnings unless in debug mode
         */
        warn(...args) {
            // In production, only show critical warnings
            // In debug mode, show all warnings
            if (debugEnabled) {
                console.warn(...args);
            }
        },

        /**
         * Warn level that always shows (for critical warnings)
         */
        warnAlways(...args) {
            console.warn(...args);
        },

        /**
         * Error level - always logs
         * Errors should always be visible for debugging
         */
        error(...args) {
            console.error(...args);
        }
    };

    // Log initial state (only in debug mode)
    if (debugEnabled) {
        console.info('[UILogger] Debug mode is ON. Set localStorage ag_debug=false to disable.');
    }
})();
