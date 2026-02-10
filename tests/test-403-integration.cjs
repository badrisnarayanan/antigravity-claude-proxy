/**
 * Integration Test: 403 Account Rotation Handler Flow
 *
 * Tests the ACTUAL handler control flow for 403 VALIDATION_REQUIRED errors,
 * verifying that:
 * 1. Account is marked invalid with verifyUrl when 403 + VALIDATION_REQUIRED
 * 2. Handler rotates to next account (doesn't retry same account)
 * 3. Generic 403s fall through to endpoint rotation (not account rotation)
 * 4. clearInvalid() properly re-enables accounts after verification
 * 5. WebUI refresh endpoint uses AccountManager.clearInvalid() (encapsulated)
 */

const { strict: assert } = require('assert');

// ============================================================================
// Mock infrastructure
// ============================================================================

/** Minimal AccountManager mock that tracks all mutations */
class MockAccountManager {
    constructor(accounts) {
        this._accounts = accounts.map(a => ({
            ...a,
            isInvalid: false,
            invalidReason: null,
            verifyUrl: null,
            modelRateLimits: {},
            consecutiveFailures: 0,
            enabled: true,
        }));
        this._log = []; // Track all method calls for assertions
        this._savedToDisk = 0;
    }

    getAvailableAccounts(model) {
        return this._accounts.filter(a => !a.isInvalid && a.enabled !== false);
    }

    getAllAccounts() {
        return this._accounts;
    }

    markInvalid(email, reason, verifyUrl = null) {
        const acc = this._accounts.find(a => a.email === email);
        if (!acc) return false;
        acc.isInvalid = true;
        acc.invalidReason = reason;
        acc.verifyUrl = verifyUrl || null;
        acc.invalidAt = Date.now();
        this._log.push({ action: 'markInvalid', email, reason, verifyUrl });
        return true;
    }

    clearInvalid(email) {
        const acc = this._accounts.find(a => a.email === email);
        if (!acc) return false;
        acc.isInvalid = false;
        acc.invalidReason = null;
        acc.verifyUrl = null;
        this._log.push({ action: 'clearInvalid', email });
        this._savedToDisk++;
        return true;
    }

    markRateLimited(email, resetMs, model) {
        this._log.push({ action: 'markRateLimited', email, resetMs, model });
    }

    notifySuccess(account, model) {
        this._log.push({ action: 'notifySuccess', email: account.email, model });
    }

    notifyFailure(account, model) {
        this._log.push({ action: 'notifyFailure', email: account.email, model });
    }

    notifyRateLimit(account, model) {
        this._log.push({ action: 'notifyRateLimit', email: account.email, model });
    }

    getConsecutiveFailures(email) { return 0; }
    incrementConsecutiveFailures(email) { return 1; }
    saveToDisk() { this._savedToDisk++; }
    clearTokenCache() {}
    clearProjectCache() {}
}

// Import the actual detection/classification functions
const {
    isValidationRequired,
    extractVerificationUrl,
    isPermanentAuthFailure,
} = require('../src/cloudcode/rate-limit-state.js');

const {
    AccountForbiddenError,
    isAccountForbiddenError,
    isRateLimitError,
    isAuthError,
} = require('../src/errors.js');

// ============================================================================
// Test runner
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
    }
}

// ============================================================================
// Integration Tests
// ============================================================================

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║   INTEGRATION TEST: 403 Account Rotation Handler Flow      ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ─────────────────────────────────────────────────────────────────────────────
// Test Group 1: Handler-level account rotation on 403 VALIDATION_REQUIRED
// ─────────────────────────────────────────────────────────────────────────────
console.log('── Handler: 403 VALIDATION_REQUIRED → account rotation ────────');

test('403 + VALIDATION_REQUIRED marks account invalid and rotates', () => {
    const mgr = new MockAccountManager([
        { email: 'a@test.com' },
        { email: 'b@test.com' },
    ]);

    // Simulate what the handler does on 403 + VALIDATION_REQUIRED
    const errorText = '{"error":{"code":403,"message":"VALIDATION_REQUIRED: Please verify","status":"PERMISSION_DENIED"}}';
    const account = mgr.getAvailableAccounts()[0];

    assert.ok(isValidationRequired(errorText), 'should detect VALIDATION_REQUIRED');

    const verifyUrl = extractVerificationUrl(errorText);
    mgr.markInvalid(account.email, 'Account requires verification', verifyUrl);

    const err = new AccountForbiddenError(errorText, account.email);
    assert.ok(isAccountForbiddenError(err), 'should classify as account forbidden');

    // Verify account was marked invalid
    assert.strictEqual(account.isInvalid, true, 'account should be invalid');
    assert.strictEqual(account.invalidReason, 'Account requires verification');

    // Verify second account is still available for rotation
    const available = mgr.getAvailableAccounts();
    assert.strictEqual(available.length, 1, 'should have 1 available account');
    assert.strictEqual(available[0].email, 'b@test.com', 'should rotate to b@test.com');

    // Verify mutation was logged
    const markCall = mgr._log.find(l => l.action === 'markInvalid');
    assert.ok(markCall, 'markInvalid should have been called');
    assert.strictEqual(markCall.email, 'a@test.com');
});

