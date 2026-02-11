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
        globalQuotaThreshold: 0, // Global minimum quota threshold (fraction 0-0.99)
        maxAccounts: 10, // Maximum number of accounts allowed (from config)
        devMode: false, // Developer mode flag (from server config)
        placeholderMode: false, // Inject placeholder account data for UI testing
        placeholderIncludeReal: true, // Include real accounts alongside placeholder data
        _realAccounts: null, // Stash for real accounts when placeholder mode is on
        _realModels: null, // Stash for real models when placeholder mode is on
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

            // Restore placeholder mode from persisted settings
            // Read localStorage directly since settings store may not be initialized yet
            try {
                const saved = JSON.parse(localStorage.getItem('antigravity_settings') || '{}');
                if (saved.placeholderMode) {
                    this.setPlaceholderMode(true, saved.placeholderIncludeReal !== false);
                }
            } catch (e) { /* ignore parse errors */ }

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
                        if (window.UILogger) window.UILogger.debug('Cache expired, skipping restoration');
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
                        if (window.UILogger) window.UILogger.debug('Restored data from cache');
                    }
                }
            } catch (e) {
                if (window.UILogger) window.UILogger.debug('Failed to load cache', e.message);
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
                if (window.UILogger) window.UILogger.debug('Failed to save cache', e.message);
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
                this.globalQuotaThreshold = data.globalQuotaThreshold || 0;

                // Store usage history if included (for dashboard)
                if (data.history) {
                    this.usageHistory = data.history;
                }

                this.saveToCache(); // Save fresh data

                // Re-inject placeholder data if active
                if (this.placeholderMode) {
                    this._realAccounts = [...this.accounts];
                    this._realModels = [...this.models];
                    const { accounts: fakeAccounts, models: fakeModels } = this._generatePlaceholderData();
                    if (this.placeholderIncludeReal) {
                        this.accounts = [...this._realAccounts, ...fakeAccounts];
                        const modelSet = new Set([...this._realModels, ...fakeModels]);
                        this.models = Array.from(modelSet).sort();
                    } else {
                        this.accounts = fakeAccounts;
                        this.models = fakeModels;
                    }
                }

                this.computeQuotaRows();

                this.lastUpdated = new Date().toLocaleTimeString();
            } catch (error) {
                // Keep error logging for actual fetch failures
                console.error('Fetch error:', error);
                const store = Alpine.store('global');
                store.showToast(store.t('connectionLost'), 'error');
            } finally {
                this.loading = false;
                this.initialLoad = false; // Mark initial load as complete
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
                    // Update devMode from server config
                    try {
                        const data = await response.json();
                        if (data.config) {
                            this.devMode = !!data.config.devMode;
                        }
                    } catch (e) { /* ignore parse errors */ }
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
                let maxEffectiveThreshold = 0;
                const globalThreshold = this.globalQuotaThreshold || 0;

                this.accounts.forEach(acc => {
                    if (acc.enabled === false) return;
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

                    // Resolve effective threshold: per-model > per-account > global
                    const accModelThreshold = acc.modelQuotaThresholds?.[modelId];
                    const accThreshold = acc.quotaThreshold;
                    const effective = accModelThreshold ?? accThreshold ?? globalThreshold;
                    if (effective > maxEffectiveThreshold) {
                        maxEffectiveThreshold = effective;
                    }

                    // Determine threshold source for display
                    let thresholdSource = 'global';
                    if (accModelThreshold !== undefined) thresholdSource = 'model';
                    else if (accThreshold !== undefined) thresholdSource = 'account';

                    quotaInfo.push({
                        email: acc.email.split('@')[0],
                        fullEmail: acc.email,
                        pct: pct,
                        resetTime: limit.resetTime,
                        thresholdPct: Math.round(effective * 100),
                        thresholdSource
                    });
                });

                if (quotaInfo.length === 0) return;
                const avgQuota = validAccountCount > 0 ? Math.round(totalQuotaSum / validAccountCount) : 0;

                if (!showExhausted && minQuota === 0) return;

                // Check if thresholds vary across accounts
                const uniqueThresholds = new Set(quotaInfo.map(q => q.thresholdPct));
                const hasVariedThresholds = uniqueThresholds.size > 1;

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
                    activeCount: quotaInfo.filter(q => q.pct > 0).length,
                    effectiveThresholdPct: Math.round(maxEffectiveThreshold * 100),
                    hasVariedThresholds
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
                    if (acc.enabled === false) return;
                    const limit = acc.limits?.[modelId];
                    if (!limit) return;
                    const pct = limit.remainingFraction !== null ? Math.round(limit.remainingFraction * 100) : 0;
                    quotaInfo.push({ pct });
                });

                // treat missing quotaInfo as 0%/unknown; still include row
                rows.push({ modelId, family, quotaInfo });
            });

            return rows;
        },

        /**
         * Generate placeholder account and model data for UI testing
         */
        _generatePlaceholderData() {
            const models = [
                'claude-opus-4-6-thinking',
                'claude-sonnet-4-5-thinking',
                'claude-sonnet-4-5',
                'gemini-3-pro-high',
                'gemini-3-pro-low',
                'gemini-3-flash'
            ];

            const tiers = ['ultra', 'pro', 'pro', 'free'];
            const names = ['alice', 'bob', 'charlie', 'diana'];
            const domains = ['workspace.dev', 'company.io', 'example.org', 'test.net'];

            const accounts = names.map((name, i) => {
                const email = `${name}@${domains[i]}`;
                const tier = tiers[i];

                // Generate varied quota per model per account
                const limits = {};
                models.forEach((modelId, mi) => {
                    // Create a deterministic but varied fraction
                    const seed = ((i * 7 + mi * 13) % 100);
                    const fraction = seed < 10 ? 0 : seed / 100;
                    const resetTime = fraction === 0
                        ? new Date(Date.now() + (30 + i * 15) * 60000).toISOString()
                        : null;
                    limits[modelId] = {
                        remaining: Math.round(fraction * 100) + '%',
                        remainingFraction: fraction,
                        resetTime
                    };
                });

                return {
                    email,
                    status: i === 3 ? 'invalid' : 'ok',
                    error: i === 3 ? 'Token expired' : null,
                    source: i === 0 ? 'database' : 'oauth',
                    enabled: i !== 2 ? true : false,
                    projectId: `proj-${name}-${1000 + i}`,
                    isInvalid: i === 3,
                    invalidReason: i === 3 ? 'Token expired' : null,
                    lastUsed: new Date(Date.now() - i * 3600000).toISOString(),
                    modelRateLimits: {},
                    quotaThreshold: i === 1 ? 0.15 : undefined,
                    modelQuotaThresholds: i === 0 ? { 'claude-opus-4-6-thinking': 0.25 } : {},
                    subscription: { tier, projectId: `proj-${name}-${1000 + i}`, detectedAt: Date.now() },
                    limits
                };
            });

            return { accounts, models };
        },

        /**
         * Enable or disable placeholder data injection
         */
        setPlaceholderMode(enabled, includeReal) {
            this.placeholderMode = enabled;
            this.placeholderIncludeReal = includeReal;

            // Persist to settings store
            const settings = Alpine.store('settings');
            if (settings) {
                settings.placeholderMode = enabled;
                settings.placeholderIncludeReal = includeReal;
                settings.saveSettings(true);
            }

            if (enabled) {
                // Stash real data
                this._realAccounts = [...this.accounts];
                this._realModels = [...this.models];

                const { accounts: fakeAccounts, models: fakeModels } = this._generatePlaceholderData();

                if (includeReal && this._realAccounts.length > 0) {
                    // Merge: real accounts first, then placeholders
                    this.accounts = [...this._realAccounts, ...fakeAccounts];
                    // Union of models
                    const modelSet = new Set([...this._realModels, ...fakeModels]);
                    this.models = Array.from(modelSet).sort();
                } else {
                    this.accounts = fakeAccounts;
                    this.models = fakeModels;
                }
            } else {
                // Restore real data
                if (this._realAccounts !== null) {
                    this.accounts = this._realAccounts;
                    this._realAccounts = null;
                }
                if (this._realModels !== null) {
                    this.models = this._realModels;
                    this._realModels = null;
                }
            }

            this.computeQuotaRows();
        }
    });
});
