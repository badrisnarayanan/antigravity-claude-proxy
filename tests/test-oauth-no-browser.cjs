/**
 * OAuth No-Browser Mode Unit Tests
 *
 * Tests the extractCodeFromInput() function which enables OAuth authentication
 * on headless servers without a desktop environment.
 *
 * ============================================================================
 * FEATURE: --no-browser OAuth Mode
 * ============================================================================
 *
 * PURPOSE:
 *   Allow users to add Google accounts on remote servers (headless Linux,
 *   Docker containers, SSH sessions) where automatic browser opening is
 *   not possible.
 *
 * USAGE:
 *   npm run accounts:add -- --no-browser
 *
 * USER FLOW:
 *   1. User runs command on headless server
 *   2. System displays Google OAuth URL
 *   3. User opens URL on another device (phone/laptop) with a browser
 *   4. User signs in to Google and authorizes the app
 *   5. Browser redirects to localhost (page won't load - this is expected)
 *   6. User copies the redirect URL or authorization code from address bar
 *   7. User pastes into server terminal
 *   8. System extracts code using extractCodeFromInput() (tested here)
 *   9. Account is added successfully
 *
 * FUNCTION UNDER TEST:
 *   extractCodeFromInput(input: string) => { code: string, state: string|null }
 *
 *   Accepts either:
 *   - Full callback URL: http://localhost:51121/callback?code=xxx&state=yyy
 *   - Raw authorization code: 4/0AQSTgQG...
 *
 *   Throws on:
 *   - Empty/null input
 *   - Too short input (< 10 chars)
 *   - URL with OAuth error parameter
 *   - URL without code parameter
 *
 * ============================================================================
 *
 * Run: node tests/test-oauth-no-browser.cjs
 */

