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
    selectedAccountQuotaSummary: null,
    showPerModelBreakdown: false,

    // Health Inspector (Developer Mode)
    healthData: {},
    healthLoading: false,

    init() {
        if (Alpine.store('data').devMode && Alpine.store('settings').healthInspectorOpen) {
            this.fetchHealthData();
        }
    },

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
            store.showToast(store.t('refreshingAccount', { email: Redact.email(email) }), 'info');

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}/refresh`,
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('refreshedAccount', { email: Redact.email(email) }), 'success');
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
                store.showToast(store.t('accountToggled', { email: Redact.email(email), status }), 'success');
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
        const dataStore = Alpine.store('data');
        // If the account has a verification URL (403 VALIDATION_REQUIRED), open it directly
        const account = (dataStore.accounts || []).find(a => a.email === email);
        if (account?.verifyUrl) {
            window.open(account.verifyUrl, '_blank');
            store.showToast(store.t('verifyThenRefresh') || 'After completing verification, click the ↻ Refresh button to re-enable this account', 'info', 10000);
            return;
        }
        // Otherwise fall back to OAuth re-auth
        store.showToast(store.t('reauthenticating', { email: Redact.email(email) }), 'info');
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
                store.showToast(store.t('deletedAccount', { email: Redact.email(email) }), 'success');
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
        this.selectedAccountQuotaSummary = account.quotaSummary || null;
        this.showPerModelBreakdown = false;
        document.getElementById('quota_modal').showModal();
    },

    // Threshold settings
    thresholdDialog: {
        email: '',
        quotaThreshold: null,  // null means use global
        modelQuotaThresholds: {},
        saving: false,
        addingModel: false,
        newModelId: '',
        newModelThreshold: 10
    },

    openThresholdModal(account) {
        this.thresholdDialog = {
            email: account.email,
            // Convert from fraction (0-1) to percentage (0-99) for display
            quotaThreshold: account.quotaThreshold !== undefined ? Math.round(account.quotaThreshold * 100) : null,
            modelQuotaThresholds: Object.fromEntries(
                Object.entries(account.modelQuotaThresholds || {}).map(([k, v]) => [k, Math.round(v * 100)])
            ),
            saving: false,
            addingModel: false,
            newModelId: '',
            newModelThreshold: 10
        };
        document.getElementById('threshold_modal').showModal();
    },

    async saveAccountThreshold() {
        const store = Alpine.store('global');
        this.thresholdDialog.saving = true;

        try {
            // Convert percentage back to fraction
            const quotaThreshold = this.thresholdDialog.quotaThreshold !== null && this.thresholdDialog.quotaThreshold !== ''
                ? parseFloat(this.thresholdDialog.quotaThreshold) / 100
                : null;

            // Convert model thresholds from percentage to fraction
            const modelQuotaThresholds = {};
            for (const [modelId, pct] of Object.entries(this.thresholdDialog.modelQuotaThresholds)) {
                modelQuotaThresholds[modelId] = parseFloat(pct) / 100;
            }

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(this.thresholdDialog.email)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quotaThreshold, modelQuotaThresholds })
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast('Settings saved', 'success');
                Alpine.store('data').fetchData();
                document.getElementById('threshold_modal').close();
            } else {
                throw new Error(data.error || 'Failed to save settings');
            }
        } catch (e) {
            store.showToast('Failed to save settings: ' + e.message, 'error');
        } finally {
            this.thresholdDialog.saving = false;
        }
    },

    clearAccountThreshold() {
        this.thresholdDialog.quotaThreshold = null;
    },

    // Per-model threshold methods
    addModelThreshold() {
        this.thresholdDialog.addingModel = true;
        this.thresholdDialog.newModelId = '';
        this.thresholdDialog.newModelThreshold = 10;
    },

    updateModelThreshold(modelId, value) {
        const numValue = parseInt(value);
        if (!isNaN(numValue) && numValue >= 0 && numValue <= 99) {
            this.thresholdDialog.modelQuotaThresholds[modelId] = numValue;
        }
    },

    removeModelThreshold(modelId) {
        delete this.thresholdDialog.modelQuotaThresholds[modelId];
    },

    confirmAddModelThreshold() {
        const modelId = this.thresholdDialog.newModelId;
        const threshold = parseInt(this.thresholdDialog.newModelThreshold) || 10;

        if (modelId && threshold >= 0 && threshold <= 99) {
            this.thresholdDialog.modelQuotaThresholds[modelId] = threshold;
            this.thresholdDialog.addingModel = false;
            this.thresholdDialog.newModelId = '';
            this.thresholdDialog.newModelThreshold = 10;
        }
    },

    getAvailableModelsForThreshold() {
        // Get models from data store, exclude already configured ones
        const allModels = Alpine.store('data').models || [];
        const configured = Object.keys(this.thresholdDialog.modelQuotaThresholds);
        return allModels.filter(m => !configured.includes(m));
    },

    getEffectiveThreshold(account) {
        // Return display string for effective threshold
        if (account.quotaThreshold !== undefined) {
            return Math.round(account.quotaThreshold * 100) + '%';
        }
        // If no per-account threshold, show global value
        const globalThreshold = Alpine.store('data').globalQuotaThreshold;
        if (globalThreshold > 0) {
            return Math.round(globalThreshold * 100) + '% (global)';
        }
        return 'Global';
    },

    /**
     * Get two-group quotas for an account: Gemini and Claude/GPT
     * Extracts weekly and 5-hour quota percentages and reset times.
     *
     * @param {Object} account - Account object
     * @returns {Object} { gemini: { percent, weeklyPercent, fiveHourPercent, resetTime, weeklyResetTime }, claude: { ... } }
     */
    getAccountGroupQuotas(account) {
        const groups = this.getQuotaGroups(account);
        const geminiGrp = groups.find(g => /gemini/i.test(g.displayName || g.id || '')) || null;
        const claudeGrp = groups.find(g => /claude|3p|gpt/i.test(g.displayName || g.id || '')) || null;

        const extractBucket = (grp, window) => {
            if (!grp || !grp.buckets) return null;
            return grp.buckets.find(b => b.window === window || (b.bucketId && b.bucketId.includes(window))) || null;
        };

        const buildGroupData = (grp) => {
            if (!grp) return { percent: null, weeklyPercent: null, fiveHourPercent: null, resetTime: null, weeklyResetTime: null };
            const weeklyBkt = extractBucket(grp, 'weekly');
            const fiveHourBkt = extractBucket(grp, '5h');

            const weeklyPct = weeklyBkt && weeklyBkt.remainingFraction !== null && weeklyBkt.remainingFraction !== undefined
                ? Math.round(weeklyBkt.remainingFraction * 100)
                : null;
            const fiveHourPct = fiveHourBkt && fiveHourBkt.remainingFraction !== null && fiveHourBkt.remainingFraction !== undefined
                ? Math.round(fiveHourBkt.remainingFraction * 100)
                : null;

            // Prioritize 5h limit as the primary bar, or weekly if 5h is not present
            const percent = fiveHourPct !== null ? fiveHourPct : weeklyPct;

            return {
                percent,
                weeklyPercent: weeklyPct,
                fiveHourPercent: fiveHourPct,
                resetTime: fiveHourBkt?.resetTime || null,
                weeklyResetTime: weeklyBkt?.resetTime || null,
                weeklyDesc: weeklyBkt?.description || null
            };
        };

        return {
            gemini: buildGroupData(geminiGrp),
            claude: buildGroupData(claudeGrp)
        };
    },

    /**
     * Get normalized quota groups for the account (from quotaSummary or synthesized from limits)
     *
     * @param {Object} [account] - Account object (defaults to currently selected account or param)
     * @returns {Array<Object>} Array of group objects with displayName, description, and buckets
     */
    getQuotaGroups(account = null) {
        const acc = account || { limits: this.selectedAccountLimits, quotaSummary: this.selectedAccountQuotaSummary };
        const summary = acc.quotaSummary || (this.selectedAccountEmail === acc.email ? this.selectedAccountQuotaSummary : null);

        if (summary && Array.isArray(summary.groups) && summary.groups.length > 0) {
            return summary.groups.map(grp => ({
                id: grp.displayName?.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'group',
                displayName: grp.displayName || 'Model Group',
                description: grp.description || '',
                buckets: (grp.buckets || []).map(b => ({
                    bucketId: b.bucketId || '',
                    displayName: b.displayName || (b.window === 'weekly' ? 'Weekly Limit Remaining' : 'Five Hour Limit Remaining'),
                    window: b.window || (b.bucketId?.includes('weekly') ? 'weekly' : '5h'),
                    remainingFraction: b.remainingFraction !== undefined ? b.remainingFraction : null,
                    percent: b.remainingFraction !== null && b.remainingFraction !== undefined ? Math.round(b.remainingFraction * 100) : null,
                    resetTime: b.resetTime || null,
                    description: b.description || ''
                }))
            }));
        }

        // Synthesize groups from limits if quotaSummary not available
        const limits = acc.limits || this.selectedAccountLimits || {};
        const geminiModels = Object.entries(limits).filter(([id]) => id.toLowerCase().includes('gemini'));
        const claudeGptModels = Object.entries(limits).filter(([id]) => !id.toLowerCase().includes('gemini'));

        const getGroupBucket = (models, prefix) => {
            const valid = models.find(([_, l]) => l && l.remainingFraction !== null && l.remainingFraction !== undefined);
            const modelLimit = valid ? valid[1] : (models[0] ? models[0][1] : null);
            const frac = modelLimit ? modelLimit.remainingFraction : null;
            return {
                bucketId: `${prefix}-5h`,
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: frac,
                percent: frac !== null && frac !== undefined ? Math.round(frac * 100) : null,
                resetTime: modelLimit?.resetTime || null,
                description: 'Shared 5-hour limit for models in this group'
            };
        };

        const groups = [];
        if (geminiModels.length > 0 || Object.keys(limits).length === 0) {
            groups.push({
                id: 'gemini-group',
                displayName: 'Gemini Models',
                description: 'Models within this group: Gemini Flash, Gemini Pro',
                buckets: [
                    getGroupBucket(geminiModels, 'gemini')
                ]
            });
        }

        if (claudeGptModels.length > 0) {
            groups.push({
                id: '3p-group',
                displayName: 'Claude and GPT models',
                description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
                buckets: [
                    getGroupBucket(claudeGptModels, '3p')
                ]
            });
        }

        return groups;
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
     * Fetch strategy health data for the inspector panel
     */
    async fetchHealthData() {
        this.healthLoading = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(
                '/api/strategy/health',
                {},
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                this.healthData = data;
            } else {
                this.healthData = {};
                if (response.status === 403) {
                    store.showToast(data.error || 'Developer mode is not enabled', 'warning');
                }
            }
        } catch (e) {
            console.error('Failed to fetch health data:', e);
        } finally {
            this.healthLoading = false;
        }
    },

    /**
     * Export accounts to JSON file
     */
    async exportAccounts() {
        const store = Alpine.store('global');
        try {
            const { response, newPassword } = await window.utils.request(
                '/api/accounts/export',
                {},
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            // API returns plain array directly
            if (Array.isArray(data)) {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `antigravity-accounts-${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                store.showToast(store.t('exportSuccess', { count: data.length }), 'success');
            } else if (data.error) {
                throw new Error(data.error);
            }
        } catch (e) {
            store.showToast(store.t('exportFailed') + ': ' + e.message, 'error');
        }
    },

    /**
     * Import accounts from JSON file
     * @param {Event} event - file input change event
     */
    async importAccounts(event) {
        const store = Alpine.store('global');
        const file = event.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importData = JSON.parse(text);

            // Support both plain array and wrapped format
            const accounts = Array.isArray(importData) ? importData : (importData.accounts || []);
            if (!Array.isArray(accounts) || accounts.length === 0) {
                throw new Error('Invalid file format: expected accounts array');
            }

            const { response, newPassword } = await window.utils.request(
                '/api/accounts/import',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(accounts)
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const { added, updated, failed } = data.results;
                let msg = store.t('importSuccess') + ` ${added.length} added, ${updated.length} updated`;
                if (failed.length > 0) {
                    msg += `, ${failed.length} failed`;
                }
                store.showToast(msg, failed.length > 0 ? 'info' : 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || 'Import failed');
            }
        } catch (e) {
            store.showToast(store.t('importFailed') + ': ' + e.message, 'error');
        } finally {
            // Reset file input
            event.target.value = '';
        }
    }
});
