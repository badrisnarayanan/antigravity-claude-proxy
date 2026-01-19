/**
 * Test Streaming Whitespace - Verifies that whitespace-only chunks are not dropped
 *
 * Reproduction for Issue #138: "Claude models swallow spaces between words"
 */

const { TextEncoder } = require('util');

// Mock Response class
class MockResponse {
    constructor(chunks) {
        this.body = {
            getReader: () => {
                let index = 0;
                return {
                    read: async () => {
                        if (index >= chunks.length) {
                            return { done: true, value: undefined };
                        }
                        const chunk = chunks[index++];
                        const encoder = new TextEncoder();
                        return { done: false, value: encoder.encode(chunk) };
                    }
                };
            }
        };
    }
}

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           STREAMING WHITESPACE TEST SUITE                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const { streamSSEResponse } = await import('../src/cloudcode/sse-streamer.js');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
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

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: "${expected}"\nActual: "${actual}"`);
        }
    }

    // Test Case: Whitespace preservation
    await test('Preserves whitespace-only chunks', async () => {
        // Construct chunks that simulate the Google SSE format
        // We split "Hello World" into "Hello", " ", "World"
        const chunks = [
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] }) + '\n\n',
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: " " }] } }] }) + '\n\n',
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: "World" }] } }] }) + '\n\n'
        ];

        const response = new MockResponse(chunks);
        const originalModel = 'claude-sonnet-4-5';

        let fullText = '';
        const generator = streamSSEResponse(response, originalModel);

        for await (const event of generator) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                fullText += event.delta.text;
            }
        }

        assertEqual(fullText, 'Hello World', 'Should preserve space between words');
    });

    // Test Case: Empty string (should be skipped)
    await test('Skips truly empty strings but keeps newlines', async () => {
        const chunks = [
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: "Line1" }] } }] }) + '\n\n',
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] } }] }) + '\n\n', // Empty
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: "\n" }] } }] }) + '\n\n', // Newline
            'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: "Line2" }] } }] }) + '\n\n'
        ];

        const response = new MockResponse(chunks);
        const originalModel = 'claude-sonnet-4-5';

        let fullText = '';
        const generator = streamSSEResponse(response, originalModel);

        for await (const event of generator) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                fullText += event.delta.text;
            }
        }

        assertEqual(fullText, 'Line1\nLine2', 'Should preserve newline but ignore empty string');
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
