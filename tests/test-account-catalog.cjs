/** Metadata-only account isolation, eligibility and cache regression tests. */
const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-catalog-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.ANTIGRAVITY_SIGNATURE_STORE = path.join(home, 'signatures.json');
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const FLASH = 'gemini-3.8-flash-medium';
const CLAUDE = 'claude-sonnet-5-5-high';
let api, clearMetadataCache, clearModelRegistry, isThinkingModel;
let calls;
const response = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
const catalog = ids => ({ models: Object.fromEntries(ids.map(id => [id, {
    supportsThinking: true, quotaInfo: { remainingFraction: 0.8 }
}])) });
before(async () => {
    api = await import('../src/cloudcode/model-api.js');
    ({ clearMetadataCache } = await import('../src/cloudcode/metadata-cache.js'));
    ({ clearModelRegistry } = await import('../src/cloudcode/model-registry.js'));
    ({ isThinkingModel } = await import('../src/constants.js'));
});
beforeEach(() => {
    clearMetadataCache();
    clearModelRegistry();
    calls = [];
    globalThis.fetch = async (url, options) => {
        assert.match(url, /:fetchAvailableModels$/);
        calls.push({ url, options });
        return response(catalog([FLASH]));
    };
});
after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    fs.rmSync(home, { recursive: true, force: true });
});

test('restricted Pro cannot borrow Ultra models, regardless of lookup order', async () => {
    globalThis.fetch = async (url, options) => {
        assert.match(url, /:fetchAvailableModels$/);
        calls.push(options.headers.Authorization);
        return response(catalog(options.headers.Authorization === 'Bearer fixture-ultra' ? [FLASH, CLAUDE] : [FLASH]));
    };
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-ultra'), true);
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-restricted-pro'), false);
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-ultra'), true);
    assert.equal(calls.length, 2);
});

test('catalog cache isolates projects on the same token', async () => {
    globalThis.fetch = async (url, options) => {
        assert.match(url, /:fetchAvailableModels$/);
        const project = JSON.parse(options.body).project;
        calls.push(project);
        return response(catalog(project === 'fixture-enterprise' ? [CLAUDE] : [FLASH]));
    };
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-token', 'fixture-enterprise'), true);
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-token', 'fixture-consumer'), false);
    assert.deepEqual(calls, ['fixture-enterprise', 'fixture-consumer']);
});

test('listing, quota and concurrent validation share one metadata call', async () => {
    await Promise.all([
        api.listModels('fixture-token'), api.getModelQuotas('fixture-token'),
        ...Array.from({ length: 15 }, () => api.isValidModel(FLASH, 'fixture-token'))
    ]);
    assert.equal(calls.length, 1);
});

test('an empty valid catalog is authoritative and cached', async () => {
    globalThis.fetch = async () => { calls.push(1); return response(catalog([])); };
    assert.deepEqual((await api.listModels('fixture-token')).data, []);
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-token'), false);
    assert.equal(calls.length, 1);
});

test('metadata outage fails closed and negative caching avoids a request storm', async () => {
    globalThis.fetch = async url => { assert.match(url, /:fetchAvailableModels$/); calls.push(1); throw new Error('fixture offline'); };
    await assert.rejects(api.isValidModel(CLAUDE, 'fixture-token'), /Failed to fetch/);
    const attempts = calls.length;
    await assert.rejects(api.isValidModel(CLAUDE, 'fixture-token'), /Failed to fetch/);
    assert.equal(calls.length, attempts);
});

test('malformed metadata never grants permission', async () => {
    globalThis.fetch = async () => response({ unexpected: true });
    await assert.rejects(api.isValidModel(CLAUDE, 'fixture-token'), /Invalid model metadata/);
});

test('disabled and deprecated Argon are absent from listing, validation and quotas', async () => {
    const old = 'gemini-4-argon-high';
    const data = catalog([FLASH, CLAUDE, old]);
    data.models[CLAUDE].disabled = true;
    data.deprecatedModelIds = { [old]: { newModelId: 'gemini-4-neon-high' } };
    globalThis.fetch = async () => response(data);
    assert.deepEqual((await api.listModels('fixture-token')).data.map(m => m.id), [FLASH]);
    assert.equal(await api.isValidModel(old, 'fixture-token'), false);
    assert.equal(await api.isValidModel(CLAUDE, 'fixture-token'), false);
    assert.deepEqual(Object.keys(await api.getModelQuotas('fixture-token')), [FLASH]);
    assert.equal(await api.isValidModel('gemini-4-neon-high', 'fixture-token'), false, 'never silently replace deprecated model');
});

