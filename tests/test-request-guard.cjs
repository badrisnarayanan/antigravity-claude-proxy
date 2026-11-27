/**
 * Test Request Guard - Verifies the WebUI/admin protections
 *
 * Covers Host header checks (DNS rebinding), Origin checks (cross-site
 * requests), loopback-only admin access without a WebUI password, and the
 * Claude Code settings allow-list that keeps hooks and command-running keys
 * out of settings.json.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               REQUEST GUARD TEST SUITE                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const guard = await import('../src/utils/request-guard.js');
    const claudeConfig = await import('../src/utils/claude-config.js');
    const { DEFAULT_PRESETS } = await import('../src/constants.js');

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

    function assert(cond, msg) {
        if (!cond) throw new Error(msg || 'assertion failed');
    }

    function run(cfg, { host = 'localhost:8080', origin, path = '/api/claude/config', method = 'POST', remote = '127.0.0.1', isProtected } = {}) {
        const mw = guard.createRequestGuard({ getConfig: () => cfg, ...(isProtected ? { isProtected } : {}) });
        const headers = { host };
        if (origin !== undefined) headers.origin = origin;
        const req = { headers, path, method, socket: { remoteAddress: remote } };
        let status = 200;
        let nextCalled = false;
        const res = { status(c) { status = c; return this; }, json() { return this; } };
        mw(req, res, () => { nextCalled = true; });
        return nextCalled ? 200 : status;
    }

    test('Allows same-origin WebUI request on localhost', () => {
        assert(run({}, { origin: 'http://localhost:8080' }) === 200);
    });

    test('Allows non-browser client with no Origin', () => {
        assert(run({}, { path: '/api/claude/config' }) === 200);
    });

    test('Blocks cross-origin POST to Claude config', () => {
        assert(run({}, { origin: 'https://evil.example' }) === 403);
    });

    test('Blocks Origin: null (sandboxed iframe)', () => {
        assert(run({}, { origin: 'null' }) === 403);
    });

    test('Blocks DNS-rebinding Host header', () => {
        assert(run({}, { host: 'attacker.example:8080', origin: 'http://attacker.example:8080' }) === 403);
        assert(run({}, { host: 'attacker.example:8080' }) === 403);
    });

    test('Allows IP-literal hosts (LAN use by IP)', () => {
        assert(run({ webuiPassword: 'x' }, { host: '192.168.1.20:8080', origin: 'http://192.168.1.20:8080', remote: '192.168.1.30' }) === 200);
        assert(run({}, { host: '[::1]:8080' }) === 200);
    });

    test('Allows hosts listed in allowedHosts', () => {
        assert(run({ allowedHosts: ['proxy.lan'] }, { host: 'proxy.lan:8080' }) === 200);
    });

    test('Allows origins listed in corsOrigins', () => {
        assert(run({ corsOrigins: 'https://tool.example' }, { origin: 'https://tool.example' }) === 200);
    });

    test('Blocks remote admin access when no WebUI password is set', () => {
        assert(run({}, { host: '192.168.1.20:8080', remote: '192.168.1.30' }) === 403);
        assert(run({}, { host: '192.168.1.20:8080', remote: '::ffff:192.168.1.30', path: '/account-limits', method: 'GET' }) === 403);
    });

    test('Allows remote /v1 access without WebUI password (API key governs it)', () => {
        assert(run({}, { host: '192.168.1.20:8080', remote: '192.168.1.30', path: '/v1/messages' }) === 200);
    });

    test('Leaves /v1 alone for any hostname (pasted proxy URLs keep working)', () => {
        assert(run({}, { host: 'myproxy.example.com', remote: '203.0.113.9', path: '/v1/messages' }) === 200);
        assert(run({}, { host: 'myproxy.example.com', remote: '203.0.113.9', path: '/v1/models', method: 'GET', origin: 'https://some-app.example' }) === 200);
    });

    test('Still guards admin paths reached through a hostname', () => {
        assert(run({ webuiPassword: 'x' }, { host: 'myproxy.example.com', remote: '203.0.113.9', path: '/api/accounts', method: 'GET' }) === 403);
        assert(run({ webuiPassword: 'x', allowedHosts: 'myproxy.example.com' }, { host: 'myproxy.example.com', remote: '203.0.113.9', path: '/api/accounts', method: 'GET' }) === 200);
    });

    test('Default guard leaves /v1/account-quotas to the API key check', () => {
        assert(run({}, { path: '/v1/account-quotas', method: 'GET', remote: '203.0.113.9' }) === 200);
    });

    test('isProtected guard blocks /v1/account-quotas from another machine without a WebUI password', () => {
        assert(run({}, { path: '/v1/account-quotas', method: 'GET', remote: '203.0.113.9', isProtected: () => true }) === 403);
    });

    test('isProtected guard blocks cross-origin /v1/account-quotas', () => {
        assert(run({}, { path: '/v1/account-quotas', method: 'GET', origin: 'https://evil.example', isProtected: () => true }) === 403);
    });

    test('isProtected guard allows local /v1/account-quotas with no Origin', () => {
        assert(run({}, { path: '/v1/account-quotas', method: 'GET', isProtected: () => true }) === 200);
    });

    test('Treats ::ffff:127.0.0.1 as loopback', () => {
        assert(guard.isLoopbackAddress('::ffff:127.0.0.1'));
        assert(!guard.isLoopbackAddress('10.0.0.5'));
    });

    test('safeEqual compares correctly', () => {
        assert(guard.safeEqual('abc', 'abc'));
        assert(!guard.safeEqual('abc', 'abd'));
        assert(!guard.safeEqual('abc', 'abcd'));
        assert(!guard.safeEqual(undefined, 'abc'));
    });

    test('Claude config update drops hooks and other top-level keys', () => {
        const { updates, ignored } = claudeConfig.sanitizeClaudeConfigUpdate({
            env: { ANTHROPIC_BASE_URL: 'http://localhost:8080' },
            hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch /tmp/x' }] }] },
            apiKeyHelper: 'sh -c id',
            statusLine: { type: 'command', command: 'id' }
        });
        assert(JSON.stringify(updates) === JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:8080' } }), JSON.stringify(updates));
        assert(ignored.includes('hooks') && ignored.includes('apiKeyHelper') && ignored.includes('statusLine'));
    });

    test('Claude config update drops command-running env vars', () => {
        const { updates, ignored } = claudeConfig.sanitizeClaudeConfigUpdate({
            env: { ANTHROPIC_MODEL: 'claude-opus-5-5', CLAUDE_CODE_SHELL_PREFIX: 'evil', NODE_OPTIONS: '--require /tmp/x.js', MAX_THINKING_TOKENS: 1000 }
        });
        assert(updates.env.ANTHROPIC_MODEL === 'claude-opus-5-5');
        assert(updates.env.MAX_THINKING_TOKENS === '1000');
        assert(!('CLAUDE_CODE_SHELL_PREFIX' in updates.env) && !('NODE_OPTIONS' in updates.env));
        assert(ignored.includes('env.CLAUDE_CODE_SHELL_PREFIX') && ignored.includes('env.NODE_OPTIONS'));
    });

    test('Claude config update with no env changes nothing', () => {
        const { updates } = claudeConfig.sanitizeClaudeConfigUpdate({ hooks: {} });
        assert(Object.keys(updates).length === 0);
    });

    test('Default presets only use allow-listed env vars', () => {
        for (const preset of DEFAULT_PRESETS) {
            for (const key of Object.keys(preset.config)) {
                assert(claudeConfig.ALLOWED_CLAUDE_ENV_KEYS.has(key), `${preset.name}: ${key}`);
            }
        }
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
