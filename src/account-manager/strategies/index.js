/**
 * Strategy Factory
 *
 * Creates and exports account selection strategy instances.
 */

import { StickyStrategy } from './sticky-strategy.js';
import { RoundRobinStrategy } from './round-robin-strategy.js';
import { HybridStrategy } from './hybrid-strategy.js';
import { SilentFailoverStrategy } from './silent-failover-strategy.js';
import { OnDemandStrategy } from './on-demand-strategy.js';
import { AggressiveStrategy } from './aggressive-strategy.js';
import { QuotaFirstStrategy } from './quota-first-strategy.js';
import { ConservativeStrategy } from './conservative-strategy.js';
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
 * @param {string} strategyName - Name of the strategy
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

        case 'silent-failover':
        case 'silentfailover':
            logger.debug('[Strategy] Creating SilentFailoverStrategy');
            return new SilentFailoverStrategy(config);

        case 'on-demand':
        case 'ondemand':
            logger.debug('[Strategy] Creating OnDemandStrategy');
            return new OnDemandStrategy(config);

        case 'aggressive':
            logger.debug('[Strategy] Creating AggressiveStrategy');
            return new AggressiveStrategy(config);

        case 'quota-first':
        case 'quotafirst':
            logger.debug('[Strategy] Creating QuotaFirstStrategy');
            return new QuotaFirstStrategy(config);

        case 'conservative':
            logger.debug('[Strategy] Creating ConservativeStrategy');
            return new ConservativeStrategy(config);

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
    const aliases = ['roundrobin', 'silentfailover', 'ondemand', 'quotafirst'];
    return STRATEGY_NAMES.includes(lower) || aliases.includes(lower);
}

/**
 * Get the display label for a strategy
 * @param {string} name - Strategy name
 * @returns {string} Display label
 */
export function getStrategyLabel(name) {
    const lower = (name || DEFAULT_STRATEGY).toLowerCase();
    const aliasMap = {
        'roundrobin': 'round-robin',
        'silentfailover': 'silent-failover',
        'ondemand': 'on-demand',
        'quotafirst': 'quota-first'
    };
    const normalized = aliasMap[lower] || lower;
    return STRATEGY_LABELS[normalized] || STRATEGY_LABELS[DEFAULT_STRATEGY];
}

// Re-export strategies for direct use
export { StickyStrategy } from './sticky-strategy.js';
export { RoundRobinStrategy } from './round-robin-strategy.js';
export { HybridStrategy } from './hybrid-strategy.js';
export { SilentFailoverStrategy } from './silent-failover-strategy.js';
export { OnDemandStrategy } from './on-demand-strategy.js';
export { AggressiveStrategy } from './aggressive-strategy.js';
export { QuotaFirstStrategy } from './quota-first-strategy.js';
export { ConservativeStrategy } from './conservative-strategy.js';
export { BaseStrategy } from './base-strategy.js';

// Re-export trackers
export { HealthTracker, TokenBucketTracker } from './trackers/index.js';
