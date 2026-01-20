import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class AggressiveStrategy extends BaseStrategy {
    #currentIndex = 0;
    #issueTracker = new Map();
    #switchThreshold = 1;

    constructor(config = {}) {
        super(config);
        this.#switchThreshold = config.switchThreshold || 1;
        this.silentFailover = true;
    }

    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        if (this.#currentIndex >= accounts.length) {
            this.#currentIndex = 0;
        }

        let attempts = 0;

        while (attempts < accounts.length) {
            const idx = (this.#currentIndex + attempts) % accounts.length;
            const account = accounts[idx];

            if (this.isAccountUsable(account, modelId)) {
                const issues = this.#issueTracker.get(account.email) || 0;

                if (issues < this.#switchThreshold) {
                    account.lastUsed = Date.now();
                    this.#currentIndex = idx;
                    if (onSave) onSave();

                    const position = idx + 1;
                    const total = accounts.length;
                    logger.info(`[AggressiveStrategy] Using account: ${account.email} (${position}/${total})`);

                    return { account, index: idx, waitMs: 0 };
                }
            }

            attempts++;
        }

        this.#issueTracker.clear();
        return this.selectAccount(accounts, modelId, options);
    }

    onSuccess(account, modelId) {
        if (account && account.email) {
            this.#issueTracker.delete(account.email);
        }
    }

    onRateLimit(account, modelId) {
        this.#recordIssue(account);
        this.#rotateNext();
    }

    onFailure(account, modelId) {
        this.#recordIssue(account);
        this.#rotateNext();
    }

    #recordIssue(account) {
        if (!account || !account.email) return;
        const current = this.#issueTracker.get(account.email) || 0;
        this.#issueTracker.set(account.email, current + 1);
    }

    #rotateNext() {
        this.#currentIndex++;
        logger.debug(`[AggressiveStrategy] Rotating to next account (index: ${this.#currentIndex})`);
    }
}

export default AggressiveStrategy;
