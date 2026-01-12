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

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}/refresh`,
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('refreshedAccount', { email }), 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || store.t('refreshFailed'));
            }
        }, this, 'refreshing', { errorMessage: 'Failed to refresh account' });
    },

    async toggleAccount(email, enabled) {
        const store = Alpine.store('global');
        const password = store.webuiPassword;

        // Optimistic update: immediately update UI
        const dataStore = Alpine.store('data');
        const account = dataStore.accounts.find(a => a.email === email);
        if (account) {
            account.enabled = enabled;
        }

        try {
            const { response, newPassword } = await window.utils.request(`/api/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            }, password);
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
                store.showToast(store.t('accountToggled', { email, status }), 'success');
                // Refresh to confirm server state
                await dataStore.fetchData();
            } else {
                store.showToast(data.error || store.t('toggleFailed'), 'error');
                // Rollback optimistic update on error
                if (account) {
                    account.enabled = !enabled;
                }
                await dataStore.fetchData();
            }
        } catch (e) {
            store.showToast(store.t('toggleFailed') + ': ' + e.message, 'error');
            // Rollback optimistic update on error
            if (account) {
                account.enabled = !enabled;
            }
            await dataStore.fetchData();
        }
    },

    async fixAccount(email) {
        const store = Alpine.store('global');
        store.showToast(store.t('reauthenticating', { email }), 'info');
        const password = store.webuiPassword;
        try {
            const urlPath = `/api/auth/url?email=${encodeURIComponent(email)}`;
            const { response, newPassword } = await window.utils.request(urlPath, {}, password);
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                window.open(data.url, 'google_oauth', 'width=600,height=700,scrollbars=yes');
            } else {
                store.showToast(data.error || store.t('authUrlFailed'), 'error');
            }
        } catch (e) {
            store.showToast(store.t('authUrlFailed') + ': ' + e.message, 'error');
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

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}`,
                { method: 'DELETE' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('deletedAccount', { email }), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('delete_account_modal').close();
                this.deleteTarget = '';
            } else {
                throw new Error(data.error || store.t('deleteFailed'));
            }
        }, this, 'deleting', { errorMessage: 'Failed to delete account' });
    },

    async reloadAccounts() {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');

            const { response, newPassword } = await window.utils.request(
                '/api/accounts/reload',
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountsReloaded'), 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || store.t('reloadFailed'));
            }
        }, this, 'reloading', { errorMessage: 'Failed to reload accounts' });
    },

    openQuotaModal(account) {
        this.selectedAccountEmail = account.email;
        this.selectedAccountLimits = account.limits || {};
        document.getElementById('quota_modal').showModal();
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
    }
});
