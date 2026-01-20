import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class QuotaFirstStrategy extends BaseStrategy {
    constructor(config = {}) {
        super(config);
    }

    selectAccount(accounts, modelId, options = {}) {
        const { onSave } = options;

        if (accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const usableAccounts = this.getUsableAccounts(accounts, modelId);

        if (usableAccounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const scored = usableAccounts.map(({ account, index }) => {
            let quotaScore = 0;

            if (account.quota && account.quota.models) {
                const modelQuota = account.quota.models[modelId];
                if (modelQuota && typeof modelQuota.remainingFraction === 'number') {
                    quotaScore = modelQuota.remainingFraction * 100;
                } else {
                    const allQuotas = Object.values(account.quota.models);
                    if (allQuotas.length > 0) {
                        const avgRemaining = allQuotas.reduce((sum, q) => {
                            return sum + (q.remainingFraction || 0);
                        }, 0) / allQuotas.length;
                        quotaScore = avgRemaining * 100;
                    }
                }
            }

            if (quotaScore === 0 && account.subscription) {
                const tierScores = { ultra: 30, pro: 20, free: 10 };
                quotaScore = tierScores[account.subscription.tier] || 5;
            }

            return { account, index, quotaScore };
        });

        scored.sort((a, b) => b.quotaScore - a.quotaScore);

        const best = scored[0];
        best.account.lastUsed = Date.now();
        if (onSave) onSave();

        const position = best.index + 1;
        const total = accounts.length;
        logger.info(`[QuotaFirstStrategy] Using account: ${best.account.email} (${position}/${total}, quota: ${best.quotaScore.toFixed(1)}%)`);

        return { account: best.account, index: best.index, waitMs: 0 };
    }

    onSuccess(account, modelId) {
    }

    onRateLimit(account, modelId) {
    }

    onFailure(account, modelId) {
    }
}

export default QuotaFirstStrategy;
