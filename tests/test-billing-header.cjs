/**
 * Test Billing Header Stripping - Tests for issue #375
 *
 * Claude Code injects an "x-anthropic-billing-header: ..." line into the system
 * prompt. Cloud Code API rejects requests containing it with a false
 * 429 RESOURCE_EXHAUSTED, so it must be stripped during conversion.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           BILLING HEADER TEST SUITE                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');

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

    const HEADER = 'x-anthropic-billing-header: cc_version=2.1.274.834; cc_entrypoint=sdk-cli;';
    const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

    function systemTexts(system) {
        const result = convertAnthropicToGoogle({
            model: 'gemini-3-flash',
            system,
            messages: [{ role: 'user', content: 'hi' }]
        });
        return result.systemInstruction ? result.systemInstruction.parts.map(p => p.text) : null;
    }

    test('Header in its own block is dropped', () => {
        assertEqual(
            systemTexts([{ type: 'text', text: HEADER }, { type: 'text', text: IDENTITY }]),
            [IDENTITY]
        );
    });

    test('Header line inside a block is removed', () => {
        assertEqual(
            systemTexts([{ type: 'text', text: `${HEADER}\n${IDENTITY}\nMore instructions.` }]),
            [`${IDENTITY}\nMore instructions.`]
        );
    });

    test('Header in a string system prompt is removed', () => {
        assertEqual(systemTexts(`${HEADER}\n${IDENTITY}`), [IDENTITY]);
    });

    test('System prompt containing only the header yields no systemInstruction', () => {
        assertEqual(systemTexts(HEADER), null);
        assertEqual(systemTexts([{ type: 'text', text: HEADER }]), null);
    });

    test('Header match is case-insensitive', () => {
        assertEqual(
            systemTexts([{ type: 'text', text: 'X-Anthropic-Billing-Header: cc_version=1;' }, { type: 'text', text: IDENTITY }]),
            [IDENTITY]
        );
    });

    test('Other x-anthropic lines and identity text are left alone', () => {
        const text = `${IDENTITY}\nExample headers:\nx-anthropic-beta: foo\nanthropic-version: 2023-06-01`;
        assertEqual(systemTexts([{ type: 'text', text }]), [text]);
    });

    test('Prompts without the header are unchanged, including whitespace', () => {
        const text = `  ${IDENTITY}\n\n`;
        assertEqual(systemTexts([{ type: 'text', text }]), [text]);
        assertEqual(systemTexts(text), [text]);
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