test('agent roster excludes unsupported tiers present in the wider models map', async () => {
    const data = catalog([FLASH, CLAUDE, 'claude-sonnet-5-5-max']);
    data.agentModelSorts = [{ groups: [{ modelIds: [FLASH, CLAUDE] }] }];
    globalThis.fetch = async () => response(data);
    assert.equal(await api.isValidModel('claude-sonnet-5-5-max', 'fixture-token'), false);
    assert.deepEqual((await api.listModels('fixture-token')).data.map(m => m.id), [FLASH, CLAUDE]);
});

test('thinking labels are opaque backend metadata; no Extra/Max normalization or ghost IDs', async () => {
    const id = 'gemini-4-neon-xhigh';
    const data = catalog([id]);
    data.groupedModels = { 'gemini-4-neon': { displayName: 'Neon', supportedThinkingLevels: [
        { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra' },
        { thinkingSuffix: 'max', thinkingDisplayName: 'An unavailable example' }
    ] } };
    globalThis.fetch = async () => response(data);
    const models = (await api.listModels('fixture-token')).data;
    assert.equal(models.length, 1);
    assert.equal(models[0].id, id);
    assert.deepEqual(models[0].thinking_level, { id: 'xhigh', display_name: 'Extra' });
    assert.equal(await api.isValidModel('gemini-4-neon-max', 'fixture-token'), false);
});

test('backend capability can describe a future Claude suffix without synthesizing a model', async () => {
    const id = 'claude-sonnet-5-5-xhigh'; // Synthetic fixture, NOT a claimed published ID.
    const data = catalog([id]);
    data.models[id] = { supportsThinking: false, supportsAdaptiveThinking: true };
    globalThis.fetch = async () => response(data);
    assert.equal(await api.isValidModel(id, 'fixture-token'), true);
    assert.equal(isThinkingModel(id), true);
    assert.equal(await api.isValidModel('claude-sonnet-5-5-max', 'fixture-token'), false);
});

test('expired catalog refresh removes retired models without generating a request', async () => {
    let now = originalNow();
    Date.now = () => now;
    let ids = [FLASH, CLAUDE];
    globalThis.fetch = async url => { assert.match(url, /:fetchAvailableModels$/); calls.push(1); return response(catalog(ids)); };
    try {
        assert.equal(await api.isValidModel(CLAUDE, 'fixture-token'), true);
        ids = [FLASH];
        now += 300001;
        assert.equal(await api.isValidModel(CLAUDE, 'fixture-token'), false);
        assert.equal(calls.length, 2);
    } finally { Date.now = originalNow; }
});

test('subscription metadata errors remain unknown and are briefly cached', async () => {
    globalThis.fetch = async url => { assert.match(url, /:loadCodeAssist$/); calls.push(1); throw new Error('fixture offline'); };
    assert.equal((await api.getSubscriptionTier('fixture-token')).tier, 'unknown');
    const attempts = calls.length;
    const unknown = await api.getSubscriptionTier('fixture-token');
    assert.equal(unknown.paymentStatus, 'unknown');
    assert.equal(calls.length, attempts);
});


test('subscription display and project discovery share one metadata lookup', async () => {
    const { discoverProject } = await import('../src/account-manager/credentials.js');
    globalThis.fetch = async url => {
        assert.match(url, /:loadCodeAssist$/);
        calls.push(1);
        return response({ paidTier: { id: 'g1-pro-tier' }, cloudaicompanionProject: 'fixture-project' });
    };
    const [subscription, discovery] = await Promise.all([
        api.getSubscriptionTier('fixture-token'), discoverProject('fixture-token')
    ]);
    assert.equal(subscription.tier, 'pro');
    assert.equal(discovery.subscription.trialStatus, 'unknown');
    assert.equal(calls.length, 1);
});


test('metadata deadline aborts a hanging header request', async () => {
    const { metadataJSON } = await import('../src/cloudcode/metadata-http.js');
    let signal;
    globalThis.fetch = async (_url, options) => { signal = options.signal; return new Promise(() => {}); };
    await assert.rejects(metadataJSON('https://metadata.example.test', {}, 15), /METADATA_TIMEOUT/);
    assert.equal(signal.aborted, true);
});

test('metadata deadline also covers a hanging response body', async () => {
    const { metadataJSON } = await import('../src/cloudcode/metadata-http.js');
    let signal;
    globalThis.fetch = async (_url, options) => {
        signal = options.signal;
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
    };
    await assert.rejects(metadataJSON('https://metadata.example.test', {}, 15), /METADATA_TIMEOUT/);
    assert.equal(signal.aborted, true);
});
