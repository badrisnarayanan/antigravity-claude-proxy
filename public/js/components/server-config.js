/**
 * Server Config Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.serverConfig = () => ({
    serverConfig: {},
    loading: false,
    advancedExpanded: false,
    debounceTimers: {}, // Store debounce timers for each config field

    init() {
        // Initial fetch if this is the active sub-tab
        if (this.activeTab === 'server') {
            this.fetchServerConfig();
        }

        // Watch local activeTab (from parent settings scope, skip initial trigger)
        this.$watch('activeTab', (tab, oldTab) => {
            if (tab === 'server' && oldTab !== undefined) {
                this.fetchServerConfig();
            }
        });
    },

    async fetchServerConfig() {
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/config', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error('Failed to fetch config');
            const data = await response.json();
            this.serverConfig = data.config || {};
        } catch (e) {
            console.error('Failed to fetch server config:', e);
        }
    },



    // Password management
    passwordDialog: {
        show: false,
        oldPassword: '',
        newPassword: '',
        confirmPassword: ''
    },

    showPasswordDialog() {
        this.passwordDialog = {
            show: true,
            oldPassword: '',
            newPassword: '',
            confirmPassword: ''
        };
    },

    hidePasswordDialog() {
        this.passwordDialog = {
            show: false,
            oldPassword: '',
            newPassword: '',
            confirmPassword: ''
        };
    },

    async changePassword() {
        const store = Alpine.store('global');
        const { oldPassword, newPassword, confirmPassword } = this.passwordDialog;

        if (newPassword !== confirmPassword) {
            store.showToast(store.t('passwordsNotMatch'), 'error');
            return;
        }
        if (newPassword.length < 6) {
            store.showToast(store.t('passwordTooShort'), 'error');
            return;
        }

        try {
            const { response } = await window.utils.request('/api/config/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPassword, newPassword })
            }, store.webuiPassword);

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || store.t('failedToChangePassword'));
            }

            // Update stored password
            store.webuiPassword = newPassword;
            store.showToast(store.t('passwordChangedSuccess'), 'success');
            this.hidePasswordDialog();
        } catch (e) {
            store.showToast(store.t('failedToChangePassword') + ': ' + e.message, 'error');
        }
    },

    // Toggle Debug Mode with instant save
    async toggleDebug(enabled) {
        const store = Alpine.store('global');

        // Optimistic update
        const previousValue = this.serverConfig.debug;
        this.serverConfig.debug = enabled;

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ debug: enabled })
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
                store.showToast(store.t('debugModeToggled', { status }), 'success');
                await this.fetchServerConfig(); // Confirm server state
            } else {
                throw new Error(data.error || store.t('failedToUpdateDebugMode'));
            }
        } catch (e) {
            // Rollback on error
            this.serverConfig.debug = previousValue;
            store.showToast(store.t('failedToUpdateDebugMode') + ': ' + e.message, 'error');
        }
    },

    // Toggle Token Cache with instant save
    async toggleTokenCache(enabled) {
        const store = Alpine.store('global');

        // Optimistic update
        const previousValue = this.serverConfig.persistTokenCache;
        this.serverConfig.persistTokenCache = enabled;

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persistTokenCache: enabled })
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
                store.showToast(store.t('tokenCacheToggled', { status }), 'success');
                await this.fetchServerConfig(); // Confirm server state
            } else {
                throw new Error(data.error || store.t('failedToUpdateTokenCache'));
            }
        } catch (e) {
            // Rollback on error
            this.serverConfig.persistTokenCache = previousValue;
            store.showToast(store.t('failedToUpdateTokenCache') + ': ' + e.message, 'error');
        }
    },

    // Generic debounced save method for numeric configs with validation
    async saveConfigField(fieldName, value, displayName, validator = null) {
        const store = Alpine.store('global');

        // Validate input if validator provided
        if (validator) {
            const validation = window.Validators.validate(value, validator, true);
            if (!validation.isValid) {
                // Rollback to previous value
                this.serverConfig[fieldName] = this.serverConfig[fieldName];
                return;
            }
            value = validation.value;
        } else {
            value = parseInt(value);
        }

        // Clear existing timer for this field
        if (this.debounceTimers[fieldName]) {
            clearTimeout(this.debounceTimers[fieldName]);
        }

        // Optimistic update
        const previousValue = this.serverConfig[fieldName];
        this.serverConfig[fieldName] = value;

        // Set new timer
        this.debounceTimers[fieldName] = setTimeout(async () => {
            try {
                const payload = {};
                payload[fieldName] = value;

                const { response, newPassword } = await window.utils.request('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }, store.webuiPassword);

                if (newPassword) store.webuiPassword = newPassword;

                const data = await response.json();
                if (data.status === 'ok') {
                    store.showToast(store.t('fieldUpdated', { displayName, value }), 'success');
                    await this.fetchServerConfig(); // Confirm server state
                } else {
                    throw new Error(data.error || store.t('failedToUpdateField', { displayName }));
                }
            } catch (e) {
                // Rollback on error
                this.serverConfig[fieldName] = previousValue;
                store.showToast(store.t('failedToUpdateField', { displayName }) + ': ' + e.message, 'error');
            }
        }, window.AppConstants.INTERVALS.CONFIG_DEBOUNCE);
    },

    // Individual toggle methods for each Advanced Tuning field with validation
    toggleMaxRetries(value) {
        const { MAX_RETRIES_MIN, MAX_RETRIES_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('maxRetries', value, 'Max Retries',
            (v) => window.Validators.validateRange(v, MAX_RETRIES_MIN, MAX_RETRIES_MAX, 'Max Retries'));
    },

    toggleRetryBaseMs(value) {
        const { RETRY_BASE_MS_MIN, RETRY_BASE_MS_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('retryBaseMs', value, 'Retry Base Delay',
            (v) => window.Validators.validateRange(v, RETRY_BASE_MS_MIN, RETRY_BASE_MS_MAX, 'Retry Base Delay'));
    },

    toggleRetryMaxMs(value) {
        const { RETRY_MAX_MS_MIN, RETRY_MAX_MS_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('retryMaxMs', value, 'Retry Max Delay',
            (v) => window.Validators.validateRange(v, RETRY_MAX_MS_MIN, RETRY_MAX_MS_MAX, 'Retry Max Delay'));
    },

    toggleDefaultCooldownMs(value) {
        const { DEFAULT_COOLDOWN_MIN, DEFAULT_COOLDOWN_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('defaultCooldownMs', value, 'Default Cooldown',
            (v) => window.Validators.validateTimeout(v, DEFAULT_COOLDOWN_MIN, DEFAULT_COOLDOWN_MAX));
    },

    toggleMaxWaitBeforeErrorMs(value) {
        const { MAX_WAIT_MIN, MAX_WAIT_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('maxWaitBeforeErrorMs', value, 'Max Wait Threshold',
            (v) => window.Validators.validateTimeout(v, MAX_WAIT_MIN, MAX_WAIT_MAX));
    }
});
