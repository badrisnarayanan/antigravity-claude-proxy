/**
 * Regression tests for Claude Code billing headers causing false 429s (#375).
 */
const assert = require('node:assert/strict');

async function runTests() {
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    const { convertOpenAIToAnthropic } = await import('../src/format/openai-converter.js');
    const HEADER = 'x-anthropic-billing-header: cc_version=2.1.274.834; cc_entrypoint=sdk-cli;';
    const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
    let passed = 0;

    function systemTexts(system, model) {
        const result = convertAnthropicToGoogle({
            model,
            system,
            messages: [{ role: 'user', content: 'hi' }]
        });
        return result.systemInstruction ? result.systemInstruction.parts.map(p => p.text) : null;
    }

    for (const model of ['gemini-3-flash', 'claude-sonnet-4-6']) {
        function test(name, fn) {
            fn();
            console.log(`PASS ${model}: ${name}`);
            passed++;
        }

        test('Header in its own block is dropped', () => {
            assert.deepEqual(systemTexts([
                { type: 'text', text: HEADER },
                { type: 'text', text: IDENTITY }
            ], model), [IDENTITY]);
        });

        test('Header line inside a block is removed', () => {
            assert.deepEqual(systemTexts([
                { type: 'text', text: `${HEADER}\n${IDENTITY}\nMore instructions.` }
            ], model), [`${IDENTITY}\nMore instructions.`]);
        });

        test('Header in a string system prompt is removed', () => {
            assert.deepEqual(systemTexts(`${HEADER}\n${IDENTITY}`, model), [IDENTITY]);
        });

        test('Header-only system prompts yield no systemInstruction', () => {
            assert.equal(systemTexts(HEADER, model), null);
            assert.equal(systemTexts([{ type: 'text', text: HEADER }], model), null);
        });

        test('Header match is case-insensitive', () => {
            assert.deepEqual(systemTexts([
                { type: 'text', text: 'X-Anthropic-Billing-Header: cc_version=1;' },
                { type: 'text', text: IDENTITY }
            ], model), [IDENTITY]);
        });

        test('Other headers and identity text are left alone', () => {
            const text = `${IDENTITY}\nExample headers:\nx-anthropic-beta: foo\nanthropic-version: 2023-06-01`;
            assert.deepEqual(systemTexts([{ type: 'text', text }], model), [text]);
        });

        test('Prompts without the header retain their whitespace', () => {
            const text = `  ${IDENTITY}\n\n`;
            assert.deepEqual(systemTexts([{ type: 'text', text }], model), [text]);
            assert.deepEqual(systemTexts(text, model), [text]);
        });

        test('Multiple header lines and CRLF are handled', () => {
            assert.deepEqual(systemTexts(`${HEADER}\r\n${IDENTITY}\r\n${HEADER}`, model), [IDENTITY]);
        });

        test('Headers in the middle preserve surrounding instructions', () => {
            assert.deepEqual(systemTexts(`First instruction.\n${HEADER}\nLast instruction.`, model),
                ['First instruction.\nLast instruction.']);
        });

        test('OpenAI system and developer messages use the same stripping path', () => {
            for (const role of ['system', 'developer']) {
                const request = convertOpenAIToAnthropic({
                    model,
                    messages: [
                        { role, content: `${HEADER}\n${IDENTITY}` },
                        { role: 'user', content: 'hi' }
                    ]
                });
                assert.deepEqual(convertAnthropicToGoogle(request).systemInstruction.parts,
                    [{ text: IDENTITY }]);
            }
        });
    }

    console.log(`Billing header tests: ${passed} passed`);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
