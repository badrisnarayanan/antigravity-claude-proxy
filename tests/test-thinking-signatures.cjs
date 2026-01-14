/**
 * Thinking Signature Test
 *
 * Tests that thinking blocks with signatures are properly handled in multi-turn
 * conversations, simulating how Claude Code sends requests.
 *
 * Claude Code sends assistant messages with thinking blocks that include signatures.
 * These signatures must be preserved and sent back to the API.
 *
 * Note: Claude puts signatures on thinking blocks, Gemini 3+ puts them on tool_use blocks.
 *
 * Runs for both Claude and Gemini model families.
 */
const { streamRequest, analyzeContent, commonTools } = require('./helpers/http-client.cjs');
const { getTestModels, getModelConfig, familySupportsThinking } = require('./helpers/test-models.cjs');

const tools = [commonTools.getWeather];

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`THINKING SIGNATURE TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Simulates Claude Code multi-turn with thinking blocks');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);
    const expectThinking = familySupportsThinking(family);

    // ===== TEST 1: First turn - get thinking block with signature =====
    console.log('TEST 1: Initial request with thinking model');
    console.log('-'.repeat(40));

    const turn1Messages = [
        { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }
    ];

    const turn1Result = await streamRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: true,
        tools,
        thinking: modelConfig.thinking,
        messages: turn1Messages
    });

    const content = analyzeContent(turn1Result.content);

    console.log(`  Thinking blocks: ${content.thinking.length}`);
    console.log(`  Tool use blocks: ${content.toolUse.length}`);
    console.log(`  Text blocks: ${content.text.length}`);

    // Check signatures - Claude puts them on thinking blocks, Gemini on tool_use blocks
    console.log(`  Thinking signature: ${content.thinkingHasSignature ? 'YES' : 'NO'}`);
    console.log(`  Tool use signature: ${content.toolUseHasSignature ? 'YES' : 'NO'}`);
    console.log(`  Has signature (combined): ${content.hasSignature ? 'YES' : 'NO'}`);

    if (content.hasThinking && content.thinking[0].thinking) {
        console.log(`  Thinking preview: "${content.thinking[0].thinking.substring(0, 80)}..."`);
    }

    // For models that support thinking, expect signature (somewhere) + tool use
    // Note: Gemini doesn't always produce thinking blocks, but does put signatures on tool_use
    // Claude always produces thinking blocks with signatures
    const test1Pass = expectThinking
        ? (content.hasSignature && content.hasToolUse)  // Signature required, thinking optional for Gemini
        : (content.hasToolUse || content.hasText);
    results.push({ name: 'Turn 1: Thinking + Signature + Tool Use', passed: test1Pass });
    console.log(`  Result: ${test1Pass ? 'PASS' : 'FAIL'}`);
    if (!test1Pass) allPassed = false;

    // ===== TEST 2: Second turn - send back thinking with signature =====
    console.log('\nTEST 2: Multi-turn with thinking signature in assistant message');
    console.log('-'.repeat(40));

    if (!content.hasToolUse) {
        console.log('  SKIPPED - No tool use in turn 1');
        results.push({ name: 'Turn 2: Multi-turn with signature', passed: false, skipped: true });
    } else {
        // Build assistant message with thinking (including signature) - this is how Claude Code sends it
        const assistantContent = turn1Result.content;

        // Log what we're sending back
        const thinkingInAssistant = assistantContent.find(b => b.type === 'thinking');
        const toolUseInAssistant = assistantContent.find(b => b.type === 'tool_use');
        if (thinkingInAssistant) {
            console.log(`  Sending thinking with signature: ${(thinkingInAssistant.signature || '').length} chars`);
        }
        if (toolUseInAssistant && toolUseInAssistant.thoughtSignature) {
            console.log(`  Sending tool_use with thoughtSignature: ${toolUseInAssistant.thoughtSignature.length} chars`);
        }

        const turn2Messages = [
            ...turn1Messages,
            { role: 'assistant', content: assistantContent },
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: content.toolUse[0].id,
                    content: 'The weather in Paris is 18°C and sunny.'
                }]
            }
        ];

        const turn2Result = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            tools,
            thinking: modelConfig.thinking,
            messages: turn2Messages
        });

        const turn2Content = analyzeContent(turn2Result.content);

        console.log(`  Thinking blocks: ${turn2Content.thinking.length}`);
        console.log(`  Text blocks: ${turn2Content.text.length}`);

        // Check for errors
        const hasError = turn2Result.events.some(e => e.type === 'error');
        if (hasError) {
            const errorEvent = turn2Result.events.find(e => e.type === 'error');
            console.log(`  ERROR: ${errorEvent?.data?.error?.message || 'Unknown error'}`);
        }

        if (turn2Content.hasThinking && turn2Content.thinking[0].thinking) {
            console.log(`  Thinking preview: "${turn2Content.thinking[0].thinking.substring(0, 80)}..."`);
        }

        if (turn2Content.hasText && turn2Content.text[0].text) {
            console.log(`  Response: "${turn2Content.text[0].text.substring(0, 100)}..."`);
        }

        const test2Pass = !hasError && (turn2Content.hasThinking || turn2Content.hasText);
        results.push({ name: 'Turn 2: Multi-turn with signature', passed: test2Pass });
        console.log(`  Result: ${test2Pass ? 'PASS' : 'FAIL'}`);
        if (!test2Pass) allPassed = false;
    }

    // ===== TEST 3: Verify signature_delta events in stream =====
    console.log('\nTEST 3: Verify signature events in stream');
    console.log('-'.repeat(40));

    const signatureDeltas = turn1Result.events.filter(
        e => e.type === 'content_block_delta' && e.data?.delta?.type === 'signature_delta'
    );
    console.log(`  signature_delta events: ${signatureDeltas.length}`);

    if (signatureDeltas.length > 0) {
        const totalSigLength = signatureDeltas.reduce((sum, e) => sum + (e.data.delta.signature?.length || 0), 0);
        console.log(`  Total signature length from deltas: ${totalSigLength} chars`);
    }

    // For Claude: signature_delta events should be present
    // For Gemini: signature is attached to tool_use block directly, may not have signature_delta events
    const test3Pass = expectThinking
        ? (signatureDeltas.length > 0 || content.toolUseHasSignature)
        : true;
    results.push({ name: 'Signature present (delta or on tool_use)', passed: test3Pass });
    console.log(`  Result: ${test3Pass ? 'PASS' : 'FAIL'}`);
    if (!test3Pass) allPassed = false;

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
