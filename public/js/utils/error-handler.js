/**
 * Error Handling Utilities
 * Provides standardized error handling with toast notifications
 */
window.ErrorHandler = window.ErrorHandler || {};

/**
 * Safely execute an async function with error handling
 * @param {Function} fn - Async function to execute
 * @param {string} errorMessage - User-friendly error message prefix
 * @param {object} options - Additional options
 * @param {boolean} options.rethrow - Whether to rethrow the error after handling (default: false)
 * @param {Function} options.onError - Custom error handler callback
 * @returns {Promise<any>} Result of the function or undefined on error
 */
window.ErrorHandler.safeAsync = async function(fn, errorMessage = null, options = {}) {
    const { rethrow = false, onError = null } = options;
    const store = Alpine.store('global');
    const defaultErrorMessage = errorMessage || store.t('operationFailed');

    try {
        return await fn();
    } catch (error) {
        // Log error for debugging
        console.error(`[ErrorHandler] ${defaultErrorMessage}:`, error);

        // Show toast notification
        const fullMessage = `${defaultErrorMessage}: ${error.message || store.t('unknownError')}`;
        store.showToast(fullMessage, 'error');

        // Call custom error handler if provided
        if (onError && typeof onError === 'function') {
            try {
                onError(error);
            } catch (handlerError) {
                console.error('[ErrorHandler] Custom error handler failed:', handlerError);
            }
        }

        // Rethrow if requested
        if (rethrow) {
            throw error;
        }

        return undefined;
    }
};

/**
 * Wrap a component method with error handling
 * @param {Function} method - Method to wrap
 * @param {string} errorMessage - Error message prefix
 * @returns {Function} Wrapped method
 */
window.ErrorHandler.wrapMethod = function(method, errorMessage = null) {
    return async function(...args) {
        return window.ErrorHandler.safeAsync(
            () => method.apply(this, args),
            errorMessage || Alpine.store('global').t('operationFailed')
        );
    };
};

/**
 * Show a success toast notification
 * @param {string} message - Success message
 */
window.ErrorHandler.showSuccess = function(message) {
    const store = Alpine.store('global');
    store.showToast(message, 'success');
};

/**
 * Show an info toast notification
 * @param {string} message - Info message
 */
window.ErrorHandler.showInfo = function(message) {
    const store = Alpine.store('global');
    store.showToast(message, 'info');
};

/**
 * Show an error toast notification
 * @param {string} message - Error message
 * @param {Error} error - Optional error object
 */
window.ErrorHandler.showError = function(message, error = null) {
    const store = Alpine.store('global');
    const fullMessage = error ? `${message}: ${error.message}` : message;
    store.showToast(fullMessage, 'error');
};

/**
 * Validate and execute an API call with error handling
 * @param {Function} apiCall - Async function that makes the API call
 * @param {string} successMessage - Message to show on success (optional)
 * @param {string} errorMessage - Message to show on error
 * @returns {Promise<any>} API response or undefined on error
 */
window.ErrorHandler.apiCall = async function(apiCall, successMessage = null, errorMessage = 'API call failed') {
    const result = await window.ErrorHandler.safeAsync(apiCall, errorMessage);

    if (result !== undefined && successMessage) {
        window.ErrorHandler.showSuccess(successMessage);
    }

    return result;
};

/**
 * Execute an async function with automatic loading state management
 * @param {Function} asyncFn - Async function to execute
 * @param {object} context - Component context (this) that contains the loading state
 * @param {string} loadingKey - Name of the loading state property (default: 'loading')
 * @param {object} options - Additional options (same as safeAsync)
 * @returns {Promise<any>} Result of the function or undefined on error
 *
 * @example
 * // In your Alpine component:
 * async refreshAccount(email) {
 *   return await window.ErrorHandler.withLoading(async () => {
 *     const response = await window.utils.request(`/api/accounts/${email}/refresh`, { method: 'POST' });
 *     this.$store.global.showToast('Account refreshed', 'success');
 *     return response;
 *   }, this, 'refreshing');
 * }
 *
 * // In HTML:
 * // <button @click="refreshAccount(email)" :disabled="refreshing">
 * //   <i class="fas fa-sync-alt" :class="{ 'fa-spin': refreshing }"></i>
 * //   Refresh
 * // </button>
 */
window.ErrorHandler.withLoading = async function(asyncFn, context, loadingKey = 'loading', options = {}) {
    // Set loading state to true
    context[loadingKey] = true;

    try {
        // Execute the async function with error handling
        const result = await window.ErrorHandler.safeAsync(asyncFn, options.errorMessage, options);
        return result;
    } finally {
        // Always reset loading state, even if there was an error
        context[loadingKey] = false;
    }
};
