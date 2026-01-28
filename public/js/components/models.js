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
