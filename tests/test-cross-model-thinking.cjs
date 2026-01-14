/**
 * Cross-Model Thinking Signature Test
 *
 * Tests that switching between Claude and Gemini models mid-conversation
 * properly handles incompatible thinking signatures.
 *
 * Scenarios tested:
 * 1. Claude → Gemini: Claude thinking signatures should be dropped
 * 2. Gemini → Claude: Gemini thinking signatures should be dropped
 * 3. Both should still work without errors (thinking recovery kicks in)
 */
const { streamRequest, analyzeContent, commonTools } = require('./helpers/http-client.cjs');
const { getModelConfig, getModels } = require('./helpers/test-models.cjs');

const tools = [commonTools.executeCommand];

async function testClaudeToGemini(CLAUDE_MODEL, GEMINI_MODEL) {
    console.log('='.repeat(60));
    console.log('TEST: Claude → Gemini Cross-Model Switch');
    console.log('Simulates starting with Claude, then switching to Gemini');
    console.log('='.repeat(60));
    console.log('');

    const claudeConfig = getModelConfig('claude');
    const geminiConfig = getModelConfig('gemini');

    // TURN 1: Get response from Claude with thinking + tool use
    console.log('TURN 1: Request to Claude (get thinking signature)');
    console.log('-'.repeat(40));

    const turn1Messages = [
        { role: 'user', content: 'Run the command "ls -la" to list files.' }
    ];

    const turn1Result = await streamRequest({
        model: CLAUDE_MODEL,
        max_tokens: claudeConfig.max_tokens,
        stream: true,
        tools,
        thinking: claudeConfig.thinking,
        messages: turn1Messages
    });

    const turn1Content = analyzeContent(turn1Result.content);
    console.log(`  Thinking: ${turn1Content.hasThinking ? 'YES' : 'NO'}`);
    console.log(`  Signature: ${turn1Content.hasSignature ? 'YES' : 'NO'}`);
    console.log(`  Tool Use: ${turn1Content.hasToolUse ? 'YES' : 'NO'}`);

    if (!turn1Content.hasToolUse) {
        console.log('  SKIP: No tool use in turn 1');
        return { passed: false, skipped: true };
    }

    // Extract thinking and tool_use for the assistant message
    const assistantContent = [];
    if (turn1Content.hasThinking && turn1Content.thinking[0]) {
        assistantContent.push({
            type: 'thinking',
            thinking: turn1Content.thinking[0].thinking,
            signature: turn1Content.thinking[0].signature || ''
        });
    }
    if (turn1Content.hasText && turn1Content.text[0]) {
        assistantContent.push({
            type: 'text',
            text: turn1Content.text[0].text
        });
    }
    for (const tool of turn1Content.toolUse) {
        assistantContent.push({
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: tool.input
        });
    }

    const signatureLength = turn1Content.thinking[0]?.signature?.length || 0;
    console.log(`  Claude signature length: ${signatureLength}`);

    // TURN 2: Switch to Gemini with Claude's thinking signature in history
    console.log('\nTURN 2: Request to Gemini (with Claude thinking in history)');
    console.log('-'.repeat(40));

    const turn2Messages = [
        { role: 'user', content: 'Run the command "ls -la" to list files.' },
        { role: 'assistant', content: assistantContent },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: turn1Content.toolUse[0].id,
                content: 'total 16\ndrwxr-xr-x  5 user staff  160 Jan  1 12:00 .\ndrwxr-xr-x  3 user staff   96 Jan  1 12:00 ..\n-rw-r--r--  1 user staff  100 Jan  1 12:00 file.txt'
            }]
        }
    ];

    try {
        const turn2Result = await streamRequest({
            model: GEMINI_MODEL,
            max_tokens: geminiConfig.max_tokens,
            stream: true,
            tools,
            thinking: geminiConfig.thinking,
            messages: turn2Messages
        });

        const turn2Content = analyzeContent(turn2Result.content);
        console.log(`  Response received: YES`);
        console.log(`  Thinking: ${turn2Content.hasThinking ? 'YES' : 'NO'}`);
        console.log(`  Text: ${turn2Content.hasText ? 'YES' : 'NO'}`);
        console.log(`  Error: NO`);

        // Success if we got any response without error
        const passed = turn2Content.hasText || turn2Content.hasThinking || turn2Content.hasToolUse;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        return { passed };
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log(`  Result: FAIL`);
        return { passed: false, error: error.message };
    }
}

