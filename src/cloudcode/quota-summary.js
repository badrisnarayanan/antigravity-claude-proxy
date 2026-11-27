/**
 * Quota Summary for Cloud Code
 *
 * Fetches each account's quota pools (the 5-hour and the weekly window of
 * each model group) from retrieveUserQuotaSummary and maps them to the
 * GET /v1/account-quotas reply.
 */

import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_HEADERS } from '../constants.js';
import { throttledFetch } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/** How long one account's result is reused before Google is asked again */
export const QUOTA_SUMMARY_CACHE_TTL_MS = 60_000;

/** Longest error message the reply carries */
const MAX_ERROR_LENGTH = 120;

/** Google's bucket window -> reply window key. Other windows are skipped. */
const WINDOW_KEYS = {
    '5h': 'fiveHour',
    'weekly': 'weekly'
};

/**
 * Fetch the raw quota summary for one account
 * @param {string} token - OAuth access token
 * @param {string} projectId - The account's Cloud Code project id
 * @returns {Promise<Object>} Raw retrieveUserQuotaSummary reply
 * @throws {Error} With a short message (e.g. "HTTP 503") when every endpoint fails
 */
export async function fetchQuotaSummary(token, projectId) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    let lastError = 'Request failed';
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await throttledFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ project: projectId })
            });
            if (!response.ok) {
                // Drain the body but never pass it on: it can be long
                await response.text().catch(() => '');
                lastError = `HTTP ${response.status}`;
                logger.warn(`[CloudCode] retrieveUserQuotaSummary error at ${endpoint}: ${response.status}`);
                continue;
            }
            return await response.json();
        } catch (error) {
            lastError = error.message || 'Request failed';
            logger.warn(`[CloudCode] retrieveUserQuotaSummary failed at ${endpoint}:`, error.message);
        }
    }
    throw new Error(lastError);
}

/**
 * Clamp a remaining fraction to 0-1
 * @param {*} value
 * @returns {number}
 */
function clampFraction(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

/**
 * Map a retrieveUserQuotaSummary reply to the reply's groups (pure)
 * @param {Object} summary - Raw reply: { groups: [{ displayName, buckets: [{ bucketId, window, resetTime, remainingFraction }] }] }
 * @returns {Array<{id: string, name: string, windows: Object}>} Groups with fiveHour/weekly windows
 */
export function mapQuotaSummary(summary) {
    const groups = [];
    for (const group of Array.isArray(summary?.groups) ? summary.groups : []) {
        let id = null;
        const windows = {};
        for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
            const key = WINDOW_KEYS[bucket?.window];
            if (!key) continue;
            if (id === null && typeof bucket.bucketId === 'string') {
                const dash = bucket.bucketId.lastIndexOf('-');
                id = dash > 0 ? bucket.bucketId.slice(0, dash) : bucket.bucketId;
            }
            windows[key] = {
                remainingFraction: clampFraction(bucket.remainingFraction),
                resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : null
            };
        }
        if (Object.keys(windows).length === 0) continue;
        groups.push({ id, name: group.displayName ?? null, windows });
    }
    return groups;
}

/**
 * Shorten an error to a message safe for the reply
 * @param {*} error
 * @returns {string}
 */
function shortError(error) {
    const message = String(error?.message || error || 'Unknown error');
    return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/**
 * Create a reporter that builds the GET /v1/account-quotas reply, caching
 * each account's result for the TTL so frequent polls cost one Google call
 * per account per TTL.
 * @param {Object} deps
 * @param {Object} deps.accountManager - Needs getAllAccounts, getTokenForAccount, getProjectForAccount
 * @param {(token: string, projectId: string) => Promise<Object>} [deps.fetchSummary] - Raw summary fetcher
 * @param {() => number} [deps.now] - Clock in ms
 * @param {number} [deps.ttlMs] - Cache TTL in ms
 * @returns {{getAccountQuotas: () => Promise<{fetchedAt: string, accounts: Array<Object>}>}}
 */
export function createAccountQuotaReporter({
    accountManager,
    fetchSummary = fetchQuotaSummary,
    now = Date.now,
    ttlMs = QUOTA_SUMMARY_CACHE_TTL_MS
}) {
    /** @type {Map<string, {at: number, promise: Promise<Object>}>} email -> cached result */
    const cache = new Map();

    async function load(account) {
        try {
            const token = await accountManager.getTokenForAccount(account);
            const projectId = await accountManager.getProjectForAccount(account, token);
            const summary = await fetchSummary(token, projectId);
            return { status: 'ok', groups: mapQuotaSummary(summary) };
        } catch (error) {
            return { status: 'error', error: shortError(error), groups: [] };
        }
    }

    function accountQuotas(account) {
        const base = {
            email: account.email,
            enabled: account.enabled !== false
        };
        if (!base.enabled) {
            return { ...base, status: 'disabled', tier: null, groups: [] };
        }
        const tier = account.subscription?.tier ?? null;
        if (account.isInvalid) {
            return { ...base, status: 'invalid', tier, error: shortError(account.invalidReason || 'Invalid account'), groups: [] };
        }

        let entry = cache.get(account.email);
        if (!entry || now() - entry.at >= ttlMs) {
            entry = { at: now(), promise: load(account) };
            cache.set(account.email, entry);
        }
        // Re-read the tier: resolving the project may have detected it
        return entry.promise.then(({ status, error, groups }) => ({
            ...base,
            status,
            tier: account.subscription?.tier ?? null,
            ...(error === undefined ? {} : { error }),
            groups
        }));
    }

    return {
        async getAccountQuotas() {
            const accounts = await Promise.all(accountManager.getAllAccounts().map(accountQuotas));
            return { fetchedAt: new Date(now()).toISOString(), accounts };
        }
    };
}
