/**
 * Model Configuration Utilities
 * Shared functions for model configuration updates
 */
window.ModelConfigUtils = window.ModelConfigUtils || {};

/**
 * Update model configuration with authentication and optimistic updates
 * @param {string} modelId - The model ID to update
 * @param {object} configUpdates - Configuration updates (pinned, hidden, alias, mapping)
 * @returns {Promise<void>}
 */
window.ModelConfigUtils.updateModelConfig = async function(modelId, configUpdates) {
    return window.ErrorHandler.safeAsync(async () => {
        const store = Alpine.store('global');

        const { response, newPassword } = await window.utils.request('/api/models/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId, config: configUpdates })
        }, store.webuiPassword);

        // Update password if server provided a new one
        if (newPassword) {
            store.webuiPassword = newPassword;
        }

        if (!response.ok) {
            throw new Error(store.t('failedToUpdateModelConfig'));
        }

        // Optimistic update of local state
        const dataStore = Alpine.store('data');
        dataStore.modelConfig[modelId] = {
            ...dataStore.modelConfig[modelId],
            ...configUpdates
        };

        // Recompute quota rows to reflect changes
        dataStore.computeQuotaRows();
    }, Alpine.store('global').t('failedToUpdateModelConfig'));
};