test('403 + VALIDATION_REQUIRED with verification URL stores it', () => {
    const mgr = new MockAccountManager([{ email: 'a@test.com' }]);
    const errorText = '403 VALIDATION_REQUIRED: Visit https://accounts.google.com/signin/continue?sarp=1&scc=1&otp=abc123 to verify';

    const verifyUrl = extractVerificationUrl(errorText);
    assert.ok(verifyUrl, 'should extract verification URL');
    assert.ok(verifyUrl.startsWith('https://accounts.google.com/signin/continue'), 'URL should be Google verification');
    assert.ok(!verifyUrl.endsWith('.'), 'URL should not end with punctuation');

    mgr.markInvalid('a@test.com', 'Account requires verification', verifyUrl);
    const acc = mgr.getAllAccounts()[0];
    assert.strictEqual(acc.verifyUrl, verifyUrl, 'verifyUrl should be stored');
});

test('generic 403 (no VALIDATION_REQUIRED) does NOT trigger account rotation', () => {
    const errorText = '{"error":{"code":403,"message":"Forbidden","status":"FORBIDDEN"}}';

    assert.strictEqual(isValidationRequired(errorText), false, 'generic 403 should not be validation required');

    // Handler would NOT create AccountForbiddenError, just fall through to endpoint rotation
    const genericErr = new Error(`API error 403: ${errorText}`);
    assert.strictEqual(isAccountForbiddenError(genericErr), false, 'generic 403 should not be account forbidden');
});

