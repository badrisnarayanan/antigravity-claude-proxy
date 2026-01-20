/**
 * Round-Robin Strategy
 *
 * Rotates to the next account on every request for maximum throughput.
 * Does not maintain cache continuity but maximizes concurrent requests.
 */

import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class RoundRobinStrategy extends BaseStrategy {
    #cursor = 0; // Tracks current position in rotation

    /**
     * Create a new RoundRobinStrategy
     * @param {Object} config - Strategy configuration
     */
    constructor(config = {}) {
        super(config);
    }

    /**
     * Select the next available account in rotation
     *
     * @param {Array} accounts - Array of account objects
     * @param {string} modelId - The model ID for the request
     * @param {Object} options - Additional options
     * @returns {SelectionResult} The selected account and index
     */
    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        // Clamp cursor to valid range
        if (this.#cursor >= accounts.length) {
            this.#cursor = 0;
        }

        // Start from the next position after the cursor
        const startIndex = (this.#cursor + 1) % accounts.length;

        // Try each account starting from startIndex
        for (let i = 0; i < accounts.length; i++) {
            const idx = (startIndex + i) % accounts.length;
            const account = accounts[idx];

            if (this.isAccountUsable(account, modelId)) {
                account.lastUsed = Date.now();
                this.#cursor = idx;

                if (onSave) onSave();

                const position = idx + 1;
                const total = accounts.length;
                logger.info(`[RoundRobinStrategy] Using account: ${account.email} (${position}/${total})`);

                return { account, index: idx, waitMs: 0 };
            }
        }

        // No usable accounts found
        return { account: null, index: this.#cursor, waitMs: 0 };
    }

    /**
     * Reset the cursor position
     */
    resetCursor() {
        this.#cursor = 0;
    }
}

export default RoundRobinStrategy;
