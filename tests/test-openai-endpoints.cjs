/**
 * Test OpenAI Endpoints Integration
 *
 * Verifies that the server registers and responds to:
 * - GET /v1/models and GET /models
 * - GET /v1/models/:model and GET /models/:model
 * - POST /v1/chat/completions and POST /chat/completions
 * - POST /v1/completions and POST /completions
 * - Validates OpenAI error responses
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep tests independent of installed accounts, credentials and persisted history.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-endpoints-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.ANTIGRAVITY_SIGNATURE_STORE = path.join(testHome, 'signatures.json');
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           OPENAI ENDPOINTS TEST SUITE                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const appModule = await import('../src/server.js');
    const app = appModule.default;
    const { accountManager } = appModule;
    const accounts = [{ email: 'fixture@example.com', enabled: true, modelRateLimits: {} }];
    accountManager.initialize = async () => {};
    accountManager.getStatus = () => ({ summary: '1 fixture account', accounts });
    accountManager.getAllAccounts = () => accounts;
    accountManager.getTokenForAccount = async () => 'fixture-token';
    accountManager.getProjectForAccount = async () => 'fixture-project';
    accountManager.saveToDisk = async () => {};

    const realFetch = globalThis.fetch;
    const models = {
        'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 0.8 } },
        'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.6 } }
    };
    const quotaSummary = {
        groups: ['Gemini', 'Claude/GPT'].map(displayName => ({
            displayName,
            buckets: [{ window: 'weekly', remainingFraction: 0.5 }]
        }))
    };
    globalThis.fetch = async (url, options) => {
        const target = new URL(url);
        if (target.hostname === '127.0.0.1') return realFetch(url, options);
        let data;
        if (target.pathname.endsWith(':fetchAvailableModels')) data = { models };
        else if (target.pathname.endsWith(':retrieveUserQuotaSummary')) data = quotaSummary;
        else if (target.pathname.endsWith(':loadCodeAssist')) {
            data = { cloudaicompanionProject: 'fixture-project', paidTier: { id: 'g1-pro-tier' } };
        } else throw new Error(`Unexpected external request: ${target.origin}${target.pathname}`);
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };

    let passed = 0;
    let failed = 0;

    // Start server on random port
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    function assertTrue(condition, message = '') {
        if (!condition) throw new Error(message || 'Expected condition to be true');
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
        }
    }

    async function testAsync(name, fn) {
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

    try {
        // 1. GET /v1/models
        await testAsync('GET /v1/models returns model list in OpenAI format', async () => {
            const res = await fetch(`${baseUrl}/v1/models`);
            assertEqual(res.status, 200);
            const data = await res.json();
            assertEqual(data.object, 'list');
            assertTrue(Array.isArray(data.data), 'data should be an array');
            assertTrue(data.data.length > 0, 'data should not be empty');
            assertTrue(data.data.some(m => m.id.includes('gemini')), 'should list gemini models');
        });

        // 2. GET /models (without /v1)
        await testAsync('GET /models returns model list', async () => {
            const res = await fetch(`${baseUrl}/models`);
            assertEqual(res.status, 200);
            const data = await res.json();
            assertEqual(data.object, 'list');
        });

        // 3. GET /v1/models/:model
        await testAsync('GET /v1/models/:model returns specific model details', async () => {
            const listRes = await fetch(`${baseUrl}/v1/models`);
            const listData = await listRes.json();
            const firstModelId = listData.data[0].id;

            const res = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(firstModelId)}`);
            assertEqual(res.status, 200);
            const data = await res.json();
            assertEqual(data.id, firstModelId);
            assertEqual(data.object, 'model');
        });

        // 4. GET /v1/models/non-existent-model returns 404 with OpenAI error format
        await testAsync('GET /v1/models/:model returns 404 for non-existent model', async () => {
            const res = await fetch(`${baseUrl}/v1/models/definitely-not-a-model-xyz`);
            assertEqual(res.status, 404);
            const data = await res.json();
            assertTrue(data.error !== undefined, 'Should have error object');
            assertEqual(data.error.code, 'model_not_found');
            assertEqual(data.error.type, 'invalid_request_error');
        });

        // 5. POST /v1/chat/completions validates missing messages
        await testAsync('POST /v1/chat/completions validates missing messages with OpenAI error', async () => {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gemini-3.8-flash-tiered' })
            });
            assertEqual(res.status, 400);
            const data = await res.json();
            assertTrue(data.error !== undefined, 'Should have error object');
            assertEqual(data.error.param, 'messages');
            assertEqual(data.error.code, 'missing_required_parameter');
        });

        // 6. POST /v1/chat/completions validates invalid model
        await testAsync('POST /v1/chat/completions validates invalid model', async () => {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'non-existent-model-12345',
                    messages: [{ role: 'user', content: 'hello' }]
                })
            });
            assertEqual(res.status, 400);
            const data = await res.json();
            assertTrue(data.error !== undefined, 'Should have error object');
            assertEqual(data.error.code, 'model_not_found');
        });

        // 7. POST /chat/completions route alias exists
        await testAsync('POST /chat/completions alias works identically', async () => {
            const res = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            assertEqual(res.status, 400);
            const data = await res.json();
            assertTrue(data.error !== undefined);
        });

        await testAsync('Express 5 handles unparsed bodies with a validation error', async () => {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST' });
            assertEqual(res.status, 400);
            assertEqual((await res.json()).error.param, 'messages');
        });

        await testAsync('Unknown routes return 404 under Express 5', async () => {
            const res = await fetch(`${baseUrl}/does-not-exist`);
            assertEqual(res.status, 404);
        });

        await testAsync('Log messages use text bindings instead of HTML', async () => {
            const res = await fetch(`${baseUrl}/views/logs.html`);
            assertEqual(res.status, 200);
            const html = await res.text();
            assertTrue(html.includes('x-text="Redact.logMessage(log.message)"'));
            assertTrue(!html.includes('x-html="Redact.logMessage'));
        });

        // 8. GET /account-limits returns weekly and 5h quota summary
        await testAsync('GET /account-limits returns quotaSummary with groups', async () => {
            const res = await fetch(`${baseUrl}/account-limits`);
            assertEqual(res.status, 200);
            const data = await res.json();
            assertTrue(Array.isArray(data.accounts), 'accounts should be array');
            assertTrue(data.accounts.length > 0, 'accounts should not be empty');

            const firstAcc = data.accounts[0];
            assertTrue(firstAcc.quotaSummary !== undefined, 'account should include quotaSummary field');
            if (firstAcc.quotaSummary && firstAcc.quotaSummary.groups) {
                const groups = firstAcc.quotaSummary.groups;
                assertTrue(groups.length >= 2, 'Should have at least 2 groups (Gemini, Claude/GPT)');
                const hasWeekly = groups.some(g => g.buckets?.some(b => b.window === 'weekly'));
                assertTrue(hasWeekly, 'Should have weekly quota buckets');
            }
        });

    } finally {
        globalThis.fetch = realFetch;
        server.close();
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
