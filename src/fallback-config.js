/**
 * Model Fallback Configuration
 *
 * Defines fallback mappings for when a model's quota is exhausted across all accounts.
 * Enables graceful degradation to alternative models with similar capabilities.
 *
 * The static MODEL_FALLBACK_MAP is used when its target is still offered by the
 * backend. Otherwise the fallback is derived from the live model list, so it
 * keeps working when Google renames models:
 * - Claude -> the backend's default agent model (a Gemini model)
 * - Gemini -> the newest Claude Opus (high/xhigh efforts) or Sonnet (others)
 */

import { MODEL_FALLBACK_MAP, getModelFamily } from './constants.js';
import { getRegisteredModelIds, getDefaultAgentModelId } from './cloudcode/model-registry.js';
import { pickNewestInFamily } from './cloudcode/model-resolver.js';

// Re-export for convenience
export { MODEL_FALLBACK_MAP };

/**
 * Derive a cross-family fallback from the live model list.
 * @param {string} model
 * @param {Set<string>} known - Model ids the backend currently offers
 * @returns {string|null}
 */
function dynamicFallback(model, known) {
    const family = getModelFamily(model);

    if (family === 'claude') {
        const defaultAgent = getDefaultAgentModelId();
        if (defaultAgent && known.has(defaultAgent) && getModelFamily(defaultAgent) === 'gemini') {
            return defaultAgent;
        }
        return null;
    }

    if (family === 'gemini') {
        const strong = /-(high|xhigh)$/.test(model) || /-pro/.test(model);
        return pickNewestInFamily(strong ? 'opus' : 'sonnet', 'medium', known)
            || pickNewestInFamily(strong ? 'sonnet' : 'opus', 'medium', known);
    }

    return null;
}

/**
 * Get fallback model for a given model ID
 * @param {string} model - Primary model ID
 * @returns {string|null} Fallback model ID or null if no fallback exists
 */
export function getFallbackModel(model) {
    const known = getRegisteredModelIds();
    const staticTarget = MODEL_FALLBACK_MAP[model];

    // No live list yet: the static table is all we have
    if (known.size === 0) return staticTarget || null;

    if (staticTarget && known.has(staticTarget)) return staticTarget;

    const derived = dynamicFallback(model, known);
    return derived && derived !== model ? derived : null;
}

/**
 * Check if a model has a fallback configured
 * @param {string} model - Model ID to check
 * @returns {boolean} True if fallback exists
 */
export function hasFallback(model) {
    return getFallbackModel(model) !== null;
}
