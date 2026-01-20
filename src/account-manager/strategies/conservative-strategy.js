import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class ConservativeStrategy extends BaseStrategy {
    #activeAccountEmail = null;
    #failureCount = 0;
    #maxFailuresBeforeSwitch = 3;
    #accounts = [];
    #pendingSave = null;

    constructor(config = {}) {
        super(config);
        this.#maxFailuresBeforeSwitch = config.maxFailuresBeforeSwitch || 3;
    }

    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;
        this.#accounts = accounts;
        this.#pendingSave = onSave;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        if (this.#activeAccountEmail) {
            const activeIdx = accounts.findIndex(a => a.email === this.#activeAccountEmail);
            if (activeIdx !== -1) {
                const activeAccount = accounts[activeIdx];
                if (this.isAccountUsable(activeAccount, modelId)) {
                    activeAccount.lastUsed = Date.now();
                    if (onSave) onSave();

                    const position = activeIdx + 1;
                    const total = accounts.length;
                    logger.info(`[ConservativeStrategy] Using active account: ${activeAccount.email} (${position}/${total})`);

                    return { account: activeAccount, index: activeIdx, waitMs: 0 };
                }
            }
        }

        const bestAccount = this.#findBestAccount(accounts, modelId);

        if (bestAccount) {
            this.#activateAccount(bestAccount.account, accounts, onSave);

            const position = bestAccount.index + 1;
            const total = accounts.length;
            logger.info(`[ConservativeStrategy] Activated new account: ${bestAccount.account.email} (${position}/${total})`);

            return { account: bestAccount.account, index: bestAccount.index, waitMs: 0 };
        }

        return { account: null, index: 0, waitMs: 0 };
    }

    onSuccess(account, modelId, options = {}) {
        this.#failureCount = 0;
    }

    onRateLimit(account, modelId, options = {}) {
        if (account && account.email === this.#activeAccountEmail) {
            logger.info(`[ConservativeStrategy] Active account rate-limited: ${account.email}`);
            this.#deactivateCurrent(account, options.onSave);
        }
    }

    onFailure(account, modelId, options = {}) {
        if (account && account.email === this.#activeAccountEmail) {
            this.#failureCount++;

            if (this.#failureCount >= this.#maxFailuresBeforeSwitch) {
                logger.info(`[ConservativeStrategy] Max failures reached for: ${account.email}`);
                this.#deactivateCurrent(account, options.onSave);
            }
        }
    }

    #findBestAccount(accounts, modelId) {
        const candidates = accounts
            .map((account, index) => ({ account, index }))
            .filter(({ account }) => {
                if (account.isInvalid) return false;
                return true;
            });

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            const aQuota = this.#getQuotaScore(a.account, modelId);
            const bQuota = this.#getQuotaScore(b.account, modelId);
            return bQuota - aQuota;
        });

        return candidates[0];
    }

    #getQuotaScore(account, modelId) {
        if (account.quota && account.quota.models && account.quota.models[modelId]) {
            return account.quota.models[modelId].remainingFraction || 0;
        }
        const tierScores = { ultra: 1, pro: 0.7, free: 0.3 };
        return tierScores[account.subscription?.tier] || 0.1;
    }

    #activateAccount(account, allAccounts, onSave) {
        for (const acc of allAccounts) {
            if (acc.email !== account.email && acc.enabled !== false) {
                acc.enabled = false;
            }
        }

        account.enabled = true;
        account.lastUsed = Date.now();
        this.#activeAccountEmail = account.email;
        this.#failureCount = 0;

        if (onSave) onSave();
    }

    #deactivateCurrent(account, onSave) {
        if (account) {
            account.enabled = false;
        }
        this.#activeAccountEmail = null;
        this.#failureCount = 0;

        if (onSave) onSave();
    }

    getActiveAccountEmail() {
        return this.#activeAccountEmail;
    }
}

export default ConservativeStrategy;
