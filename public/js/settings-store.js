/**
 * Settings Store
 */
document.addEventListener('alpine:init', () => {
    Alpine.store('settings', {
        refreshInterval: 60,
        logLimit: 2000,
        showExhausted: true,
        showHiddenModels: false, // New field
        compact: false,
        redactMode: false,
        debugLogging: true,
        logExport: true,
        healthInspector: true,
        port: 8080, // Display only

        init() {
            this.loadSettings();
        },

        // Call this method when toggling settings in the UI
        toggle(key) {
            if (this.hasOwnProperty(key) && typeof this[key] === 'boolean') {
                this[key] = !this[key];
                this.saveSettings(true);
            }
        },

        loadSettings() {
            const saved = localStorage.getItem('antigravity_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.keys(parsed).forEach(k => {
                    // Only load keys that exist in our default state (safety)
                    if (this.hasOwnProperty(k)) this[k] = parsed[k];
                });
            }
        },

        saveSettings(silent = false) {
            const toSave = {
                refreshInterval: this.refreshInterval,
                logLimit: this.logLimit,
                showExhausted: this.showExhausted,
                showHiddenModels: this.showHiddenModels,
                compact: this.compact,
                redactMode: this.redactMode,
                debugLogging: this.debugLogging,
                logExport: this.logExport,
                healthInspector: this.healthInspector
            };
            localStorage.setItem('antigravity_settings', JSON.stringify(toSave));

            if (!silent) {
                const store = Alpine.store('global');
                store.showToast(store.t('configSaved'), 'success');
            }

            // Trigger updates
            document.dispatchEvent(new CustomEvent('refresh-interval-changed'));
            if (Alpine.store('data')) {
                Alpine.store('data').computeQuotaRows();
            }
        }
    });
});
