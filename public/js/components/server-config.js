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

    // Server presets state
    serverPresets: [],
    selectedServerPreset: '',
    loadingPreset: false,
    savingServerPreset: false,
    deletingServerPreset: false,
    newServerPresetName: '',
    newServerPresetDescription: '',
    editingPresetMode: false,
    editingPresetOriginalName: '',
    presetPreviewExpanded: false,
    editingPresetConfig: false,
    editingConfigDraft: { accountSelection: { strategy: 'hybrid' } },
    editingConfigErrors: {},
    savingPresetConfig: false,
    configEditMode: 'ui',
    editingJsonText: '',
    jsonParseError: null,

    init() {
        // Initial fetch if this is the active sub-tab
        if (this.$store.global.settingsTab === 'server') {
            this.fetchServerConfig();
            this.fetchServerPresets();
        }

        // Watch settings sub-tab (skip initial trigger)
        this.$watch('$store.global.settingsTab', (tab, oldTab) => {
            if (tab === 'server' && oldTab !== undefined) {
                this.fetchServerConfig();
                this.fetchServerPresets();
            }
        });

        // Cancel config editing when switching presets
        this.$watch('selectedServerPreset', () => {
            if (this.editingPresetConfig) {
                this.cancelPresetConfigEdit();
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

    // Toggle Developer Mode with instant save
    async toggleDevMode(enabled) {
        const store = Alpine.store('global');

        // Optimistic update
        const previousDevMode = this.serverConfig.devMode;
        const previousDebug = this.serverConfig.debug;
        this.serverConfig.devMode = enabled;
        this.serverConfig.debug = enabled;

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ devMode: enabled })
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
                store.showToast(store.t('devModeToggled', { status }), 'success');
                // Update data store
                Alpine.store('data').devMode = enabled;
                await this.fetchServerConfig(); // Confirm server state
            } else {
                throw new Error(data.error || store.t('failedToUpdateDevMode'));
            }
        } catch (e) {
            // Rollback on error
            this.serverConfig.devMode = previousDevMode;
            this.serverConfig.debug = previousDebug;
            store.showToast(store.t('failedToUpdateDevMode') + ': ' + e.message, 'error');
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
                // Rollback to clamped value
                this.serverConfig[fieldName] = validation.value;
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
    },

    toggleGlobalQuotaThreshold(value) {
        const { GLOBAL_QUOTA_THRESHOLD_MIN, GLOBAL_QUOTA_THRESHOLD_MAX } = window.AppConstants.VALIDATION;
        const store = Alpine.store('global');
        const pct = parseInt(value);
        if (isNaN(pct) || pct < GLOBAL_QUOTA_THRESHOLD_MIN || pct > GLOBAL_QUOTA_THRESHOLD_MAX) return;

        // Store as percentage in UI, convert to fraction for backend
        const fraction = pct / 100;

        if (this.debounceTimers['globalQuotaThreshold']) {
            clearTimeout(this.debounceTimers['globalQuotaThreshold']);
        }

        const previousValue = this.serverConfig.globalQuotaThreshold;
        this.serverConfig.globalQuotaThreshold = fraction;

        this.debounceTimers['globalQuotaThreshold'] = setTimeout(async () => {
            try {
                const { response, newPassword } = await window.utils.request('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ globalQuotaThreshold: fraction })
                }, store.webuiPassword);

                if (newPassword) store.webuiPassword = newPassword;

                const data = await response.json();
                if (data.status === 'ok') {
                    store.showToast(store.t('fieldUpdated', { displayName: 'Minimum Quota Level', value: pct + '%' }), 'success');
                    await this.fetchServerConfig();
                } else {
                    throw new Error(data.error || store.t('failedToUpdateField', { displayName: 'Minimum Quota Level' }));
                }
            } catch (e) {
                this.serverConfig.globalQuotaThreshold = previousValue;
                store.showToast(store.t('failedToUpdateField', { displayName: 'Minimum Quota Level' }) + ': ' + e.message, 'error');
            }
        }, window.AppConstants.INTERVALS.CONFIG_DEBOUNCE);
    },

    async toggleRequestThrottling(enabled) {
        const store = Alpine.store('global');
        const previousValue = this.serverConfig.requestThrottlingEnabled;
        this.serverConfig.requestThrottlingEnabled = enabled;

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestThrottlingEnabled: enabled })
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(`Request Throttling ${enabled ? 'enabled' : 'disabled'}`, 'success');
            } else {
                throw new Error(data.error || 'Failed to update');
            }
        } catch (e) {
            this.serverConfig.requestThrottlingEnabled = previousValue;
            store.showToast('Failed to update Request Throttling: ' + e.message, 'error');
        }
    },

    toggleRequestDelayMs(value) {
        const { REQUEST_DELAY_MIN, REQUEST_DELAY_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('requestDelayMs', value, 'Request Delay',
            (v) => window.Validators.validateRange(v, REQUEST_DELAY_MIN, REQUEST_DELAY_MAX, 'Request Delay'));
    },

    toggleMaxAccounts(value) {
        const { MAX_ACCOUNTS_MIN, MAX_ACCOUNTS_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('maxAccounts', value, 'Max Accounts',
            (v) => window.Validators.validateRange(v, MAX_ACCOUNTS_MIN, MAX_ACCOUNTS_MAX, 'Max Accounts'));
    },

    toggleRateLimitDedupWindowMs(value) {
        const { RATE_LIMIT_DEDUP_MIN, RATE_LIMIT_DEDUP_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('rateLimitDedupWindowMs', value, 'Rate Limit Dedup Window',
            (v) => window.Validators.validateTimeout(v, RATE_LIMIT_DEDUP_MIN, RATE_LIMIT_DEDUP_MAX));
    },

    toggleMaxConsecutiveFailures(value) {
        const { MAX_CONSECUTIVE_FAILURES_MIN, MAX_CONSECUTIVE_FAILURES_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('maxConsecutiveFailures', value, 'Max Consecutive Failures',
            (v) => window.Validators.validateRange(v, MAX_CONSECUTIVE_FAILURES_MIN, MAX_CONSECUTIVE_FAILURES_MAX, 'Max Consecutive Failures'));
    },

    toggleExtendedCooldownMs(value) {
        const { EXTENDED_COOLDOWN_MIN, EXTENDED_COOLDOWN_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('extendedCooldownMs', value, 'Extended Cooldown',
            (v) => window.Validators.validateTimeout(v, EXTENDED_COOLDOWN_MIN, EXTENDED_COOLDOWN_MAX));
    },

    toggleMaxCapacityRetries(value) {
        const { MAX_CAPACITY_RETRIES_MIN, MAX_CAPACITY_RETRIES_MAX } = window.AppConstants.VALIDATION;
        this.saveConfigField('maxCapacityRetries', value, 'Max Capacity Retries',
            (v) => window.Validators.validateRange(v, MAX_CAPACITY_RETRIES_MIN, MAX_CAPACITY_RETRIES_MAX, 'Max Capacity Retries'));
    },

    async toggleThinkingTagMode(mode) {
        const store = Alpine.store('global');
        const validModes = ['passthrough', 'strip', 'native'];

        if (!validModes.includes(mode)) {
            store.showToast('Invalid thinking tag mode', 'error');
            return;
        }

        const previousValue = this.serverConfig.thinkingTagMode || 'passthrough';
        this.serverConfig.thinkingTagMode = mode;

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ thinkingTagMode: mode })
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('thinkingTagModeUpdated'), 'success');
            } else {
                throw new Error(data.error || 'Failed to update');
            }
        } catch (e) {
            this.serverConfig.thinkingTagMode = previousValue;
            store.showToast('Failed to update Thinking Tag Mode: ' + e.message, 'error');
        }
    },

    // Toggle Account Selection Strategy
    async toggleStrategy(strategy) {
        const store = Alpine.store('global');
        const validStrategies = ['sticky', 'round-robin', 'hybrid'];

        if (!validStrategies.includes(strategy)) {
            store.showToast(store.t('invalidStrategy'), 'error');
            return;
        }

        // Optimistic update
        const previousValue = this.serverConfig.accountSelection?.strategy || 'hybrid';
        if (!this.serverConfig.accountSelection) {
            this.serverConfig.accountSelection = {};
        }
        this.serverConfig.accountSelection.strategy = strategy;

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountSelection: { strategy } })
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const strategyLabel = this.getStrategyLabel(strategy);
                store.showToast(store.t('strategyUpdated', { strategy: strategyLabel }), 'success');
                await this.fetchServerConfig(); // Confirm server state
            } else {
                throw new Error(data.error || store.t('failedToUpdateStrategy'));
            }
        } catch (e) {
            // Rollback on error
            if (!this.serverConfig.accountSelection) {
                this.serverConfig.accountSelection = {};
            }
            this.serverConfig.accountSelection.strategy = previousValue;
            store.showToast(store.t('failedToUpdateStrategy') + ': ' + e.message, 'error');
        }
    },

    // Get display label for a strategy
    getStrategyLabel(strategy) {
        const store = Alpine.store('global');
        const labels = {
            'sticky': store.t('strategyStickyLabel'),
            'round-robin': store.t('strategyRoundRobinLabel'),
            'hybrid': store.t('strategyHybridLabel')
        };
        return labels[strategy] || strategy;
    },

    // Get description for current strategy
    currentStrategyDescription() {
        const store = Alpine.store('global');
        const strategy = this.serverConfig.accountSelection?.strategy || 'hybrid';
        const descriptions = {
            'sticky': store.t('strategyStickyDesc'),
            'round-robin': store.t('strategyRoundRobinDesc'),
            'hybrid': store.t('strategyHybridDesc')
        };
        return descriptions[strategy] || '';
    },

    // ==========================================
    // Server Configuration Presets
    // ==========================================

    async fetchServerPresets() {
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/server/presets', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'ok') {
                this.serverPresets = data.presets || [];
                if (this.serverPresets.length > 0 && !this.selectedServerPreset) {
                    this.selectedServerPreset = this.serverPresets[0].name;
                }
            }
        } catch (e) {
            console.error('Failed to fetch server presets:', e);
        }
    },

    /**
     * Load a server preset — applies all config values via POST /api/config
     */
    async loadServerPreset(name) {
        const preset = this.serverPresets.find(p => p.name === name);
        if (!preset) return;

        this.loadingPreset = true;
        const store = Alpine.store('global');

        try {
            const { response, newPassword } = await window.utils.request('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(preset.config)
            }, store.webuiPassword);

            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('serverPresetLoaded', { name }) || `Preset "${name}" applied`, 'success');
                await this.fetchServerConfig();
            } else {
                throw new Error(data.error || 'Failed to apply preset');
            }
        } catch (e) {
            store.showToast((store.t('failedToLoadServerPreset') || 'Failed to apply preset') + ': ' + e.message, 'error');
        } finally {
            this.loadingPreset = false;
        }
    },

    /**
     * Save current server config as a new custom preset
     */
    async saveCurrentAsServerPreset() {
        this.editingPresetMode = false;
        this.editingPresetOriginalName = '';
        this.newServerPresetName = '';
        this.newServerPresetDescription = '';
        document.getElementById('save_server_preset_modal').showModal();
    },

    /**
     * Edit an existing custom preset's name and description
     */
    editServerPreset() {
        const preset = this.serverPresets.find(p => p.name === this.selectedServerPreset);
        if (!preset || preset.builtIn) return;

        this.editingPresetMode = true;
        this.editingPresetOriginalName = preset.name;
        this.newServerPresetName = preset.name;
        this.newServerPresetDescription = preset.description || '';
        document.getElementById('save_server_preset_modal').showModal();
    },

    /**
     * Execute PATCH to update preset metadata
     */
    async executeEditServerPreset() {
        const name = this.newServerPresetName.trim();
        if (!name) {
            Alpine.store('global').showToast(Alpine.store('global').t('presetNameRequired') || 'Preset name is required', 'error');
            return;
        }

        this.savingServerPreset = true;
        const store = Alpine.store('global');

        try {
            const payload = { name, description: this.newServerPresetDescription.trim() || '' };

            const { response, newPassword } = await window.utils.request(
                `/api/server/presets/${encodeURIComponent(this.editingPresetOriginalName)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `HTTP ${response.status}`);
            }
            const data = await response.json();
            if (data.status === 'ok') {
                this.serverPresets = data.presets || [];
                this.selectedServerPreset = name;
                this.editingPresetMode = false;
                this.editingPresetOriginalName = '';
                this.newServerPresetName = '';
                this.newServerPresetDescription = '';
                store.showToast(store.t('serverPresetUpdated') || 'Preset updated', 'success');
                document.getElementById('save_server_preset_modal').close();
            } else {
                throw new Error(data.error || 'Failed to update preset');
            }
        } catch (e) {
            store.showToast((store.t('failedToEditServerPreset') || 'Failed to update preset') + ': ' + e.message, 'error');
        } finally {
            this.savingServerPreset = false;
        }
    },

    async executeSaveServerPreset(name) {
        if (!name || !name.trim()) {
            Alpine.store('global').showToast(Alpine.store('global').t('presetNameRequired') || 'Preset name is required', 'error');
            return;
        }

        this.savingServerPreset = true;
        const store = Alpine.store('global');
        const password = store.webuiPassword;

        try {
            // Extract relevant config fields (exclude sensitive/non-tunable)
            const relevantKeys = [
                'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs',
                'maxWaitBeforeErrorMs', 'maxAccounts', 'globalQuotaThreshold',
                'rateLimitDedupWindowMs', 'maxConsecutiveFailures', 'extendedCooldownMs',
                'maxCapacityRetries', 'switchAccountDelayMs', 'capacityBackoffTiersMs',
                'accountSelection'
            ];
            const presetConfig = {};
            relevantKeys.forEach(k => {
                if (this.serverConfig[k] !== undefined) {
                    presetConfig[k] = JSON.parse(JSON.stringify(this.serverConfig[k]));
                }
            });

            const payload = { name: name.trim(), config: presetConfig };
            if (this.newServerPresetDescription.trim()) {
                payload.description = this.newServerPresetDescription.trim();
            }

            const { response, newPassword } = await window.utils.request('/api/server/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }, password);
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `HTTP ${response.status}`);
            }
            const data = await response.json();
            if (data.status === 'ok') {
                this.serverPresets = data.presets || [];
                this.selectedServerPreset = name.trim();
                this.newServerPresetName = '';
                this.newServerPresetDescription = '';
                store.showToast(store.t('serverPresetSaved') || `Preset "${name}" saved`, 'success');
                document.getElementById('save_server_preset_modal').close();
            } else {
                throw new Error(data.error || 'Failed to save preset');
            }
        } catch (e) {
            store.showToast((store.t('failedToSaveServerPreset') || 'Failed to save preset') + ': ' + e.message, 'error');
        } finally {
            this.savingServerPreset = false;
        }
    },

    async deleteSelectedServerPreset() {
        if (!this.selectedServerPreset) return;

        // Check if built-in
        const preset = this.serverPresets.find(p => p.name === this.selectedServerPreset);
        if (preset?.builtIn) {
            Alpine.store('global').showToast(Alpine.store('global').t('cannotDeleteBuiltIn') || 'Cannot delete built-in presets', 'warning');
            return;
        }

        const store = Alpine.store('global');
        const translated = store.t('deletePresetConfirm', { name: this.selectedServerPreset });
        const confirmMsg = translated === 'deletePresetConfirm' ? `Delete preset "${this.selectedServerPreset}"?` : translated;
        if (!confirm(confirmMsg)) return;

        this.deletingServerPreset = true;

        try {
            const { response, newPassword } = await window.utils.request(
                `/api/server/presets/${encodeURIComponent(this.selectedServerPreset)}`,
                { method: 'DELETE' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `HTTP ${response.status}`);
            }
            const data = await response.json();
            if (data.status === 'ok') {
                this.serverPresets = data.presets || [];
                this.selectedServerPreset = this.serverPresets.length > 0 ? this.serverPresets[0].name : '';
                store.showToast(store.t('serverPresetDeleted') || 'Preset deleted', 'success');
            } else {
                throw new Error(data.error || 'Failed to delete preset');
            }
        } catch (e) {
            store.showToast((store.t('failedToDeleteServerPreset') || 'Failed to delete preset') + ': ' + e.message, 'error');
        } finally {
            this.deletingServerPreset = false;
        }
    },

    isSelectedPresetBuiltIn() {
        const preset = this.serverPresets.find(p => p.name === this.selectedServerPreset);
        return preset?.builtIn === true;
    },

    /**
     * Format a millisecond value to a human-readable string.
     * e.g. 60000 → "1m", 1000 → "1s", 1500 → "1.5s", 90000 → "1m 30s"
     */
    formatMsValue(ms) {
        if (ms == null) return '—';
        if (ms < 1000) return ms + 'ms';
        const totalSeconds = ms / 1000;
        if (totalSeconds < 60) {
            return Number.isInteger(totalSeconds) ? totalSeconds + 's' : totalSeconds.toFixed(1) + 's';
        }
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (seconds === 0) return minutes + 'm';
        return minutes + 'm ' + (Number.isInteger(seconds) ? seconds : seconds.toFixed(1)) + 's';
    },

    /**
     * Get preview sections for the currently selected preset.
     * Returns { strategy, strategyLabel, sections } where each section has { label, rows }.
     * Each row has { label, value, differs } where differs is true when the preset
     * value doesn't match the current running serverConfig.
     */
    getPresetPreviewSections() {
        const preset = this.serverPresets.find(p => p.name === this.selectedServerPreset);
        if (!preset?.config) return null;

        const cfg = preset.config;
        const cur = this.serverConfig;
        const store = Alpine.store('global');

        const strategy = cfg.accountSelection?.strategy || 'hybrid';
        const currentStrategy = cur.accountSelection?.strategy || 'hybrid';

        const differs = (presetVal, currentVal) => {
            if (presetVal == null && currentVal == null) return false;
            if (presetVal == null || currentVal == null) return true;
            return JSON.stringify(presetVal) !== JSON.stringify(currentVal);
        };

        const fmtQuota = (val) => {
            if (!val || val === 0) return store.t('quotaDisabled') || 'Disabled';
            return Math.round(val * 100) + '%';
        };

        const V = window.AppConstants.VALIDATION;

        const sections = [
            {
                label: store.t('networkRetry') || 'Network Retry Settings',
                rows: [
                    { label: store.t('maxRetries') || 'Max Retries', value: cfg.maxRetries ?? '—', differs: differs(cfg.maxRetries, cur.maxRetries), key: 'maxRetries', min: V.MAX_RETRIES_MIN, max: V.MAX_RETRIES_MAX, step: 1 },
                    { label: store.t('retryBaseDelay') || 'Retry Base Delay', value: this.formatMsValue(cfg.retryBaseMs), differs: differs(cfg.retryBaseMs, cur.retryBaseMs), key: 'retryBaseMs', min: V.RETRY_BASE_MS_MIN, max: V.RETRY_BASE_MS_MAX, step: 100, suffix: 'ms' },
                    { label: store.t('retryMaxDelay') || 'Retry Max Delay', value: this.formatMsValue(cfg.retryMaxMs), differs: differs(cfg.retryMaxMs, cur.retryMaxMs), key: 'retryMaxMs', min: V.RETRY_MAX_MS_MIN, max: V.RETRY_MAX_MS_MAX, step: 1000, suffix: 'ms' },
                ]
            },
            {
                label: store.t('rateLimiting') || 'Rate Limiting',
                rows: [
                    { label: store.t('defaultCooldown') || 'Default Cooldown', value: this.formatMsValue(cfg.defaultCooldownMs), differs: differs(cfg.defaultCooldownMs, cur.defaultCooldownMs), key: 'defaultCooldownMs', min: V.DEFAULT_COOLDOWN_MIN, max: V.DEFAULT_COOLDOWN_MAX, step: 1000, suffix: 'ms' },
                    { label: store.t('maxWaitThreshold') || 'Max Wait Before Error', value: this.formatMsValue(cfg.maxWaitBeforeErrorMs), differs: differs(cfg.maxWaitBeforeErrorMs, cur.maxWaitBeforeErrorMs), key: 'maxWaitBeforeErrorMs', min: V.MAX_WAIT_MIN, max: V.MAX_WAIT_MAX, step: 1000, suffix: 'ms' },
                    { label: store.t('maxAccounts') || 'Max Accounts', value: cfg.maxAccounts ?? '—', differs: differs(cfg.maxAccounts, cur.maxAccounts), key: 'maxAccounts', min: V.MAX_ACCOUNTS_MIN, max: V.MAX_ACCOUNTS_MAX, step: 1 },
                    { label: store.t('switchAccountDelay') || 'Switch Account Delay', value: this.formatMsValue(cfg.switchAccountDelayMs), differs: differs(cfg.switchAccountDelayMs, cur.switchAccountDelayMs), key: 'switchAccountDelayMs', min: V.SWITCH_ACCOUNT_DELAY_MIN, max: V.SWITCH_ACCOUNT_DELAY_MAX, step: 1000, suffix: 'ms' },
                ]
            },
            {
                label: store.t('quotaProtection') || 'Quota Protection',
                rows: [
                    { label: store.t('minimumQuotaLevel') || 'Minimum Quota Level', value: fmtQuota(cfg.globalQuotaThreshold), differs: differs(cfg.globalQuotaThreshold, cur.globalQuotaThreshold), key: 'globalQuotaThreshold', min: V.GLOBAL_QUOTA_THRESHOLD_MIN, max: V.GLOBAL_QUOTA_THRESHOLD_MAX, step: 1, suffix: '%' },
                ]
            },
            {
                label: store.t('errorHandlingTuning') || 'Error Handling',
                rows: [
                    { label: store.t('rateLimitDedupWindow') || 'Dedup Window', value: this.formatMsValue(cfg.rateLimitDedupWindowMs), differs: differs(cfg.rateLimitDedupWindowMs, cur.rateLimitDedupWindowMs), key: 'rateLimitDedupWindowMs', min: V.RATE_LIMIT_DEDUP_MIN, max: V.RATE_LIMIT_DEDUP_MAX, step: 1000, suffix: 'ms' },
                    { label: store.t('maxConsecutiveFailures') || 'Max Consecutive Failures', value: cfg.maxConsecutiveFailures ?? '—', differs: differs(cfg.maxConsecutiveFailures, cur.maxConsecutiveFailures), key: 'maxConsecutiveFailures', min: V.MAX_CONSECUTIVE_FAILURES_MIN, max: V.MAX_CONSECUTIVE_FAILURES_MAX, step: 1 },
                    { label: store.t('extendedCooldown') || 'Extended Cooldown', value: this.formatMsValue(cfg.extendedCooldownMs), differs: differs(cfg.extendedCooldownMs, cur.extendedCooldownMs), key: 'extendedCooldownMs', min: V.EXTENDED_COOLDOWN_MIN, max: V.EXTENDED_COOLDOWN_MAX, step: 1000, suffix: 'ms' },
                    { label: store.t('maxCapacityRetries') || 'Max Capacity Retries', value: cfg.maxCapacityRetries ?? '—', differs: differs(cfg.maxCapacityRetries, cur.maxCapacityRetries), key: 'maxCapacityRetries', min: V.MAX_CAPACITY_RETRIES_MIN, max: V.MAX_CAPACITY_RETRIES_MAX, step: 1 },
                    { label: store.t('capacityBackoffTiers') || 'Capacity Backoff Tiers', value: (cfg.capacityBackoffTiersMs || []).map(v => this.formatMsValue(v)).join(', ') || '—', differs: differs(cfg.capacityBackoffTiersMs, cur.capacityBackoffTiersMs), key: 'capacityBackoffTiersMs', type: 'text' },
                ]
            }
        ];

        // Add hybrid-only sections when strategy is hybrid
        if (strategy === 'hybrid') {
            const as = cfg.accountSelection || {};
            const curAs = cur.accountSelection || {};

            // Scoring Weights
            const w = as.weights || {};
            const curW = curAs.weights || {};
            sections.push({
                label: store.t('scoringWeights') || 'Scoring Weights',
                hybridOnly: true,
                rows: [
                    { label: store.t('weightHealth') || 'Health Weight', value: w.health ?? '—', differs: differs(w.health, curW.health), key: 'w_health', min: V.W_HEALTH_MIN, max: V.W_HEALTH_MAX, step: 0.1 },
                    { label: store.t('weightTokens') || 'Tokens Weight', value: w.tokens ?? '—', differs: differs(w.tokens, curW.tokens), key: 'w_tokens', min: V.W_TOKENS_MIN, max: V.W_TOKENS_MAX, step: 0.1 },
                    { label: store.t('weightQuota') || 'Quota Weight', value: w.quota ?? '—', differs: differs(w.quota, curW.quota), key: 'w_quota', min: V.W_QUOTA_MIN, max: V.W_QUOTA_MAX, step: 0.1 },
                    { label: store.t('weightLru') || 'LRU Weight', value: w.lru ?? '—', differs: differs(w.lru, curW.lru), key: 'w_lru', min: V.W_LRU_MIN, max: V.W_LRU_MAX, step: 0.01 },
                ]
            });

            // Health Score
            const hs = as.healthScore || {};
            const curHs = curAs.healthScore || {};
            sections.push({
                label: store.t('healthScoreSection') || 'Health Score',
                hybridOnly: true,
                rows: [
                    { label: store.t('hsInitial') || 'Initial Score', value: hs.initial ?? '—', differs: differs(hs.initial, curHs.initial), key: 'hs_initial', min: V.HS_INITIAL_MIN, max: V.HS_INITIAL_MAX, step: 1 },
                    { label: store.t('hsSuccessReward') || 'Success Reward', value: hs.successReward ?? '—', differs: differs(hs.successReward, curHs.successReward), key: 'hs_successReward', min: V.HS_SUCCESS_REWARD_MIN, max: V.HS_SUCCESS_REWARD_MAX, step: 1 },
                    { label: store.t('hsRateLimitPenalty') || 'Rate Limit Penalty', value: hs.rateLimitPenalty ?? '—', differs: differs(hs.rateLimitPenalty, curHs.rateLimitPenalty), key: 'hs_rateLimitPenalty', min: V.HS_RATE_LIMIT_PENALTY_MIN, max: V.HS_RATE_LIMIT_PENALTY_MAX, step: 1 },
                    { label: store.t('hsFailurePenalty') || 'Failure Penalty', value: hs.failurePenalty ?? '—', differs: differs(hs.failurePenalty, curHs.failurePenalty), key: 'hs_failurePenalty', min: V.HS_FAILURE_PENALTY_MIN, max: V.HS_FAILURE_PENALTY_MAX, step: 1 },
                    { label: store.t('hsRecoveryPerHour') || 'Recovery/Hour', value: hs.recoveryPerHour ?? '—', differs: differs(hs.recoveryPerHour, curHs.recoveryPerHour), key: 'hs_recoveryPerHour', min: V.HS_RECOVERY_PER_HOUR_MIN, max: V.HS_RECOVERY_PER_HOUR_MAX, step: 1 },
                    { label: store.t('hsMinUsable') || 'Min Usable Score', value: hs.minUsable ?? '—', differs: differs(hs.minUsable, curHs.minUsable), key: 'hs_minUsable', min: V.HS_MIN_USABLE_MIN, max: V.HS_MIN_USABLE_MAX, step: 1 },
                    { label: store.t('hsMaxScore') || 'Max Score', value: hs.maxScore ?? '—', differs: differs(hs.maxScore, curHs.maxScore), key: 'hs_maxScore', min: V.HS_MAX_SCORE_MIN, max: V.HS_MAX_SCORE_MAX, step: 1 },
                ]
            });

            // Token Bucket
            const tb = as.tokenBucket || {};
            const curTb = curAs.tokenBucket || {};
            sections.push({
                label: store.t('tokenBucketSection') || 'Token Bucket',
                hybridOnly: true,
                rows: [
                    { label: store.t('tbMaxTokens') || 'Max Tokens', value: tb.maxTokens ?? '—', differs: differs(tb.maxTokens, curTb.maxTokens), key: 'tb_maxTokens', min: V.TB_MAX_TOKENS_MIN, max: V.TB_MAX_TOKENS_MAX, step: 1 },
                    { label: store.t('tbTokensPerMinute') || 'Tokens/Minute', value: tb.tokensPerMinute ?? '—', differs: differs(tb.tokensPerMinute, curTb.tokensPerMinute), key: 'tb_tokensPerMinute', min: V.TB_TOKENS_PER_MINUTE_MIN, max: V.TB_TOKENS_PER_MINUTE_MAX, step: 1 },
                    { label: store.t('tbInitialTokens') || 'Initial Tokens', value: tb.initialTokens ?? '—', differs: differs(tb.initialTokens, curTb.initialTokens), key: 'tb_initialTokens', min: V.TB_INITIAL_TOKENS_MIN, max: V.TB_INITIAL_TOKENS_MAX, step: 1 },
                ]
            });

            // Quota Awareness
            const q = as.quota || {};
            const curQ = curAs.quota || {};
            sections.push({
                label: store.t('quotaAwarenessSection') || 'Quota Awareness',
                hybridOnly: true,
                rows: [
                    { label: store.t('qLowThreshold') || 'Low Threshold', value: q.lowThreshold != null ? Math.round(q.lowThreshold * 100) + '%' : '—', differs: differs(q.lowThreshold, curQ.lowThreshold), key: 'q_lowThreshold', min: V.Q_LOW_THRESHOLD_MIN, max: V.Q_LOW_THRESHOLD_MAX, step: 1, suffix: '%' },
                    { label: store.t('qCriticalThreshold') || 'Critical Threshold', value: q.criticalThreshold != null ? Math.round(q.criticalThreshold * 100) + '%' : '—', differs: differs(q.criticalThreshold, curQ.criticalThreshold), key: 'q_criticalThreshold', min: V.Q_CRITICAL_THRESHOLD_MIN, max: V.Q_CRITICAL_THRESHOLD_MAX, step: 1, suffix: '%' },
                    { label: store.t('qStaleMs') || 'Stale Data Timeout', value: this.formatMsValue(q.staleMs), differs: differs(q.staleMs, curQ.staleMs), key: 'q_staleMs', min: V.Q_STALE_MS_MIN, max: V.Q_STALE_MS_MAX, step: 1000, suffix: 'ms' },
                ]
            });
        }

        return {
            strategy,
            strategyLabel: this.getStrategyLabel(strategy),
            strategyDiffers: differs(strategy, currentStrategy),
            sections
        };
    },

    // ==========================================
    // Inline Preset Config Editing
    // ==========================================

    /**
     * Flatten a nested config object into a flat draft for UI editing.
     * Converts fractions to percentages where needed.
     */
    flattenConfigToDraft(cfg) {
        const as = cfg.accountSelection || {};
        const hs = as.healthScore || {};
        const tb = as.tokenBucket || {};
        const q = as.quota || {};
        const w = as.weights || {};
        return {
            maxRetries: cfg.maxRetries,
            retryBaseMs: cfg.retryBaseMs,
            retryMaxMs: cfg.retryMaxMs,
            defaultCooldownMs: cfg.defaultCooldownMs,
            maxWaitBeforeErrorMs: cfg.maxWaitBeforeErrorMs,
            maxAccounts: cfg.maxAccounts,
            globalQuotaThreshold: cfg.globalQuotaThreshold ? Math.round(cfg.globalQuotaThreshold * 100) : 0,
            rateLimitDedupWindowMs: cfg.rateLimitDedupWindowMs,
            maxConsecutiveFailures: cfg.maxConsecutiveFailures,
            extendedCooldownMs: cfg.extendedCooldownMs,
            maxCapacityRetries: cfg.maxCapacityRetries,
            switchAccountDelayMs: cfg.switchAccountDelayMs,
            capacityBackoffTiersMs: Array.isArray(cfg.capacityBackoffTiersMs) ? cfg.capacityBackoffTiersMs.join(', ') : '',
            accountSelection: { strategy: as.strategy || 'hybrid' },
            // Health score (prefixed hs_)
            hs_initial: hs.initial,
            hs_successReward: hs.successReward,
            hs_rateLimitPenalty: hs.rateLimitPenalty,
            hs_failurePenalty: hs.failurePenalty,
            hs_recoveryPerHour: hs.recoveryPerHour,
            hs_minUsable: hs.minUsable,
            hs_maxScore: hs.maxScore,
            // Token bucket (prefixed tb_)
            tb_maxTokens: tb.maxTokens,
            tb_tokensPerMinute: tb.tokensPerMinute,
            tb_initialTokens: tb.initialTokens,
            // Quota (prefixed q_, fractions → percentages)
            q_lowThreshold: q.lowThreshold != null ? Math.round(q.lowThreshold * 100) : 0,
            q_criticalThreshold: q.criticalThreshold != null ? Math.round(q.criticalThreshold * 100) : 0,
            q_staleMs: q.staleMs,
            // Weights (prefixed w_)
            w_health: w.health,
            w_tokens: w.tokens,
            w_quota: w.quota,
            w_lru: w.lru,
        };
    },

    /**
     * Build a nested config object from a flat UI draft.
     * Converts percentages back to fractions where needed.
     */
    buildConfigFromDraft(draft) {
        const cfg = {
            maxRetries: draft.maxRetries,
            retryBaseMs: draft.retryBaseMs,
            retryMaxMs: draft.retryMaxMs,
            defaultCooldownMs: draft.defaultCooldownMs,
            maxWaitBeforeErrorMs: draft.maxWaitBeforeErrorMs,
            maxAccounts: draft.maxAccounts,
            globalQuotaThreshold: (draft.globalQuotaThreshold || 0) / 100,
            rateLimitDedupWindowMs: draft.rateLimitDedupWindowMs,
            maxConsecutiveFailures: draft.maxConsecutiveFailures,
            extendedCooldownMs: draft.extendedCooldownMs,
            maxCapacityRetries: draft.maxCapacityRetries,
            switchAccountDelayMs: draft.switchAccountDelayMs,
        };

        // Parse capacityBackoffTiersMs from comma-separated string
        if (typeof draft.capacityBackoffTiersMs === 'string' && draft.capacityBackoffTiersMs.trim()) {
            const tiers = draft.capacityBackoffTiersMs.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
            if (tiers.length > 0) cfg.capacityBackoffTiersMs = tiers;
        } else if (Array.isArray(draft.capacityBackoffTiersMs)) {
            cfg.capacityBackoffTiersMs = draft.capacityBackoffTiersMs;
        }

        // Build accountSelection with nested objects
        cfg.accountSelection = {
            strategy: draft.accountSelection?.strategy || 'hybrid',
            healthScore: {
                initial: draft.hs_initial,
                successReward: draft.hs_successReward,
                rateLimitPenalty: draft.hs_rateLimitPenalty,
                failurePenalty: draft.hs_failurePenalty,
                recoveryPerHour: draft.hs_recoveryPerHour,
                minUsable: draft.hs_minUsable,
                maxScore: draft.hs_maxScore,
            },
            tokenBucket: {
                maxTokens: draft.tb_maxTokens,
                tokensPerMinute: draft.tb_tokensPerMinute,
                initialTokens: draft.tb_initialTokens,
            },
            quota: {
                lowThreshold: (draft.q_lowThreshold || 0) / 100,
                criticalThreshold: (draft.q_criticalThreshold || 0) / 100,
                staleMs: draft.q_staleMs,
            },
            weights: {
                health: draft.w_health,
                tokens: draft.w_tokens,
                quota: draft.w_quota,
                lru: draft.w_lru,
            }
        };

        // Clean undefined values from nested objects
        for (const subKey of ['healthScore', 'tokenBucket', 'quota', 'weights']) {
            const obj = cfg.accountSelection[subKey];
            const cleaned = {};
            let hasValues = false;
            for (const [k, v] of Object.entries(obj)) {
                if (v !== undefined && v !== null) {
                    cleaned[k] = v;
                    hasValues = true;
                }
            }
            if (hasValues) {
                cfg.accountSelection[subKey] = cleaned;
            } else {
                delete cfg.accountSelection[subKey];
            }
        }

        return cfg;
    },

    enterPresetConfigEdit() {
        const preset = this.serverPresets.find(p => p.name === this.selectedServerPreset);
        if (!preset?.config || preset.builtIn) return;

        this.editingConfigDraft = this.flattenConfigToDraft(preset.config);
        this.editingConfigErrors = {};
        this.editingPresetConfig = true;
        this.presetPreviewExpanded = true;
        this.configEditMode = 'ui';
        this.editingJsonText = '';
        this.jsonParseError = null;
    },

    cancelPresetConfigEdit() {
        this.editingPresetConfig = false;
        this.editingConfigDraft = { accountSelection: { strategy: 'hybrid' } };
        this.editingConfigErrors = {};
        this.configEditMode = 'ui';
        this.editingJsonText = '';
        this.jsonParseError = null;
    },

    switchConfigEditMode(mode) {
        if (mode === this.configEditMode) return;

        if (mode === 'json') {
            // UI → JSON: convert flat draft to nested config, then stringify
            const nested = this.buildConfigFromDraft(this.editingConfigDraft);
            this.editingJsonText = JSON.stringify(nested, null, 2);
            this.jsonParseError = null;
            this.editingConfigErrors = {};
            this.configEditMode = 'json';
        } else {
            // JSON → UI: parse nested config and flatten to draft
            try {
                const parsed = JSON.parse(this.editingJsonText);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    this.jsonParseError = Alpine.store('global').t('invalidJson') || 'Invalid JSON';
                    return;
                }
                this.editingConfigDraft = this.flattenConfigToDraft(parsed);
                this.editingConfigErrors = {};
                this.jsonParseError = null;
                // Re-validate all numeric fields
                const allKeys = [
                    'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs',
                    'maxWaitBeforeErrorMs', 'maxAccounts', 'globalQuotaThreshold',
                    'rateLimitDedupWindowMs', 'maxConsecutiveFailures', 'extendedCooldownMs',
                    'maxCapacityRetries', 'switchAccountDelayMs',
                    'hs_initial', 'hs_successReward', 'hs_rateLimitPenalty', 'hs_failurePenalty',
                    'hs_recoveryPerHour', 'hs_minUsable', 'hs_maxScore',
                    'tb_maxTokens', 'tb_tokensPerMinute', 'tb_initialTokens',
                    'q_lowThreshold', 'q_criticalThreshold', 'q_staleMs',
                    'w_health', 'w_tokens', 'w_quota', 'w_lru'
                ];
                allKeys.forEach(k => {
                    if (this.editingConfigDraft[k] !== undefined) this.validatePresetConfigField(k, this.editingConfigDraft[k]);
                });
                // Validate capacityBackoffTiersMs text
                this.validatePresetConfigField('capacityBackoffTiersMs', this.editingConfigDraft.capacityBackoffTiersMs);
                this.configEditMode = 'ui';
            } catch (e) {
                this.jsonParseError = Alpine.store('global').t('invalidJson') || 'Invalid JSON';
            }
        }
    },

    validateJsonText() {
        try {
            const parsed = JSON.parse(this.editingJsonText);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                this.jsonParseError = Alpine.store('global').t('invalidJson') || 'Invalid JSON';
            } else {
                this.jsonParseError = null;
            }
        } catch {
            this.jsonParseError = Alpine.store('global').t('invalidJson') || 'Invalid JSON';
        }
    },

    validatePresetConfigField(key, value) {
        const V = window.AppConstants.VALIDATION;

        // Special text validation for capacityBackoffTiersMs
        if (key === 'capacityBackoffTiersMs') {
            const str = String(value || '').trim();
            if (!str) {
                delete this.editingConfigErrors[key];
                return;
            }
            const parts = str.split(',').map(s => s.trim());
            if (parts.length < V.CAPACITY_BACKOFF_TIERS_MIN_LENGTH || parts.length > V.CAPACITY_BACKOFF_TIERS_MAX_LENGTH) {
                this.editingConfigErrors[key] = `${V.CAPACITY_BACKOFF_TIERS_MIN_LENGTH}–${V.CAPACITY_BACKOFF_TIERS_MAX_LENGTH} values`;
                return;
            }
            const allValid = parts.every(s => {
                const n = Number(s);
                return !isNaN(n) && n >= V.CAPACITY_BACKOFF_TIER_MIN && n <= V.CAPACITY_BACKOFF_TIER_MAX;
            });
            if (!allValid) {
                this.editingConfigErrors[key] = `each ${V.CAPACITY_BACKOFF_TIER_MIN}–${V.CAPACITY_BACKOFF_TIER_MAX}`;
            } else {
                delete this.editingConfigErrors[key];
            }
            return;
        }

        const numVal = Number(value);
        const ranges = {
            maxRetries: [V.MAX_RETRIES_MIN, V.MAX_RETRIES_MAX],
            retryBaseMs: [V.RETRY_BASE_MS_MIN, V.RETRY_BASE_MS_MAX],
            retryMaxMs: [V.RETRY_MAX_MS_MIN, V.RETRY_MAX_MS_MAX],
            defaultCooldownMs: [V.DEFAULT_COOLDOWN_MIN, V.DEFAULT_COOLDOWN_MAX],
            maxWaitBeforeErrorMs: [V.MAX_WAIT_MIN, V.MAX_WAIT_MAX],
            maxAccounts: [V.MAX_ACCOUNTS_MIN, V.MAX_ACCOUNTS_MAX],
            globalQuotaThreshold: [V.GLOBAL_QUOTA_THRESHOLD_MIN, V.GLOBAL_QUOTA_THRESHOLD_MAX],
            rateLimitDedupWindowMs: [V.RATE_LIMIT_DEDUP_MIN, V.RATE_LIMIT_DEDUP_MAX],
            maxConsecutiveFailures: [V.MAX_CONSECUTIVE_FAILURES_MIN, V.MAX_CONSECUTIVE_FAILURES_MAX],
            extendedCooldownMs: [V.EXTENDED_COOLDOWN_MIN, V.EXTENDED_COOLDOWN_MAX],
            maxCapacityRetries: [V.MAX_CAPACITY_RETRIES_MIN, V.MAX_CAPACITY_RETRIES_MAX],
            switchAccountDelayMs: [V.SWITCH_ACCOUNT_DELAY_MIN, V.SWITCH_ACCOUNT_DELAY_MAX],
            // Health score
            hs_initial: [V.HS_INITIAL_MIN, V.HS_INITIAL_MAX],
            hs_successReward: [V.HS_SUCCESS_REWARD_MIN, V.HS_SUCCESS_REWARD_MAX],
            hs_rateLimitPenalty: [V.HS_RATE_LIMIT_PENALTY_MIN, V.HS_RATE_LIMIT_PENALTY_MAX],
            hs_failurePenalty: [V.HS_FAILURE_PENALTY_MIN, V.HS_FAILURE_PENALTY_MAX],
            hs_recoveryPerHour: [V.HS_RECOVERY_PER_HOUR_MIN, V.HS_RECOVERY_PER_HOUR_MAX],
            hs_minUsable: [V.HS_MIN_USABLE_MIN, V.HS_MIN_USABLE_MAX],
            hs_maxScore: [V.HS_MAX_SCORE_MIN, V.HS_MAX_SCORE_MAX],
            // Token bucket
            tb_maxTokens: [V.TB_MAX_TOKENS_MIN, V.TB_MAX_TOKENS_MAX],
            tb_tokensPerMinute: [V.TB_TOKENS_PER_MINUTE_MIN, V.TB_TOKENS_PER_MINUTE_MAX],
            tb_initialTokens: [V.TB_INITIAL_TOKENS_MIN, V.TB_INITIAL_TOKENS_MAX],
            // Quota
            q_lowThreshold: [V.Q_LOW_THRESHOLD_MIN, V.Q_LOW_THRESHOLD_MAX],
            q_criticalThreshold: [V.Q_CRITICAL_THRESHOLD_MIN, V.Q_CRITICAL_THRESHOLD_MAX],
            q_staleMs: [V.Q_STALE_MS_MIN, V.Q_STALE_MS_MAX],
            // Weights
            w_health: [V.W_HEALTH_MIN, V.W_HEALTH_MAX],
            w_tokens: [V.W_TOKENS_MIN, V.W_TOKENS_MAX],
            w_quota: [V.W_QUOTA_MIN, V.W_QUOTA_MAX],
            w_lru: [V.W_LRU_MIN, V.W_LRU_MAX],
        };
        const range = ranges[key];
        if (!range) return;

        if (isNaN(numVal) || numVal < range[0] || numVal > range[1]) {
            this.editingConfigErrors[key] = `${range[0]}–${range[1]}`;
        } else {
            delete this.editingConfigErrors[key];
            this.editingConfigDraft[key] = numVal;
        }
    },

    hasPresetConfigErrors() {
        if (this.configEditMode === 'json') return !!this.jsonParseError;
        return Object.keys(this.editingConfigErrors).length > 0;
    },

    async savePresetConfig() {
        if (this.hasPresetConfigErrors() || this.savingPresetConfig) return;

        const store = Alpine.store('global');
        const presetName = this.selectedServerPreset;
        if (!presetName) return;

        let configPayload;
        if (this.configEditMode === 'json') {
            // Parse JSON textarea directly into config payload
            try {
                configPayload = JSON.parse(this.editingJsonText);
            } catch {
                this.jsonParseError = store.t('invalidJson') || 'Invalid JSON';
                return;
            }
            // Must be a plain object (not null, not an array, not a primitive)
            if (typeof configPayload !== 'object' || configPayload === null || Array.isArray(configPayload)) {
                this.jsonParseError = store.t('invalidJson') || 'Invalid JSON';
                return;
            }
        } else {
            // Build nested config from flat UI draft
            configPayload = this.buildConfigFromDraft(this.editingConfigDraft);
        }

        this.savingPresetConfig = true;
        try {
            const { response, newPassword } = await window.utils.request(
                `/api/server/presets/${encodeURIComponent(presetName)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ config: configPayload })
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `HTTP ${response.status}`);
            }
            const data = await response.json();
            if (data.status === 'ok') {
                this.serverPresets = data.presets || [];
                this.editingPresetConfig = false;
                this.editingConfigDraft = { accountSelection: { strategy: 'hybrid' } };
                this.editingConfigErrors = {};
                this.configEditMode = 'ui';
                this.editingJsonText = '';
                this.jsonParseError = null;
                store.showToast(store.t('presetConfigSaved') || 'Preset config updated', 'success');
            } else {
                throw new Error(data.error || 'Failed to save preset config');
            }
        } catch (e) {
            store.showToast((store.t('failedToSavePresetConfig') || 'Failed to update preset config') + ': ' + e.message, 'error');
        } finally {
            this.savingPresetConfig = false;
        }
    }
});
