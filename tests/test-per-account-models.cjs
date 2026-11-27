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

    let passed = 0;
    let failed = 0;
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

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
