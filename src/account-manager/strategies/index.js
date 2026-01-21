/**
 * Strategy Factory
 *
 * Creates and exports account selection strategy instances.
 */

import { StickyStrategy } from './sticky-strategy.js';
import { RoundRobinStrategy } from './round-robin-strategy.js';
import { HybridStrategy } from './hybrid-strategy.js';
import { logger } from '../../utils/logger.js';
import {
    SELECTION_STRATEGIES,
    DEFAULT_SELECTION_STRATEGY,
    STRATEGY_LABELS
} from '../../constants.js';

// Re-export strategy constants for convenience
export const STRATEGY_NAMES = SELECTION_STRATEGIES;
export const DEFAULT_STRATEGY = DEFAULT_SELECTION_STRATEGY;

/**
 * Create a strategy instance
 * @param {string} strategyName - Name of the strategy ('sticky', 'round-robin', 'hybrid')
 * @param {Object} config - Strategy configuration
 * @returns {BaseStrategy} The strategy instance
 */
export function createStrategy(strategyName, config = {}) {
    const name = (strategyName || DEFAULT_STRATEGY).toLowerCase();

    switch (name) {
        case 'sticky':
            logger.debug('[Strategy] Creating StickyStrategy');
            return new StickyStrategy(config);

        case 'round-robin':
        case 'roundrobin':
            logger.debug('[Strategy] Creating RoundRobinStrategy');
            return new RoundRobinStrategy(config);

        case 'hybrid':
            logger.debug('[Strategy] Creating HybridStrategy');
            return new HybridStrategy(config);

        default:
            logger.warn(`[Strategy] Unknown strategy "${strategyName}", falling back to ${DEFAULT_STRATEGY}`);
            return new HybridStrategy(config);
    }
}

/**
 * Check if a strategy name is valid
 * @param {string} name - Strategy name to check
 * @returns {boolean} True if valid
 */
export function isValidStrategy(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return STRATEGY_NAMES.includes(lower) || lower === 'roundrobin';
}

/**
 * Get the display label for a strategy
 * @param {string} name - Strategy name
 * @returns {string} Display label
 */
export function getStrategyLabel(name) {
    const lower = (name || DEFAULT_STRATEGY).toLowerCase();
    if (lower === 'roundrobin') return STRATEGY_LABELS['round-robin'];
    return STRATEGY_LABELS[lower] || STRATEGY_LABELS[DEFAULT_STRATEGY];
}

// Re-export strategies for direct use
export { StickyStrategy } from './sticky-strategy.js';
export { RoundRobinStrategy } from './round-robin-strategy.js';
export { HybridStrategy } from './hybrid-strategy.js';
export { BaseStrategy } from './base-strategy.js';

// Re-export trackers
export { HealthTracker, TokenBucketTracker } from './trackers/index.js';