async function testGeminiToClaude(CLAUDE_MODEL, GEMINI_MODEL) {
    console.log('\n' + '='.repeat(60));
    console.log('TEST: Gemini → Claude Cross-Model Switch');
    console.log('Simulates starting with Gemini, then switching to Claude');
    console.log('='.repeat(60));
    console.log('');

    const claudeConfig = getModelConfig('claude');
    const geminiConfig = getModelConfig('gemini');

    // TURN 1: Get response from Gemini with thinking + tool use
    console.log('TURN 1: Request to Gemini (get thinking signature)');
    console.log('-'.repeat(40));

    const turn1Messages = [
        { role: 'user', content: 'Run the command "pwd" to show current directory.' }
    ];

    const turn1Result = await streamRequest({
        model: GEMINI_MODEL,
        max_tokens: geminiConfig.max_tokens,
        stream: true,
        tools,
        thinking: geminiConfig.thinking,
        messages: turn1Messages
    });

    const turn1Content = analyzeContent(turn1Result.content);
    console.log(`  Thinking: ${turn1Content.hasThinking ? 'YES' : 'NO'}`);
    console.log(`  Signature: ${turn1Content.hasSignature ? 'YES' : 'NO'}`);
    console.log(`  Tool Use: ${turn1Content.hasToolUse ? 'YES' : 'NO'}`);

    if (!turn1Content.hasToolUse) {
        console.log('  SKIP: No tool use in turn 1');
        return { passed: false, skipped: true };
    }

    // Extract content for the assistant message
    const assistantContent = [];
    if (turn1Content.hasThinking && turn1Content.thinking[0]) {
        assistantContent.push({
            type: 'thinking',
            thinking: turn1Content.thinking[0].thinking,
            signature: turn1Content.thinking[0].signature || ''
        });
    }
    if (turn1Content.hasText && turn1Content.text[0]) {
        assistantContent.push({
            type: 'text',
            text: turn1Content.text[0].text
        });
    }
    for (const tool of turn1Content.toolUse) {
        const toolBlock = {
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: tool.input
        };
        // Include thoughtSignature if present (Gemini puts it on tool_use)
        if (tool.thoughtSignature) {
            toolBlock.thoughtSignature = tool.thoughtSignature;
        }
        assistantContent.push(toolBlock);
    }

    const thinkingSigLength = turn1Content.thinking[0]?.signature?.length || 0;
    const toolUseSigLength = turn1Content.toolUse[0]?.thoughtSignature?.length || 0;
    console.log(`  Gemini thinking signature length: ${thinkingSigLength}`);
    console.log(`  Gemini tool_use signature length: ${toolUseSigLength}`);

    // TURN 2: Switch to Claude with Gemini's thinking signature in history
    console.log('\nTURN 2: Request to Claude (with Gemini thinking in history)');
    console.log('-'.repeat(40));
    console.log(`  Assistant content being sent: ${JSON.stringify(assistantContent).substring(0, 400)}`);

    const turn2Messages = [
        { role: 'user', content: 'Run the command "pwd" to show current directory.' },
        { role: 'assistant', content: assistantContent },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: turn1Content.toolUse[0].id,
                content: '/home/user/projects'
            }]
        }
    ];

    try {
        const turn2Result = await streamRequest({
            model: CLAUDE_MODEL,
            max_tokens: claudeConfig.max_tokens,
            stream: true,
            tools,
            thinking: claudeConfig.thinking,
            messages: turn2Messages
        });

        const turn2Content = analyzeContent(turn2Result.content);
        console.log(`  Response received: YES`);
        console.log(`  Stop reason: ${turn2Result.stop_reason}`);
        console.log(`  Thinking: ${turn2Content.hasThinking ? 'YES' : 'NO'}`);
        console.log(`  Text: ${turn2Content.hasText ? 'YES' : 'NO'}`);
        console.log(`  Tool Use: ${turn2Content.hasToolUse ? 'YES' : 'NO'}`);
        console.log(`  Raw content: ${JSON.stringify(turn2Result.content).substring(0, 300)}`);
        console.log(`  Error: NO`);

        // Success if we got any response without error
        const passed = turn2Content.hasText || turn2Content.hasThinking || turn2Content.hasToolUse;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        return { passed };
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log(`  Result: FAIL`);
        return { passed: false, error: error.message };
    }
}

