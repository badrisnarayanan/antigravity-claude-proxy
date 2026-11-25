const assert = require('node:assert/strict');

async function runTests() {
    const { convertAnthropicToGoogle } = await import(
        '../src/format/request-converter.js'
    );

    const request = {
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'Search memory' }],
        max_tokens: 4096,
        tools: [{
            name: 'recall',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string' }
                }
            }
        }]
    };

    const cases = [
        [
            { type: 'tool', name: 'recall' },
            { mode: 'ANY', allowedFunctionNames: ['recall'] }
        ],
        [{ type: 'any' }, { mode: 'ANY' }],
        [{ type: 'auto' }, { mode: 'AUTO' }],
        [{ type: 'none' }, { mode: 'NONE' }],
        ['required', { mode: 'ANY' }]
    ];

    for (const [choice, expected] of cases) {
        const result = convertAnthropicToGoogle({
            ...request,
            tool_choice: choice
        });

        assert.deepEqual(
            result.toolConfig.functionCallingConfig,
            expected
        );

        console.log(`PASS: ${JSON.stringify(choice)}`);
    }

    assert.equal(
        convertAnthropicToGoogle(request).toolConfig,
        undefined
    );
    console.log('PASS: omitted tool_choice');

    const claude = convertAnthropicToGoogle({
        ...request,
        model: 'claude-sonnet-4-6',
        tool_choice: { type: 'tool', name: 'recall' }
    });

    assert.deepEqual(
        claude.toolConfig.functionCallingConfig,
        { mode: 'VALIDATED' }
    );
    console.log('PASS: existing Claude behavior');

    console.log('All 7 tests passed');
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
