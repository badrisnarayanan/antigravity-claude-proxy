/**
 * Claude Config Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.claudeConfig = () => ({
    config: { env: {} },
    models: [],
    loading: false,
    gemini1mSuffix: false,

    // Model fields that may contain Gemini model names
    geminiModelFields: [
        'ANTHROPIC_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL'
    ],

    init() {
        // Only fetch config if this is the active sub-tab
        if (this.activeTab === 'claude') {
            this.fetchConfig();
        }

        // Watch local activeTab (from parent settings scope, skip initial trigger)
        this.$watch('activeTab', (tab, oldTab) => {
            if (tab === 'claude' && oldTab !== undefined) {
                this.fetchConfig();
            }
        });

        this.$watch('$store.data.models', (val) => {
            this.models = val || [];
        });
        this.models = Alpine.store('data').models || [];
    },

    /**
     * Detect if any Gemini model has [1m] suffix
     */
    detectGemini1mSuffix() {
        for (const field of this.geminiModelFields) {
            const val = this.config.env[field];
            if (val && val.toLowerCase().includes('gemini') && val.includes('[1m]')) {
                return true;
            }
        }
        return false;
    },

    /**
     * Toggle [1m] suffix for all Gemini models
     */
    toggleGemini1mSuffix(enabled) {
        for (const field of this.geminiModelFields) {
            const val = this.config.env[field];
            // Fix: Case-insensitive check for gemini
            if (val && /gemini/i.test(val)) {
                if (enabled && !val.includes('[1m]')) {
                    this.config.env[field] = val.trim() + ' [1m]';
                } else if (!enabled && val.includes('[1m]')) {
                    this.config.env[field] = val.replace(/\s*\[1m\]$/i, '').trim();
                }
            }
        }
        this.gemini1mSuffix = enabled;
    },

    /**
     * Helper to select a model from the dropdown
     * @param {string} field - The config.env field to update
     * @param {string} modelId - The selected model ID
     */
    selectModel(field, modelId) {
        if (!this.config.env) this.config.env = {};
        
        let finalModelId = modelId;
        // If 1M mode is enabled and it's a Gemini model, append the suffix
        if (this.gemini1mSuffix && modelId.toLowerCase().includes('gemini')) {
            if (!finalModelId.includes('[1m]')) {
                finalModelId = finalModelId.trim() + ' [1m]';
            }
        }
        
        this.config.env[field] = finalModelId;
    },

    async fetchConfig() {
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/config', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.config = data.config || {};
            if (!this.config.env) this.config.env = {};

            // Default MCP CLI to true if not set
            if (this.config.env.ENABLE_EXPERIMENTAL_MCP_CLI === undefined) {
                this.config.env.ENABLE_EXPERIMENTAL_MCP_CLI = 'true';
            }

            // Detect existing [1m] suffix state, default to true
            const hasExistingSuffix = this.detectGemini1mSuffix();
            const hasGeminiModels = this.geminiModelFields.some(f => 
                this.config.env[f]?.toLowerCase().includes('gemini')
            );
            
            // Default to enabled: if no suffix found but Gemini models exist, apply suffix
            if (!hasExistingSuffix && hasGeminiModels) {
                this.toggleGemini1mSuffix(true);
            } else {
                this.gemini1mSuffix = hasExistingSuffix || !hasGeminiModels;
            }
        } catch (e) {
            console.error('Failed to fetch Claude config:', e);
        }
    },

    async saveClaudeConfig() {
        this.loading = true;
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.config)
            }, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            Alpine.store('global').showToast(Alpine.store('global').t('claudeConfigSaved'), 'success');
        } catch (e) {
            Alpine.store('global').showToast(Alpine.store('global').t('saveConfigFailed') + ': ' + e.message, 'error');
        } finally {
            this.loading = false;
        }
    }
});
