/**
 * Subscription metadata from loadCodeAssist, without generation requests.
 *
 * GeminiUserTier describes an active product tier, not proof that a user paid
 * for it. In particular, paidTier does not distinguish an ordinary Pro trial,
 * a device promotion, a paid subscription, or a family entitlement. Preserve
 * that uncertainty; model access must come from the account's model catalog.
 *
 * Schema reference:
 * https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts
 */

/**
 * Classify known active Cloud Code tier IDs. Do not classify arbitrary names
 * by substring: upgrade offers and future tier names are not entitlements.
 * standard-tier retains the proxy's existing Code Assist Pro classification.
 * @param {unknown} tierId
 * @returns {'free'|'pro'|'ultra'|'unknown'}
 */
export function parseTierId(tierId) {
    if (typeof tierId !== 'string') return 'unknown';
    switch (tierId.trim().toLowerCase()) {
        case 'free-tier': return 'free';
        case 'standard-tier':
        case 'g1-pro-tier': return 'pro';
        case 'g1-ultra-tier': return 'ultra';
        default: return 'unknown';
    }
}

/**
 * Extract only active subscription metadata. allowedTiers is a list of
 * available onboarding/upgrade choices and must never elevate the account.
 * A failed/empty lookup remains unknown instead of becoming a free account.
 * @param {Object|null|undefined} data - loadCodeAssist response
 * @returns {{tier: string, tierId: string|null, tierSource: string|null,
 * paymentStatus: 'unknown', trialStatus: 'unknown', projectId: string|null,
 * detectedAt: string}}
 */
export function extractSubscriptionFromResponse(data) {
    let tier = 'unknown';
    let tierId = null;
    let tierSource = null;

    for (const source of ['paidTier', 'currentTier']) {
        const id = data?.[source]?.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        // Keep an unknown active ID for diagnosis, while permitting a known
        // currentTier to resolve the legacy product-tier field.
        if (tierSource === null) {
            tierId = id;
            tierSource = source;
        }
        const parsed = parseTierId(id);
        if (parsed !== 'unknown') {
            tier = parsed;
            tierId = id;
            tierSource = source;
            break;
        }
    }

    const project = data?.cloudaicompanionProject;
    const projectId = typeof project === 'string' ? project
        : (typeof project?.id === 'string' ? project.id : null);

    return {
        tier,
        tierId,
        tierSource,
        paymentStatus: 'unknown',
        trialStatus: 'unknown',
        projectId,
        detectedAt: new Date().toISOString()
    };
}
