/** Offline regressions for account-specific model rollouts and routing. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function runTests() {
    const { listModels, isValidModel } = await import('../src/cloudcode/model-api.js');
    const { isThinkingModel, MODEL_VALIDATION_CACHE_TTL_MS } = await import('../src/constants.js');
    const { buildCloudCodeRequest, buildHeaders } = await import('../src/cloudcode/request-builder.js');
    const { createStrategy } = await import('../src/account-manager/strategies/index.js');
    const { getAvailableAccounts, isAllRateLimited, getMinWaitTimeMs } = await import('../src/account-manager/rate-limits.js');
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    let calls = 0;
    let passed = 0;
    const catalogs = {
        legacy: { 'claude-opus-4-6-thinking': {}, 'gemini-3.1-pro-high': {}, 'gemini-3.8-flash-tiered': {} },
        rollout: { 'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)' }, 'claude-sonnet-5-5-medium': {}, 'gemini-3.8-flash-tiered': {} },
        disabled: { 'claude-disabled': {} },
        invalid: { 'claude-invalid': {} }
    };
    const accounts = Object.keys(catalogs).map(email => ({
        email, enabled: email !== 'disabled', isInvalid: email === 'invalid', modelRateLimits: {}
    }));
    const manager = {
        getAllAccounts: () => accounts,
        getTokenForAccount: async account => account.email,
        getProjectForAccount: async account => `project-${account.email}`
    };

    async function test(name, fn) {
        await fn();
        console.log(`PASS ${name}`);
        passed++;
    }

    try {
        Date.now = () => now;
        globalThis.fetch = async (_url, options) => {
            calls++;
            const email = options.headers.Authorization.slice('Bearer '.length);
            assert.equal(JSON.parse(options.body).project, `project-${email}`);
            if (!catalogs[email]) throw new Error('Discovery unavailable');
            return { ok: true, json: async () => ({ models: catalogs[email] }) };
        };

        await test('listing merges account catalogs and concurrent discovery is deduplicated', async () => {
            const [models, valid] = await Promise.all([listModels(manager), isValidModel('claude-opus-5-5-high', manager)]);
            assert.equal(valid, true);
            assert.equal(calls, 2);
            const ids = models.data.map(model => model.id);
            assert.ok(ids.includes('claude-opus-5-5-high'));
            assert.ok(ids.includes('claude-opus-4-6-thinking'));
            assert.equal(ids.filter(id => id === 'gemini-3.8-flash-tiered').length, 1);
            assert.ok(!ids.includes('gemini-3.1-pro-high'));
            assert.ok(!ids.includes('claude-disabled'));
            assert.ok(!ids.includes('claude-invalid'));
        });

        await test('validation accepts hidden legacy IDs and rejects unknown IDs', async () => {
            assert.equal(await isValidModel('gemini-3.1-pro-high', manager), true);
            assert.equal(await isValidModel('claude-not-real', manager), false);
            assert.equal(calls, 2);
        });

        await test('disabling the rollout account removes its models from validation', async () => {
            accounts[1].enabled = false;
            assert.equal(await isValidModel('claude-opus-5-5-high', manager), false);
            accounts[1].enabled = true;
            assert.equal(await isValidModel('claude-opus-5-5-high', manager), true);
        });

        for (const name of ['sticky', 'round-robin', 'hybrid']) {
            await test(`${name} routes rollout models only to supporting accounts`, () => {
                const strategy = createStrategy(name);
                assert.equal(strategy.selectAccount(accounts, 'claude-opus-5-5-high', { currentIndex: 0 }).account, accounts[1]);
            });
        }

        await test('availability and wait calculations ignore unsupported accounts', () => {
            assert.deepEqual(getAvailableAccounts(accounts, 'claude-opus-5-5-high'), [accounts[1]]);
            accounts[0].modelRateLimits['claude-opus-5-5-high'] = { isRateLimited: true, resetTime: now + 1000 };
            accounts[1].modelRateLimits['claude-opus-5-5-high'] = { isRateLimited: true, resetTime: now + 30000 };
            assert.equal(isAllRateLimited(accounts, 'claude-opus-5-5-high'), true);
            assert.equal(getMinWaitTimeMs(accounts, 'claude-opus-5-5-high'), 30000);
            assert.deepEqual(getAvailableAccounts(accounts, 'claude-opus-5-5-high'), []);
            accounts[1].modelRateLimits = {};
        });

        await test('a model unsupported by every account does not enter a rate-limit wait loop', () => {
            assert.deepEqual(getAvailableAccounts(accounts, 'claude-not-real'), []);
            assert.equal(isAllRateLimited(accounts, 'claude-not-real'), false);
            assert.equal(isAllRateLimited([], 'claude-opus-5-5-high'), false);
        });

        await test('Claude effort variants enable thinking payloads and SSE headers', () => {
            for (const model of ['claude-opus-5-5-high', 'claude-opus-5-5-low', 'claude-sonnet-5-5-medium']) {
                assert.equal(isThinkingModel(model), true);
                const payload = buildCloudCodeRequest({ model, max_tokens: 4096, messages: [{ role: 'user', content: 'Hi' }] }, 'project', 'rollout');
                assert.equal(payload.model, model);
                assert.equal(payload.request.generationConfig.thinkingConfig.include_thoughts, true);
                assert.ok(buildHeaders('token', model)['anthropic-beta']);
            }
            assert.equal(isThinkingModel('claude-sonnet-4-6'), false);
        });

        await test('expired catalogs refresh when new models roll out', async () => {
            catalogs.legacy['claude-sonnet-5-5-high'] = {};
            now += MODEL_VALIDATION_CACHE_TTL_MS + 1;
            assert.equal(await isValidModel('claude-sonnet-5-5-high', manager), true);
            assert.ok(accounts[0].availableModels.has('claude-sonnet-5-5-high'));
            assert.equal(calls, 4);
        });

        await test('failed refresh retains listed models, backs off, and recovers routing', async () => {
            const rolloutCatalog = catalogs.rollout;
            catalogs.rollout = null;
            now += MODEL_VALIDATION_CACHE_TTL_MS + 1;
            const models = await listModels(manager);
            assert.ok(models.data.some(model => model.id === 'claude-opus-5-5-high'));
            assert.equal(accounts[1].availableModels, undefined);
            const callsAfterFailure = calls;
            assert.equal(await isValidModel('claude-future-model', manager), true);
            await listModels(manager);
            assert.equal(calls, callsAfterFailure, 'failed discovery must not repeat on every API request');

            catalogs.rollout = rolloutCatalog;
            now += 30001;
            assert.equal(await isValidModel('claude-opus-5-5-high', manager), true);
            assert.ok(accounts[1].availableModels.has('claude-opus-5-5-high'));
            assert.equal(calls, callsAfterFailure + 1);
        });

        await test('partial discovery failure stays fail-open without hiding known models', async () => {
            accounts.push({ email: 'offline', enabled: true });
            assert.equal(await isValidModel('claude-future-model', manager), true);
            assert.equal(accounts.at(-1).availableModels, undefined);
            const callsAfterFailure = calls;
            const models = await listModels(manager);
            assert.ok(models.data.some(model => model.id === 'claude-opus-5-5-high'));
            assert.equal(calls, callsAfterFailure);
        });

        await test('empty successful catalogs are not mistaken for discovery failure', async () => {
            catalogs.empty = {};
            const emptyManager = { ...manager, getAllAccounts: () => [{ email: 'empty' }] };
            assert.equal(await isValidModel('claude-opus-5-5-high', emptyManager), false);
        });

        await test('dashboard does not count absent rollout models as exhausted quotas', () => {
            const dashboardAccounts = [
                { status: 'ok', limits: { legacy: { remainingFraction: 1 }, rollout: null } },
                { status: 'ok', limits: { legacy: null, rollout: { remainingFraction: 0.9 } } },
                { status: 'ok', limits: { legacy: { remainingFraction: 0.02 }, rollout: null } },
                { status: 'ok', enabled: false, limits: { legacy: { remainingFraction: 0 } } }
            ];
            const window = {};
            vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/components/dashboard/stats.js'), 'utf8'), {
                window,
                Alpine: { store: () => ({ accounts: dashboardAccounts }) }
            });
            const component = { stats: {} };
            window.DashboardStats.updateStats(component);
            assert.equal(component.stats.total, 3);
            assert.equal(component.stats.active, 2);
            assert.equal(component.stats.limited, 1);
            assert.deepEqual({ ...component.stats.modelUsage }, { limited: 1, total: 3 });

            dashboardAccounts.splice(0, dashboardAccounts.length, { status: 'ok', limits: { rollout: null } });
            window.DashboardStats.updateStats(component);
            assert.equal(component.stats.limited, 1, 'entirely missing quota data stays conservative');
            assert.deepEqual({ ...component.stats.modelUsage }, { limited: 0, total: 0 });
        });

        console.log(`Model routing: ${passed} tests passed`);
    } finally {
        globalThis.fetch = originalFetch;
        Date.now = originalNow;
    }
}

runTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