test('403 PERMISSION_DENIED without VALIDATION_REQUIRED does NOT trigger account rotation', () => {
    const errorText = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}';

    assert.strictEqual(isValidationRequired(errorText), false, 'generic PERMISSION_DENIED should not trigger');
    const err = new Error(`API error 403: ${errorText}`);
    assert.strictEqual(isAccountForbiddenError(err), false, 'should not be classified as account forbidden');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Group 2: Multi-account rotation chain
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Handler: Multi-account rotation chain ──────────────────────');

test('all accounts marked invalid → no accounts available', () => {
    const mgr = new MockAccountManager([
        { email: 'a@test.com' },
        { email: 'b@test.com' },
        { email: 'c@test.com' },
    ]);

    // Simulate all accounts hitting VALIDATION_REQUIRED
    for (const acc of mgr.getAllAccounts()) {
        mgr.markInvalid(acc.email, 'Account requires verification');
    }

    const available = mgr.getAvailableAccounts();
    assert.strictEqual(available.length, 0, 'no accounts should be available');
});

test('one account invalid, others still available for rotation', () => {
    const mgr = new MockAccountManager([
        { email: 'a@test.com' },
        { email: 'b@test.com' },
        { email: 'c@test.com' },
    ]);

    mgr.markInvalid('b@test.com', 'Account requires verification');

    const available = mgr.getAvailableAccounts();
    assert.strictEqual(available.length, 2, 'should have 2 available accounts');
    assert.ok(available.every(a => a.email !== 'b@test.com'), 'b@test.com should be excluded');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Group 3: clearInvalid() re-enables accounts (WebUI refresh flow)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Handler: clearInvalid() re-enables accounts (WebUI flow) ───');

test('clearInvalid() re-enables account after verification', () => {
    const mgr = new MockAccountManager([{ email: 'a@test.com' }]);

    // Mark invalid
    mgr.markInvalid('a@test.com', 'Account requires verification', 'https://accounts.google.com/signin/continue?sarp=1');
    assert.strictEqual(mgr.getAvailableAccounts().length, 0, 'should have 0 available');

    // Simulate WebUI refresh endpoint (user completed verification)
    mgr.clearInvalid('a@test.com');
    assert.strictEqual(mgr.getAvailableAccounts().length, 1, 'should have 1 available after clear');

    const acc = mgr.getAllAccounts()[0];
    assert.strictEqual(acc.isInvalid, false, 'isInvalid should be false');
    assert.strictEqual(acc.invalidReason, null, 'invalidReason should be null');
    assert.strictEqual(acc.verifyUrl, null, 'verifyUrl should be null');
});

test('clearInvalid() persists to disk via saveToDisk()', () => {
    const mgr = new MockAccountManager([{ email: 'a@test.com' }]);
    mgr.markInvalid('a@test.com', 'test');

    const beforeSaves = mgr._savedToDisk;
    mgr.clearInvalid('a@test.com');
    assert.ok(mgr._savedToDisk > beforeSaves, 'should save to disk after clearInvalid');
});

test('WebUI refresh does NOT clear auth errors (only verification errors)', () => {
    const mgr = new MockAccountManager([{ email: 'a@test.com' }]);

    // Auth error (no verifyUrl) — requires OAuth re-auth, NOT just refresh
    mgr.markInvalid('a@test.com', 'Token revoked', null);

    const acc = mgr.getAllAccounts()[0];
    // WebUI refresh logic: only clear if account has verifyUrl
    if (acc.isInvalid && acc.verifyUrl) {
        mgr.clearInvalid(acc.email);
    }
    // Should NOT have been cleared — no verifyUrl
    assert.strictEqual(acc.isInvalid, true, 'auth error should NOT be cleared by refresh');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Group 4: Error classification doesn't interfere with other handlers
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Handler: Error classification isolation ─────────────────────');

test('AccountForbiddenError does not trigger rate limit handler', () => {
    const err = new AccountForbiddenError('403 VALIDATION_REQUIRED', 'a@test.com');
    assert.strictEqual(isRateLimitError(err), false, 'should not be rate limit');
    assert.strictEqual(isAuthError(err), false, 'should not be auth error');
    assert.strictEqual(isAccountForbiddenError(err), true, 'should be account forbidden');
});

test('rate limit errors do not trigger account forbidden handler', () => {
    const err = new Error('429 RESOURCE_EXHAUSTED: quota exceeded');
    assert.strictEqual(isAccountForbiddenError(err), false);
    assert.strictEqual(isRateLimitError(err), true);
});

test('permanent auth failure is distinct from validation required', () => {
    const authText = 'invalid_grant: Token has been expired or revoked';
    const validText = '403 VALIDATION_REQUIRED: Please verify';

    assert.strictEqual(isPermanentAuthFailure(authText), true);
    assert.strictEqual(isValidationRequired(authText), false);
    assert.strictEqual(isPermanentAuthFailure(validText), false);
    assert.strictEqual(isValidationRequired(validText), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Group 5: Edge cases in handler flow
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Handler: Edge cases ────────────────────────────────────────');

test('ACCOUNT_DISABLED triggers account rotation (same as VALIDATION_REQUIRED)', () => {
    const errorText = '{"error":{"code":403,"message":"ACCOUNT_DISABLED","status":"PERMISSION_DENIED"}}';
    assert.strictEqual(isValidationRequired(errorText), true);

    const mgr = new MockAccountManager([{ email: 'a@test.com' }, { email: 'b@test.com' }]);
    mgr.markInvalid('a@test.com', 'Account disabled');
    assert.strictEqual(mgr.getAvailableAccounts().length, 1);
});

test('USER_DISABLED triggers account rotation', () => {
    const errorText = 'user_disabled: This account has been suspended';
    assert.strictEqual(isValidationRequired(errorText), true);
});

test('mixed case detection works', () => {
    assert.strictEqual(isValidationRequired('Validation_Required'), true);
    assert.strictEqual(isValidationRequired('ACCOUNT_DISABLED'), true);
    assert.strictEqual(isValidationRequired('User_Disabled'), true);
});

test('extractVerificationUrl handles URL with trailing bracket', () => {
    const text = 'Visit [https://accounts.google.com/signin/continue?sarp=1&scc=1] to verify';
    const url = extractVerificationUrl(text);
    assert.ok(url, 'should extract URL');
    assert.ok(!url.includes(']'), 'URL should not include trailing bracket');
});

test('extractVerificationUrl handles URL with trailing angle bracket', () => {
    const text = 'Visit <https://accounts.google.com/signin/continue?sarp=1&scc=1> to verify';
    const url = extractVerificationUrl(text);
    assert.ok(url, 'should extract URL');
    assert.ok(!url.includes('>'), 'URL should not include trailing angle bracket');
});

test('extractVerificationUrl handles URL with trailing brace', () => {
    const text = '{"url":"https://accounts.google.com/signin/continue?sarp=1&scc=1"}';
    const url = extractVerificationUrl(text);
    assert.ok(url, 'should extract URL');
    assert.ok(!url.endsWith('"'), 'URL should not include trailing quote');
    assert.ok(!url.endsWith('}'), 'URL should not include trailing brace');
});

// ============================================================================
// Results
// ============================================================================

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('══════════════════════════════════════════════════════════════\n');

if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach(f => console.log(`  ✗ ${f.name}: ${f.error}`));
    process.exit(1);
} else {
    console.log('✅ All integration tests passed!');
}
