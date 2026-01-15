/**
 * Utility functions for Antigravity Console
 */

window.utils = {
    // Shared Request Wrapper
    async request(url, options = {}, webuiPassword = '') {
        options.headers = options.headers || {};
        if (webuiPassword) {
            options.headers['x-webui-password'] = webuiPassword;
        }

        let response = await fetch(url, options);

        if (response.status === 401) {
            const store = Alpine.store('global');
            const password = prompt(store ? store.t('enterPassword') : 'Enter Web UI Password:');
            if (password) {
                // Return new password so caller can update state
                // This implies we need a way to propagate the new password back
                // For simplicity in this functional utility, we might need a callback or state access
                // But generally utils shouldn't probably depend on global state directly if possible
                // let's stick to the current logic but wrapped
                sessionStorage.setItem('antigravity_webui_password', password);
                options.headers['x-webui-password'] = password;
                response = await fetch(url, options);
                return { response, newPassword: password };
            }
        }

        return { response, newPassword: null };
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