// Note: Using dynamic import because oauth.js is ESM
async function runTests() {
    console.log('='.repeat(60));
    console.log('OAUTH NO-BROWSER MODE UNIT TESTS');
    console.log('Testing: extractCodeFromInput()');
    console.log('='.repeat(60));
    console.log('');

    // Import the ESM module
    const { extractCodeFromInput } = await import('../src/auth/oauth.js');

    let allPassed = true;
    const results = [];

    /**
     * Helper to run a single test case
     * @param {string} name - Test name
     * @param {Function} testFn - Test function that returns { passed, message }
     */
    async function test(name, testFn) {
        try {
            const { passed, message } = await testFn();
            results.push({ name, passed, message });
            const status = passed ? 'PASS' : 'FAIL';
            console.log(`  [${status}] ${name}`);
            if (message) console.log(`         ${message}`);
            if (!passed) allPassed = false;
        } catch (error) {
            results.push({ name, passed: false, message: error.message });
            console.log(`  [FAIL] ${name}`);
            console.log(`         Error: ${error.message}`);
            allPassed = false;
        }
    }

    // ===== Test Group 1: Valid URL Inputs =====
    console.log('\n--- Valid URL Inputs ---');

    await test('Parse full callback URL with code and state', () => {
        const input = 'http://localhost:51121/oauth-callback?code=4/0AQSTg123&state=abc123';
        const result = extractCodeFromInput(input);
        const passed = result.code === '4/0AQSTg123' && result.state === 'abc123' && result.redirectUri === 'http://localhost:51121/oauth-callback';
        return { passed, message: `code=${result.code}, state=${result.state}, redirectUri=${result.redirectUri}` };
    });

    await test('Parse URL with only code (no state)', () => {
        const input = 'http://localhost:51121/oauth-callback?code=4/0AQSTg456';
        const result = extractCodeFromInput(input);
        const passed = result.code === '4/0AQSTg456' && result.state === null && result.redirectUri === 'http://localhost:51121/oauth-callback';
        return { passed, message: `code=${result.code}, state=${result.state}, redirectUri=${result.redirectUri}` };
    });

    await test('Parse HTTPS URL', () => {
        const input = 'https://localhost:51121/callback?code=secureCode123&state=xyz';
        const result = extractCodeFromInput(input);
        const passed = result.code === 'secureCode123' && result.redirectUri === 'https://localhost:51121/callback';
        return { passed, message: `code=${result.code}, redirectUri=${result.redirectUri}` };
    });

    await test('Parse URL with additional query params', () => {
        const input = 'http://localhost:51121/?code=myCode&state=myState&scope=email';
        const result = extractCodeFromInput(input);
        const passed = result.code === 'myCode' && result.state === 'myState' && result.redirectUri === 'http://localhost:51121/';
        return { passed, message: `code=${result.code}, state=${result.state}, redirectUri=${result.redirectUri}` };
    });

    // ===== Test Group 2: Raw Code Inputs =====
    console.log('\n--- Raw Authorization Code Inputs ---');

    await test('Parse raw authorization code (Google format)', () => {
        const input = '4/0AQSTgQGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const result = extractCodeFromInput(input);
        const passed = result.code === input && result.state === null && result.redirectUri === null;
        return { passed, message: `code length=${result.code.length}, redirectUri=${result.redirectUri}` };
    });

    await test('Parse raw code with whitespace (should trim)', () => {
        const input = '  4/0AQSTgQGcode123  \n';
        const result = extractCodeFromInput(input);
        const passed = result.code === '4/0AQSTgQGcode123' && result.state === null && result.redirectUri === null;
        return { passed, message: `trimmed code=${result.code}, redirectUri=${result.redirectUri}` };
    });

    // ===== Test Group 3: Error Cases =====
    console.log('\n--- Error Handling ---');

    await test('Throw on empty input', () => {
        try {
            extractCodeFromInput('');
            return { passed: false, message: 'Should have thrown' };
        } catch (e) {
            return { passed: e.message.includes('No input'), message: e.message };
        }
    });

    await test('Throw on null input', () => {
        try {
            extractCodeFromInput(null);
            return { passed: false, message: 'Should have thrown' };
        } catch (e) {
            return { passed: e.message.includes('No input'), message: e.message };
        }
    });

    await test('Throw on too short code', () => {
        try {
            extractCodeFromInput('abc');
            return { passed: false, message: 'Should have thrown' };
        } catch (e) {
            return { passed: e.message.includes('too short'), message: e.message };
        }
    });

    await test('Throw on OAuth error in URL', () => {
        try {
            const input = 'http://localhost:51121/?error=access_denied&error_description=User%20denied';
            extractCodeFromInput(input);
            return { passed: false, message: 'Should have thrown' };
        } catch (e) {
            return { passed: e.message.includes('OAuth error'), message: e.message };
        }
    });

    await test('Throw on URL without code param', () => {
        try {
            extractCodeFromInput('http://localhost:51121/callback?state=onlyState');
            return { passed: false, message: 'Should have thrown' };
        } catch (e) {
            return { passed: e.message.includes('No authorization code'), message: e.message };
        }
    });

    // ===== Test Group 4: Edge Cases =====
    console.log('\n--- Edge Cases ---');

    await test('Handle URL-encoded characters in code', () => {
        const input = 'http://localhost:51121/?code=4%2F0AQSTg%2B%2B&state=test';
        const result = extractCodeFromInput(input);
        // URL class automatically decodes
        const passed = result.code === '4/0AQSTg++' && result.redirectUri === 'http://localhost:51121/';
        return { passed, message: `decoded code=${result.code}, redirectUri=${result.redirectUri}` };
    });

    await test('Accept minimum valid code length (10 chars)', () => {
        const input = '1234567890';
        const result = extractCodeFromInput(input);
        const passed = result.code === input && result.redirectUri === null;
        return { passed, message: `code=${result.code}, redirectUri=${result.redirectUri}` };
    });

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

    console.log('\n' + '='.repeat(60));
    console.log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
