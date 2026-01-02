/**
 * Model Fallback Configuration
 * 
 * Defines fallback mappings for when a model's quota is exhausted across all accounts.
 * Enables graceful degradation to alternative models with similar capabilities.
 */

/**
 * Model fallback mapping
 * Maps primary model ID to fallback model ID
 */
export const MODEL_FALLBACK_MAP = {
    'gemini-3-pro-high': 'claude-sonnet-4-5-thinking',
    'gemini-3-pro-low': 'claude-sonnet-4-5',
    'claude-opus-4-5-thinking': 'gemini-3-pro-high',
    'claude-sonnet-4-5-thinking': 'gemini-3-pro-high',
    'claude-sonnet-4-5': 'gemini-3-pro-low'
};

/**
 * Get fallback model for a given model ID
 * @param {string} model - Primary model ID
 * @returns {string|null} Fallback model ID or null if no fallback exists
 */
export function getFallbackModel(model) {
    return MODEL_FALLBACK_MAP[model] || null;
}

/**
 * Check if a model has a fallback configured
 * @param {string} model - Model ID to check
 * @returns {boolean} True if fallback exists
 */
export function hasFallback(model) {
    return model in MODEL_FALLBACK_MAP;
}
