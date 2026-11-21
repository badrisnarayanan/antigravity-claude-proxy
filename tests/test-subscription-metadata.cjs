/** Offline tests for active subscription metadata; no accounts or inference. */
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-subscription-'));
process.env.HOME = temporaryHome;
process.env.USERPROFILE = temporaryHome;
process.env.XDG_CONFIG_HOME = path.join(temporaryHome, '.config');
const originalFetch = globalThis.fetch;
let parseTierId, extractSubscriptionFromResponse;
before(async () => {
    ({ parseTierId, extractSubscriptionFromResponse } = await import('../src/cloudcode/subscription.js'));
});
after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
});

for (const [id, tier] of [
    ['free-tier', 'free'], ['standard-tier', 'pro'],
    ['g1-pro-tier', 'pro'], ['g1-ultra-tier', 'ultra']
]) {
    test(`recognizes active ${id} without asserting payment or trial status`, () => {
        assert.equal(parseTierId(id), tier);
        const actual = extractSubscriptionFromResponse({ currentTier: { id } });
        assert.equal(actual.tier, tier);
        assert.equal(actual.tierId, id);
        assert.equal(actual.tierSource, 'currentTier');
        assert.equal(actual.paymentStatus, 'unknown');
        assert.equal(actual.trialStatus, 'unknown');
        assert.ok(Number.isFinite(Date.parse(actual.detectedAt)));
    });
}

test('active paidTier product takes precedence over base currentTier', () => {
    const actual = extractSubscriptionFromResponse({
        paidTier: { id: 'g1-ultra-tier' }, currentTier: { id: 'free-tier' }
    });
    assert.equal(actual.tier, 'ultra');
    assert.equal(actual.tierSource, 'paidTier');
    assert.equal(actual.paymentStatus, 'unknown');
    assert.equal(actual.trialStatus, 'unknown');
});

test('a Pro paidTier does not prove a paid, non-trial subscription', () => {
    const actual = extractSubscriptionFromResponse({ paidTier: { id: 'g1-pro-tier', name: 'Pro' } });
    assert.equal(actual.tier, 'pro');
    assert.equal(actual.paymentStatus, 'unknown');
    assert.equal(actual.trialStatus, 'unknown');
});

test('allowedTiers upgrade choices cannot elevate a free account', () => {
    const actual = extractSubscriptionFromResponse({
        currentTier: { id: 'free-tier' },
        allowedTiers: [{ id: 'g1-ultra-tier', isDefault: true }, { id: 'g1-pro-tier' }]
    });
    assert.equal(actual.tier, 'free');
    assert.equal(actual.tierId, 'free-tier');
    assert.equal(actual.tierSource, 'currentTier');
});

test('allowedTiers alone do not establish an active subscription', () => {
    const actual = extractSubscriptionFromResponse({ allowedTiers: [{ id: 'g1-pro-tier', isDefault: true }] });
    assert.equal(actual.tier, 'unknown');
    assert.equal(actual.tierId, null);
    assert.equal(actual.tierSource, null);
});

test('missing, failed or malformed metadata stays unknown', () => {
    for (const data of [null, undefined, {}, { error: { code: 503 } },
        { paidTier: { id: 123 }, currentTier: { id: false } }]) {
        const actual = extractSubscriptionFromResponse(data);
        assert.equal(actual.tier, 'unknown');
        assert.equal(actual.paymentStatus, 'unknown');
        assert.equal(actual.trialStatus, 'unknown');
    }
});

test('unknown IDs are not classified from pro, premium, ultra or free substrings', () => {
    for (const id of ['ultra-upgrade-offer', 'trial-pro-promotion', 'premium-preview', 'free-text']) {
        assert.equal(parseTierId(id), 'unknown');
        const actual = extractSubscriptionFromResponse({ paidTier: { id } });
        assert.equal(actual.tier, 'unknown');
        assert.equal(actual.tierId, id);
        assert.equal(actual.tierSource, 'paidTier');
    }
    for (const id of [null, undefined, {}, 123]) assert.equal(parseTierId(id), 'unknown');
});

test('unknown paid product can retain a recognized active currentTier', () => {
    const actual = extractSubscriptionFromResponse({
        paidTier: { id: 'future-product' }, currentTier: { id: 'standard-tier' }
    });
    assert.equal(actual.tier, 'pro');
    assert.equal(actual.tierId, 'standard-tier');
    assert.equal(actual.tierSource, 'currentTier');
    assert.equal(actual.paymentStatus, 'unknown');
});

test('tier display names do not infer trial or payment status', () => {
    for (const name of ['Free Pro Trial', 'Paid Pro', 'Device Promotion', 'Family Pro']) {
        const actual = extractSubscriptionFromResponse({ paidTier: { id: 'g1-pro-tier', name } });
        assert.equal(actual.tier, 'pro');
        assert.equal(actual.paymentStatus, 'unknown');
        assert.equal(actual.trialStatus, 'unknown');
    }
});

test('extracts project ID from both supported response shapes without guessing', () => {
    assert.equal(extractSubscriptionFromResponse({ cloudaicompanionProject: 'fixture-project' }).projectId, 'fixture-project');
    assert.equal(extractSubscriptionFromResponse({ cloudaicompanionProject: { id: 'fixture-project' } }).projectId, 'fixture-project');
    assert.equal(extractSubscriptionFromResponse({ cloudaicompanionProject: { id: 123 } }).projectId, null);
});


test('project discovery consumes the same metadata parser without inference', async () => {
    const { discoverProject } = await import('../src/account-manager/credentials.js');
    const calls = [];
    let body = {
        cloudaicompanionProject: 'fixture-project',
        paidTier: { id: 'g1-pro-tier' },
        allowedTiers: [{ id: 'g1-ultra-tier', isDefault: true }]
    };
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        assert.ok(String(url).endsWith('/v1internal:loadCodeAssist'), 'only metadata lookup is permitted');
        return { ok: true, status: 200, json: async () => body };
    };
    const result = await discoverProject('fixture-token');
    assert.equal(result.project, 'fixture-project');
    assert.equal(result.subscription.tier, 'pro');
    assert.equal(result.subscription.paymentStatus, 'unknown');
    assert.equal(result.subscription.trialStatus, 'unknown');
    body = { cloudaicompanionProject: 'fixture-project', allowedTiers: [{ id: 'g1-ultra-tier', isDefault: true }] };
    const unknown = await discoverProject('fixture-other-account');
    assert.equal(unknown.subscription.tier, 'unknown');
    assert.equal(unknown.subscription.tierSource, null);
    assert.equal(calls.length, 2);
});
