/**
 * Models Component
 * Displays model quota/status list
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.models = () => ({
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

/**
 * Model Manager Component (Settings Tab)
 * Handles model mapping and configuration editing
 */
window.Components.modelManager = () => ({
    editingId: null,

    isEditing(modelId) {
        return this.editingId === modelId;
    },

    startEditing(modelId) {
        this.editingId = modelId;
    },

    stopEditing() {
        this.editingId = null;
    },

    async updateModelConfig(modelId, configUpdates) {
        return window.ModelConfigUtils.updateModelConfig(modelId, configUpdates);
    }
});
