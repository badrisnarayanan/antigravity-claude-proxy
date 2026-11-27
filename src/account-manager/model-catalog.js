/**
 * Per-account model catalog
 *
 * Accounts on different tiers offer different models. The proxy routes a
 * model only to accounts whose quota.models lists it (#420), so every account
 * needs that list. It used to be filled only when the WebUI dashboard called
 * /account-limits; this module fills it on its own: once shortly after
 * startup, then on a slow timer, one account at a time.
 *
 * Fails open: if a fetch fails, the account keeps whatever list it had (or
 * none), and routing treats an account without a list as able to serve any
 * model, as before.
 */

import { getSubscriptionTier, getModelQuotas } from '../cloudcode/model-api.js';
import { logger } from '../utils/logger.js';

export const BANNED_REASON = 'Account banned — Gemini disabled for Terms of Service violation';

/**
 * Fetch an account's subscription tier and per-model quota from Google and
 * store them on the account (subscription, quota.models, quota.lastChecked).
 * Shared by /account-limits and the background refresh.
 *
 * @param {Object} accountManager - AccountManager instance
 * @param {Object} account - Account object (mutated)
 * @param {Object} [deps] - Overridable fetchers (tests)
 * @returns {Promise<{status: 'ok'|'banned'|'error', quotas?: Object, error?: string}>}
 */
export async function refreshAccountQuota(accountManager, account, deps = {}) {
    const fetchTier = deps.getSubscriptionTier || getSubscriptionTier;
    const fetchQuotas = deps.getModelQuotas || getModelQuotas;
    try {
        const token = await accountManager.getTokenForAccount(account);
        const subscription = await fetchTier(token);
        // Fetch quotas with project ID for accurate quota info
        const quotas = await fetchQuotas(token, subscription.projectId);

        account.subscription = {
            tier: subscription.tier,
            projectId: subscription.projectId,
            detectedAt: Date.now()
        };
        account.quota = {
            models: quotas,
            lastChecked: Date.now()
        };

        // Save updated account data to disk (async, don't wait)
        Promise.resolve(accountManager.saveToDisk()).catch(err => {
            logger.error('[ModelCatalog] Failed to save account data:', err);
        });

        return { status: 'ok', quotas };
    } catch (error) {
        // Detect ToS ban from quota/subscription fetch and mark account invalid
        if (error.message?.startsWith('ACCOUNT_BANNED:')) {
            accountManager.markInvalid(account.email, BANNED_REASON);
            return { status: 'banned', error: BANNED_REASON };
        }
        return { status: 'error', error: error.message };
    }
}

/**
 * Keeps every account's model list filled without the dashboard.
 */
export class ModelCatalogRefresher {
    #accountManager;
    #intervalMs;
    #staggerMs;
    #initialDelayMs;
    #deps;
    #timer = null;
    #startTimer = null;
    #running = null;

    /**
     * @param {Object} accountManager - AccountManager instance
     * @param {Object} [options]
     * @param {number} [options.intervalMs] - How often to refresh every account (0 disables the timer)
     * @param {number} [options.staggerMs] - Pause between two accounts, so Google isn't hit all at once
     * @param {number} [options.initialDelayMs] - Delay before the first pass after start()
     * @param {Object} [options.deps] - Overridable fetchers (tests)
     */
    constructor(accountManager, options = {}) {
        this.#accountManager = accountManager;
        this.#intervalMs = options.intervalMs ?? 30 * 60 * 1000;
        this.#staggerMs = options.staggerMs ?? 2000;
        this.#initialDelayMs = options.initialDelayMs ?? 3000;
        this.#deps = options.deps || {};
    }

    /**
     * Whether an account's list is missing or older than maxAgeMs.
     * @param {Object} account
     * @param {number} maxAgeMs
     * @returns {boolean}
     */
    static isStale(account, maxAgeMs) {
        const lastChecked = account?.quota?.lastChecked;
        const models = account?.quota?.models;
        if (!lastChecked || !models || Object.keys(models).length === 0) return true;
        return (Date.now() - new Date(lastChecked).getTime()) >= maxAgeMs;
    }

    /**
     * Refresh accounts one at a time. Skips disabled and invalid accounts, and
     * accounts whose list is younger than maxAgeMs (e.g. fresh from the dashboard).
     * Never throws. Concurrent calls share one pass.
     *
     * @param {Object} [options]
     * @param {number} [options.maxAgeMs] - Only refresh lists at least this old (default: interval)
     * @returns {Promise<{refreshed: number, failed: number, skipped: number}>}
     */
    refreshAll({ maxAgeMs = this.#intervalMs } = {}) {
        if (this.#running) return this.#running;
        this.#running = (async () => {
            const result = { refreshed: 0, failed: 0, skipped: 0 };
            try {
                const accounts = this.#accountManager.getAllAccounts();
                let first = true;
                for (const account of accounts) {
                    if (!account || account.enabled === false || account.isInvalid
                        || !ModelCatalogRefresher.isStale(account, maxAgeMs)) {
                        result.skipped++;
                        continue;
                    }
                    if (!first && this.#staggerMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, this.#staggerMs));
                    }
                    first = false;
                    const r = await refreshAccountQuota(this.#accountManager, account, this.#deps);
                    if (r.status === 'ok') {
                        result.refreshed++;
                        logger.debug(`[ModelCatalog] ${account.email}: ${Object.keys(r.quotas || {}).length} models`);
                    } else {
                        result.failed++;
                        logger.warn(`[ModelCatalog] Could not load models for ${account.email}: ${r.error}`);
                    }
                }
                if (result.refreshed || result.failed) {
                    logger.info(`[ModelCatalog] Model lists refreshed: ${result.refreshed} ok, ${result.failed} failed, ${result.skipped} skipped`);
                }
            } catch (error) {
                logger.warn(`[ModelCatalog] Refresh failed: ${error.message}`);
            } finally {
                this.#running = null;
            }
            return result;
        })();
        return this.#running;
    }

    /**
     * Start: one pass shortly after startup, then one every intervalMs.
     * Timers don't keep the process alive.
     */
    start() {
        if (this.#startTimer || this.#timer) return;
        this.#startTimer = setTimeout(() => {
            this.#startTimer = null;
            this.refreshAll();
        }, this.#initialDelayMs);
        this.#startTimer.unref?.();
        if (this.#intervalMs > 0) {
            // The periodic pass refreshes anything older than ~the interval.
            this.#timer = setInterval(() => this.refreshAll({ maxAgeMs: this.#intervalMs - 60_000 }), this.#intervalMs);
            this.#timer.unref?.();
        }
    }

    stop() {
        if (this.#startTimer) clearTimeout(this.#startTimer);
        if (this.#timer) clearInterval(this.#timer);
        this.#startTimer = null;
        this.#timer = null;
    }
}
