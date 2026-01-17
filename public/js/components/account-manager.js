/**
 * Account Manager Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.accountManager = () => ({
    searchQuery: '',
    deleteTarget: '',
    refreshing: false,
    toggling: false,
    deleting: false,
    reloading: false,
    selectedAccountEmail: '',
    selectedAccountLimits: {},
    selectedAccountHealth: {}, // New: Health data
    activeModalTab: 'quota',   // New: 'quota' | 'health'
    healthLoading: false,

    get filteredAccounts() {
        const accounts = Alpine.store('data').accounts || [];
        if (!this.searchQuery || this.searchQuery.trim() === '') {
            return accounts;
        }

        const query = this.searchQuery.toLowerCase().trim();
        return accounts.filter(acc => {
            return acc.email.toLowerCase().includes(query) ||
                   (acc.projectId && acc.projectId.toLowerCase().includes(query)) ||
                   (acc.source && acc.source.toLowerCase().includes(query));
        });
    },

    init() {
        // Listen for external requests to open account details
        window.addEventListener('open-account-details', (e) => {
            const { email, tab } = e.detail;
            const accounts = Alpine.store('data').accounts || [];
            const account = accounts.find(a => a.email === email);

            if (account) {
                this.searchQuery = email; // Optional: filter list too
                this.selectedAccountEmail = account.email;
                this.selectedAccountLimits = account.limits || {};
                this.selectedAccountHealth = {};
                this.activeModalTab = tab || 'quota';

                document.getElementById('quota_modal').showModal();
                this.fetchAccountHealth(account.email);
            }
        });
    },

    formatEmail(email) {
        if (!email || email.length <= 40) return email;

        const [user, domain] = email.split('@');
        if (!domain) return email;

        // Preserve domain integrity, truncate username if needed
        if (user.length > 20) {
            return `${user.substring(0, 10)}...${user.slice(-5)}@${domain}`;
        }
        return email;
    },

    async refreshAccount(email) {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');
            store.showToast(store.t('refreshingAccount', { email }), 'info');

            const result = await window.AccountActions.refreshAccount(email);
            if (result.success) {
                store.showToast(store.t('refreshedAccount', { email }), 'success');
            } else {
                throw new Error(result.error);
            }
        }, this, 'refreshing', { errorMessage: 'Failed to refresh account' });
    },

    async toggleAccount(email, enabled) {
        const store = Alpine.store('global');
        const result = await window.AccountActions.toggleAccount(email, enabled);

        if (result.success) {
            const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
            store.showToast(store.t('accountToggled', { email, status }), 'success');
        } else {
            store.showToast(result.error, 'error');
        }
    },

    async fixAccount(email) {
        const store = Alpine.store('global');
        store.showToast(store.t('reauthenticating', { email }), 'info');

        const result = await window.AccountActions.getFixAccountUrl(email);
        if (result.success) {
            window.open(result.url, 'google_oauth', 'width=600,height=700,scrollbars=yes');
        } else {
            store.showToast(result.error, 'error');
        }
    },

    confirmDeleteAccount(email) {
        this.deleteTarget = email;
        document.getElementById('delete_account_modal').showModal();
    },

    async executeDelete() {
        const email = this.deleteTarget;
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');
            const result = await window.AccountActions.deleteAccount(email);

            if (result.success) {
                store.showToast(store.t('deletedAccount', { email }), 'success');
                document.getElementById('delete_account_modal').close();
                this.deleteTarget = '';
            } else {
                throw new Error(result.error);
            }
        }, this, 'deleting', { errorMessage: 'Failed to delete account' });
    },

    async reloadAccounts() {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');
            const result = await window.AccountActions.reloadAccounts();

            if (result.success) {
                store.showToast(store.t('accountsReloaded'), 'success');
            } else {
                throw new Error(result.error);
            }
        }, this, 'reloading', { errorMessage: 'Failed to reload accounts' });
    },

    async openQuotaModal(account) {
        this.selectedAccountEmail = account.email;
        this.selectedAccountLimits = account.limits || {};
        this.selectedAccountHealth = {}; // Reset
        this.activeModalTab = 'quota';

        document.getElementById('quota_modal').showModal();

        // Fetch health data in background
        this.fetchAccountHealth(account.email);
    },

    async fetchAccountHealth(email) {
        this.healthLoading = true;
        try {
            const response = await fetch(`/api/accounts/${encodeURIComponent(email)}/health`);
            if (response.ok) {
                const data = await response.json();
                this.selectedAccountHealth = data.health || {};
            }
        } catch (e) {
            console.error('Failed to fetch health:', e);
        } finally {
            this.healthLoading = false;
        }
    },

    async toggleModelHealth(modelId, enabled) {
        const email = this.selectedAccountEmail;
        // Optimistic update
        if (this.selectedAccountHealth[modelId]) {
            this.selectedAccountHealth[modelId].manualDisabled = !enabled;
            this.selectedAccountHealth[modelId].disabled = !enabled; // UI logic usually checks generic 'disabled'
        }

        const result = await window.AccountActions.toggleModelHealth(email, modelId, enabled);
        if (result.success) {
            // Update with server data
            if (result.data && result.data.health) {
                this.selectedAccountHealth = result.data.health;
            } else {
                // Refresh full health if partial update not available
                this.fetchAccountHealth(email);
            }
        } else {
            Alpine.store('global').showToast(result.error, 'error');
            this.fetchAccountHealth(email); // Revert
        }
    },

    async resetModelHealth(modelId = null) {
        if (!confirm('Reset health metrics for this model? This will clear failure counts and enable the model.')) return;

        const email = this.selectedAccountEmail;
        const result = await window.AccountActions.resetHealth(email, modelId);

        if (result.success) {
            Alpine.store('global').showToast('Health metrics reset', 'success');
            this.fetchAccountHealth(email);
        } else {
            Alpine.store('global').showToast(result.error, 'error');
        }
    },

    /**
     * Get main model quota for display
     * Prioritizes flagship models (Opus > Sonnet > Flash)
     * @param {Object} account - Account object with limits
     * @returns {Object} { percent: number|null, model: string }
     */
    getMainModelQuota(account) {
        const limits = account.limits || {};

        const getQuotaVal = (id) => {
             const l = limits[id];
             if (!l) return -1;
             if (l.remainingFraction !== null) return l.remainingFraction;
             if (l.resetTime) return 0; // Rate limited
             return -1; // Unknown
        };

        const validIds = Object.keys(limits).filter(id => getQuotaVal(id) >= 0);

        if (validIds.length === 0) return { percent: null, model: '-' };

        const DEAD_THRESHOLD = 0.01;

        const MODEL_TIERS = [
            { pattern: /\bopus\b/, aliveScore: 100, deadScore: 60 },
            { pattern: /\bsonnet\b/, aliveScore: 90, deadScore: 55 },
            // Gemini 3 Pro / Ultra
            { pattern: /\bgemini-3\b/, extraCheck: (l) => /\bpro\b/.test(l) || /\bultra\b/.test(l), aliveScore: 80, deadScore: 50 },
            { pattern: /\bpro\b/, aliveScore: 75, deadScore: 45 },
            // Mid/Low Tier
            { pattern: /\bhaiku\b/, aliveScore: 30, deadScore: 15 },
            { pattern: /\bflash\b/, aliveScore: 20, deadScore: 10 }
        ];

        const getPriority = (id) => {
            const lower = id.toLowerCase();
            const val = getQuotaVal(id);
            const isAlive = val > DEAD_THRESHOLD;

            for (const tier of MODEL_TIERS) {
                if (tier.pattern.test(lower)) {
                    if (tier.extraCheck && !tier.extraCheck(lower)) continue;
                    return isAlive ? tier.aliveScore : tier.deadScore;
                }
            }

            return isAlive ? 5 : 0;
        };

        // Sort by priority desc
        validIds.sort((a, b) => getPriority(b) - getPriority(a));

        const bestModel = validIds[0];
        const val = getQuotaVal(bestModel);

        return {
            percent: Math.round(val * 100),
            model: bestModel
        };
    },

    /**
     * Get health score color class
     */
    getHealthColor(score) {
        if (score >= 90) return 'text-neon-green';
        if (score >= 70) return 'text-yellow-500';
        return 'text-red-500';
    },

    /**
     * Get relative time string
     */
    timeAgo(isoString) {
        if (!isoString) return '-';
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.round(diffMs / 60000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.round(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${Math.round(diffHours / 24)}d ago`;
    }
});
