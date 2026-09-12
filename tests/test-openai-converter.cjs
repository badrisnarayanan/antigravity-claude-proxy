/**
 * Test OpenAI Converter - Tests for OpenAI Chat Completions format conversion
 *
 * Verifies that requests and responses are correctly translated between
 * OpenAI format and Anthropic / Cloud Code format.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           OPENAI CONVERTER TEST SUITE                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        convertOpenAIToAnthropic,
        convertAnthropicToOpenAI,
        streamAnthropicToOpenAI,
        mapAnthropicStopReasonToOpenAI
    } = await import('../src/format/openai-converter.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    async function testAsync(name, fn) {
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
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    function assertTrue(condition, message = '') {
        if (!condition) {
            throw new Error(message || 'Expected condition to be true');
        }
    }

    // 1. Basic Request Conversion
    test('Converts simple text prompt with system message', () => {
        const req = {
            model: 'gemini-3.8-flash-tiered',
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'Hello!' }
            ],
            temperature: 0.7,
            max_tokens: 100
        };

        const result = convertOpenAIToAnthropic(req);
        assertEqual(result.system, 'You are a helpful assistant.');
        assertEqual(result.messages.length, 1);
        assertEqual(result.messages[0], { role: 'user', content: 'Hello!' });
        assertEqual(result.temperature, 0.7);
        assertEqual(result.max_tokens, 100);
        assertEqual(result.stream, false);
    });

    test('Combines developer and system messages into system prompt', () => {
        const req = {
            model: 'claude-sonnet-4-6',
            messages: [
                { role: 'developer', content: 'Developer guideline.' },
                { role: 'system', content: 'System instruction.' },
                { role: 'user', content: 'Hi' }
            ]
        };

        const result = convertOpenAIToAnthropic(req);
        assertEqual(result.system, 'Developer guideline.\n\nSystem instruction.');
        assertEqual(result.messages.length, 1);
    });

    test('Converts multimodal user messages with image_url (base64 data URI)', () => {
        const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const req = {
            model: 'gemini-3-flash',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe this:' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } }
                    ]
                }
            ]
        };

        const result = convertOpenAIToAnthropic(req);
        assertEqual(result.messages[0].role, 'user');
        assertTrue(Array.isArray(result.messages[0].content));
        assertEqual(result.messages[0].content[0], { type: 'text', text: 'Describe this:' });
        assertEqual(result.messages[0].content[1], {
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Data
            }
        });
    });

    test('Converts assistant message with tool_calls to Anthropic tool_use blocks', () => {
        const req = {
            model: 'gemini-3.8-flash-tiered',
            messages: [
                { role: 'user', content: 'What is the weather in Tokyo?' },
                {
                    role: 'assistant',
                    content: 'Let me check for you.',
                    tool_calls: [
                        {
                            id: 'call_12345',
                            type: 'function',
                            function: {
                                name: 'get_weather',
                                arguments: '{"city":"Tokyo","unit":"celsius"}'
                            }
                        }
                    ]
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_12345',
                    content: '{"temp": 22, "condition": "Sunny"}'
                }
            ]
        };

        const result = convertOpenAIToAnthropic(req);
        assertEqual(result.messages.length, 3);

        // Assistant turn
        assertEqual(result.messages[1].role, 'assistant');
        assertEqual(result.messages[1].content.length, 2);
        assertEqual(result.messages[1].content[0], { type: 'text', text: 'Let me check for you.' });
        assertEqual(result.messages[1].content[1], {
            type: 'tool_use',
            id: 'call_12345',
            name: 'get_weather',
            input: { city: 'Tokyo', unit: 'celsius' }
        });

        // Tool result turn (mapped to user role in Anthropic)
        assertEqual(result.messages[2].role, 'user');
        assertEqual(result.messages[2].content[0], {
            type: 'tool_result',
            tool_use_id: 'call_12345',
            content: '{"temp": 22, "condition": "Sunny"}'
        });
    });

    test('Converts OpenAI tools and tool_choice to Anthropic format', () => {
        const req = {
            model: 'gemini-3.8-flash-tiered',
            messages: [{ role: 'user', content: 'test' }],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'calculate',
                        description: 'Perform math calculation',
                        parameters: {
                            type: 'object',
                            properties: { expr: { type: 'string' } },
                            required: ['expr']
                        }
                    }
                }
            ],
            tool_choice: { type: 'function', function: { name: 'calculate' } }
        };

        const result = convertOpenAIToAnthropic(req);
        assertEqual(result.tools.length, 1);
        assertEqual(result.tools[0].name, 'calculate');
        assertEqual(result.tools[0].description, 'Perform math calculation');
        assertEqual(result.tools[0].input_schema, req.tools[0].function.parameters);
        assertEqual(result.tool_choice, { type: 'tool', name: 'calculate' });
    });

    test('Converts tool_choice auto, required, and none', () => {
        assertEqual(convertOpenAIToAnthropic({ messages: [], tool_choice: 'auto' }).tool_choice, { type: 'auto' });
        assertEqual(convertOpenAIToAnthropic({ messages: [], tool_choice: 'required' }).tool_choice, { type: 'any' });
        assertEqual(convertOpenAIToAnthropic({ messages: [], tool_choice: 'none' }).tool_choice, { type: 'none' });
    });

    // 2. Non-Streaming Response Conversion
    test('Converts Anthropic response to OpenAI ChatCompletion format', () => {
        const anthropicRes = {
            id: 'msg_987654321',
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'text', text: 'Hello! How can I help you today?' }
            ],
            model: 'gemini-3.8-flash-tiered',
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 15,
                output_tokens: 25
            }
        };

        const result = convertAnthropicToOpenAI(anthropicRes, 'gemini-3.8-flash-tiered');
        assertEqual(result.id, 'chatcmpl-987654321');
        assertEqual(result.object, 'chat.completion');
        assertEqual(result.model, 'gemini-3.8-flash-tiered');
        assertEqual(result.choices.length, 1);
        assertEqual(result.choices[0].finish_reason, 'stop');
        assertEqual(result.choices[0].message.role, 'assistant');
        assertEqual(result.choices[0].message.content, 'Hello! How can I help you today?');
        assertEqual(result.usage.prompt_tokens, 15);
        assertEqual(result.usage.completion_tokens, 25);
        assertEqual(result.usage.total_tokens, 40);
    });

    test('Converts Anthropic response with tool_use to OpenAI tool_calls', () => {
        const anthropicRes = {
            id: 'msg_112233',
            type: 'message',
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'call_abc123',
                    name: 'search',
                    input: { query: 'antigravity quota' }
                }
            ],
            model: 'claude-sonnet-4-6',
            stop_reason: 'tool_use',
            usage: { input_tokens: 20, output_tokens: 30 }
        };

        const result = convertAnthropicToOpenAI(anthropicRes, 'claude-sonnet-4-6');
        assertEqual(result.choices[0].finish_reason, 'tool_calls');
        assertEqual(result.choices[0].message.content, null);
        assertEqual(result.choices[0].message.tool_calls.length, 1);
        assertEqual(result.choices[0].message.tool_calls[0], {
            id: 'call_abc123',
            type: 'function',
            function: {
                name: 'search',
                arguments: '{"query":"antigravity quota"}'
            }
        });
    });

    // 3. Stop Reason Mapping
    test('Maps stop reasons correctly', () => {
        assertEqual(mapAnthropicStopReasonToOpenAI('end_turn'), 'stop');
        assertEqual(mapAnthropicStopReasonToOpenAI('stop_sequence'), 'stop');
        assertEqual(mapAnthropicStopReasonToOpenAI('tool_use'), 'tool_calls');
        assertEqual(mapAnthropicStopReasonToOpenAI('max_tokens'), 'length');
        assertEqual(mapAnthropicStopReasonToOpenAI('unknown'), 'stop');
    });

    // 4. Streaming SSE Conversion
    await testAsync('Streams Anthropic events as OpenAI SSE chunks', async () => {
        async function* mockAnthropicStream() {
            yield {
                type: 'message_start',
                message: {
                    id: 'msg_stream_01',
                    model: 'gemini-3.8-flash-tiered',
                    usage: { input_tokens: 12 }
                }
            };
            yield {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            };
            yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hello' }
            };
            yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: ' world!' }
            };
            yield {
                type: 'content_block_stop',
                index: 0
            };
            yield {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 4 }
            };
            yield {
                type: 'message_stop'
            };
        }

        const chunks = [];
        for await (const chunk of streamAnthropicToOpenAI(mockAnthropicStream(), 'gemini-3.8-flash-tiered', 'chatcmpl-test-id')) {
            chunks.push(chunk);
        }

        assertTrue(chunks.length >= 4, 'Should yield multiple SSE chunks');
        assertTrue(chunks[chunks.length - 1] === 'data: [DONE]\n\n', 'Last chunk must be data: [DONE]');

        // First chunk
        const first = JSON.parse(chunks[0].replace(/^data: /, '').trim());
        assertEqual(first.id, 'chatcmpl-test-id');
        assertEqual(first.object, 'chat.completion.chunk');
        assertEqual(first.choices[0].delta.role, 'assistant');

        // Content deltas
        const second = JSON.parse(chunks[1].replace(/^data: /, '').trim());
        assertEqual(second.choices[0].delta.content, 'Hello');

        const third = JSON.parse(chunks[2].replace(/^data: /, '').trim());
        assertEqual(third.choices[0].delta.content, ' world!');

        // Final chunk
        const finalChunk = JSON.parse(chunks[chunks.length - 2].replace(/^data: /, '').trim());
        assertEqual(finalChunk.choices[0].finish_reason, 'stop');
        assertEqual(finalChunk.usage.prompt_tokens, 12);
        assertEqual(finalChunk.usage.completion_tokens, 4);
        assertEqual(finalChunk.usage.total_tokens, 16);
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
