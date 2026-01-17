/**
 * Logs Viewer Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.logsViewer = () => ({
    logs: [],
    isAutoScroll: true,
    onlyProblems: false,      // Only show errors/warnings
    logEventSource: null,    // Original logger stream
    eventEventSource: null,  // New structured event stream
    searchQuery: '',
    expandedLogs: new Set(), // Track expanded log IDs

    // Time range filter
    timeRange: '1h',  // Default: 1 hour
    timeRangeOptions: [
        { value: '1h', label: '1 Hour', ms: 60 * 60 * 1000 },
        { value: '6h', label: '6 Hours', ms: 6 * 60 * 60 * 1000 },
        { value: '12h', label: '12 Hours', ms: 12 * 60 * 60 * 1000 },
        { value: '24h', label: '24 Hours', ms: 24 * 60 * 60 * 1000 },
        { value: '7d', label: '7 Days', ms: 7 * 24 * 60 * 60 * 1000 },
        { value: 'all', label: 'All', ms: null }
    ],

    // Get current time range in milliseconds (null = all)
    get timeRangeMs() {
        const option = this.timeRangeOptions.find(o => o.value === this.timeRange);
        return option?.ms || null;
    },

    // Get display label for current time range
    get timeRangeLabel() {
        const option = this.timeRangeOptions.find(o => o.value === this.timeRange);
        return option?.label || 'All';
    },

    // Summary stats for selected time range
    summary: {
        activeIssues: 0,
        rateLimits: 0,
        authFailures: 0,
        errors: 0
    },

    // Filters
    filters: {
        // Levels
        INFO: true,
        WARN: true,
        ERROR: true,
        SUCCESS: true,
        DEBUG: false,

        // Event Types (for structured events)
        request: true,
        rate_limit: true,
        auth_failure: true,
        fallback: true,
        account_switch: true,
        health_change: true,
        system: true
    },

    get filteredLogs() {
        const query = this.searchQuery.trim();
        let matcher = null;

        if (query) {
            // Try regex first, fallback to plain text search
            try {
                const regex = new RegExp(query, 'i');
                matcher = (log) => {
                    if (log.message && regex.test(log.message)) return true;
                    if (log.details && regex.test(JSON.stringify(log.details))) return true;
                    return false;
                };
            } catch (e) {
                // Invalid regex, fallback to case-insensitive string search
                const lowerQuery = query.toLowerCase();
                matcher = (log) => {
                    if (log.message && log.message.toLowerCase().includes(lowerQuery)) return true;
                    if (log.details && JSON.stringify(log.details).toLowerCase().includes(lowerQuery)) return true;
                    return false;
                };
            }
        }

        return this.logs.filter(log => {
            // Time Range Filter (apply first for performance)
            if (this.timeRangeMs) {
                const logTime = new Date(log.timestamp).getTime();
                const cutoff = Date.now() - this.timeRangeMs;
                if (logTime < cutoff) return false;
            }

            // Level Filter (Backward compatibility + new severity mapping)
            const level = (log.level || log.severity || 'INFO').toUpperCase();

            // Problem-only mode: Show only WARN, ERROR, and critical event types
            if (this.onlyProblems) {
                const isProblemLevel = level === 'ERROR' || level === 'WARN';
                const isProblemType = ['rate_limit', 'auth_failure', 'fallback', 'health_change'].includes(log.type);
                if (!isProblemLevel && !isProblemType) return false;
            } else {
                // Standard level filter
                if (this.filters[level] === false) return false;

                // Type Filter - apply to all logs with a type
                const logType = log.type || 'system';
                if (this.filters[logType] === false) return false;
            }

            // Search Filter
            if (matcher && !matcher(log)) return false;

            return true;
        });
    },

    init() {
        this.startLogStreams();

        this.$watch('isAutoScroll', (val) => {
            if (val) this.scrollToBottom();
        });

        // Watch logs to update summary
        this.$watch('logs', () => this.updateSummary());

        // Listen for issue updates from issue-banner component
        window.addEventListener('issues-updated', (e) => {
            if (e.detail && typeof e.detail.count === 'number') {
                this.summary.activeIssues = e.detail.count;
            }
        });

        // Watch filters to maintain auto-scroll if enabled
        this.$watch('searchQuery', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
        this.$watch('filters', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
        this.$watch('onlyProblems', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
        this.$watch('timeRange', () => {
            this.updateSummary();
            if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom());
        });
    },

    updateSummary() {
        const now = Date.now();

        // Use selected time range (or all if null)
        let recentLogs;
        if (this.timeRangeMs) {
            const cutoff = now - this.timeRangeMs;
            recentLogs = this.logs.filter(l => new Date(l.timestamp).getTime() > cutoff);
        } else {
            recentLogs = this.logs;
        }

        this.summary.rateLimits = recentLogs.filter(l => l.type === 'rate_limit').length;
        this.summary.authFailures = recentLogs.filter(l => l.type === 'auth_failure').length;
        this.summary.errors = recentLogs.filter(l => l.level === 'ERROR').length;
    },

    toggleProblemOnly() {
        this.onlyProblems = !this.onlyProblems;
    },

    // Show active issues mode (resets filters first to avoid confusion)
    showActiveIssues() {
        // Reset filters to default without going through resetFilters()
        // (which would set onlyProblems = false)
        const defaults = this._defaultFilters;
        Object.keys(defaults).forEach(k => {
            this.filters[k] = defaults[k];
        });
        // Enable problems-only mode
        this.onlyProblems = true;
    },

    goToDashboard() {
        Alpine.store('global').activeTab = 'dashboard';
    },

    quickFilter(type) {
        // Reset problem only mode when doing specific type filter
        this.onlyProblems = false;

        // Enable all levels so we see the filtered type regardless of severity
        this.filters.INFO = true;
        this.filters.WARN = true;
        this.filters.ERROR = true;
        this.filters.SUCCESS = true;
        // Keep DEBUG as-is (usually off)

        // Reset all types to false, then enable the specific one
        Object.keys(this.filters).forEach(k => {
            if (['request', 'rate_limit', 'auth_failure', 'fallback', 'account_switch', 'health_change', 'system'].includes(k)) {
                this.filters[k] = (k === type);
            }
        });
    },

    // Quick filter by log level (e.g., only show ERROR)
    quickFilterLevel(level) {
        this.onlyProblems = false;

        // Disable all levels except the target
        this.filters.INFO = (level === 'INFO');
        this.filters.WARN = (level === 'WARN');
        this.filters.ERROR = (level === 'ERROR');
        this.filters.SUCCESS = (level === 'SUCCESS');
        this.filters.DEBUG = (level === 'DEBUG');

        // Enable all event types
        ['request', 'rate_limit', 'auth_failure', 'fallback', 'account_switch', 'health_change', 'system'].forEach(k => {
            this.filters[k] = true;
        });
    },

    // Default filter state for comparison
    _defaultFilters: {
        INFO: true, WARN: true, ERROR: true, SUCCESS: true, DEBUG: false,
        request: true, rate_limit: true, auth_failure: true, fallback: true,
        account_switch: true, health_change: true, system: true
    },

    // Check if filters differ from default
    hasActiveFilters() {
        const defaults = this._defaultFilters;
        return Object.keys(defaults).some(k => this.filters[k] !== defaults[k]);
    },

    // Enable all filters
    selectAllFilters() {
        this.onlyProblems = false;
        Object.keys(this.filters).forEach(k => {
            this.filters[k] = true;
        });
    },

    // Disable all filters (show nothing)
    selectNoFilters() {
        this.onlyProblems = false;
        Object.keys(this.filters).forEach(k => {
            this.filters[k] = false;
        });
    },

    // Reset to default filter state
    resetFilters() {
        this.onlyProblems = false;
        const defaults = this._defaultFilters;
        Object.keys(defaults).forEach(k => {
            this.filters[k] = defaults[k];
        });
    },

    // Toggle all severity levels
    toggleAllLevels() {
        const levels = ['INFO', 'WARN', 'ERROR', 'SUCCESS', 'DEBUG'];
        const allEnabled = levels.every(l => this.filters[l]);
        levels.forEach(l => {
            this.filters[l] = !allEnabled;
        });
    },

    // Toggle all event types
    toggleAllTypes() {
        const types = ['request', 'rate_limit', 'auth_failure', 'fallback', 'account_switch', 'health_change', 'system'];
        const allEnabled = types.every(t => this.filters[t]);
        types.forEach(t => {
            this.filters[t] = !allEnabled;
        });
    },

    startLogStreams() {
        // Close existing connections
        if (this.logEventSource) this.logEventSource.close();
        if (this.eventEventSource) this.eventEventSource.close();

        const store = Alpine.store('global');
        const historyLimit = Alpine.store('settings')?.logLimit || window.AppConstants.LIMITS.DEFAULT_LOG_LIMIT;

        // 1. Original logger stream (for regular server logs)
        let logUrl = '/api/logs/stream?history=true';
        if (store.webuiPassword) {
            logUrl += `&password=${encodeURIComponent(store.webuiPassword)}`;
        }

        this.logEventSource = new EventSource(logUrl);
        this.logEventSource.onmessage = (event) => {
            this.handleLogMessage(event.data, 'logger');
        };
        this.logEventSource.onerror = () => {
            console.warn('Logger stream disconnected, reconnecting...');
            this.logEventSource.close();
            setTimeout(() => this.startLogStreams(), 3000);
        };

        // 2. New structured event stream (for rate_limit, auth_failure, fallback, etc.)
        let eventUrl = `/api/events/stream?history=true&limit=${historyLimit}`;
        if (store.webuiPassword) {
            eventUrl += `&password=${encodeURIComponent(store.webuiPassword)}`;
        }

        this.eventEventSource = new EventSource(eventUrl);
        this.eventEventSource.onmessage = (event) => {
            this.handleLogMessage(event.data, 'event');
        };
        this.eventEventSource.onerror = () => {
            console.warn('Event stream disconnected, reconnecting...');
            this.eventEventSource.close();
            // Don't reconnect here, will reconnect with logger stream
        };
    },

    handleLogMessage(data, source) {
        try {
            const parsed = JSON.parse(data);

            // Handle both single event and array (history)
            const newLogs = Array.isArray(parsed) ? parsed : [parsed];

            // Map/Normalize logs
            const processedLogs = newLogs.map(log => ({
                ...log,
                // Ensure timestamp is a Date object or string
                timestamp: log.timestamp || new Date().toISOString(),
                // Map severity to level if missing
                level: (log.level || log.severity || 'INFO').toUpperCase(),
                // Ensure type exists (use 'system' for regular logs)
                type: log.type || 'system',
                // Mark the source
                _source: source,
                // Generate a temp ID if missing for UI keys
                _ui_id: log.id || `${source}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
            }));

            // Filter out 'connected' system messages from event stream
            const filteredLogs = processedLogs.filter(log =>
                !(log.type === 'connected' && log._source === 'event')
            );

            if (filteredLogs.length === 0) return;

            this.logs.push(...filteredLogs);

            // Sort by timestamp to interleave both streams properly
            this.logs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Limit log buffer
            const limit = Alpine.store('settings')?.logLimit || window.AppConstants.LIMITS.DEFAULT_LOG_LIMIT;
            if (this.logs.length > limit) {
                this.logs = this.logs.slice(-limit);
            }

            if (this.isAutoScroll) {
                this.$nextTick(() => this.scrollToBottom());
            }
        } catch (e) {
            console.error('Log parse error:', e);
        }
    },

    scrollToBottom() {
        const container = document.getElementById('logs-container');
        if (container) container.scrollTop = container.scrollHeight;
    },

    clearLogs() {
        this.logs = [];
        this.expandedLogs.clear();
    },

    toggleDetails(log) {
        if (this.expandedLogs.has(log._ui_id)) {
            this.expandedLogs.delete(log._ui_id);
        } else {
            this.expandedLogs.add(log._ui_id);
        }
        // Force reactivity for Set
        this.expandedLogs = new Set(this.expandedLogs);
    },

    isExpanded(log) {
        return this.expandedLogs.has(log._ui_id);
    },

    formatDetails(details) {
        try {
            return JSON.stringify(details, null, 2);
        } catch (e) {
            return String(details);
        }
    }
});
