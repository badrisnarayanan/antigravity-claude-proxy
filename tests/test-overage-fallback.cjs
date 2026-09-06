/**
 * Test Overage Fallback for Google AI Pro (Issue #347)
 *
 * Verifies that when an account gets "Individual quota reached" (429):
 * 1. It is parsed as QUOTA_EXHAUSTED.
 * 2. It is classified as rate limit error by isRateLimitError.
 * 3. The non-streaming handler (sendMessage) triggers immediate fallback to
 *    the fallback model when fallbackEnabled && minWaitMs >= 1000 without sleeping.
 * 4. The streaming handler (sendMessageStream) triggers immediate fallback to
 *    the fallback model when fallbackEnabled && minWaitMs >= 1000 without sleeping.
 *
 * Usage: node tests/test-overage-fallback.cjs
 */

const { strict: assert } = require('assert');
const fs = require('fs');
const path = require('path');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           GOOGLE AI PRO OVERAGE FALLBACK TEST SUITE          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const { parseRateLimitReason } = await import('../src/cloudcode/rate-limit-parser.js');
    const { isRateLimitError } = await import('../src/errors.js');
    const { sendMessage } = await import('../src/cloudcode/message-handler.js');
    const { sendMessageStream } = await import('../src/cloudcode/streaming-handler.js');
    const { AccountManager } = await import('../src/account-manager/index.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`  ✗ ${name}`);
            console.log(`    Error: ${e.message}`);
            failed++;
        }
    }

    async function testAsync(name, fn) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`  ✗ ${name}`);
            console.log(`    Error: ${e.stack || e.message}`);
            failed++;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 1: Parsing and Classification tests
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('── Unit: Rate Limit Parsing & Classification ──────────────────');

    const mockQuotaErrorPayload = JSON.stringify({
        error: {
            code: 429,
            message: "Individual quota reached. Contact your administrator to enable overages.",
            status: "RESOURCE_EXHAUSTED"
        }
    });

    test('parseRateLimitReason identifies Individual Quota Reached as QUOTA_EXHAUSTED', () => {
        const reason = parseRateLimitReason(mockQuotaErrorPayload, 429);
        assert.strictEqual(reason, 'QUOTA_EXHAUSTED');
    });

    test('isRateLimitError detects Individual Quota Reached error message', () => {
        const rawError = new Error("Individual quota reached. Contact your administrator to enable overages.");
        assert.strictEqual(isRateLimitError(rawError), true);
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 2: Handler Fallback tests
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Integration: Overage Fallback flow in Handlers ────────────');

    // Create a temporary accounts config file
    const configPath = path.join(__dirname, 'temp-overage-accounts.json');
    const mockAccounts = {
        accounts: [
            {
                email: "test-primary@example.com",
                source: "manual",
                apiKey: "primary-api-key",
                projectId: "primary-project-id",
                enabled: true,
                subscription: { tier: 'pro', projectId: 'primary-project-id', detectedAt: Date.now() },
                quota: { models: {}, lastChecked: null },
                modelRateLimits: {}
            }
        ],
        settings: {
            accountSelection: {
                strategy: "round-robin"
            }
        },
        activeIndex: 0
    };

    fs.writeFileSync(configPath, JSON.stringify(mockAccounts, null, 2));

    const originalFetch = global.fetch;

    // Helper to run non-streaming fallback test
    await testAsync('sendMessage correctly catches 429, marks account rate-limited, and triggers immediate fallback', async () => {
        const originalSetTimeout = global.setTimeout;
        global.setTimeout = (fn, delay, ...args) => {
            if (delay === 5000) {
                return originalSetTimeout(fn, 0, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            // Setup AccountManager
            const accountManager = new AccountManager(configPath);
            await accountManager.initialize();

            let fetchCalls = [];

            global.fetch = async (url, options) => {
                fetchCalls.push({ url, options });
                const payload = options.body ? JSON.parse(options.body) : {};
                const model = payload.model;

                if (model === 'gemini-3.1-pro-high' && fetchCalls.length === 1) {
                    return {
                        ok: false,
                        status: 429,
                        headers: {
                            get: (name) => null
                        },
                        async text() {
                            return JSON.stringify({
                                error: {
                                    code: 429,
                                    message: "Individual quota reached. Contact your administrator to enable overages.",
                                    status: "RESOURCE_EXHAUSTED"
                                }
                            });
                        }
                    };
                }

                // Mocked successful non-streaming response for the fallback model
                return {
                    ok: true,
                    status: 200,
                    headers: {
                        get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null
                    },
                    async json() {
                        return {
                            candidates: [
                                {
                                    content: {
                                        parts: [
                                            {
                                                text: "Hello, I am the fallback model response."
                                            }
                                        ]
                                    },
                                    finishReason: "STOP"
                                }
                            ],
                            usageMetadata: {
                                promptTokenCount: 10,
                                candidatesTokenCount: 5
                            }
                        };
                    }
                };
            };

            const startTime = Date.now();
            const response = await sendMessage(
                {
                    model: 'gemini-3.1-pro-high',
                    messages: [{ role: 'user', content: 'Hi' }]
                },
                accountManager,
                true // fallbackEnabled
            );
            const duration = Date.now() - startTime;

            // Assert that we received the fallback model's response successfully
            assert.ok(response);
            assert.strictEqual(response.model, 'claude-opus-4-6-thinking');
            assert.strictEqual(response.content[0].text, 'Hello, I am the fallback model response.');

            // Assert that we did NOT sleep for 60s (should be near-instant, way less than 1s)
            assert.ok(duration < 2000, `Should run immediately without sleeping (took ${duration}ms)`);

            // Verify the account is rate-limited for the primary model
            const accounts = accountManager.getAvailableAccounts('gemini-3.1-pro-high');
            assert.strictEqual(accounts.length, 0, 'Primary account should be marked rate-limited for gemini-3.1-pro-high');

            // Clean up mock fetch
            global.fetch = originalFetch;
        } finally {
            global.setTimeout = originalSetTimeout;
        }
    });

    // Helper to run streaming fallback test
    await testAsync('sendMessageStream correctly catches 429, marks account rate-limited, and triggers immediate fallback', async () => {
        const originalSetTimeout = global.setTimeout;
        global.setTimeout = (fn, delay, ...args) => {
            if (delay === 5000) {
                return originalSetTimeout(fn, 0, ...args);
            }
            return originalSetTimeout(fn, delay, ...args);
        };

        try {
            // Setup a fresh AccountManager
            const accountManager = new AccountManager(configPath);
            await accountManager.initialize();

            let fetchCalls = [];

            global.fetch = async (url, options) => {
                fetchCalls.push({ url, options });
                const payload = options.body ? JSON.parse(options.body) : {};
                const model = payload.model;

                if (model === 'gemini-3.1-pro-high' && fetchCalls.length === 1) {
                    return {
                        ok: false,
                        status: 429,
                        headers: {
                            get: (name) => null
                        },
                        async text() {
                            return JSON.stringify({
                                error: {
                                    code: 429,
                                    message: "Individual quota reached. Contact your administrator to enable overages.",
                                    status: "RESOURCE_EXHAUSTED"
                                }
                            });
                        }
                    };
                }

                // Mocked successful SSE streaming response for the fallback model
                const chunks = [
                    'data: {"candidates": [{"content": {"parts": [{"text": "Streaming fallback response!"}]}}], "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 6}}\n'
                ];

                return {
                    ok: true,
                    status: 200,
                    headers: {
                        get: (name) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null
                    },
                    body: {
                        getReader() {
                            let index = 0;
                            return {
                                async read() {
                                    if (index < chunks.length) {
                                        return { done: false, value: new TextEncoder().encode(chunks[index++]) };
                                    }
                                    return { done: true, value: undefined };
                                }
                            };
                        }
                    }
                };
            };

            const startTime = Date.now();
            const events = [];
            for await (const event of sendMessageStream(
                {
                    model: 'gemini-3.1-pro-high',
                    messages: [{ role: 'user', content: 'Hi' }]
                },
                accountManager,
                true // fallbackEnabled
            )) {
                events.push(event);
            }
            const duration = Date.now() - startTime;

            // Assert that we received events and the model matches the fallback model
            assert.ok(events.length > 0);
            const startEvent = events.find(e => e.type === 'message_start');
            assert.ok(startEvent);
            assert.strictEqual(startEvent.message.model, 'claude-opus-4-6-thinking');

            // Assert that we did NOT sleep for 60s (should be near-instant, way less than 1s)
            assert.ok(duration < 2000, `Should run immediately without sleeping (took ${duration}ms)`);

            // Verify the account is rate-limited for the primary model
            const accounts = accountManager.getAvailableAccounts('gemini-3.1-pro-high');
            assert.strictEqual(accounts.length, 0, 'Primary account should be marked rate-limited for gemini-3.1-pro-high');

            // Clean up mock fetch
            global.fetch = originalFetch;
        } finally {
            global.setTimeout = originalSetTimeout;
        }
    });

    // Cleanup temp files
    try {
        fs.unlinkSync(configPath);
    } catch (e) {}

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
