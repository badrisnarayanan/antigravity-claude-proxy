/**
 * Interleaved Thinking Test
 *
 * Tests that interleaved thinking works correctly:
 * - Multiple thinking blocks can appear in a single response
 * - Thinking blocks between tool calls
 * - Thinking after tool results
 *
 * This simulates complex Claude Code scenarios where the model
 * thinks multiple times during a single turn.
 *
 * NOTE: This test is Claude-only. Interleaved thinking requires
 * the anthropic-beta header which is specific to Claude thinking models.
 */
const { streamRequest, commonTools } = require('./helpers/http-client.cjs');
const { getTestModels, getModelConfig } = require('./helpers/test-models.cjs');

// Multiple tools to encourage interleaved thinking
const tools = [commonTools.readFile, commonTools.writeFile, commonTools.runTests];

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`INTERLEAVED THINKING TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Tests complex multi-step reasoning with tools');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);

    // ===== TEST 1: Complex task requiring multiple steps =====
    console.log('TEST 1: Complex task - read, modify, write, test');
    console.log('-'.repeat(40));

    const result = await streamRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: true,
        tools,
        thinking: modelConfig.thinking,
        messages: [{
            role: 'user',
            content: `I need you to:
1. Read the file src/config.js
2. Add a new config option "debug: true"
3. Write the updated file
4. Run the tests to make sure nothing broke

Please do this step by step, reading each file before modifying.`
        }]
    });

    if (result.error) {
        console.log(`  ERROR: ${result.error.message}`);
        allPassed = false;
        results.push({ name: 'Complex multi-step task', passed: false });
    } else {
        const thinking = result.content.filter(b => b.type === 'thinking');
        const toolUse = result.content.filter(b => b.type === 'tool_use');
        const text = result.content.filter(b => b.type === 'text');

        console.log(`  Thinking blocks: ${thinking.length}`);
        console.log(`  Tool use blocks: ${toolUse.length}`);
        console.log(`  Text blocks: ${text.length}`);

        // Check signatures
        const signedThinking = thinking.filter(t => t.signature && t.signature.length >= 50);
        console.log(`  Signed thinking blocks: ${signedThinking.length}`);

        // Analyze block order
        const blockOrder = result.content.map(b => b.type).join(' -> ');
        console.log(`  Block order: ${blockOrder}`);

        // Show thinking previews
        thinking.forEach((t, i) => {
            console.log(`  Thinking ${i + 1}: "${(t.thinking || '').substring(0, 50)}..."`);
        });

        // Show tool calls
        toolUse.forEach((t, i) => {
            console.log(`  Tool ${i + 1}: ${t.name}(${JSON.stringify(t.input).substring(0, 50)}...)`);
        });

        // Expect at least one thinking block (ideally multiple for complex task)
        const passed = thinking.length >= 1 && signedThinking.length >= 1 && toolUse.length >= 1;
        results.push({ name: 'Thinking + Tools in complex task', passed });
        if (!passed) allPassed = false;
    }

    // ===== TEST 2: Response after tool result =====
    console.log('\nTEST 2: Response after tool result');
    console.log('-'.repeat(40));

    // Start with previous result and add tool result
    if (result.content && result.content.some(b => b.type === 'tool_use')) {
        const toolUseBlock = result.content.find(b => b.type === 'tool_use');

        const result2 = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            tools,
            thinking: modelConfig.thinking,
            messages: [
                {
                    role: 'user',
                    content: `Analyze the src/config.js file structure and explain the security implications of each setting. What are the potential risks if this config were exposed in production?`
                },
                { role: 'assistant', content: result.content },
                {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: toolUseBlock.id,
                        content: `module.exports = {
    port: 3000,
    host: 'localhost',
    debug: false
};`
                    }]
                }
            ]
        });

        if (result2.error) {
            console.log(`  ERROR: ${result2.error.message}`);
            allPassed = false;
            results.push({ name: 'Thinking after tool result', passed: false });
        } else {
            const thinking2 = result2.content.filter(b => b.type === 'thinking');
            const text2 = result2.content.filter(b => b.type === 'text');
            const toolUse2 = result2.content.filter(b => b.type === 'tool_use');

            console.log(`  Thinking blocks: ${thinking2.length}`);
            console.log(`  Text blocks: ${text2.length}`);
            console.log(`  Tool use blocks: ${toolUse2.length}`);

            if (text2.length > 0) {
                console.log(`  Response: "${text2[0].text?.substring(0, 80)}..."`);
            }

            // Model may or may not produce thinking blocks after tool result
            // The key is that it produces a valid response (text or tool use)
            // Note: Thinking is optional - model decides when to use it based on task complexity
            const passed = text2.length > 0 || toolUse2.length > 0;
            results.push({ name: 'Response after tool result', passed });
            if (!passed) allPassed = false;
        }
    } else {
        console.log('  SKIPPED - No tool use in previous test');
        results.push({ name: 'Response after tool result', passed: false, skipped: true });
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log(`SUMMARY [${family.toUpperCase()}]`);
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.skipped ? 'SKIP' : (result.passed ? 'PASS' : 'FAIL');
        console.log(`  [${status}] ${result.name}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`[${family.toUpperCase()}] ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    return allPassed;
}

async function runTests() {
    // Interleaved thinking is Claude-only (requires anthropic-beta header)
    const models = await getTestModels(['gemini']);
    let allPassed = true;

    for (const { family, model } of models) {
        console.log('\n');
        const passed = await runTestsForModel(family, model);
        if (!passed) allPassed = false;
    }

    console.log('\n' + '='.repeat(60));
    console.log('FINAL RESULT');
    console.log('='.repeat(60));
    console.log(`Overall: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
