/**
 * Test Models Configuration
 *
 * Provides model configuration for parameterized testing across
 * multiple model families (Claude and Gemini).
 *
 * TEST_MODELS is imported from src/constants.js (single source of truth).
 */

let TEST_MODELS;

// Dynamic import to bridge ESM -> CJS
async function loadConstants() {
    if (!TEST_MODELS) {
        const constants = await import('../../src/constants.js');
        TEST_MODELS = constants.TEST_MODELS;
    }
    return TEST_MODELS;
}

/**
 * Get models to test, optionally excluding certain families.
 * @param {string[]} excludeFamilies - Array of family names to exclude (e.g., ['gemini'])
 * @returns {Promise<Array<{family: string, model: string}>>} Array of model configs to test
 */
async function getTestModels(excludeFamilies = []) {
    const testModels = await loadConstants();
    const models = [];
    for (const [family, model] of Object.entries(testModels)) {
        if (!excludeFamilies.includes(family)) {
            models.push({ family, model });
        }
    }
    return models;
}

/**
 * Check if a model family requires thinking features.
 * Both Claude thinking models and Gemini 3+ support thinking.
 * @param {string} family - Model family name
 * @returns {boolean} True if thinking is expected
 */
function familySupportsThinking(family) {
    // Both Claude thinking models and Gemini 3+ support thinking
    return family === 'claude' || family === 'gemini';
}

/**
 * Get model-specific configuration overrides.
 * @param {string} family - Model family name
 * @returns {Object} Configuration overrides for the model family
 */
function getModelConfig(family) {
    if (family === 'gemini') {
        return {
            // Gemini has lower max output tokens
            max_tokens: 8000,
            thinking: { type: 'enabled', budget_tokens: 10000 }
        };
    }
    return {
        max_tokens: 16000,
        thinking: { type: 'enabled', budget_tokens: 10000 }
    };
}

/**
 * Get TEST_MODELS directly (async).
 * @returns {Promise<Object>} TEST_MODELS object
 */
async function getModels() {
    return loadConstants();
}

module.exports = {
    getTestModels,
    getModels,
    familySupportsThinking,
    getModelConfig
};
