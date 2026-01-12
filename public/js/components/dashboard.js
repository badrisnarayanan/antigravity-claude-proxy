/**
 * Dashboard Component (Refactored)
 * Orchestrates stats, charts, and filters modules
 * Registers itself to window.Components for Alpine.js to consume
 *
 * Performance optimizations:
 * - Consolidated watchers with debounced refresh to prevent redundant updates
 * - Single unified update path for all data changes
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

    // Filter state (from module)
    ...window.DashboardFilters.getInitialState(),

    // Debounced update functions to prevent rapid successive updates
    _debouncedRefresh: null,
    _refreshScheduled: false,

    init() {
        // Create debounced refresh function (consolidates all update logic)
        this._debouncedRefresh = window.utils.debounce(() => {
            this._performRefresh();
        }, 100);

        // Load saved preferences from localStorage
        window.DashboardFilters.loadPreferences(this);

        // Single consolidated watcher for tab activation
        this.$watch('$store.global.activeTab', (val, oldVal) => {
            if (val === 'dashboard' && oldVal !== undefined) {
                this._scheduleRefresh();
            }
        });

        // Consolidated watcher for data changes - only refresh if on dashboard tab
        this.$watch('$store.data.accounts', () => {
            if (this.$store.global.activeTab === 'dashboard') {
                this._scheduleRefresh();
            }
        });

        // Watch for history updates - merge with main refresh cycle
        this.$watch('$store.data.usageHistory', (newHistory) => {
            if (newHistory && Object.keys(newHistory).length > 0) {
                this.historyData = newHistory;
                if (this.$store.global.activeTab === 'dashboard') {
                    this._scheduleRefresh();
                }
            }
        });

        // Initial update if already on dashboard
        if (this.$store.global.activeTab === 'dashboard') {
            this.$nextTick(() => {
                // Load history if already in store
                const history = Alpine.store('data').usageHistory;
                if (history && Object.keys(history).length > 0) {
                    this.historyData = history;
                }
                this._performRefresh();
            });
        }
    },

    /**
     * Schedule a debounced refresh - prevents multiple rapid updates
     */
    _scheduleRefresh() {
        if (this._debouncedRefresh) {
            this._debouncedRefresh();
        }
    },

    /**
     * Perform the actual refresh - updates all dashboard components in optimal order
     */
    _performRefresh() {
        // Update stats first (fastest, needed for display)
        this.updateStats();

        // Process history if available (needed for trend chart)
        if (this.historyData && Object.keys(this.historyData).length > 0) {
            this.processHistory(this.historyData);
            this.stats.hasTrendData = true;
        }

        // Update charts after DOM settles
        this.$nextTick(() => {
            window.DashboardCharts.updateCharts(this);
            window.DashboardCharts.updateTrendChart(this);
        });
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
        window.DashboardCharts.updateTrendChart(this);
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
    }
});
