/**
 * Test for 403 VALIDATION_REQUIRED Account Rotation (Issue #248)
 *
 * Validates that when an account receives a 403 PERMISSION_DENIED / VALIDATION_REQUIRED
 * error, the proxy rotates to the next account instead of only cycling through endpoints.
 *
 * Tests:
 * 1. isValidationRequired() correctly detects account-level 403 errors
 * 2. isAccountForbiddenError() correctly classifies errors for account rotation
 * 3. AccountForbiddenError class works correctly
 * 4. Non-validation 403 errors (e.g., 404-like) still fall through to endpoint rotation
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║       403 ACCOUNT ROTATION TEST SUITE (Issue #248)          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const {
        AccountForbiddenError,
        isAccountForbiddenError,
        isRateLimitError,
        isAuthError
    } = await import('../src/errors.js');

    const {
        isValidationRequired,
        extractVerificationUrl,
        isPermanentAuthFailure,
        isModelCapacityExhausted
    } = await import('../src/cloudcode/rate-limit-state.js');

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

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    function assertTrue(value, message = '') {
        if (!value) {
            throw new Error(message || 'Expected true but got false');
        }
    }

    function assertFalse(value, message = '') {
        if (value) {
            throw new Error(message || 'Expected false but got true');
        }
    }

    // =========================================================================
    // Test Group 1: isValidationRequired() detection
    // =========================================================================
    console.log('\n── isValidationRequired() Detection ──────────────────────────');

    test('detects VALIDATION_REQUIRED in error text', () => {
        assertTrue(isValidationRequired(
            '{"error":{"code":403,"message":"VALIDATION_REQUIRED: Please complete account validation","status":"PERMISSION_DENIED"}}'
        ));
    });

    test('does NOT match generic PERMISSION_DENIED (too broad)', () => {
        assertFalse(isValidationRequired(
            '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED"}}'
        ));
    });

    test('does NOT match generic "forbidden" (too broad)', () => {
        assertFalse(isValidationRequired(
            '{"error":{"code":403,"message":"Forbidden: some generic error"}}'
        ));
    });

    test('does NOT match generic ACCESS_DENIED (too broad)', () => {
        assertFalse(isValidationRequired(
            '{"error":{"code":403,"message":"Access denied for this account"}}'
        ));
    });

    test('detects ACCOUNT_DISABLED in error text', () => {
        assertTrue(isValidationRequired(
            '{"error":{"code":403,"message":"account_disabled: This account has been disabled"}}'
        ));
    });

    test('detects USER_DISABLED in error text', () => {
        assertTrue(isValidationRequired(
            '{"error":{"code":403,"message":"user_disabled: User account is disabled"}}'
        ));
    });

    test('does NOT detect generic 404 error', () => {
        assertFalse(isValidationRequired(
            '{"error":{"code":404,"message":"Resource not found"}}'
        ));
    });

    test('does NOT detect rate limit errors', () => {
        assertFalse(isValidationRequired(
            '{"error":{"code":429,"message":"RESOURCE_EXHAUSTED: Quota exceeded"}}'
        ));
    });

    test('does NOT detect empty string', () => {
        assertFalse(isValidationRequired(''));
    });

    test('does NOT detect null', () => {
        assertFalse(isValidationRequired(null));
    });

    test('does NOT detect capacity exhausted', () => {
        assertFalse(isValidationRequired(
            '{"error":{"code":429,"message":"MODEL_CAPACITY_EXHAUSTED"}}'
        ));
    });

    // =========================================================================
    // Test Group 2: AccountForbiddenError class
    // =========================================================================
    console.log('\n── AccountForbiddenError Class ────────────────────────────────');

    test('creates AccountForbiddenError with correct properties', () => {
        const err = new AccountForbiddenError('Test forbidden', 'test@example.com');
        assertEqual(err.name, 'AccountForbiddenError');
        assertEqual(err.code, 'ACCOUNT_FORBIDDEN');
        assertEqual(err.accountEmail, 'test@example.com');
        assertEqual(err.retryable, false);
        assertTrue(err.message.includes('Test forbidden'));
    });

    test('AccountForbiddenError is instance of Error', () => {
        const err = new AccountForbiddenError('Test');
        assertTrue(err instanceof Error);
    });

    test('AccountForbiddenError toJSON includes metadata', () => {
        const err = new AccountForbiddenError('Test', 'user@test.com');
        const json = err.toJSON();
        assertEqual(json.code, 'ACCOUNT_FORBIDDEN');
        assertEqual(json.accountEmail, 'user@test.com');
    });

    // =========================================================================
    // Test Group 3: isAccountForbiddenError() classification
    // =========================================================================
    console.log('\n── isAccountForbiddenError() Classification ───────────────────');

    test('detects AccountForbiddenError instance', () => {
        const err = new AccountForbiddenError('Test');
        assertTrue(isAccountForbiddenError(err));
    });

    test('detects ACCOUNT_FORBIDDEN in error message', () => {
        const err = new Error('ACCOUNT_FORBIDDEN: validation required');
        assertTrue(isAccountForbiddenError(err));
    });

    test('does NOT match VALIDATION_REQUIRED plain string (use AccountForbiddenError class instead)', () => {
        const err = new Error('403 VALIDATION_REQUIRED: Please complete validation');
        assertFalse(isAccountForbiddenError(err));
    });

    test('does NOT match generic 403 + PERMISSION_DENIED (too broad)', () => {
        const err = new Error('API error 403: PERMISSION_DENIED');
        assertFalse(isAccountForbiddenError(err));
    });

    test('does NOT match generic 403 + FORBIDDEN (too broad)', () => {
        const err = new Error('API error 403: Forbidden');
        assertFalse(isAccountForbiddenError(err));
    });

    test('does NOT classify rate limit errors as forbidden', () => {
        const err = new Error('429 RESOURCE_EXHAUSTED');
        assertFalse(isAccountForbiddenError(err));
    });

    test('does NOT classify auth errors as forbidden', () => {
        const err = new Error('AUTH_INVALID: token expired');
        assertFalse(isAccountForbiddenError(err));
    });

    test('does NOT classify 500 errors as forbidden', () => {
        const err = new Error('API error 500: Internal server error');
        assertFalse(isAccountForbiddenError(err));
    });

    test('does NOT classify generic errors as forbidden', () => {
        const err = new Error('Something went wrong');
        assertFalse(isAccountForbiddenError(err));
    });

    // =========================================================================
    // Test Group 4: Error classification mutual exclusivity
    // =========================================================================
    console.log('\n── Error Classification Mutual Exclusivity ────────────────────');

    test('ACCOUNT_FORBIDDEN is not a rate limit error', () => {
        const err = new AccountForbiddenError('Test');
        assertFalse(isRateLimitError(err));
    });

    test('ACCOUNT_FORBIDDEN is not an auth error', () => {
        const err = new AccountForbiddenError('Test');
        assertFalse(isAuthError(err));
    });

    test('rate limit error is not account forbidden', () => {
        const err = new Error('429 RESOURCE_EXHAUSTED: quota exceeded');
        assertTrue(isRateLimitError(err));
        assertFalse(isAccountForbiddenError(err));
    });

    test('auth error is not account forbidden', () => {
        const err = new Error('AUTH_INVALID: invalid grant');
        assertTrue(isAuthError(err));
        assertFalse(isAccountForbiddenError(err));
    });

    // =========================================================================
    // Test Group 5: isValidationRequired vs other detectors (no overlap)
    // =========================================================================
    console.log('\n── Detector Mutual Exclusivity ─────────────────────────────────');

    test('VALIDATION_REQUIRED is not permanent auth failure', () => {
        const text = '{"error":{"code":403,"message":"VALIDATION_REQUIRED","status":"PERMISSION_DENIED"}}';
        assertTrue(isValidationRequired(text));
        assertFalse(isPermanentAuthFailure(text));
    });

    test('VALIDATION_REQUIRED is not model capacity exhausted', () => {
        const text = '{"error":{"code":403,"message":"VALIDATION_REQUIRED","status":"PERMISSION_DENIED"}}';
        assertTrue(isValidationRequired(text));
        assertFalse(isModelCapacityExhausted(text));
    });

    test('permanent auth failure is not validation required (unless it also says permission_denied)', () => {
        const text = '{"error":{"message":"invalid_grant: Token has been expired or revoked"}}';
        assertTrue(isPermanentAuthFailure(text));
        // This should NOT be validation required since it's a token issue
        assertFalse(isValidationRequired(text));
    });

    // =========================================================================
    // Test Group 6: extractVerificationUrl()
    // =========================================================================
    console.log('\n── extractVerificationUrl() ──────────────────────────────────');

    test('extracts Google verification URL from error message', () => {
        const errorText = '{"error":{"code":403,"message":"To continue, verify your account at\\n\\nhttps://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://aistudio.google.com\\n\\nLearn more","status":"PERMISSION_DENIED"}}';
        const url = extractVerificationUrl(errorText);
        assertTrue(url !== null, 'Should extract URL');
        assertTrue(url.startsWith('https://accounts.google.com/signin/continue'), 'URL should start with Google signin');
    });

    test('extracts URL with complex query parameters', () => {
        const errorText = 'Error: https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https%3A%2F%2Faistudio.google.com&foo=bar end';
        const url = extractVerificationUrl(errorText);
        assertTrue(url !== null, 'Should extract URL');
        assertTrue(url.includes('sarp=1'), 'Should include query params');
    });

    test('returns null when no verification URL present', () => {
        const errorText = '{"error":{"code":403,"message":"Generic permission denied","status":"PERMISSION_DENIED"}}';
        const url = extractVerificationUrl(errorText);
        assertEqual(url, null, 'Should return null for no URL');
    });

    test('returns null for empty string', () => {
        assertEqual(extractVerificationUrl(''), null);
    });

    test('returns null for null input', () => {
        assertEqual(extractVerificationUrl(null), null);
    });

    test('extracts validation_url from structured JSON details', () => {
        const errorText = JSON.stringify({
            error: {
                code: 403,
                message: "Verify your account to continue.",
                status: "PERMISSION_DENIED",
                details: [{
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason: "VALIDATION_REQUIRED",
                    domain: "cloudcode-pa.googleapis.com",
                    metadata: {
                        validation_url: "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsbuSMNHioDdPwkLy&flowName=GlifWebSignIn&authuser"
                    }
                }]
            }
        });
        const url = extractVerificationUrl(errorText);
        assertTrue(url !== null, 'Should extract URL from structured details');
        assertTrue(url.startsWith('https://accounts.google.com/signin/continue'), 'URL should start with Google signin');
        assertTrue(url.includes('flowName=GlifWebSignIn'), 'Should preserve full URL from metadata');
    });

    // =========================================================================
    // Test Group 7: Real-world 403 error payloads
    // =========================================================================
    console.log('\n── Real-world 403 Error Payloads ────────────────────────────────');

    test('Google API PERMISSION_DENIED with VALIDATION_REQUIRED', () => {
        const errorText = JSON.stringify({
            error: {
                code: 403,
                message: "Request had insufficient authentication scopes.",
                status: "PERMISSION_DENIED",
                details: [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        reason: "VALIDATION_REQUIRED",
                        domain: "googleapis.com"
                    }
                ]
            }
        });
        assertTrue(isValidationRequired(errorText));
    });

    test('Google API generic PERMISSION_DENIED (should NOT trigger - too broad)', () => {
        const errorText = JSON.stringify({
            error: {
                code: 403,
                message: "The caller does not have permission",
                status: "PERMISSION_DENIED"
            }
        });
        assertFalse(isValidationRequired(errorText));
    });

    test('Google API FORBIDDEN response (should NOT trigger - too broad)', () => {
        const errorText = JSON.stringify({
            error: {
                code: 403,
                message: "Forbidden",
                status: "FORBIDDEN"
            }
        });
        assertFalse(isValidationRequired(errorText));
    });

    // =========================================================================
    // Test Group 8: markInvalid() with verifyUrl (integration)
    // =========================================================================
    console.log('\n── markInvalid() with verifyUrl ──────────────────────────────');

    const { markInvalid } = await import('../src/account-manager/rate-limits.js');

    test('markInvalid stores verifyUrl as separate field', () => {
        const accounts = [{ email: 'test@example.com', enabled: true }];
        const verifyUrl = 'https://accounts.google.com/signin/continue?sarp=1&scc=1';
        markInvalid(accounts, 'test@example.com', 'Account requires verification', verifyUrl);
        assertTrue(accounts[0].isInvalid, 'isInvalid should be true');
        assertEqual(accounts[0].invalidReason, 'Account requires verification');
        assertEqual(accounts[0].verifyUrl, verifyUrl, 'verifyUrl should be stored separately');
    });

    test('markInvalid without verifyUrl sets verifyUrl to null', () => {
        const accounts = [{ email: 'test@example.com', enabled: true }];
        markInvalid(accounts, 'test@example.com', 'Token revoked');
        assertTrue(accounts[0].isInvalid, 'isInvalid should be true');
        assertEqual(accounts[0].verifyUrl, null, 'verifyUrl should be null for auth errors');
    });

    test('markInvalid sets invalidAt timestamp', () => {
        const accounts = [{ email: 'test@example.com', enabled: true }];
        const before = Date.now();
        markInvalid(accounts, 'test@example.com', 'Test reason');
        assertTrue(accounts[0].invalidAt >= before, 'invalidAt should be set');
        assertTrue(accounts[0].invalidAt <= Date.now(), 'invalidAt should be reasonable');
    });

    test('markInvalid returns false for unknown email', () => {
        const accounts = [{ email: 'test@example.com', enabled: true }];
        const result = markInvalid(accounts, 'unknown@example.com', 'Test');
        assertFalse(result, 'Should return false for unknown email');
    });

    test('verification error can be cleared by resetting fields', () => {
        const accounts = [{ email: 'test@example.com', enabled: true }];
        const verifyUrl = 'https://accounts.google.com/signin/continue?sarp=1';
        markInvalid(accounts, 'test@example.com', 'Account requires verification', verifyUrl);

        // Simulate what the refresh endpoint does for verification errors
        assertTrue(accounts[0].isInvalid && accounts[0].verifyUrl, 'Should have verifyUrl');
        accounts[0].isInvalid = false;
        accounts[0].invalidReason = null;
        accounts[0].verifyUrl = null;

        assertFalse(accounts[0].isInvalid, 'isInvalid should be cleared');
        assertEqual(accounts[0].verifyUrl, null, 'verifyUrl should be cleared');
    });

    test('auth error (no verifyUrl) is NOT cleared by refresh logic', () => {
        const accounts = [{ email: 'test@example.com', enabled: true }];
        markInvalid(accounts, 'test@example.com', 'Token revoked');

        // Simulate refresh endpoint check: only clears if verifyUrl exists
        const shouldClear = accounts[0].isInvalid && accounts[0].verifyUrl;
        assertFalse(shouldClear, 'Auth errors should NOT be auto-cleared on refresh');
        assertTrue(accounts[0].isInvalid, 'isInvalid should remain true');
    });

    // =========================================================================
    // Summary
    // =========================================================================
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('══════════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        console.error(`❌ ${failed} test(s) failed!`);
        process.exit(1);
    } else {
        console.log('✅ All tests passed!');
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
