/**
 * Models Component
 * Displays model quota/status list
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.models = () => ({
    // Color palette for per-account threshold markers
    thresholdColors: [
        { bg: '#eab308', shadow: 'rgba(234,179,8,0.5)' },    // yellow
        { bg: '#06b6d4', shadow: 'rgba(6,182,212,0.5)' },     // cyan
        { bg: '#a855f7', shadow: 'rgba(168,85,247,0.5)' },    // purple
        { bg: '#22c55e', shadow: 'rgba(34,197,94,0.5)' },     // green
        { bg: '#ef4444', shadow: 'rgba(239,68,68,0.5)' },     // red
        { bg: '#f97316', shadow: 'rgba(249,115,22,0.5)' },    // orange
        { bg: '#ec4899', shadow: 'rgba(236,72,153,0.5)' },    // pink
        { bg: '#8b5cf6', shadow: 'rgba(139,92,246,0.5)' },    // violet
    ],

    getThresholdColor(index) {
        return this.thresholdColors[index % this.thresholdColors.length];
    },

    // Drag state for threshold markers
    dragging: {
        active: false,
        email: null,
        modelId: null,
        barRect: null,
        currentPct: 0,
        originalPct: 0
    },

    // Tracks which model rows have their per-account breakdown expanded beyond the cap
    expandedModels: new Set(),

    isExpanded(modelId) {
        return this.expandedModels.has(modelId);
    },

    toggleExpanded(modelId) {
        if (this.expandedModels.has(modelId)) {
            this.expandedModels.delete(modelId);
        } else {
            this.expandedModels.add(modelId);
        }
        // Force Alpine reactivity
        this.expandedModels = new Set(this.expandedModels);
    },

    /**
     * Get visible account rows for a model's breakdown, respecting the cap
     */
    getVisibleAccounts(row) {
        const all = row.quotaInfo || [];
        if (Alpine.store('settings').showAllAccounts || this.isExpanded(row.modelId)) {
            return all;
        }
        const limit = window.AppConstants.LIMITS.ACCOUNT_BREAKDOWN_LIMIT;
        return all.slice(0, limit);
    },

    /**
     * Get the number of hidden accounts for a model row
     */
    getHiddenCount(row) {
        const all = row.quotaInfo || [];
        const limit = window.AppConstants.LIMITS.ACCOUNT_BREAKDOWN_LIMIT;
        if (Alpine.store('settings').showAllAccounts || this.isExpanded(row.modelId)) {
            return 0;
        }
        return Math.max(0, all.length - limit);
    },

    // Model editing state (from main)
    editingModelId: null,
    newMapping: '',

    isEditing(modelId) {
        return this.editingModelId === modelId;
    },

    startEditing(modelId) {
        this.editingModelId = modelId;
    },

    stopEditing() {
        this.editingModelId = null;
    },

    /**
     * Start dragging a threshold marker
     */
    startDrag(event, q, row) {
        // Find the progress bar element (closest .relative container)
        const markerEl = event.currentTarget;
        const barContainer = markerEl.parentElement;
        const barRect = barContainer.getBoundingClientRect();

        this.dragging = {
            active: true,
            email: q.fullEmail,
            modelId: row.modelId,
            barRect,
            currentPct: q.thresholdPct,
            originalPct: q.thresholdPct
        };

        // Prevent text selection while dragging
        document.body.classList.add('select-none');

        // Bind document-level listeners for smooth dragging outside the marker
        this._onDrag = (e) => this.onDrag(e);
        this._endDrag = () => this.endDrag();
        document.addEventListener('mousemove', this._onDrag);
        document.addEventListener('mouseup', this._endDrag);
        document.addEventListener('touchmove', this._onDrag, { passive: false });
        document.addEventListener('touchend', this._endDrag);
    },

    /**
     * Handle drag movement — compute percentage from mouse position
     */
    onDrag(event) {
        if (!this.dragging.active) return;
        event.preventDefault();

        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const { left, width } = this.dragging.barRect;
        let pct = Math.round((clientX - left) / width * 100);
        pct = Math.max(0, Math.min(99, pct));

        this.dragging.currentPct = pct;
    },

    /**
     * End drag — save the new threshold value
     */
    endDrag() {
        if (!this.dragging.active) return;

        // Clean up listeners
        document.removeEventListener('mousemove', this._onDrag);
        document.removeEventListener('mouseup', this._endDrag);
        document.removeEventListener('touchmove', this._onDrag);
        document.removeEventListener('touchend', this._endDrag);
        document.body.classList.remove('select-none');

        const { email, modelId, currentPct, originalPct } = this.dragging;

        // Only save if value actually changed
        if (currentPct !== originalPct) {
            // Optimistic in-place update: mutate existing quotaInfo entries directly
            // to avoid full DOM rebuild from computeQuotaRows()
            const dataStore = Alpine.store('data');
            const account = dataStore.accounts.find(a => a.email === email);
            if (account) {
                if (!account.modelQuotaThresholds) account.modelQuotaThresholds = {};
                if (currentPct === 0) {
                    delete account.modelQuotaThresholds[modelId];
                } else {
                    account.modelQuotaThresholds[modelId] = currentPct / 100;
                }
            }
            // Patch quotaRows in-place so Alpine updates without tearing down DOM
            const rows = dataStore.quotaRows || [];
            for (const row of rows) {
                if (row.modelId !== modelId) continue;
                for (const q of row.quotaInfo) {
                    if (q.fullEmail !== email) continue;
                    q.thresholdPct = currentPct;
                }
                // Recompute row-level threshold stats
                const activePcts = row.quotaInfo.map(q => q.thresholdPct).filter(t => t > 0);
                row.effectiveThresholdPct = activePcts.length > 0 ? Math.max(...activePcts) : 0;
                row.hasVariedThresholds = new Set(activePcts).size > 1;
            }
            this.dragging.active = false;
            this.saveModelThreshold(email, modelId, currentPct);
        } else {
            this.dragging.active = false;
        }
    },

    /**
     * Save a per-model threshold for an account via PATCH
     */
    async saveModelThreshold(email, modelId, pct) {
        const store = Alpine.store('global');
        const dataStore = Alpine.store('data');

        const account = dataStore.accounts.find(a => a.email === email);
        if (!account) return;

        // Snapshot for rollback on failure
        const previousModelThresholds = account.modelQuotaThresholds ? { ...account.modelQuotaThresholds } : {};

        // Build full modelQuotaThresholds for API (full replacement, not merge)
        const existingModelThresholds = { ...(account.modelQuotaThresholds || {}) };

        // Preserve the account-level quotaThreshold
        const quotaThreshold = account.quotaThreshold !== undefined ? account.quotaThreshold : null;

        try {
            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quotaThreshold, modelQuotaThresholds: existingModelThresholds })
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const label = pct === 0 ? 'removed' : pct + '%';
                store.showToast(`${email.split('@')[0]} ${modelId} threshold: ${label}`, 'success');
                // Skip fetchData() — optimistic update is already applied,
                // next polling cycle will sync server state
            } else {
                throw new Error(data.error || 'Failed to save threshold');
            }
        } catch (e) {
            // Revert optimistic update on failure
            account.modelQuotaThresholds = previousModelThresholds;
            dataStore.computeQuotaRows();
            store.showToast('Failed to save threshold: ' + e.message, 'error');
        }
    },

    /**
     * Check if a specific marker is currently being dragged
     */
    isDragging(q, row) {
        return this.dragging.active && this.dragging.email === q.fullEmail && this.dragging.modelId === row.modelId;
    },

    /**
     * Get the display percentage for a marker (live during drag, stored otherwise)
     */
    getMarkerPct(q, row) {
        if (this.isDragging(q, row)) return this.dragging.currentPct;
        return q.thresholdPct;
    },

    /**
     * Compute pixel offset for overlapping markers so stacked ones fan out.
     * Markers within 2% of each other are considered overlapping.
     * Returns a CSS pixel offset string (e.g., '6px' or '-6px').
     */
    getMarkerOffset(q, row, qIdx) {
        const pct = this.getMarkerPct(q, row);
        const visible = row.quotaInfo.filter(item => item.thresholdPct > 0 || this.isDragging(item, row));
        // Find all markers within 2% of this one
        const cluster = [];
        visible.forEach((item, idx) => {
            const itemPct = this.getMarkerPct(item, row);
            if (Math.abs(itemPct - pct) <= 2) {
                cluster.push({ item, idx });
            }
        });
        if (cluster.length <= 1) return '0px';
        // Find position of this marker within its cluster
        const posInCluster = cluster.findIndex(c => c.item.fullEmail === q.fullEmail);
        // Spread markers 10px apart, centered on the base position
        const spread = 10;
        const totalWidth = (cluster.length - 1) * spread;
        return (posInCluster * spread - totalWidth / 2) + 'px';
    },

    init() {
        // Ensure data is fetched when this tab becomes active (skip initial trigger)
        this.$watch('$store.global.activeTab', (val, oldVal) => {
            if (val === 'models' && oldVal !== undefined) {
                // Trigger recompute to ensure filters are applied
                this.$nextTick(() => {
                    Alpine.store('data').computeQuotaRows();
                });
            }
        });

        // Initial compute if already on models tab
        if (this.$store.global.activeTab === 'models') {
            this.$nextTick(() => {
                Alpine.store('data').computeQuotaRows();
            });
        }
    },

    /**
     * Update model configuration (delegates to shared utility)
     * @param {string} modelId - The model ID to update
     * @param {object} configUpdates - Configuration updates (pinned, hidden)
     */
    async updateModelConfig(modelId, configUpdates) {
        return window.ModelConfigUtils.updateModelConfig(modelId, configUpdates);
    }
});
