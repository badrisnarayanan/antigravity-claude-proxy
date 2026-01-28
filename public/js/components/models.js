/**
 * Models Component
 * Displays model quota/status list
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.models = () => ({
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
