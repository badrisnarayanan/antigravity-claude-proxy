import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class OnDemandStrategy extends BaseStrategy {
    #activeAccounts = new Map();
    #currentIndex = 0;

    constructor(config = {}) {
        super(config);
    }

    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const startIndex = this.#currentIndex % accounts.length;
        let attempts = 0;

        while (attempts < accounts.length) {
            const idx = (startIndex + attempts) % accounts.length;
            const account = accounts[idx];

            if (!account.isInvalid) {
                const wasDisabled = account.enabled === false;
                account.enabled = true;

                if (wasDisabled) {
                    logger.debug(`[OnDemandStrategy] Enabled account for request: ${account.email}`);
                }

                account.lastUsed = Date.now();

                const activeCount = (this.#activeAccounts.get(account.email) || 0) + 1;
                this.#activeAccounts.set(account.email, activeCount);

                if (onSave) onSave();

                const position = idx + 1;
                const total = accounts.length;
                logger.info(`[OnDemandStrategy] Using account: ${account.email} (${position}/${total}, active: ${activeCount})`);

                this.#currentIndex = (idx + 1) % accounts.length;

                return { account, index: idx, waitMs: 0 };
            }

            attempts++;
        }

        return { account: null, index: 0, waitMs: 0 };
    }

    onSuccess(account, modelId, options = {}) {
        this.#releaseAccount(account, options.onSave);
    }

    onRateLimit(account, modelId, options = {}) {
        this.#releaseAccount(account, options.onSave);
    }

    onFailure(account, modelId, options = {}) {
        this.#releaseAccount(account, options.onSave);
    }

    #releaseAccount(account, onSave) {
        if (!account || !account.email) return;

        const activeCount = this.#activeAccounts.get(account.email) || 0;

        if (activeCount <= 1) {
            this.#activeAccounts.delete(account.email);
            account.enabled = false;
            logger.debug(`[OnDemandStrategy] Disabled account after request: ${account.email}`);

            if (onSave) onSave();
        } else {
            this.#activeAccounts.set(account.email, activeCount - 1);
        }
    }

    getActiveAccountCount() {
        return this.#activeAccounts.size;
    }
}

export default OnDemandStrategy;
