/**
 * Cache Control Field Test (Issue #189)
 *
 * Tests that cache_control fields on content blocks are properly stripped
 * before being sent to the Cloud Code API.
 *
 * Claude Code CLI sends cache_control on text, thinking, tool_use, tool_result,
 * image, and document blocks for prompt caching optimization. The Cloud Code API
 * rejects these with "Extra inputs are not permitted".
 *
 * This test verifies that:
 * 1. Text blocks with cache_control work correctly
 * 2. Multi-turn conversations with cache_control on assistant content work
 * 3. Tool_result blocks with cache_control work correctly
 *
 * Runs for both Claude and Gemini model families.
 */
const { streamRequest, analyzeContent, commonTools } = require('./helpers/http-client.cjs');
const { getTestModels, getModelConfig } = require('./helpers/test-models.cjs');

const tools = [commonTools.getWeather];

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`CACHE CONTROL TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Tests that cache_control fields are stripped from all block types');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);

    // ===== TEST 1: User text block with cache_control =====
    console.log('TEST 1: User text block with cache_control');
    console.log('-'.repeat(40));

    try {
        const test1Result = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            thinking: modelConfig.thinking,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'What is the capital of France? Reply in one word.',
                            cache_control: { type: 'ephemeral' }
                        }
                    ]
                }
            ]
        });

        const hasError1 = test1Result.events.some(e => e.type === 'error');
        const errorMsg1 = hasError1
            ? test1Result.events.find(e => e.type === 'error')?.data?.error?.message
            : null;

        console.log(`  Response received: ${test1Result.content.length > 0 ? 'YES' : 'NO'}`);
        console.log(`  Has error: ${hasError1 ? 'YES' : 'NO'}`);
        if (hasError1) {
            console.log(`  Error message: ${errorMsg1}`);
        }

        const content1 = analyzeContent(test1Result.content);
        if (content1.hasText) {
            console.log(`  Response preview: "${content1.text[0].text.substring(0, 50)}..."`);
        }

        const test1Pass = !hasError1 && test1Result.content.length > 0;
        results.push({ name: 'User text block with cache_control', passed: test1Pass });
        console.log(`  Result: ${test1Pass ? 'PASS' : 'FAIL'}`);
        if (!test1Pass) allPassed = false;
    } catch (err) {
        console.log(`  ERROR: ${err.message}`);
        results.push({ name: 'User text block with cache_control', passed: false });
        allPassed = false;
    }

    // ===== TEST 2: Multi-turn with cache_control on assistant content =====
    console.log('\nTEST 2: Multi-turn with cache_control on assistant content');
    console.log('-'.repeat(40));

    try {
        // First turn - get a response
        const turn1 = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            thinking: modelConfig.thinking,
            messages: [
                { role: 'user', content: 'Say hello.' }
            ]
        });

        if (turn1.content.length === 0) {
            console.log('  SKIPPED - Turn 1 returned empty response');
            results.push({ name: 'Multi-turn with cache_control', passed: false, skipped: true });
        } else {
            // Add cache_control to ALL blocks in assistant response (simulating Claude Code)
            const modifiedContent = turn1.content.map(block => ({
                ...block,
                cache_control: { type: 'ephemeral' }
            }));

            // Second turn - use modified content with cache_control
            const turn2 = await streamRequest({
                model,
                max_tokens: modelConfig.max_tokens,
                stream: true,
                thinking: modelConfig.thinking,
                messages: [
                    { role: 'user', content: 'Say hello.' },
                    { role: 'assistant', content: modifiedContent },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Now say goodbye.',
                                cache_control: { type: 'ephemeral' }
                            }
                        ]
                    }
                ]
            });

            const hasError2 = turn2.events.some(e => e.type === 'error');
            const errorMsg2 = hasError2
                ? turn2.events.find(e => e.type === 'error')?.data?.error?.message
                : null;

            console.log(`  Turn 1 blocks: ${turn1.content.length}`);
            console.log(`  Turn 2 response received: ${turn2.content.length > 0 ? 'YES' : 'NO'}`);
            console.log(`  Has error: ${hasError2 ? 'YES' : 'NO'}`);
            if (hasError2) {
                console.log(`  Error message: ${errorMsg2}`);
                // Check specifically for cache_control error
                if (errorMsg2 && errorMsg2.includes('cache_control')) {
                    console.log('  >>> cache_control field NOT stripped properly! <<<');
                }
            }

            const content2 = analyzeContent(turn2.content);
            if (content2.hasText) {
                console.log(`  Response preview: "${content2.text[0].text.substring(0, 50)}..."`);
            }

            const test2Pass = !hasError2 && turn2.content.length > 0;
            results.push({ name: 'Multi-turn with cache_control', passed: test2Pass });
            console.log(`  Result: ${test2Pass ? 'PASS' : 'FAIL'}`);
            if (!test2Pass) allPassed = false;
        }
    } catch (err) {
        console.log(`  ERROR: ${err.message}`);
        results.push({ name: 'Multi-turn with cache_control', passed: false });
        allPassed = false;
    }

    // ===== TEST 3: Tool loop with cache_control on tool_result =====
    console.log('\nTEST 3: Tool loop with cache_control on tool_result');
    console.log('-'.repeat(40));

    try {
        // First turn - request tool use
        const toolTurn1 = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            tools,
            thinking: modelConfig.thinking,
            messages: [
                { role: 'user', content: 'What is the weather in Tokyo? Use the get_weather tool.' }
            ]
        });

        const content3a = analyzeContent(toolTurn1.content);

        if (!content3a.hasToolUse) {
            console.log('  SKIPPED - Model did not use tool in turn 1');
            results.push({ name: 'Tool_result with cache_control', passed: true, skipped: true });
        } else {
            const toolUseId = content3a.toolUse[0].id;
            console.log(`  Tool use ID: ${toolUseId}`);

            // Second turn - provide tool result with cache_control
            const toolTurn2 = await streamRequest({
                model,
                max_tokens: modelConfig.max_tokens,
                stream: true,
                tools,
                thinking: modelConfig.thinking,
                messages: [
                    { role: 'user', content: 'What is the weather in Tokyo? Use the get_weather tool.' },
                    { role: 'assistant', content: toolTurn1.content },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: toolUseId,
                                content: 'The weather in Tokyo is 22°C and partly cloudy.',
                                cache_control: { type: 'ephemeral' }
                            }
                        ]
                    }
                ]
            });

            const hasError3 = toolTurn2.events.some(e => e.type === 'error');
            const errorMsg3 = hasError3
                ? toolTurn2.events.find(e => e.type === 'error')?.data?.error?.message
                : null;

            console.log(`  Turn 2 response received: ${toolTurn2.content.length > 0 ? 'YES' : 'NO'}`);
            console.log(`  Has error: ${hasError3 ? 'YES' : 'NO'}`);
            if (hasError3) {
                console.log(`  Error message: ${errorMsg3}`);
                if (errorMsg3 && errorMsg3.includes('cache_control')) {
                    console.log('  >>> cache_control field NOT stripped properly! <<<');
                }
            }

            const content3b = analyzeContent(toolTurn2.content);
            if (content3b.hasText) {
                console.log(`  Response preview: "${content3b.text[0].text.substring(0, 50)}..."`);
            }

            const test3Pass = !hasError3 && toolTurn2.content.length > 0;
            results.push({ name: 'Tool_result with cache_control', passed: test3Pass });
            console.log(`  Result: ${test3Pass ? 'PASS' : 'FAIL'}`);
            if (!test3Pass) allPassed = false;
        }
    } catch (err) {
        console.log(`  ERROR: ${err.message}`);
        results.push({ name: 'Tool_result with cache_control', passed: false });
        allPassed = false;
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log(`SUMMARY [${family.toUpperCase()}]`);
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.skipped ? 'SKIP' : (result.passed ? 'PASS' : 'FAIL');
        console.log(`  [${status}] ${result.name}`);
    }

    const passedCount = results.filter(r => r.passed && !r.skipped).length;
    const skippedCount = results.filter(r => r.skipped).length;
    const totalTests = results.length - skippedCount;

    console.log('\n' + '='.repeat(60));
    console.log(`[${family.toUpperCase()}] ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} (${passedCount}/${totalTests})`);
    console.log('='.repeat(60));

    return allPassed;
}

async function runTests() {
    console.log('');
    console.log('='.repeat(60));
    console.log('CACHE CONTROL FIELD STRIPPING TEST (Issue #189)');
    console.log('='.repeat(60));
    console.log('');
    console.log('This test verifies that cache_control fields are properly');
    console.log('stripped from all content blocks before sending to Cloud Code API.');
    console.log('');

    const models = await getTestModels();
    let allPassed = true;

    for (const { family, model } of models) {
        console.log('\n');
        const passed = await runTestsForModel(family, model);
        if (!passed) allPassed = false;
    }

    console.log('\n' + '='.repeat(60));
    console.log('FINAL RESULT');
    console.log('='.repeat(60));
    console.log(`Overall: ${allPassed ? 'ALL MODEL FAMILIES PASSED' : 'SOME MODEL FAMILIES FAILED'}`);
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