async function testSameModelContinuation(CLAUDE_MODEL) {
    console.log('\n' + '='.repeat(60));
    console.log('TEST: Same Model Continuation - Claude (Control Test)');
    console.log('Verifies same-model multi-turn still works');
    console.log('='.repeat(60));
    console.log('');

    const claudeConfig = getModelConfig('claude');

    // TURN 1: Get response from Claude
    console.log('TURN 1: Request to Claude');
    console.log('-'.repeat(40));

    const turn1Messages = [
        { role: 'user', content: 'Run "echo hello" command.' }
    ];

    const turn1Result = await streamRequest({
        model: CLAUDE_MODEL,
        max_tokens: claudeConfig.max_tokens,
        stream: true,
        tools,
        thinking: claudeConfig.thinking,
        messages: turn1Messages
    });

    const turn1Content = analyzeContent(turn1Result.content);
    console.log(`  Thinking: ${turn1Content.hasThinking ? 'YES' : 'NO'}`);
    console.log(`  Signature: ${turn1Content.hasSignature ? 'YES' : 'NO'}`);
    console.log(`  Tool Use: ${turn1Content.hasToolUse ? 'YES' : 'NO'}`);

    if (!turn1Content.hasToolUse) {
        console.log('  SKIP: No tool use in turn 1');
        return { passed: false, skipped: true };
    }

    // Build assistant message
    const assistantContent = [];
    if (turn1Content.hasThinking && turn1Content.thinking[0]) {
        assistantContent.push({
            type: 'thinking',
            thinking: turn1Content.thinking[0].thinking,
            signature: turn1Content.thinking[0].signature || ''
        });
    }
    if (turn1Content.hasText && turn1Content.text[0]) {
        assistantContent.push({
            type: 'text',
            text: turn1Content.text[0].text
        });
    }
    for (const tool of turn1Content.toolUse) {
        assistantContent.push({
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: tool.input
        });
    }

    // TURN 2: Continue with same model
    console.log('\nTURN 2: Continue with Claude (same model)');
    console.log('-'.repeat(40));

    const turn2Messages = [
        { role: 'user', content: 'Run "echo hello" command.' },
        { role: 'assistant', content: assistantContent },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: turn1Content.toolUse[0].id,
                content: 'hello'
            }]
        }
    ];

    try {
        const turn2Result = await streamRequest({
            model: CLAUDE_MODEL,
            max_tokens: claudeConfig.max_tokens,
            stream: true,
            tools,
            thinking: claudeConfig.thinking,
            messages: turn2Messages
        });

        const turn2Content = analyzeContent(turn2Result.content);
        console.log(`  Response received: YES`);
        console.log(`  Thinking: ${turn2Content.hasThinking ? 'YES' : 'NO'}`);
        console.log(`  Signature: ${turn2Content.hasSignature ? 'YES' : 'NO'}`);
        console.log(`  Text: ${turn2Content.hasText ? 'YES' : 'NO'}`);
        console.log(`  Error: NO`);

        // For same model, we should preserve thinking with valid signature
        const passed = turn2Content.hasText || turn2Content.hasThinking;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        return { passed };
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log(`  Result: FAIL`);
        return { passed: false, error: error.message };
    }
}

