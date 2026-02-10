/**
 * Google Error Parser Tests
 *
 * Unit tests for extracting VALIDATION_REQUIRED metadata from Cloud Code errors.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           GOOGLE ERROR PARSER TEST SUITE                     ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { extractValidationRequiredInfo } = await import('../src/cloudcode/google-error-parser.js');

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

    function assert(cond, message) {
        if (!cond) throw new Error(message);
    }

    test('Extracts validation_url and message from structured JSON error', () => {
        const sample = JSON.stringify({
            error: {
                code: 403,
                message: 'Verify your account to continue.',
                status: 'PERMISSION_DENIED',
                details: [
                    {
                        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                        reason: 'VALIDATION_REQUIRED',
                        domain: 'cloudcode-pa.googleapis.com',
                        metadata: {
                            validation_url: 'https://accounts.google.com/signin/continue?x=1',
                            validation_error_message: 'Verify your account to continue.'
                        }
                    }
                ]
            }
        });

        const out = extractValidationRequiredInfo(sample);
        assert(out && out.validationUrl === 'https://accounts.google.com/signin/continue?x=1', 'Expected validationUrl to be extracted');
        assert(out && out.message.toLowerCase().includes('verify your account'), 'Expected message to be extracted');
    });

    test('Returns null when error text is unrelated', () => {
        const out = extractValidationRequiredInfo('{"error":{"message":"nope"}}');
        assert(out === null, 'Expected null for unrelated errors');
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});

