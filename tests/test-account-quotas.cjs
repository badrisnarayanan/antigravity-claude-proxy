/**
 * Test Account Quotas - Verifies the GET /v1/account-quotas reply
 *
 * Tests that mapQuotaSummary maps retrieveUserQuotaSummary groups to
 * fiveHour/weekly windows (skipping unknown windows, omitting missing ones,
 * clamping fractions), and that the reporter reports disabled, invalid and
 * failed accounts without a Google call or without failing the reply, and
 * reuses each account's result for 60 s.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               ACCOUNT QUOTAS TEST SUITE                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { mapQuotaSummary, createAccountQuotaReporter } = await import('../src/cloudcode/quota-summary.js');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
                `${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`
            );
        }
    }

    function assert(cond, message) {
        if (!cond) throw new Error(message);
    }

    const SUMMARY = {
        groups: [
            {
                displayName: 'Gemini Models',
                description: 'Models within this group: …',
                buckets: [
                    { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-11-28T09:22:04Z', remainingFraction: 0.95908904 },
                    { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-11-21T14:22:04Z', remainingFraction: 0.8442105 }
                ]
            },
            {
                displayName: 'Claude and GPT models',
                buckets: [
                    { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-11-28T09:22:04Z', remainingFraction: 0.5 },
                    { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-21T14:22:04Z', remainingFraction: 0.25 }
                ]
            }
        ],
        description: 'Within each group, models share a weekly limit and a 5-hour limit.'
    };

    /**
     * Build a fake account manager and a counting fetcher
     */
    function setup(accounts, fetchSummary = async () => SUMMARY) {
        const calls = [];
        const accountManager = {
            getAllAccounts: () => accounts,
            getTokenForAccount: async (account) => `token-${account.email}`,
            getProjectForAccount: async (account) => `project-${account.email}`
        };
        let clock = Date.parse('2026-11-21T12:00:00Z');
        const reporter = createAccountQuotaReporter({
            accountManager,
            fetchSummary: async (token, projectId) => {
                calls.push({ token, projectId });
                return fetchSummary(token, projectId);
            },
            now: () => clock
        });
        return { reporter, calls, advance: (ms) => { clock += ms; } };
    }

    await test('Both groups map to id, name, fiveHour and weekly windows', () => {
        assertEqual(mapQuotaSummary(SUMMARY), [
            {
                id: 'gemini',
                name: 'Gemini Models',
                windows: {
                    weekly: { remainingFraction: 0.95908904, resetTime: '2026-11-28T09:22:04Z' },
                    fiveHour: { remainingFraction: 0.8442105, resetTime: '2026-11-21T14:22:04Z' }
                }
            },
            {
                id: '3p',
                name: 'Claude and GPT models',
                windows: {
                    weekly: { remainingFraction: 0.5, resetTime: '2026-11-28T09:22:04Z' },
                    fiveHour: { remainingFraction: 0.25, resetTime: '2026-11-21T14:22:04Z' }
                }
            }
        ]);
    });

    await test('A bucket with an unknown window is skipped', () => {
        const groups = mapQuotaSummary({
            groups: [{
                displayName: 'Gemini Models',
                buckets: [
                    { bucketId: 'gemini-daily', window: 'daily', remainingFraction: 0.1 },
                    { bucketId: 'gemini-5h', window: '5h', resetTime: 'r', remainingFraction: 0.7 }
                ]
            }]
        });
        assertEqual(groups, [{ id: 'gemini', name: 'Gemini Models', windows: { fiveHour: { remainingFraction: 0.7, resetTime: 'r' } } }]);
    });

    await test('A missing window is omitted and a missing resetTime is null', () => {
        const groups = mapQuotaSummary({
            groups: [{ displayName: 'G', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4 }] }]
        });
        assertEqual(groups, [{ id: 'gemini', name: 'G', windows: { weekly: { remainingFraction: 0.4, resetTime: null } } }]);
        assert(!('fiveHour' in groups[0].windows), 'fiveHour should be absent');
    });

    await test('remainingFraction is clamped to 0-1', () => {
        const groups = mapQuotaSummary({
            groups: [{
                displayName: 'G',
                buckets: [
                    { bucketId: 'x-5h', window: '5h', remainingFraction: 1.7 },
                    { bucketId: 'x-weekly', window: 'weekly', remainingFraction: -0.2 }
                ]
            }]
        });
        assertEqual(groups[0].windows.fiveHour.remainingFraction, 1);
        assertEqual(groups[0].windows.weekly.remainingFraction, 0);
    });

    await test('An empty or malformed summary maps to no groups', () => {
        assertEqual(mapQuotaSummary({}), []);
        assertEqual(mapQuotaSummary(null), []);
    });

    await test('Disabled, invalid, failed and ok accounts each get their status', async () => {
        const accounts = [
            { email: 'a@example.com', enabled: true, subscription: { tier: 'ultra', projectId: 'secret-project' }, refreshToken: 'secret-refresh' },
            { email: 'b@example.com', enabled: false, subscription: { tier: 'pro' } },
            { email: 'c@example.com', isInvalid: true, invalidReason: 'Token revoked', subscription: { tier: 'ultra' } },
            { email: 'd@example.com', subscription: { tier: 'ultra' } }
        ];
        const { reporter, calls } = setup(accounts, async (token) => {
            if (token === 'token-d@example.com') throw new Error('HTTP 503');
            return SUMMARY;
        });
        const reply = await reporter.getAccountQuotas();

        assertEqual(reply.fetchedAt, '2026-11-21T12:00:00.000Z');
        assertEqual(reply.accounts.map(a => [a.email, a.enabled, a.status, a.tier]), [
            ['a@example.com', true, 'ok', 'ultra'],
            ['b@example.com', false, 'disabled', null],
            ['c@example.com', true, 'invalid', 'ultra'],
            ['d@example.com', true, 'error', 'ultra']
        ]);
        assertEqual(reply.accounts[0].groups.length, 2);
        assert(!('error' in reply.accounts[0]), 'ok account has no error');
        assertEqual(reply.accounts[1].groups, []);
        assertEqual(reply.accounts[2].error, 'Token revoked');
        assertEqual(reply.accounts[3].error, 'HTTP 503');
        assertEqual(reply.accounts[3].groups, []);
        assertEqual(calls.map(c => c.projectId), ['project-a@example.com', 'project-d@example.com'], 'only enabled, valid accounts are fetched');

        const text = JSON.stringify(reply);
        assert(!text.includes('secret') && !text.includes('token-') && !text.includes('project-'), `reply leaks a secret: ${text}`);
    });

    await test('A long error message is shortened', async () => {
        const { reporter } = setup([{ email: 'a@example.com' }], async () => { throw new Error('x'.repeat(500)); });
        const reply = await reporter.getAccountQuotas();
        assert(reply.accounts[0].error.length <= 121, `error too long: ${reply.accounts[0].error.length}`);
    });

    await test('A tier that is not known is null', async () => {
        const { reporter } = setup([{ email: 'a@example.com' }]);
        const reply = await reporter.getAccountQuotas();
        assertEqual(reply.accounts[0].tier, null);
    });

    await test('Results are reused within 60 s and fetched again after', async () => {
        const { reporter, calls, advance } = setup([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
        await reporter.getAccountQuotas();
        assertEqual(calls.length, 2);

        advance(59_000);
        await Promise.all([reporter.getAccountQuotas(), reporter.getAccountQuotas()]);
        assertEqual(calls.length, 2, 'cached within 60 s');

        advance(1_000);
        const reply = await reporter.getAccountQuotas();
        assertEqual(calls.length, 4, 'fetched again at 60 s');
        assertEqual(reply.accounts[0].status, 'ok');
    });

    await test('A failed result is cached too, so a failing account costs one call per minute', async () => {
        const { reporter, calls, advance } = setup([{ email: 'a@example.com' }], async () => { throw new Error('HTTP 429'); });
        await reporter.getAccountQuotas();
        advance(30_000);
        const reply = await reporter.getAccountQuotas();
        assertEqual(calls.length, 1);
        assertEqual(reply.accounts[0].error, 'HTTP 429');
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
