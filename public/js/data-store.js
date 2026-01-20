/**
 * Data Store
 * Holds Accounts, Models, and Computed Quota Rows
 * Shared between Dashboard and AccountManager
 */

// utils is loaded globally as window.utils in utils.js

document.addEventListener('alpine:init', () => {
    Alpine.store('data', {
        accounts: [],
        models: [], // Source of truth
        modelConfig: {}, // Model metadata (hidden, pinned, alias)
        quotaRows: [], // Filtered view
        usageHistory: {}, // Usage statistics history (from /account-limits?includeHistory=true)
        maxAccounts: 10, // Maximum number of accounts allowed (from config)
        loading: false,
        initialLoad: true, // Track first load for skeleton screen
        connectionStatus: 'connecting',
        lastUpdated: '-',
        healthCheckTimer: null,

        // Filters state
        filters: {
            account: 'all',
            family: 'all',
            search: '',
            sortCol: 'avgQuota',
            sortAsc: true
        },

        // Settings for calculation
        // We need to access global settings? Or duplicate?
        // Let's assume settings are passed or in another store.
        // For simplicity, let's keep relevant filters here.

        init() {
            // Restore from cache first for instant render
            this.loadFromCache();

            // Watch filters to recompute
            // Alpine stores don't have $watch automatically unless inside a component?
            // We can manually call compute when filters change.
            
            // Start health check monitoring
            this.startHealthCheck();
        },

        loadFromCache() {
            try {
                const cached = localStorage.getItem('ag_data_cache');
                if (cached) {
                    const data = JSON.parse(cached);
                    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

                    // Check TTL
                    if (data.timestamp && (Date.now() - data.timestamp > CACHE_TTL)) {
                        console.log('Cache expired, skipping restoration');
                        localStorage.removeItem('ag_data_cache');
                        return;
                    }

                    // Basic validity check
                    if (data.accounts && data.models) {
                        this.accounts = data.accounts;
                        this.models = data.models;
                        this.modelConfig = data.modelConfig || {};
                        this.usageHistory = data.usageHistory || {};
                        
                        // Don't show loading on initial load if we have cache
                        this.initialLoad = false;
                        this.computeQuotaRows();
                        console.log('Restored data from cache');
                    }
                }
            } catch (e) {
                console.warn('Failed to load cache', e);
            }
        },

        saveToCache() {
            try {
                const cacheData = {
                    accounts: this.accounts,
                    models: this.models,
                    modelConfig: this.modelConfig,
                    usageHistory: this.usageHistory,
                    timestamp: Date.now()
                };
                localStorage.setItem('ag_data_cache', JSON.stringify(cacheData));
            } catch (e) {
                console.warn('Failed to save cache', e);
            }
        },

        async fetchData() {
            // Only show skeleton on initial load if we didn't restore from cache
            if (this.initialLoad) {
                this.loading = true;
            }
            try {
                // Get password from global store
                const password = Alpine.store('global').webuiPassword;

                // Include history for dashboard (single API call optimization)
                const url = '/account-limits?includeHistory=true';
                const { response, newPassword } = await window.utils.request(url, {}, password);

                if (newPassword) Alpine.store('global').webuiPassword = newPassword;

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                this.accounts = data.accounts || [];
                if (data.models && data.models.length > 0) {
                    this.models = data.models;
                }
                this.modelConfig = data.modelConfig || {};

                // Store usage history if included (for dashboard)
                if (data.history) {
                    this.usageHistory = data.history;
                }

                this.saveToCache(); // Save fresh data
                this.computeQuotaRows();

                this.lastUpdated = new Date().toLocaleTimeString();
            } catch (error) {
                console.error('Fetch error:', error);
                const store = Alpine.store('global');
                store.showToast(store.t('connectionLost'), 'error');
            } finally {
                this.loading = false;
                this.initialLoad = false; // Mark initial load as complete
            }
        },

        async fetchVersion(password) {
            try {
                const { response } = await window.utils.request('/api/config', {}, password);
                if (response.ok) {
                    const data = await response.json();
                    if (data.version) {
                        Alpine.store('global').version = data.version;
                    }
                    // Store maxAccounts from config
                    if (data.config && typeof data.config.maxAccounts === 'number') {
                        this.maxAccounts = data.config.maxAccounts;
                    }
                }
            } catch (error) {
                console.warn('Failed to fetch version:', error);
            }
        },

        async performHealthCheck() {
            try {
                // Get password from global store
                const password = Alpine.store('global').webuiPassword;
                
                // Use lightweight endpoint (no quota fetching)
                const { response, newPassword } = await window.utils.request('/api/config', {}, password);
                
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                
                if (response.ok) {
                    this.connectionStatus = 'connected';
                } else {
                    this.connectionStatus = 'disconnected';
                }
            } catch (error) {
                console.error('Health check error:', error);
                this.connectionStatus = 'disconnected';
            }
        },

        startHealthCheck() {
            // Clear existing timer
            if (this.healthCheckTimer) {
                clearInterval(this.healthCheckTimer);
            }

            // Setup visibility change listener (only once)
            if (!this._healthVisibilitySetup) {
                this._healthVisibilitySetup = true;
                this._visibilityHandler = () => {
                    if (document.hidden) {
                        // Tab hidden - stop health checks
                        this.stopHealthCheck();
                    } else {
                        // Tab visible - restart health checks
                        this.startHealthCheck();
                    }
                };
                document.addEventListener('visibilitychange', this._visibilityHandler);
            }

            // Perform immediate health check
            this.performHealthCheck();

            // Schedule regular health checks every 15 seconds
            this.healthCheckTimer = setInterval(() => {
                // Only perform health check if tab is visible
                if (!document.hidden) {
                    this.performHealthCheck();
                }
            }, 15000);
        },

        stopHealthCheck() {
            if (this.healthCheckTimer) {
                clearInterval(this.healthCheckTimer);
                this.healthCheckTimer = null;
            }
        },

        computeQuotaRows() {
            const models = this.models || [];
            const rows = [];
            const showExhausted = Alpine.store('settings')?.showExhausted ?? true;

            models.forEach(modelId => {
                // Config
                const config = this.modelConfig[modelId] || {};
                const family = this.getModelFamily(modelId);

                // Visibility Logic for Models Page (quotaRows):
                // 1. If explicitly hidden via config, ALWAYS hide (clean interface)
                // 2. If no config, default 'unknown' families to HIDDEN
                // 3. Known families (Claude/Gemini) default to VISIBLE
                // Note: To manage hidden models, use Settings → Models tab
                let isHidden = config.hidden;
                if (isHidden === undefined) {
                    isHidden = (family === 'other' || family === 'unknown');
                }

                // Models Page: Check settings for visibility
                const showHidden = Alpine.store('settings')?.showHiddenModels ?? false;
                if (isHidden && !showHidden) return;

                // Filters
                if (this.filters.family !== 'all' && this.filters.family !== family) return;
                if (this.filters.search) {
                    const searchLower = this.filters.search.toLowerCase();
                    const idMatch = modelId.toLowerCase().includes(searchLower);
                    if (!idMatch) return;
                }

                // Data Collection
                const quotaInfo = [];
                let minQuota = 100;
                let totalQuotaSum = 0;
                let validAccountCount = 0;
                let minResetTime = null;

                this.accounts.forEach(acc => {
                    if (this.filters.account !== 'all' && acc.email !== this.filters.account) return;

                    const limit = acc.limits?.[modelId];
                    if (!limit) return;

                    const pct = limit.remainingFraction !== null ? Math.round(limit.remainingFraction * 100) : 0;
                    minQuota = Math.min(minQuota, pct);

                    // Accumulate for average
                    totalQuotaSum += pct;
                    validAccountCount++;

                    if (limit.resetTime && (!minResetTime || new Date(limit.resetTime) < new Date(minResetTime))) {
                        minResetTime = limit.resetTime;
                    }

                    quotaInfo.push({
                        email: acc.email.split('@')[0],
                        fullEmail: acc.email,
                        pct: pct,
                        resetTime: limit.resetTime
                    });
                });

                if (quotaInfo.length === 0) return;
                const avgQuota = validAccountCount > 0 ? Math.round(totalQuotaSum / validAccountCount) : 0;

                if (!showExhausted && minQuota === 0) return;

                rows.push({
                    modelId,
                    displayName: modelId, // Simplified: no longer using alias
                    family,
                    minQuota,
                    avgQuota, // Added Average Quota
                    minResetTime,
                    resetIn: minResetTime ? window.utils.formatTimeUntil(minResetTime) : '-',
                    quotaInfo,
                    pinned: !!config.pinned,
                    hidden: !!isHidden, // Use computed visibility
                    activeCount: quotaInfo.filter(q => q.pct > 0).length
                });
            });

            // Sort: Pinned first, then by selected column
            const sortCol = this.filters.sortCol;
            const sortAsc = this.filters.sortAsc;

            this.quotaRows = rows.sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                
                let valA = a[sortCol];
                let valB = b[sortCol];

                // Handle nulls (always push to bottom)
                if (valA === valB) return 0;
                if (valA === null || valA === undefined) return 1;
                if (valB === null || valB === undefined) return -1;

                if (typeof valA === 'string' && typeof valB === 'string') {
                    return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                }

                return sortAsc ? valA - valB : valB - valA;
            });

            // Trigger Dashboard Update if active
            // Ideally dashboard watches this store.
        },

        setSort(col) {
            if (this.filters.sortCol === col) {
                this.filters.sortAsc = !this.filters.sortAsc;
            } else {
                this.filters.sortCol = col;
                // Default sort direction: Descending for numbers/stats, Ascending for text/time
                if (['avgQuota', 'activeCount'].includes(col)) {
                    this.filters.sortAsc = false;
                } else {
                    this.filters.sortAsc = true;
                }
            }
            this.computeQuotaRows();
        },

        getModelFamily(modelId) {
            const lower = modelId.toLowerCase();
            if (lower.includes('claude')) return 'claude';
            if (lower.includes('gemini')) return 'gemini';
            return 'other';
        },

        /**
         * Get quota data without filters applied (for Dashboard global charts)
         * Returns array of { modelId, family, quotaInfo: [{pct}] }
         */
        getUnfilteredQuotaData() {
            const models = this.models || [];
            const rows = [];
            const showHidden = Alpine.store('settings')?.showHiddenModels ?? false;

            models.forEach(modelId => {
                const config = this.modelConfig[modelId] || {};
                const family = this.getModelFamily(modelId);

                // Smart visibility (same logic as computeQuotaRows)
                let isHidden = config.hidden;
                if (isHidden === undefined) {
                    isHidden = (family === 'other' || family === 'unknown');
                }
                if (isHidden && !showHidden) return;

                const quotaInfo = [];
                // Use ALL accounts (no account filter)
                this.accounts.forEach(acc => {
                    const limit = acc.limits?.[modelId];
                    if (!limit) return;
                    const pct = limit.remainingFraction !== null ? Math.round(limit.remainingFraction * 100) : 0;
                    quotaInfo.push({ pct });
                });

                // treat missing quotaInfo as 0%/unknown; still include row
                rows.push({ modelId, family, quotaInfo });
            });

            return rows;
        }
    });
});
