/**
 * Test Quota Summary - Tests for Weekly & 5-Hour Quota Tracking and Model Grouping
 *
 * Verifies that:
 * 1. Antigravity weekly and 5h quotas are parsed and grouped correctly
 * 2. Model groups (Gemini vs Claude/GPT) are correctly formed
 * 3. Fallback synthesis works when API summary is missing
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           QUOTA SUMMARY & GROUPING TEST SUITE                ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { getUserQuotaSummary } = await import('../src/cloudcode/model-api.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
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
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    function assertTrue(condition, message = '') {
        if (!condition) {
            throw new Error(message || 'Expected condition to be true');
        }
    }

    // Load account manager component logic for testing
    // We simulate the helper functions getAccountGroupQuotas and getQuotaGroups
    // directly or evaluate the component code
    const fs = await import('fs');
    const path = await import('path');
    const compCode = fs.readFileSync(path.resolve(__dirname, '../public/js/components/account-manager.js'), 'utf8');

    // Create a mock sandbox to extract the component
    const fakeWindow = { Components: {} };
    const fakeAlpine = { store: () => ({}) };
    const evalFn = new Function('window', 'Alpine', compCode);
    evalFn(fakeWindow, fakeAlpine);
    const accountManagerComp = fakeWindow.Components.accountManager();

    test('getUserQuotaSummary function is exported', () => {
        assertTrue(typeof getUserQuotaSummary === 'function', 'getUserQuotaSummary should be a function');
    });

    test('getQuotaGroups parses live quotaSummary with weekly and 5h buckets', () => {
        const mockQuotaSummary = {
            groups: [
                {
                    displayName: 'Gemini Models',
                    description: 'Models within this group: Gemini Flash, Gemini Pro',
                    buckets: [
                        {
                            bucketId: 'gemini-weekly',
                            displayName: 'Weekly Limit Remaining',
                            window: 'weekly',
                            resetTime: '2026-09-17T18:36:43Z',
                            description: 'You have used some of your weekly limit, it will fully refresh in 5 days.',
                            remainingFraction: 0.812
                        },
                        {
                            bucketId: 'gemini-5h',
                            displayName: 'Five Hour Limit Remaining',
                            window: '5h',
                            resetTime: '2026-09-12T19:25:31Z',
                            remainingFraction: 1.0
                        }
                    ]
                },
                {
                    displayName: 'Claude and GPT models',
                    description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
                    buckets: [
                        {
                            bucketId: '3p-weekly',
                            displayName: 'Weekly Limit Remaining',
                            window: 'weekly',
                            resetTime: '2026-09-19T14:25:31Z',
                            remainingFraction: 1.0
                        },
                        {
                            bucketId: '3p-5h',
                            displayName: 'Five Hour Limit Remaining',
                            window: '5h',
                            resetTime: '2026-09-12T19:25:31Z',
                            remainingFraction: 0.65
                        }
                    ]
                }
            ]
        };

        const groups = accountManagerComp.getQuotaGroups({ quotaSummary: mockQuotaSummary });
        assertEqual(groups.length, 2);

        // Check Gemini group
        const gemini = groups[0];
        assertEqual(gemini.displayName, 'Gemini Models');
        assertEqual(gemini.buckets.length, 2);

        const weeklyBkt = gemini.buckets.find(b => b.window === 'weekly');
        assertTrue(weeklyBkt !== undefined);
        assertEqual(weeklyBkt.percent, 81);
        assertEqual(weeklyBkt.resetTime, '2026-09-17T18:36:43Z');

        const fiveHourBkt = gemini.buckets.find(b => b.window === '5h');
        assertTrue(fiveHourBkt !== undefined);
        assertEqual(fiveHourBkt.percent, 100);

        // Check Claude & GPT group
        const claude = groups[1];
        assertEqual(claude.displayName, 'Claude and GPT models');
        const claude5h = claude.buckets.find(b => b.window === '5h');
        assertEqual(claude5h.percent, 65);
    });

    test('getAccountGroupQuotas extracts both Gemini and Claude/GPT quotas', () => {
        const mockAccount = {
            email: 'test@example.com',
            quotaSummary: {
                groups: [
                    {
                        displayName: 'Gemini Models',
                        buckets: [
                            { window: 'weekly', remainingFraction: 0.85, resetTime: '2026-09-18T00:00:00Z' },
                            { window: '5h', remainingFraction: 0.95, resetTime: '2026-09-12T20:00:00Z' }
                        ]
                    },
                    {
                        displayName: 'Claude and GPT models',
                        buckets: [
                            { window: 'weekly', remainingFraction: 0.70, resetTime: '2026-09-19T00:00:00Z' },
                            { window: '5h', remainingFraction: 0.40, resetTime: '2026-09-12T21:00:00Z' }
                        ]
                    }
                ]
            }
        };

        const result = accountManagerComp.getAccountGroupQuotas(mockAccount);
        assertEqual(result.gemini.percent, 95);
        assertEqual(result.gemini.weeklyPercent, 85);
        assertEqual(result.gemini.fiveHourPercent, 95);

        assertEqual(result.claude.percent, 40);
        assertEqual(result.claude.weeklyPercent, 70);
        assertEqual(result.claude.fiveHourPercent, 40);
    });

    test('Synthesizes two model groups from raw limits when quotaSummary is missing', () => {
        const mockAccount = {
            email: 'fallback@example.com',
            limits: {
                'gemini-3.8-flash-tiered': { remainingFraction: 0.90, resetTime: '2026-09-12T19:00:00Z' },
                'gemini-3-flash': { remainingFraction: 0.90, resetTime: '2026-09-12T19:00:00Z' },
                'claude-sonnet-4-6': { remainingFraction: 0.50, resetTime: '2026-09-12T19:30:00Z' },
                'gpt-oss-120b-medium': { remainingFraction: 0.50, resetTime: '2026-09-12T19:30:00Z' }
            }
        };

        const groups = accountManagerComp.getQuotaGroups(mockAccount);
        assertEqual(groups.length, 2);
        assertEqual(groups[0].displayName, 'Gemini Models');
        assertEqual(groups[0].buckets[0].percent, 90);

        assertEqual(groups[1].displayName, 'Claude and GPT models');
        assertEqual(groups[1].buckets[0].percent, 50);

        const groupQuotas = accountManagerComp.getAccountGroupQuotas(mockAccount);
        assertEqual(groupQuotas.gemini.percent, 90);
        assertEqual(groupQuotas.claude.percent, 50);
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
