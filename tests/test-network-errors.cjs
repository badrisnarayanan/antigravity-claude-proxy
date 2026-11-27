/**
 * Network errors and DNS order (#384)
 *
 * On networks with broken IPv6, requests to Google time out. The proxy used to count
 * those timeouts like account failures: after a few, every account went on cooldown
 * and the user saw "RESOURCE_EXHAUSTED ... quota will reset", which sent them chasing
 * a quota problem that didn't exist.
 *
 * Tests:
 * 1. isNetworkError() spots fetch's "fetch failed" and the real cause codes
 * 2. DNS order defaults to ipv4first but respects an explicit user choice
 * 3. sendMessage / sendMessageStream don't rate-limit or penalise accounts on
 *    network errors, and end with a clear "Network error" instead of a quota error
 * 4. A request that hits one network error and then succeeds still succeeds
 */

// Talk to the mocked fetch directly, not through any proxy set in the environment
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'DNS_RESULT_ORDER']) {
    delete process.env[key];
}
// Keep NODE_OPTIONS from a parent shell from changing the default-order check below
const parentNodeOptions = process.env.NODE_OPTIONS || '';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${e.message}`);
        failed++;
    }
}

function assert(cond, message) {
    if (!cond) throw new Error(message || 'assertion failed');
}

function connectTimeout() {
    const cause = new Error('Connect Timeout Error (attempted address: cloudcode-pa.googleapis.com:443, timeout: 10000ms)');
    cause.code = 'UND_ERR_CONNECT_TIMEOUT';
    return new TypeError('fetch failed', { cause });
}

class MockAccountManager {
    constructor() {
        this.account = { email: 'test@example.com', enabled: true };
        this.calls = [];
    }
    getAccountCount() { return 1; }
    clearExpiredLimits() {}
    getAvailableAccounts() { return [this.account]; }
    isAllAccountsInvalid() { return false; }
    getInvalidAccounts() { return []; }
    isAllRateLimited() { return false; }
    getMinWaitTimeMs() { return 0; }
    selectAccount() { return { account: this.account, waitMs: 0 }; }
    async getTokenForAccount() { return 'token'; }
    async getProjectForAccount() { return 'project-id'; }
    markRateLimited(...args) { this.calls.push(['markRateLimited', ...args]); }
    markInvalid(...args) { this.calls.push(['markInvalid', ...args]); }
    notifySuccess() { this.calls.push(['notifySuccess']); }
    notifyFailure() { this.calls.push(['notifyFailure']); }
    notifyRateLimit() { this.calls.push(['notifyRateLimit']); }
    getConsecutiveFailures() { return 0; }
    incrementConsecutiveFailures() { this.calls.push(['incrementConsecutiveFailures']); return 1; }
    clearTokenCache() {}
    clearProjectCache() {}
    penalties() {
        return this.calls.filter(([name]) =>
            ['markRateLimited', 'markInvalid', 'notifyFailure', 'notifyRateLimit', 'incrementConsecutiveFailures'].includes(name));
    }
}

const request = {
    model: 'gemini-2.5-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }]
};

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          NETWORK ERRORS & DNS ORDER TEST SUITE (#384)        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const dns = require('dns');
    const { isNetworkError, describeNetworkError } = await import('../src/utils/helpers.js');
    const { resolveDnsResultOrder } = await import('../src/utils/dns-order.js');
    const { isRateLimitError } = await import('../src/errors.js');

    // ─────────────────────────────────────────────────────────────────────
    console.log('── isNetworkError() ──────────────────────────────────────────');

    await test('spots "fetch failed" with a connect timeout cause', () => {
        assert(isNetworkError(connectTimeout()));
    });

    await test('spots a cause code when the message says nothing useful', () => {
        const cause = new Error('connect');
        cause.code = 'ENETUNREACH';
        assert(isNetworkError(new Error('request broke', { cause })));
    });

    await test('spots a code inside AggregateError (all addresses failed)', () => {
        const v6 = Object.assign(new Error('connect'), { code: 'EHOSTUNREACH' });
        const v4 = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
        const agg = new AggregateError([v6, v4], 'all failed');
        assert(isNetworkError(new Error('request broke', { cause: agg })));
    });

    await test('spots AUTH_NETWORK_ERROR from a failed token refresh', () => {
        assert(isNetworkError(new Error('AUTH_NETWORK_ERROR: fetch failed')));
    });

    await test('does not call a 429 or 400 a network error', () => {
        assert(!isNetworkError(new Error('429 RESOURCE_EXHAUSTED: quota')));
        assert(!isNetworkError(new Error('invalid_request_error: bad schema')));
    });

    await test('does not call a 400 that mentions "timeout" a network error', () => {
        // Claude Code's Bash tool has a `timeout` parameter, so schema errors can name it
        assert(!isNetworkError(new Error('invalid_request_error: {"error":{"code":400,"message":"properties[timeout]: unsupported \'maximum\'"}}')));
    });

    await test('handles null and errors without a message', () => {
        assert(!isNetworkError(null));
        assert(!isNetworkError({}));
    });

    await test('describeNetworkError includes the cause code', () => {
        const text = describeNetworkError(connectTimeout());
        assert(text.startsWith('fetch failed (UND_ERR_CONNECT_TIMEOUT:'), text);
    });

    await test('a network error message is never read as a rate limit', () => {
        assert(!isRateLimitError(new Error(`Network error: could not reach Google Cloud Code (${describeNetworkError(connectTimeout())})`)));
    });

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n── DNS result order ──────────────────────────────────────────');

    await test('defaults to ipv4first', () => {
        const r = resolveDnsResultOrder({ env: {}, execArgv: [] });
        assert(r.order === 'ipv4first' && r.source === 'default', JSON.stringify(r));
    });

    await test('importing the module applied ipv4first to Node', () => {
        if (parentNodeOptions.includes('--dns-result-order')) {
            console.log('    (skipped: NODE_OPTIONS sets --dns-result-order)');
            return;
        }
        assert(dns.getDefaultResultOrder() === 'ipv4first', dns.getDefaultResultOrder());
    });

    await test('keeps --dns-result-order from NODE_OPTIONS', () => {
        const r = resolveDnsResultOrder({ env: { NODE_OPTIONS: '--dns-result-order=verbatim' }, execArgv: [] });
        assert(r.order === null, JSON.stringify(r));
    });

    await test('keeps --dns-result-order from the node command line', () => {
        const r = resolveDnsResultOrder({ env: {}, execArgv: ['--dns-result-order=ipv6first'] });
        assert(r.order === null, JSON.stringify(r));
    });

    await test('DNS_RESULT_ORDER sets the order directly', () => {
        const r = resolveDnsResultOrder({ env: { DNS_RESULT_ORDER: 'Verbatim' }, execArgv: [] });
        assert(r.order === 'verbatim' && r.source === 'DNS_RESULT_ORDER', JSON.stringify(r));
    });

    await test('an invalid DNS_RESULT_ORDER falls back to ipv4first', () => {
        const r = resolveDnsResultOrder({ env: { DNS_RESULT_ORDER: 'ipv5' }, execArgv: [] });
        assert(r.order === 'ipv4first', JSON.stringify(r));
    });

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n── Handlers on network errors ────────────────────────────────');

    const { sendMessage } = await import('../src/cloudcode/message-handler.js');
    const { sendMessageStream } = await import('../src/cloudcode/streaming-handler.js');
    const realFetch = global.fetch;

    await test('sendMessage: no cooldown or penalty, ends with "Network error"', async () => {
        const am = new MockAccountManager();
        let fetches = 0;
        global.fetch = async () => { fetches++; throw connectTimeout(); };
        let thrown;
        try {
            await sendMessage(request, am, true);
        } catch (e) {
            thrown = e;
        } finally {
            global.fetch = realFetch;
        }
        assert(thrown, 'expected an error');
        assert(thrown.message.startsWith('Network error:'), thrown.message);
        assert(!/RESOURCE_EXHAUSTED|quota/i.test(thrown.message), thrown.message);
        assert(am.penalties().length === 0, JSON.stringify(am.penalties()));
        assert(fetches > 1, `expected retries, got ${fetches} fetch(es)`);
    });

    await test('sendMessageStream: no cooldown or penalty, ends with "Network error"', async () => {
        const am = new MockAccountManager();
        global.fetch = async () => { throw connectTimeout(); };
        let thrown;
        try {
            for await (const _ of sendMessageStream(request, am, true)) { /* drain */ }
        } catch (e) {
            thrown = e;
        } finally {
            global.fetch = realFetch;
        }
        assert(thrown, 'expected an error');
        assert(thrown.message.startsWith('Network error:'), thrown.message);
        assert(am.penalties().length === 0, JSON.stringify(am.penalties()));
    });

    await test('sendMessage: one network error, then success, returns the reply', async () => {
        const am = new MockAccountManager();
        let fetches = 0;
        global.fetch = async () => {
            fetches++;
            if (fetches === 1) throw connectTimeout();
            return new Response(JSON.stringify({
                response: {
                    candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
                }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        let result;
        try {
            result = await sendMessage(request, am, false);
        } finally {
            global.fetch = realFetch;
        }
        const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        assert(text === 'hello', `unexpected reply: ${JSON.stringify(result)}`);
        assert(am.penalties().length === 0, JSON.stringify(am.penalties()));
        assert(am.calls.some(([n]) => n === 'notifySuccess'), 'expected notifySuccess');
    });

    await test('sendMessageStream: a 400 that mentions "timeout" fails at once, not as a network error', async () => {
        const am = new MockAccountManager();
        let fetches = 0;
        const body = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: "properties[timeout]: unsupported 'maximum'" } });
        global.fetch = async () => { fetches++; return new Response(body, { status: 400 }); };
        let thrown;
        try {
            for await (const _ of sendMessageStream(request, am, true)) { /* drain */ }
        } catch (e) {
            thrown = e;
        } finally {
            global.fetch = realFetch;
        }
        assert(thrown, 'expected an error');
        assert(thrown.message.startsWith('invalid_request_error'), thrown.message);
        assert(fetches === 1, `expected 1 fetch, got ${fetches}`);
    });

    await test('sendMessageStream: a connection drop mid-stream is not retried into the same reply', async () => {
        const am = new MockAccountManager();
        let fetches = 0;
        global.fetch = async () => {
            fetches++;
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}\n\n'));
                    setTimeout(() => {
                        const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
                        controller.error(new TypeError('terminated', { cause }));
                    }, 10);
                }
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        };
        const events = [];
        let thrown;
        try {
            for await (const ev of sendMessageStream(request, am, true)) { events.push(ev.type); }
        } catch (e) {
            thrown = e;
        } finally {
            global.fetch = realFetch;
        }
        const starts = events.filter(t => t === 'message_start').length;
        assert(thrown, 'expected the drop to reach the client as an error');
        assert(fetches === 1, `expected 1 fetch, got ${fetches}`);
        assert(starts === 1, `expected 1 message_start, got ${starts}`);
    });

    console.log('\n── Error replies ─────────────────────────────────────────────');

    await test('a token refresh that cannot reach Google replies 503 "Network error"', async () => {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neterr-home-'));
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        const { parseError } = await import('../src/server.js');
        const r = parseError(new Error('AUTH_NETWORK_ERROR: fetch failed'));
        assert(r.statusCode === 503, `status ${r.statusCode}`);
        assert(r.errorType === 'api_error', r.errorType);
        assert(r.errorMessage.startsWith('Network error:') && r.errorMessage.includes('fetch failed'), r.errorMessage);
        const q = parseError(new Error('Network error: could not reach Google Cloud Code (fetch failed). Check your internet connection or proxy settings.'));
        assert(q.statusCode === 503, `status ${q.statusCode}`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
    console.error(e);
    process.exit(1);
});