async function testSameModelContinuationGemini(GEMINI_MODEL) {
    console.log('\n' + '='.repeat(60));
    console.log('TEST: Same Model Continuation - Gemini (Control Test)');
    console.log('Verifies same-model multi-turn still works for Gemini');
    console.log('='.repeat(60));
    console.log('');

    const geminiConfig = getModelConfig('gemini');

    // TURN 1: Get response from Gemini
    console.log('TURN 1: Request to Gemini');
    console.log('-'.repeat(40));

    const turn1Messages = [
        { role: 'user', content: 'Run "echo world" command.' }
    ];

    const turn1Result = await streamRequest({
        model: GEMINI_MODEL,
        max_tokens: geminiConfig.max_tokens,
        stream: true,
        tools,
        thinking: geminiConfig.thinking,
        messages: turn1Messages
    });

    const turn1Content = analyzeContent(turn1Result.content);
    console.log(`  Thinking: ${turn1Content.hasThinking ? 'YES' : 'NO'}`);
    console.log(`  Signature: ${turn1Content.hasSignature ? 'YES' : 'NO'}`);
    console.log(`  Tool Use: ${turn1Content.hasToolUse ? 'YES' : 'NO'}`);

    if (!turn1Content.hasToolUse) {
        console.log('  SKIP: No tool use in turn 1');
        return { passed: false, skipped: true };
    }

    // Build assistant message
    const assistantContent = [];
    if (turn1Content.hasThinking && turn1Content.thinking[0]) {
        assistantContent.push({
            type: 'thinking',
            thinking: turn1Content.thinking[0].thinking,
            signature: turn1Content.thinking[0].signature || ''
        });
    }
    if (turn1Content.hasText && turn1Content.text[0]) {
        assistantContent.push({
            type: 'text',
            text: turn1Content.text[0].text
        });
    }
    for (const tool of turn1Content.toolUse) {
        const toolBlock = {
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: tool.input
        };
        // Include thoughtSignature if present (Gemini puts it on tool_use)
        if (tool.thoughtSignature) {
            toolBlock.thoughtSignature = tool.thoughtSignature;
        }
        assistantContent.push(toolBlock);
    }

    // TURN 2: Continue with same model
    console.log('\nTURN 2: Continue with Gemini (same model)');
    console.log('-'.repeat(40));

    const turn2Messages = [
        { role: 'user', content: 'Run "echo world" command.' },
        { role: 'assistant', content: assistantContent },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: turn1Content.toolUse[0].id,
                content: 'world'
            }]
        }
    ];

    try {
        const turn2Result = await streamRequest({
            model: GEMINI_MODEL,
            max_tokens: geminiConfig.max_tokens,
            stream: true,
            tools,
            thinking: geminiConfig.thinking,
            messages: turn2Messages
        });

        const turn2Content = analyzeContent(turn2Result.content);
        console.log(`  Response received: YES`);
        console.log(`  Thinking: ${turn2Content.hasThinking ? 'YES' : 'NO'}`);
        console.log(`  Signature: ${turn2Content.hasSignature ? 'YES' : 'NO'}`);
        console.log(`  Text: ${turn2Content.hasText ? 'YES' : 'NO'}`);
        console.log(`  Error: NO`);

        // For same model, we should get a response
        const passed = turn2Content.hasText || turn2Content.hasThinking;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
        return { passed };
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log(`  Result: FAIL`);
        return { passed: false, error: error.message };
    }
}

async function main() {
    // Load models once from constants
    const TEST_MODELS = await getModels();
    const CLAUDE_MODEL = TEST_MODELS.claude;
    const GEMINI_MODEL = TEST_MODELS.gemini;

    console.log('\n');
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║' + '      CROSS-MODEL THINKING SIGNATURE TEST SUITE          '.padEnd(58) + '║');
    console.log('║' + '      Tests switching between Claude and Gemini          '.padEnd(58) + '║');
    console.log('╚' + '═'.repeat(58) + '╝');
    console.log('\n');

    const results = [];

    // Test 1: Claude → Gemini
    const claudeToGemini = await testClaudeToGemini(CLAUDE_MODEL, GEMINI_MODEL);
    results.push({ name: 'Claude → Gemini', ...claudeToGemini });

    // Test 2: Gemini → Claude
    const geminiToClaude = await testGeminiToClaude(CLAUDE_MODEL, GEMINI_MODEL);
    results.push({ name: 'Gemini → Claude', ...geminiToClaude });

    // Test 3: Same model Claude (control)
    const sameModelClaude = await testSameModelContinuation(CLAUDE_MODEL);
    results.push({ name: 'Same Model (Claude → Claude)', ...sameModelClaude });

    // Test 4: Same model Gemini (control)
    const sameModelGemini = await testSameModelContinuationGemini(GEMINI_MODEL);
    results.push({ name: 'Same Model (Gemini → Gemini)', ...sameModelGemini });

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    let allPassed = true;
    for (const result of results) {
        const status = result.skipped ? 'SKIP' : (result.passed ? 'PASS' : 'FAIL');
        console.log(`  [${status}] ${result.name}`);
        if (!result.passed && !result.skipped) allPassed = false;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`FINAL RESULT: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
