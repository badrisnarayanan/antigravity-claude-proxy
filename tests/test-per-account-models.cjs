/**
 * Per-account model availability (#420)
 *
 * Accounts on different tiers offer different models. A model that only some
 * accounts list in quota.models must be routed only to those accounts, and
 * "all rate-limited" must only consider them. Everything fails open when no
 * account has quota data for the model.
 */

async function runTests() {
    console.log('PER-ACCOUNT MODEL AVAILABILITY TEST SUITE\n');

    const {
        accountOffersModel,
        anyAccountOffersModel,
        isAllRateLimited,
        getAvailableAccounts
    } = await import('../src/account-manager/rate-limits.js');
    const { StickyStrategy } = await import('../src/account-manager/strategies/sticky-strategy.js');
    const { RoundRobinStrategy } = await import('../src/account-manager/strategies/round-robin-strategy.js');
    const { HybridStrategy } = await import('../src/account-manager/strategies/hybrid-strategy.js');
    const { ModelCatalogRefresher, refreshAccountQuota } = await import('../src/account-manager/model-catalog.js');

    let passed = 0;
    let failed = 0;
    const asyncTests = [];
    function atest(name, fn) { asyncTests.push([name, fn]); }
    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}\n  ${e.message}`);
            failed++;
        }
    }
    function assert(cond, msg) {
        if (!cond) throw new Error(msg || 'assertion failed');
    }

    const CARBON = 'gemini-4-carbon-high';
    const SHARED = 'gemini-3-flash';

    function quota(models) {
        const out = {};
        for (const m of models) out[m] = { remainingFraction: 0.9, resetTime: null };
        return { models: out, lastChecked: Date.now() };
    }
    function makeAccounts() {
        return [
            { email: 'ultra-1@test', enabled: true, modelRateLimits: {}, quota: quota([CARBON, SHARED]) },
            { email: 'ultra-2@test', enabled: true, modelRateLimits: {}, quota: quota([CARBON, SHARED]) },
            { email: 'pro-1@test', enabled: true, modelRateLimits: {}, quota: quota([SHARED]) },
            { email: 'pro-2@test', enabled: true, modelRateLimits: {}, quota: quota([SHARED]) }
        ];
    }
    const limited = () => ({ isRateLimited: true, resetTime: Date.now() + 60_000 });

    test('accountOffersModel: true for accounts that list the model', () => {
        const a = makeAccounts();
        assert(accountOffersModel(a, a[0], CARBON));
        assert(!accountOffersModel(a, a[2], CARBON), 'pro account must not be offered Carbon');
        assert(accountOffersModel(a, a[2], SHARED));
    });

    test('accountOffersModel: fails open for an account without quota data', () => {
        const a = makeAccounts();
        a[2].quota = { models: {}, lastChecked: null };
        assert(accountOffersModel(a, a[2], CARBON));
    });

    test('accountOffersModel: fails open when no account lists the model', () => {
        const a = makeAccounts();
        assert(accountOffersModel(a, a[2], 'gemini-9-new'));
    });

    test('accountOffersModel: an old saved list does not leave an account out', () => {
        // pro-1's refresh has been failing for two days, so its saved list may be out of date
        const a = makeAccounts();
        a[2].quota.lastChecked = Date.now() - 2 * 24 * 60 * 60 * 1000;
        assert(accountOffersModel(a, a[2], CARBON), 'an account with only an old list must fail open');
        // a recent list still counts
        a[2].quota.lastChecked = Date.now() - 60 * 1000;
        assert(!accountOffersModel(a, a[2], CARBON), 'a recent list still excludes the account');
    });

    test('accountOffersModel: old lists on other accounts do not exclude anyone', () => {
        // Only ultra accounts list Carbon, and their lists are old: fail open for pro-1
        const a = makeAccounts();
        a[0].quota.lastChecked = Date.now() - 2 * 24 * 60 * 60 * 1000;
        a[1].quota.lastChecked = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        assert(accountOffersModel(a, a[2], CARBON), 'nobody lists it in a recent list, so fail open');
    });

    test('accountOffersModel: a list without lastChecked is not used', () => {
        const a = makeAccounts();
        delete a[2].quota.lastChecked;
        assert(accountOffersModel(a, a[2], CARBON));
    });

    test('accountOffersModel: ignores disabled/invalid accounts as the only listers', () => {
        const a = makeAccounts();
        a[0].enabled = false;
        a[1].isInvalid = true;
        assert(accountOffersModel(a, a[2], CARBON), 'nobody usable lists it, so fail open');
    });

    test('anyAccountOffersModel: true when some usable account lists it', () => {
        const a = makeAccounts();
        assert(anyAccountOffersModel(a, CARBON));
        assert(!anyAccountOffersModel(a, 'gemini-9-new'));
        a[0].enabled = false;
        a[1].enabled = false;
        assert(!anyAccountOffersModel(a, CARBON), 'disabled accounts do not count');
    });

    test('getAvailableAccounts: only Carbon accounts for Carbon, all for shared model', () => {
        const a = makeAccounts();
        const carbon = getAvailableAccounts(a, CARBON).map(x => x.email);
        assert(carbon.length === 2 && carbon.every(e => e.startsWith('ultra')), carbon.join(','));
        assert(getAvailableAccounts(a, SHARED).length === 4);
    });

    test('isAllRateLimited: true when every account that offers the model is limited', () => {
        const a = makeAccounts();
        a[0].modelRateLimits[CARBON] = limited();
        a[1].modelRateLimits[CARBON] = limited();
        assert(isAllRateLimited(a, CARBON), 'should wait for the Carbon reset, not use a pro account');
        assert(!isAllRateLimited(a, SHARED));
    });

    test('isAllRateLimited: false while one Carbon account is free', () => {
        const a = makeAccounts();
        a[0].modelRateLimits[CARBON] = limited();
        assert(!isAllRateLimited(a, CARBON));
    });

    for (const [name, Strategy] of [['Sticky', StickyStrategy], ['RoundRobin', RoundRobinStrategy], ['Hybrid', HybridStrategy]]) {
        test(`${name}: 200 Carbon selections only pick Carbon accounts`, () => {
            const a = makeAccounts();
            const s = new Strategy();
            s.setAllAccounts(a);
            let idx = 2; // start on a pro account, like the reporter's account 7
            for (let i = 0; i < 200; i++) {
                const r = s.selectAccount(a, CARBON, { currentIndex: idx });
                assert(r.account, 'expected an account');
                assert(r.account.email.startsWith('ultra'), `picked ${r.account.email}`);
                idx = r.index;
            }
        });

        test(`${name}: shared model can still use pro accounts`, () => {
            const a = makeAccounts();
            a[0].modelRateLimits[SHARED] = limited();
            a[1].modelRateLimits[SHARED] = limited();
            const s = new Strategy();
            s.setAllAccounts(a);
            const r = s.selectAccount(a, SHARED, { currentIndex: 0 });
            assert(r.account && r.account.email.startsWith('pro'), `picked ${r.account && r.account.email}`);
        });

        test(`${name}: no Carbon account free -> no pro account picked`, () => {
            const a = makeAccounts();
            a[0].modelRateLimits[CARBON] = limited();
            a[1].modelRateLimits[CARBON] = limited();
            const s = new Strategy();
            s.setAllAccounts(a);
            const r = s.selectAccount(a, CARBON, { currentIndex: 2 });
            assert(!r.account || r.account.email.startsWith('ultra'), `picked ${r.account && r.account.email}`);
        });
    }

    test('Strategy without setAllAccounts keeps old behaviour (fails open)', () => {
        const a = makeAccounts();
        const s = new RoundRobinStrategy();
        const r = s.selectAccount(a, CARBON, { currentIndex: 1 });
        assert(r.account, 'expected an account');
    });

    // ---- Background model-list refresh (no dashboard needed) ----

    function fakeManager(accounts, opts = {}) {
        const calls = { tokens: [], saves: 0, invalid: [] };
        return {
            calls,
            getAllAccounts: () => accounts,
            getTokenForAccount: async (acc) => {
                calls.tokens.push(acc.email);
                if (opts.tokenFails?.includes(acc.email)) throw new Error('token refresh failed');
                return 'tok-' + acc.email;
            },
            saveToDisk: async () => { calls.saves++; },
            markInvalid: (email) => { calls.invalid.push(email); const a = accounts.find(x => x.email === email); if (a) a.isInvalid = true; }
        };
    }
    function fakeDeps(catalog, log = []) {
        return {
            getSubscriptionTier: async (token) => ({ tier: 'pro', projectId: 'p-' + token }),
            getModelQuotas: async (token) => {
                const email = token.replace('tok-', '');
                log.push({ email, at: Date.now() });
                if (catalog[email] instanceof Error) throw catalog[email];
                return Object.fromEntries(catalog[email].map(m => [m, { remainingFraction: 1, resetTime: null }]));
            }
        };
    }
    const bare = (email, extra = {}) => ({ email, enabled: true, modelRateLimits: {}, quota: { models: {}, lastChecked: null }, ...extra });

    atest('refreshAll fills quota.models for every account, so routing works without the dashboard', async () => {
        const accounts = [bare('ultra-1@test'), bare('pro-1@test')];
        const mgr = fakeManager(accounts);
        const r = new ModelCatalogRefresher(mgr, { staggerMs: 0, deps: fakeDeps({ 'ultra-1@test': [CARBON, SHARED], 'pro-1@test': [SHARED] }) });
        // Before: no lists, everything fails open
        assert(accountOffersModel(accounts, accounts[1], CARBON), 'fails open before refresh');
        const res = await r.refreshAll();
        assert(res.refreshed === 2 && res.failed === 0, JSON.stringify(res));
        assert(CARBON in accounts[0].quota.models);
        assert(!(CARBON in accounts[1].quota.models));
        assert(accounts[0].subscription.tier === 'pro');
        assert(!accountOffersModel(accounts, accounts[1], CARBON), 'pro account excluded after refresh');
        assert(anyAccountOffersModel(accounts, CARBON), 'Carbon valid after refresh');
        assert(mgr.calls.saves === 2, 'saved to disk');
    });

    atest('refreshAll skips disabled, invalid and fresh accounts', async () => {
        const fresh = { models: { [SHARED]: { remainingFraction: 1 } }, lastChecked: Date.now() };
        const accounts = [bare('a@test', { enabled: false }), bare('b@test', { isInvalid: true }), bare('c@test', { quota: fresh }), bare('d@test')];
        const mgr = fakeManager(accounts);
        const r = new ModelCatalogRefresher(mgr, { staggerMs: 0, deps: fakeDeps({ 'd@test': [SHARED] }) });
        const res = await r.refreshAll();
        assert(res.refreshed === 1 && res.skipped === 3, JSON.stringify(res));
        assert(mgr.calls.tokens.join() === 'd@test', mgr.calls.tokens.join());
    });

    atest('refreshAll fails open: a failed fetch keeps the old list and does not throw', async () => {
        const old = { models: { [CARBON]: { remainingFraction: 1 } }, lastChecked: 1 };
        const accounts = [bare('a@test', { quota: old }), bare('b@test')];
        const mgr = fakeManager(accounts, { tokenFails: ['b@test'] });
        const r = new ModelCatalogRefresher(mgr, { staggerMs: 0, deps: fakeDeps({ 'a@test': new Error('Google down') }) });
        const res = await r.refreshAll();
        assert(res.failed === 2 && res.refreshed === 0, JSON.stringify(res));
        assert(accounts[0].quota === old, 'old list kept');
        assert(Object.keys(accounts[1].quota.models).length === 0, 'still no list, routing fails open');
    });

    atest('refreshAll marks a banned account invalid', async () => {
        const accounts = [bare('banned@test')];
        const mgr = fakeManager(accounts);
        const r = new ModelCatalogRefresher(mgr, { staggerMs: 0, deps: fakeDeps({ 'banned@test': new Error('ACCOUNT_BANNED: disabled') }) });
        await r.refreshAll();
        assert(mgr.calls.invalid.join() === 'banned@test');
    });

    atest('refreshAll waits between accounts and runs one pass at a time', async () => {
        const accounts = [bare('a@test'), bare('b@test'), bare('c@test')];
        const log = [];
        const mgr = fakeManager(accounts);
        const r = new ModelCatalogRefresher(mgr, { staggerMs: 60, deps: fakeDeps({ 'a@test': [SHARED], 'b@test': [SHARED], 'c@test': [SHARED] }, log) });
        const [x, y] = await Promise.all([r.refreshAll(), r.refreshAll()]);
        assert(x === y, 'second call shares the running pass');
        assert(log.length === 3, `fetched ${log.length} times`);
        assert(log[1].at - log[0].at >= 50 && log[2].at - log[1].at >= 50, 'calls are staggered');
    });

    atest('refreshAccountQuota returns the same shape /account-limits uses', async () => {
        const acc = bare('a@test');
        const r = await refreshAccountQuota(fakeManager([acc]), acc, fakeDeps({ 'a@test': [SHARED] }));
        assert(r.status === 'ok' && SHARED in r.quotas);
    });

    atest('start() runs a first pass by itself and stop() clears timers', async () => {
        const accounts = [bare('a@test')];
        const mgr = fakeManager(accounts);
        const r = new ModelCatalogRefresher(mgr, { staggerMs: 0, initialDelayMs: 10, intervalMs: 60_000, deps: fakeDeps({ 'a@test': [SHARED] }) });
        r.start();
        await new Promise(res => setTimeout(res, 80));
        r.stop();
        assert(SHARED in accounts[0].quota.models, 'first pass ran without anyone calling /account-limits');
    });

    for (const [name, fn] of asyncTests) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}\n  ${e.message}`);
            failed++;
        }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
