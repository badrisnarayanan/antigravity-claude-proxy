/**
 * Image Support Test
 *
 * Tests that images can be sent to the API with thinking models.
 * Simulates Claude Code sending screenshots or images for analysis.
 *
 * Runs for both Claude and Gemini model families.
 */
const fs = require('fs');
const path = require('path');
const { streamRequest, analyzeContent } = require('./helpers/http-client.cjs');
const { getTestModels, getModelConfig, familySupportsThinking } = require('./helpers/test-models.cjs');

// Load test image from disk
const TEST_IMAGE_PATH = path.join(__dirname, 'utils', 'test_image.jpeg');
const TEST_IMAGE_BASE64 = fs.readFileSync(TEST_IMAGE_PATH).toString('base64');

async function runTestsForModel(family, model) {
    console.log('='.repeat(60));
    console.log(`IMAGE SUPPORT TEST [${family.toUpperCase()}]`);
    console.log(`Model: ${model}`);
    console.log('Tests image processing with thinking models');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];
    const modelConfig = getModelConfig(family);
    const expectThinking = familySupportsThinking(family);

    // ===== TEST 1: Single image with question =====
    console.log('TEST 1: Single image with question');
    console.log('-'.repeat(40));

    const result1 = await streamRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: true,
        thinking: modelConfig.thinking,
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/jpeg',
                        data: TEST_IMAGE_BASE64
                    }
                },
                {
                    type: 'text',
                    text: 'What do you see in this image? Describe it briefly.'
                }
            ]
        }]
    });

    if (result1.error) {
        console.log(`  ERROR: ${result1.error.message}`);
        allPassed = false;
        results.push({ name: 'Single image processing', passed: false });
    } else {
        const content = analyzeContent(result1.content);

        console.log(`  Thinking: ${content.hasThinking ? 'YES' : 'NO'}`);
        console.log(`  Text response: ${content.hasText ? 'YES' : 'NO'}`);

        if (content.hasThinking && content.thinking[0].thinking) {
            console.log(`  Thinking: "${content.thinking[0].thinking.substring(0, 60)}..."`);
        }
        if (content.hasText && content.text[0].text) {
            console.log(`  Response: "${content.text[0].text.substring(0, 100)}..."`);
        }

        // For thinking models, expect thinking + text. For others, just text.
        const passed = expectThinking
            ? (content.hasThinking && content.hasText)
            : content.hasText;
        results.push({ name: 'Single image processing', passed });
        if (!passed) allPassed = false;
    }

    // ===== TEST 2: Image + text in multi-turn =====
    console.log('\nTEST 2: Image in multi-turn conversation');
    console.log('-'.repeat(40));

    const result2 = await streamRequest({
        model,
        max_tokens: modelConfig.max_tokens,
        stream: true,
        thinking: modelConfig.thinking,
        messages: [
            {
                role: 'user',
                content: 'I will show you an image.'
            },
            {
                role: 'assistant',
                content: [{
                    type: 'text',
                    text: 'Sure, please share the image and I\'ll help analyze it.'
                }]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/jpeg',
                            data: TEST_IMAGE_BASE64
                        }
                    },
                    {
                        type: 'text',
                        text: 'Here is the image. What do you see?'
                    }
                ]
            }
        ]
    });

    if (result2.error) {
        console.log(`  ERROR: ${result2.error.message}`);
        allPassed = false;
        results.push({ name: 'Image in multi-turn', passed: false });
    } else {
        const content = analyzeContent(result2.content);

        console.log(`  Thinking: ${content.hasThinking ? 'YES' : 'NO'}`);
        console.log(`  Text response: ${content.hasText ? 'YES' : 'NO'}`);

        if (content.hasText && content.text[0].text) {
            console.log(`  Response: "${content.text[0].text.substring(0, 80)}..."`);
        }

        const passed = content.hasText;
        results.push({ name: 'Image in multi-turn', passed });
        if (!passed) allPassed = false;
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
