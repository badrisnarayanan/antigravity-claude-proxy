/**
 * OpenAI Chat Completions Compatibility Tests
 *
 * Unit tests for OpenAI <-> Anthropic conversion helpers used by
 * POST /v1/chat/completions.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        OPENAI CHAT COMPLETIONS COMPAT TEST SUITE             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        convertOpenAIChatCompletionsToAnthropicRequest,
        convertAnthropicToOpenAIChatCompletion,
        createOpenAIChatCompletionStreamTransformer
    } = await import('../src/openai/chat-completions.js');

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

    function assert(cond, message) {
        if (!cond) throw new Error(message);
    }

    function assertEqual(actual, expected, message = '') {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    test('Converts system + user messages', () => {
        const { anthropicRequest } = convertOpenAIChatCompletionsToAnthropicRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' }
            ]
        });

        assertEqual(anthropicRequest.system, 'You are helpful.');
        assertEqual(anthropicRequest.messages, [{ role: 'user', content: 'Hello' }]);
    });

    test('Converts OpenAI content parts (text + data URL image) to Anthropic blocks', () => {
        const { anthropicRequest } = convertOpenAIChatCompletionsToAnthropicRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Look' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                    ]
                }
            ]
        });

        const msg = anthropicRequest.messages[0];
        assert(Array.isArray(msg.content), 'Expected Anthropic content to be array blocks');
        assertEqual(msg.content[0], { type: 'text', text: 'Look' });
        assertEqual(msg.content[1], {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
        });
    });

    test('Converts OpenAI tool_calls to Anthropic tool_use blocks', () => {
        const { anthropicRequest } = convertOpenAIChatCompletionsToAnthropicRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'getWeather', arguments: '{"city":"SF"}' }
                        }
                    ]
                }
            ]
        });

        const msg = anthropicRequest.messages[0];
        assertEqual(msg.role, 'assistant');
        assert(Array.isArray(msg.content), 'Expected assistant content array');
        assertEqual(msg.content[0], {
            type: 'tool_use',
            id: 'call_1',
            name: 'getWeather',
            input: { city: 'SF' }
        });
    });

    test('Converts OpenAI tool result messages to Anthropic tool_result blocks', () => {
        const { anthropicRequest } = convertOpenAIChatCompletionsToAnthropicRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
            ]
        });

        const msg = anthropicRequest.messages[0];
        assertEqual(msg.role, 'user');
        assertEqual(msg.content, [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }
        ]);
    });

    test('Converts Anthropic response to OpenAI response (text + tool_calls + usage)', () => {
        const openai = convertAnthropicToOpenAIChatCompletion({
            id: 'msg_x',
            model: 'claude-sonnet-4-5-thinking',
            stop_reason: 'tool_use',
            content: [
                { type: 'thinking', thinking: '...', signature: 'sig' },
                { type: 'text', text: 'hi' },
                { type: 'tool_use', id: 'toolu_1', name: 'getWeather', input: { city: 'SF' } }
            ],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 }
        }, { id: 'chatcmpl_test', created: 123, model: 'claude-sonnet-4-5-thinking' });

        assertEqual(openai.id, 'chatcmpl_test');
        assertEqual(openai.object, 'chat.completion');
        assertEqual(openai.created, 123);
        assertEqual(openai.model, 'claude-sonnet-4-5-thinking');
        assertEqual(openai.choices[0].finish_reason, 'tool_calls');
        assertEqual(openai.choices[0].message.content, 'hi');
        assertEqual(openai.choices[0].message.tool_calls[0].id, 'toolu_1');
        assertEqual(openai.choices[0].message.tool_calls[0].function.name, 'getWeather');
        assertEqual(openai.choices[0].message.tool_calls[0].function.arguments, '{"city":"SF"}');
        assertEqual(openai.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
    });

    test('Streams Anthropic events as OpenAI chunks (text)', () => {
        const t = createOpenAIChatCompletionStreamTransformer({
            id: 'chatcmpl_stream',
            created: 123,
            model: 'claude-sonnet-4-5',
            includeUsage: true
        });

        const chunks = [];
        chunks.push(...t.handleAnthropicEvent({
            type: 'message_start',
            message: { usage: { input_tokens: 10, cache_read_input_tokens: 2 } }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5, cache_read_input_tokens: 2 }
        }));

        assertEqual(chunks[0].choices[0].delta.role, 'assistant');
        assertEqual(chunks[1].choices[0].delta.content, 'Hello');
        assertEqual(chunks[2].choices[0].finish_reason, 'stop');
        assertEqual(chunks[3].choices.length, 0);
        assertEqual(chunks[3].usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
    });

    test('Streams Anthropic events as OpenAI chunks (tool_calls)', () => {
        const t = createOpenAIChatCompletionStreamTransformer({
            id: 'chatcmpl_stream_tools',
            created: 123,
            model: 'claude-sonnet-4-5',
            includeUsage: false
        });

        const chunks = [];
        chunks.push(...t.handleAnthropicEvent({
            type: 'message_start',
            message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'getWeather', input: {} }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"city":"SF"}' }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 1 }
        }));

        assertEqual(chunks[1].choices[0].delta.tool_calls[0].function.name, 'getWeather');
        assertEqual(chunks[2].choices[0].delta.tool_calls[0].function.arguments, '{"city":"SF"}');
        assertEqual(chunks[3].choices[0].finish_reason, 'tool_calls');
    });

    test('Converts Anthropic image blocks to OpenAI message content (data URL markdown)', () => {
        const openai = convertAnthropicToOpenAIChatCompletion({
            model: 'gemini-3-pro-image',
            stop_reason: 'end_turn',
            content: [
                {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
                }
            ],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }, { id: 'chatcmpl_img', created: 123, model: 'gemini-3-pro-image' });

        assertEqual(openai.choices[0].message.content, '![image_1](data:image/png;base64,AAAA)');
    });

    test('Converts Anthropic url image blocks to OpenAI message content (markdown)', () => {
        const openai = convertAnthropicToOpenAIChatCompletion({
            model: 'gemini-3-pro-image',
            stop_reason: 'end_turn',
            content: [
                {
                    type: 'image',
                    source: { type: 'url', media_type: 'image/png', url: 'https://example.com/a.png' }
                }
            ],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }, { id: 'chatcmpl_img_url', created: 123, model: 'gemini-3-pro-image' });

        assertEqual(openai.choices[0].message.content, '![image_1](https://example.com/a.png)');
    });

    test('Streams Anthropic image blocks as OpenAI content chunks (data URL markdown)', () => {
        const t = createOpenAIChatCompletionStreamTransformer({
            id: 'chatcmpl_stream_img',
            created: 123,
            model: 'gemini-3-pro-image',
            includeUsage: false
        });

        const chunks = [];
        chunks.push(...t.handleAnthropicEvent({
            type: 'message_start',
            message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'content_block_start',
            index: 0,
            content_block: {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
            }
        }));

        assertEqual(chunks[0].choices[0].delta.role, 'assistant');
        assertEqual(chunks[1].choices[0].delta.content, '![image](data:image/png;base64,AAAA)');
    });

    test('Streams Anthropic url image blocks as OpenAI content chunks (markdown)', () => {
        const t = createOpenAIChatCompletionStreamTransformer({
            id: 'chatcmpl_stream_img_url',
            created: 123,
            model: 'gemini-3-pro-image',
            includeUsage: false
        });

        const chunks = [];
        chunks.push(...t.handleAnthropicEvent({
            type: 'message_start',
            message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } }
        }));
        chunks.push(...t.handleAnthropicEvent({
            type: 'content_block_start',
            index: 0,
            content_block: {
                type: 'image',
                source: { type: 'url', media_type: 'image/png', url: 'https://example.com/a.png' }
            }
        }));

        assertEqual(chunks[0].choices[0].delta.role, 'assistant');
        assertEqual(chunks[1].choices[0].delta.content, '![image](https://example.com/a.png)');
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    process.exit(failed === 0 ? 0 : 1);
}

runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
