import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class SilentFailoverStrategy extends BaseStrategy {
    #currentIndex = 0;
    #failureCounts = new Map();
    #maxFailuresBeforeSwitch = 1;
    #accountCount = 1;

    constructor(config = {}) {
        super(config);
        this.#maxFailuresBeforeSwitch = config.maxFailuresBeforeSwitch || 1;
    }

    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        this.#accountCount = accounts.length;

        if (this.#currentIndex >= accounts.length) {
            this.#currentIndex = 0;
        }

        const startIndex = this.#currentIndex;
        let attempts = 0;

        while (attempts < accounts.length) {
            const account = accounts[this.#currentIndex];

            if (this.isAccountUsable(account, modelId)) {
                account.lastUsed = Date.now();
                if (onSave) onSave();

                const position = this.#currentIndex + 1;
                const total = accounts.length;
                logger.info(`[SilentFailoverStrategy] Using account: ${account.email} (${position}/${total})`);

                return { account, index: this.#currentIndex, waitMs: 0 };
            }

            this.#currentIndex = (this.#currentIndex + 1) % accounts.length;
            attempts++;
        }

        this.#currentIndex = startIndex;
        return { account: null, index: startIndex, waitMs: 0 };
    }

    onSuccess(account, modelId, options = {}) {
        if (account && account.email) {
            this.#failureCounts.delete(account.email);
        }
    }

    onRateLimit(account, modelId, options = {}) {
        this.#switchToNext(account);
    }

    onFailure(account, modelId, options = {}) {
        if (!account || !account.email) return;

        const count = (this.#failureCounts.get(account.email) || 0) + 1;
        this.#failureCounts.set(account.email, count);

        if (count >= this.#maxFailuresBeforeSwitch) {
            this.#switchToNext(account);
            this.#failureCounts.delete(account.email);
        }
    }

    #switchToNext(account) {
        this.#currentIndex = (this.#currentIndex + 1) % Math.max(1, this.#accountCount);
        logger.debug(`[SilentFailoverStrategy] Silently switched away from ${account?.email || 'unknown'}`);
    }
}

export default SilentFailoverStrategy;
