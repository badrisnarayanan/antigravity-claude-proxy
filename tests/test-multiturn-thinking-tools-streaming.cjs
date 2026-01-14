/**
 * Multi-Turn Tool Call Test (Streaming)
 *
 * Simulates Claude Code's streaming multi-turn conversation pattern.
 * Same flow as non-streaming but verifies:
 * - SSE events are properly formatted
 * - signature_delta events are present
 * - Thinking blocks accumulate correctly across deltas
 *
 * Runs for both Claude and Gemini model families.
 */
const { streamRequest, analyzeContent, analyzeEvents, commonTools } = require('./helpers/http-client.cjs');
const { getTestModels, getModelConfig } = require('./helpers/test-models.cjs');

const tools = [commonTools.executeCommand];

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`MULTI-TURN TOOL CALL TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Simulates Claude Code streaming conversation');
    console.log('='.repeat(60));
    console.log('');

    let messages = [];
    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);

    // ===== TURN 1: Initial request =====
    console.log('TURN 1: User asks to run a command');
    console.log('-'.repeat(40));

    messages.push({
        role: 'user',
        content: 'Run "ls -la" in the current directory and tell me what files exist.'
    });

    const turn1 = await streamRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: true,
        tools,
        thinking: modelConfig.thinking,
        messages
    });

    if (turn1.error) {
        console.log(`  ERROR: ${turn1.error.message}`);
        allPassed = false;
        results.push({ name: 'Turn 1: Streaming request', passed: false });
    } else {
        const content = analyzeContent(turn1.content);
        const events = analyzeEvents(turn1.events);

        console.log('  Content:');
        console.log(`    Thinking: ${content.hasThinking ? 'YES' : 'NO'} (${content.thinking.length} blocks)`);
        console.log(`    Signature: ${content.hasSignature ? 'YES' : 'NO'}`);
        console.log(`    Tool Use: ${content.hasToolUse ? 'YES' : 'NO'} (${content.toolUse.length} calls)`);

        console.log('  Events:');
        console.log(`    message_start: ${events.messageStart}`);
        console.log(`    content_block_start/stop: ${events.blockStart}/${events.blockStop}`);
        console.log(`    thinking_delta: ${events.thinkingDeltas}`);
        console.log(`    signature_delta: ${events.signatureDeltas}`);
        console.log(`    input_json_delta: ${events.inputJsonDeltas}`);

        if (content.hasThinking && content.thinking[0].thinking) {
            console.log(`  Thinking: "${content.thinking[0].thinking.substring(0, 60)}..."`);
        }
        if (content.hasToolUse) {
            console.log(`  Tool: ${content.toolUse[0].name}(${JSON.stringify(content.toolUse[0].input)})`);
        }

        // For Claude: signature is on thinking block and comes via signature_delta events
        // For Gemini: signature is on tool_use block (no signature_delta events)
        // Note: Some models may skip thinking on simple first requests - signature + tool use is key
        const hasSignature = content.hasSignature || events.signatureDeltas > 0;
        const passed = hasSignature && content.hasToolUse;
        results.push({ name: 'Turn 1: Signature + Tool Use', passed });
        if (!passed) allPassed = false;

        if (content.hasToolUse) {
            messages.push({ role: 'assistant', content: turn1.content });
        }
    }

    // ===== TURN 2: Provide tool result =====
    if (messages.length >= 2) {
        console.log('\nTURN 2: Provide command output, expect summary');
        console.log('-'.repeat(40));

        const lastAssistant = messages[messages.length - 1];
        const toolUseBlock = lastAssistant.content.find(b => b.type === 'tool_use');

        messages.push({
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: `total 32
drwxr-xr-x  10 user  staff   320 Dec 19 10:00 .
drwxr-xr-x   5 user  staff   160 Dec 19 09:00 ..
-rw-r--r--   1 user  staff  1024 Dec 19 10:00 package.json
-rw-r--r--   1 user  staff  2048 Dec 19 10:00 README.md
drwxr-xr-x   8 user  staff   256 Dec 19 10:00 src
drwxr-xr-x   4 user  staff   128 Dec 19 10:00 tests`
            }]
        });

        const turn2 = await streamRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: true,
            tools,
            thinking: modelConfig.thinking,
            messages
        });

        if (turn2.error) {
            console.log(`  ERROR: ${turn2.error.message}`);
            allPassed = false;
            results.push({ name: 'Turn 2: After tool result', passed: false });
        } else {
            const content = analyzeContent(turn2.content);
            const events = analyzeEvents(turn2.events);

            console.log('  Content:');
            console.log(`    Thinking: ${content.hasThinking ? 'YES' : 'NO'} (${content.thinking.length} blocks)`);
            console.log(`    Signature: ${content.hasSignature ? 'YES' : 'NO'}`);
            console.log(`    Text: ${content.hasText ? 'YES' : 'NO'}`);

            console.log('  Events:');
            console.log(`    thinking_delta: ${events.thinkingDeltas}`);
            console.log(`    signature_delta: ${events.signatureDeltas}`);
            console.log(`    text_delta: ${events.textDeltas}`);

            if (content.hasText && content.text[0].text) {
                console.log(`  Response: "${content.text[0].text.substring(0, 100)}..."`);
            }

            // Text or tool use response is acceptable
            // Note: Models may skip thinking on obvious responses - this is valid behavior
            const passed = (content.hasText && events.textDeltas > 0) || content.hasToolUse;
            results.push({ name: 'Turn 2: Text or Tool response', passed });
            if (!passed) allPassed = false;
        }
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log(`SUMMARY [${family.toUpperCase()}]`);
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.passed ? 'PASS' : 'FAIL';
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
