/**
 * Multi-Turn Tool Call Test (Non-Streaming)
 *
 * Simulates Claude Code's actual multi-turn conversation pattern:
 * 1. User asks question requiring tool
 * 2. Assistant responds with thinking + tool_use
 * 3. User provides tool_result
 * 4. Assistant responds with thinking + final answer
 *
 * Key aspects tested:
 * - Thinking blocks with signatures are preserved across turns
 * - Tool use/result flow works correctly
 * - Interleaved thinking with tools
 *
 * Runs for both Claude and Gemini model families.
 */
const { makeRequest, analyzeContent, commonTools } = require('./helpers/http-client.cjs');
const { getTestModels, getModelConfig, familySupportsThinking } = require('./helpers/test-models.cjs');

const tools = [commonTools.searchFiles, commonTools.readFile];

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`MULTI-TURN TOOL CALL TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Simulates Claude Code conversation pattern');
    console.log('='.repeat(60));
    console.log('');

    let messages = [];
    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);
    const expectThinking = familySupportsThinking(family);

    // ===== TURN 1: Initial request =====
    console.log('TURN 1: User asks to find and read a config file');
    console.log('-'.repeat(40));

    messages.push({
        role: 'user',
        content: 'Find the package.json file and tell me what dependencies it has. Use search_files first.'
    });

    const turn1 = await makeRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: false,
        tools,
        thinking: modelConfig.thinking,
        messages
    });

    if (turn1.statusCode !== 200 || turn1.error) {
        console.log(`  ERROR: ${turn1.error?.message || `Status ${turn1.statusCode}`}`);
        allPassed = false;
        results.push({ name: 'Turn 1: Initial request', passed: false });
    } else {
        const analysis = analyzeContent(turn1.content || []);
        console.log(`  Thinking: ${analysis.hasThinking ? 'YES' : 'NO'} (${analysis.thinking.length} blocks)`);
        console.log(`  Signature: ${analysis.hasSignature ? 'YES' : 'NO'}`);
        console.log(`  Tool Use: ${analysis.hasToolUse ? 'YES' : 'NO'} (${analysis.toolUse.length} calls)`);
        console.log(`  Text: ${analysis.hasText ? 'YES' : 'NO'}`);

        if (analysis.hasThinking && analysis.thinking[0].thinking) {
            console.log(`  Thinking: "${analysis.thinking[0].thinking.substring(0, 60)}..."`);
        }
        if (analysis.hasToolUse) {
            console.log(`  Tool: ${analysis.toolUse[0].name}(${JSON.stringify(analysis.toolUse[0].input)})`);
        }

        // For thinking models, expect signature + tool use
        // Note: Gemini doesn't always produce thinking blocks, but does put signatures on tool_use
        const passed = expectThinking
            ? (analysis.hasSignature && analysis.hasToolUse)  // Signature required, thinking optional
            : analysis.hasToolUse;
        results.push({ name: 'Turn 1: Thinking + Signature + Tool Use', passed });
        if (!passed) allPassed = false;

        // Prepare for turn 2
        if (analysis.hasToolUse) {
            messages.push({ role: 'assistant', content: turn1.content });
        }
    }

    // ===== TURN 2: Provide tool result =====
    if (messages.length >= 2) {
        console.log('\nTURN 2: Provide tool result, expect another tool call');
        console.log('-'.repeat(40));

        const lastAssistant = messages[messages.length - 1];
        const toolUseBlock = lastAssistant.content.find(b => b.type === 'tool_use');

        messages.push({
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: 'Found files:\n- /project/package.json (root, 2.3KB, modified 2 days ago)\n- /project/packages/core/package.json (workspace, 1.1KB, modified 1 hour ago)\n- /project/packages/legacy/package.json (deprecated, 0.8KB, modified 1 year ago)\n- /project/node_modules/lodash/package.json (dependency, 3.2KB)\n\nIMPORTANT: Before proceeding, reason through which files are most relevant. Consider: Are node_modules relevant? Should deprecated packages be included? Which workspace packages matter for the user\'s question about dependencies?'
            }]
        });

        const turn2 = await makeRequest({
            model,
            max_tokens: modelConfig.max_tokens,
            stream: false,
            tools,
            thinking: modelConfig.thinking,
            messages
        });

        if (turn2.statusCode !== 200 || turn2.error) {
            console.log(`  ERROR: ${turn2.error?.message || `Status ${turn2.statusCode}`}`);
            allPassed = false;
            results.push({ name: 'Turn 2: After tool result', passed: false });
        } else {
            const analysis = analyzeContent(turn2.content || []);
            console.log(`  Thinking: ${analysis.hasThinking ? 'YES' : 'NO'} (${analysis.thinking.length} blocks)`);
            console.log(`  Signature: ${analysis.hasSignature ? 'YES' : 'NO'}`);
            console.log(`  Tool Use: ${analysis.hasToolUse ? 'YES' : 'NO'} (${analysis.toolUse.length} calls)`);
            console.log(`  Text: ${analysis.hasText ? 'YES' : 'NO'}`);

            if (analysis.hasThinking && analysis.thinking[0].thinking) {
                console.log(`  Thinking: "${analysis.thinking[0].thinking.substring(0, 60)}..."`);
            }
            if (analysis.hasToolUse) {
                console.log(`  Tool: ${analysis.toolUse[0].name}(${JSON.stringify(analysis.toolUse[0].input)})`);
            }

            // Either tool use (to read file) or text response is acceptable
            // Note: Claude may skip thinking on obvious next steps - this is valid behavior
            // We only require thinking on the first turn to verify signatures work
            const passed = analysis.hasToolUse || analysis.hasText;
            results.push({ name: 'Turn 2: Tool or Text response', passed });
            if (!passed) allPassed = false;

            if (analysis.hasToolUse) {
                messages.push({ role: 'assistant', content: turn2.content });
            }
        }
    }

    // ===== TURN 3: Final tool result and response =====
    if (messages.length >= 4) {
        const lastAssistant = messages[messages.length - 1];
        const toolUseBlocks = lastAssistant.content?.filter(b => b.type === 'tool_use') || [];

        if (toolUseBlocks.length > 0) {
            console.log('\nTURN 3: Provide file content, expect final response');
            console.log('-'.repeat(40));

            // Provide tool_result for ALL tool_use blocks (API requires this)
            const toolResults = toolUseBlocks.map((toolUseBlock, idx) => ({
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: JSON.stringify({
                    name: idx === 0 ? 'my-project' : 'core-package',
                    dependencies: idx === 0
                        ? { express: '^4.18.2', cors: '^2.8.5' }
                        : { lodash: '^4.17.21' }
                }, null, 2)
            }));

            messages.push({
                role: 'user',
                content: toolResults
            });

            const turn3 = await makeRequest({
                model,
                max_tokens: modelConfig.max_tokens,
                stream: false,
                tools,
                thinking: modelConfig.thinking,
                messages
            });

            if (turn3.statusCode !== 200 || turn3.error) {
                console.log(`  ERROR: ${turn3.error?.message || `Status ${turn3.statusCode}`}`);
                allPassed = false;
                results.push({ name: 'Turn 3: Final response', passed: false });
            } else {
                            const analysis = analyzeContent(turn3.content || []);
                console.log(`  Thinking: ${analysis.hasThinking ? 'YES' : 'NO'} (${analysis.thinking.length} blocks)`);
                console.log(`  Signature: ${analysis.hasSignature ? 'YES' : 'NO'}`);
                console.log(`  Tool Use: ${analysis.hasToolUse ? 'YES' : 'NO'} (${analysis.toolUse.length} calls)`);
                console.log(`  Text: ${analysis.hasText ? 'YES' : 'NO'}`);

                if (analysis.hasText && analysis.text[0].text) {
                    console.log(`  Response: "${analysis.text[0].text.substring(0, 100)}..."`);
                }
                if (analysis.hasToolUse) {
                    console.log(`  Tool: ${analysis.toolUse[0].name}(${JSON.stringify(analysis.toolUse[0].input)})`);
                }

                // For final turn: expect text OR another tool call (model may need more info)
                const passed = analysis.hasText || analysis.hasToolUse;
                const responseType = analysis.hasText ? 'text' : (analysis.hasToolUse ? 'tool_use' : 'none');
                results.push({ name: `Turn 3: Response (${responseType})`, passed });
                if (!passed) allPassed = false;
            }
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
