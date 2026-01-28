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
            this.saveModelThreshold(email, modelId, currentPct);
        }

        this.dragging.active = false;
    },

    /**
     * Save a per-model threshold for an account via PATCH
     */
    async saveModelThreshold(email, modelId, pct) {
        const store = Alpine.store('global');

        // Find the account to get existing thresholds
        const account = Alpine.store('data').accounts.find(a => a.email === email);
        if (!account) return;

        // Build full modelQuotaThresholds (API does full replacement, not merge)
        const existingModelThresholds = { ...(account.modelQuotaThresholds || {}) };
        if (pct === 0) {
            // Dragging to 0 removes the per-model override
            delete existingModelThresholds[modelId];
        } else {
            existingModelThresholds[modelId] = pct / 100;
        }

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
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || 'Failed to save threshold');
            }
        } catch (e) {
            store.showToast('Failed to save threshold: ' + e.message, 'error');
            // Refresh to revert visual state
            Alpine.store('data').fetchData();
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
