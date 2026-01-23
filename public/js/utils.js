/**
 * Utility functions for Antigravity Console
 */

window.utils = {
    // Shared Request Wrapper with timeout protection
    async request(url, options = {}, webuiPassword = '', timeout = 30000) {
        options.headers = options.headers || {};
        if (webuiPassword) {
            options.headers['x-webui-password'] = webuiPassword;
        }

        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        options.signal = controller.signal;

        try {
            let response = await fetch(url, options);
            clearTimeout(timeoutId);

            if (response.status === 401) {
                const store = Alpine.store('global');
                const password = prompt(store ? store.t('enterPassword') : 'Enter Web UI Password:');
                if (password) {
                    localStorage.setItem('antigravity_webui_password', password);
                    options.headers['x-webui-password'] = password;

                    // Create new controller for retry
                    const retryController = new AbortController();
                    const retryTimeoutId = setTimeout(() => retryController.abort(), timeout);
                    options.signal = retryController.signal;

                    try {
                        response = await fetch(url, options);
                        clearTimeout(retryTimeoutId);
                        return { response, newPassword: password };
                    } catch (retryError) {
                        clearTimeout(retryTimeoutId);
                        if (retryError.name === 'AbortError') {
                            throw new Error('Request timeout');
                        }
                        throw retryError;
                    }
                }
            }

            return { response, newPassword: null };
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timeout - server may be unresponsive');
            }
            throw error;
        }
    },

    formatTimeUntil(isoTime) {
        const store = Alpine.store('global');
        const diff = new Date(isoTime) - new Date();
        if (diff <= 0) return store ? store.t('ready') : 'READY';
        const mins = Math.floor(diff / 60000);
        const hrs = Math.floor(mins / 60);

        const hSuffix = store ? store.t('timeH') : 'H';
        const mSuffix = store ? store.t('timeM') : 'M';

        if (hrs > 0) return `${hrs}${hSuffix} ${mins % 60}${mSuffix}`;
        return `${mins}${mSuffix}`;
    },

    getThemeColor(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },

    /**
     * Debounce function - delays execution until after specified wait time
     * @param {Function} func - Function to debounce
     * @param {number} wait - Wait time in milliseconds
     * @returns {Function} Debounced function
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
};
