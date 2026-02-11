/**
 * Dashboard Component (Refactored)
 * Orchestrates stats, charts, and filters modules
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.dashboard = () => ({
    // Core state
    stats: { total: 0, active: 0, limited: 0, overallHealth: 0, hasTrendData: false },
    hasFilteredTrendData: true,
    charts: { quotaDistribution: null, usageTrend: null },
    usageStats: { total: 0, today: 0, thisHour: 0 },
    historyData: {},
    modelTree: {},
    families: [],

    // Claude config status
    claudeConfigStatus: {
        needsApply: false,
        presetName: '',
        checked: false,
        lastCheckedAt: 0
    },

    // Filter state (from module)
    ...window.DashboardFilters.getInitialState(),

    // Debounced chart update to prevent rapid successive updates
    _debouncedUpdateTrendChart: null,

    init() {
        // Create debounced version of updateTrendChart (300ms delay for stability)
        this._debouncedUpdateTrendChart = window.utils.debounce(() => {
            window.DashboardCharts.updateTrendChart(this);
        }, 300);

        // Load saved preferences from localStorage
        window.DashboardFilters.loadPreferences(this);

        // Check Claude config status on init
        this.checkClaudeConfigStatus();

        // Update stats when dashboard becomes active (skip initial trigger)
        this.$watch('$store.global.activeTab', (val, oldVal) => {
            if (val === 'dashboard' && oldVal !== undefined) {
                this.$nextTick(() => {
                    this.updateStats();
                    this.updateCharts();
                    this.updateTrendChart();
                    this.checkClaudeConfigStatus();
                });
            }
        });

        // Watch for data changes
        this.$watch('$store.data.accounts', () => {
            if (this.$store.global.activeTab === 'dashboard') {
                this.updateStats();
                // Debounce chart updates to prevent rapid flickering
                if (this._debouncedUpdateCharts) {
                    this._debouncedUpdateCharts();
                } else {
                    this._debouncedUpdateCharts = window.utils.debounce(() => this.updateCharts(), 100);
                    this._debouncedUpdateCharts();
                }
            }
        });

        // Watch for history updates from data-store (automatically loaded with account data)
        this.$watch('$store.data.usageHistory', (newHistory) => {
            if (this.$store.global.activeTab === 'dashboard' && newHistory && Object.keys(newHistory).length > 0) {
                // Optimization: Skip if data hasn't changed (prevents double render on load)
                if (this.historyData && JSON.stringify(newHistory) === JSON.stringify(this.historyData)) {
                    return;
                }

                this.historyData = newHistory;
                this.processHistory(newHistory);
                this.stats.hasTrendData = true;
            }
        });

        // Initial update if already on dashboard
        // Note: Alpine.store('data') may already have data from cache if initialized before this component
        if (this.$store.global.activeTab === 'dashboard') {
            this.$nextTick(() => {
                this.updateStats();
                this.updateCharts();

                // Optimization: Only process history if it hasn't been processed yet
                // The usageHistory watcher above will handle updates if data changes
                const history = Alpine.store('data').usageHistory;
                if (history && Object.keys(history).length > 0) {
                    // Check if we already have this data to avoid redundant chart update
                    if (!this.historyData || JSON.stringify(history) !== JSON.stringify(this.historyData)) {
                        this.historyData = history;
                        this.processHistory(history);
                        this.stats.hasTrendData = true;
                    }
                }
            });
        }
    },

    processHistory(history) {
        // Build model tree from hierarchical data
        const tree = {};
        let total = 0, today = 0, thisHour = 0;

        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const currentHour = new Date(now);
        currentHour.setMinutes(0, 0, 0);

        Object.entries(history).forEach(([iso, hourData]) => {
            const timestamp = new Date(iso);

            // Process each family in the hour data
            Object.entries(hourData).forEach(([key, value]) => {
                // Skip metadata keys
                if (key === '_total' || key === 'total') return;

                // Handle hierarchical format: { claude: { "opus-4-5": 10, "_subtotal": 10 } }
                if (typeof value === 'object' && value !== null) {
                    if (!tree[key]) tree[key] = new Set();

                    Object.keys(value).forEach(modelName => {
                        if (modelName !== '_subtotal') {
                            tree[key].add(modelName);
                        }
                    });
                }
            });

            // Calculate totals
            const hourTotal = hourData._total || hourData.total || 0;
            total += hourTotal;

            if (timestamp >= todayStart) {
                today += hourTotal;
            }
            if (timestamp.getTime() === currentHour.getTime()) {
                thisHour = hourTotal;
            }
        });

        this.usageStats = { total, today, thisHour };

        // Convert Sets to sorted arrays
        this.modelTree = {};
        Object.entries(tree).forEach(([family, models]) => {
            this.modelTree[family] = Array.from(models).sort();
        });
        this.families = Object.keys(this.modelTree).sort();

        // Auto-select new families/models that haven't been configured
        this.autoSelectNew();

        this.updateTrendChart();
    },

    // Delegation methods for stats
    updateStats() {
        window.DashboardStats.updateStats(this);
    },

    // Delegation methods for charts
    updateCharts() {
        window.DashboardCharts.updateCharts(this);
    },

    updateTrendChart() {
        // Use debounced version to prevent rapid successive updates
        if (this._debouncedUpdateTrendChart) {
            this._debouncedUpdateTrendChart();
        } else {
            // Fallback if debounced version not initialized
            window.DashboardCharts.updateTrendChart(this);
        }
    },

    // Delegation methods for filters
    loadPreferences() {
        window.DashboardFilters.loadPreferences(this);
    },

    savePreferences() {
        window.DashboardFilters.savePreferences(this);
    },

    setDisplayMode(mode) {
        window.DashboardFilters.setDisplayMode(this, mode);
    },

    setTimeRange(range) {
        window.DashboardFilters.setTimeRange(this, range);
    },

    getTimeRangeLabel() {
        return window.DashboardFilters.getTimeRangeLabel(this);
    },

    toggleFamily(family) {
        window.DashboardFilters.toggleFamily(this, family);
    },

    toggleModel(family, model) {
        window.DashboardFilters.toggleModel(this, family, model);
    },

    isFamilySelected(family) {
        return window.DashboardFilters.isFamilySelected(this, family);
    },

    isModelSelected(family, model) {
        return window.DashboardFilters.isModelSelected(this, family, model);
    },

    selectAll() {
        window.DashboardFilters.selectAll(this);
    },

    deselectAll() {
        window.DashboardFilters.deselectAll(this);
    },

    getFamilyColor(family) {
        return window.DashboardFilters.getFamilyColor(family);
    },

    getModelColor(family, modelIndex) {
        return window.DashboardFilters.getModelColor(family, modelIndex);
    },

    getSelectedCount() {
        return window.DashboardFilters.getSelectedCount(this);
    },

    autoSelectNew() {
        window.DashboardFilters.autoSelectNew(this);
    },

    autoSelectTopN(n = 5) {
        window.DashboardFilters.autoSelectTopN(this, n);
    },

    /**
     * Check if Claude CLI config needs to be updated.
     * Fetches both local config and presets, then compares against all presets.
     * Skips if already checked within the last 30 seconds.
     */
    async checkClaudeConfigStatus() {
        const now = Date.now();
        if (this.claudeConfigStatus.checked && now - this.claudeConfigStatus.lastCheckedAt < 30000) return;

        try {
            const password = Alpine.store('global').webuiPassword;

            const [configRes, presetsRes] = await Promise.all([
                window.utils.request('/api/claude/config', {}, password),
                window.utils.request('/api/claude/presets', {}, password)
            ]);

            if (!configRes.response.ok || !presetsRes.response.ok) {
                this.claudeConfigStatus.checked = true;
                this.claudeConfigStatus.lastCheckedAt = now;
                return;
            }

            const configData = await configRes.response.json();
            const presetsData = await presetsRes.response.json();

            const localConfig = configData.config || { env: {} };
            const presets = presetsData.presets || [];

            if (presets.length === 0) {
                this.claudeConfigStatus = { needsApply: false, presetName: '', checked: true, lastCheckedAt: now };
                return;
            }

            const relevantKeys = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_MODEL',
                'CLAUDE_CODE_SUBAGENT_MODEL',
                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'ENABLE_EXPERIMENTAL_MCP_CLI'
            ];

            // Check if local config matches ANY preset
            const matchesAnyPreset = presets.some(preset => {
                return relevantKeys.every(key => {
                    const localVal = localConfig.env?.[key] || '';
                    const presetVal = preset.config?.[key] || '';
                    return localVal === presetVal;
                });
            });

            this.claudeConfigStatus = {
                needsApply: !matchesAnyPreset,
                presetName: presets[0].name,
                checked: true,
                lastCheckedAt: now
            };
        } catch (e) {
            console.error('Failed to check Claude config status:', e);
            this.claudeConfigStatus.checked = true;
            this.claudeConfigStatus.lastCheckedAt = Date.now();
        }
    },

    /**
     * Navigate to Claude CLI settings and dismiss the warning
     */
    goToClaudeSettings() {
        this.$store.global.activeTab = 'settings';
        this.$store.global.settingsTab = 'claude';
    }
});
