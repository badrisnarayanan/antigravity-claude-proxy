import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class OnDemandStrategy extends BaseStrategy {
    #activeRequests = new Map();
    #currentIndex = 0;

    constructor(config = {}) {
        super(config);
    }

    selectAccount(accounts, modelId, options = {}) {
        const { onSave, requestId } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const enabledAccounts = accounts.filter(a => a.enabled !== false && !a.isInvalid);

        if (enabledAccounts.length === 0) {
            for (const account of accounts) {
                if (!account.isInvalid) {
                    account.enabled = true;
                    break;
                }
            }
        }

        const startIndex = this.#currentIndex % accounts.length;
        let attempts = 0;

        while (attempts < accounts.length) {
            const idx = (startIndex + attempts) % accounts.length;
            const account = accounts[idx];

            if (!account.isInvalid) {
                const wasDisabled = account.enabled === false;
                if (wasDisabled) {
                    account.enabled = true;
                    logger.debug(`[OnDemandStrategy] Enabled account for request: ${account.email}`);
                }

                account.lastUsed = Date.now();

                const rid = requestId || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                this.#activeRequests.set(rid, { email: account.email, index: idx, wasDisabled });

                if (onSave) onSave();

                const position = idx + 1;
                const total = accounts.length;
                logger.info(`[OnDemandStrategy] Using account: ${account.email} (${position}/${total})`);

                this.#currentIndex = (idx + 1) % accounts.length;

                return { account, index: idx, waitMs: 0, requestId: rid };
            }

            attempts++;
        }

        return { account: null, index: 0, waitMs: 0 };
    }

    onSuccess(account, modelId, options = {}) {
        this.#releaseAccount(options.requestId, account);
    }

    onRateLimit(account, modelId, options = {}) {
        this.#releaseAccount(options.requestId, account);
    }

    onFailure(account, modelId, options = {}) {
        this.#releaseAccount(options.requestId, account);
    }

    #releaseAccount(requestId, account) {
        if (!account) return;

        const requestInfo = requestId ? this.#activeRequests.get(requestId) : null;

        if (requestInfo) {
            this.#activeRequests.delete(requestId);
        }

        const hasOtherActiveRequests = Array.from(this.#activeRequests.values())
            .some(r => r.email === account.email);

        if (!hasOtherActiveRequests) {
            account.enabled = false;
            logger.debug(`[OnDemandStrategy] Disabled account after request: ${account.email}`);
        }
    }

    getActiveRequestCount() {
        return this.#activeRequests.size;
    }
}

export default OnDemandStrategy;
