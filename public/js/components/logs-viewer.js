/**
 * Logs Viewer Component
 * Registers itself to window.Components for Alpine.js to consume
 *
 * Performance optimizations:
 * - Ring buffer for O(1) log insertion without array reallocation
 * - Throttled scroll updates to prevent layout thrashing
 * - Batch log processing with requestAnimationFrame
 */
window.Components = window.Components || {};

/**
 * Ring Buffer implementation for efficient log storage
 * O(1) push, no array reallocation or slicing needed
 */
class LogRingBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;  // Next write position
        this.size = 0;  // Current number of items
    }

    push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size++;
        }
    }

    toArray() {
        if (this.size === 0) return [];
        if (this.size < this.capacity) {
            return this.buffer.slice(0, this.size);
        }
        // Full buffer: concatenate from head to end + start to head
        return [
            ...this.buffer.slice(this.head),
            ...this.buffer.slice(0, this.head)
        ];
    }

    clear() {
        this.head = 0;
        this.size = 0;
    }

    get length() {
        return this.size;
    }
}

window.Components.logsViewer = () => ({
    // Internal ring buffer (not reactive, for performance)
    _logBuffer: null,
    _pendingLogs: [],
    _flushScheduled: false,
    _scrollScheduled: false,

    // Reactive state for Alpine
    logs: [],
    isAutoScroll: true,
    eventSource: null,
    searchQuery: '',
    filters: {
        INFO: true,
        WARN: true,
        ERROR: true,
        SUCCESS: true,
        DEBUG: false
    },

    get filteredLogs() {
        const query = this.searchQuery.trim();
        if (!query) {
            return this.logs.filter(log => this.filters[log.level]);
        }

        // Try regex first, fallback to plain text search
        let matcher;
        try {
            const regex = new RegExp(query, 'i');
            matcher = (msg) => regex.test(msg);
        } catch (e) {
            // Invalid regex, fallback to case-insensitive string search
            const lowerQuery = query.toLowerCase();
            matcher = (msg) => msg.toLowerCase().includes(lowerQuery);
        }

        return this.logs.filter(log => {
            // Level Filter
            if (!this.filters[log.level]) return false;

            // Search Filter
            return matcher(log.message);
        });
    },

    init() {
        // Initialize ring buffer with configured limit
        const limit = Alpine.store('settings')?.logLimit || window.AppConstants?.LIMITS?.DEFAULT_LOG_LIMIT || 500;
        this._logBuffer = new LogRingBuffer(limit);

        this.startLogStream();

        this.$watch('isAutoScroll', (val) => {
            if (val) this.scrollToBottom();
        });

        // Watch filters to maintain auto-scroll if enabled
        this.$watch('searchQuery', () => {
            if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom());
        });
        this.$watch('filters', () => {
            if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom());
        });
    },

    /**
     * Batch flush pending logs using requestAnimationFrame
     * Prevents excessive DOM updates during high-frequency log streams
     */
    _flushLogs() {
        if (this._pendingLogs.length === 0) {
            this._flushScheduled = false;
            return;
        }

        // Push all pending logs to ring buffer
        for (const log of this._pendingLogs) {
            this._logBuffer.push(log);
        }
        this._pendingLogs = [];
        this._flushScheduled = false;

        // Update reactive array from ring buffer
        this.logs = this._logBuffer.toArray();

        // Schedule scroll update (throttled)
        if (this.isAutoScroll && !this._scrollScheduled) {
            this._scrollScheduled = true;
            requestAnimationFrame(() => {
                this.scrollToBottom();
                this._scrollScheduled = false;
            });
        }
    },

    /**
     * Queue a log for batch processing
     */
    _queueLog(log) {
        this._pendingLogs.push(log);

        if (!this._flushScheduled) {
            this._flushScheduled = true;
            requestAnimationFrame(() => this._flushLogs());
        }
    },

    startLogStream() {
        if (this.eventSource) this.eventSource.close();

        const password = Alpine.store('global').webuiPassword;
        const url = password
            ? `/api/logs/stream?history=true&password=${encodeURIComponent(password)}`
            : '/api/logs/stream?history=true';

        this.eventSource = new EventSource(url);
        this.eventSource.onmessage = (event) => {
            try {
                const log = JSON.parse(event.data);
                this._queueLog(log);
            } catch (e) {
                console.error('Log parse error:', e);
            }
        };

        this.eventSource.onerror = () => {
            console.warn('Log stream disconnected, reconnecting...');
            setTimeout(() => this.startLogStream(), 3000);
        };
    },

    scrollToBottom() {
        const container = document.getElementById('logs-container');
        if (container) container.scrollTop = container.scrollHeight;
    },

    clearLogs() {
        this._logBuffer?.clear();
        this._pendingLogs = [];
        this.logs = [];
    }
});
