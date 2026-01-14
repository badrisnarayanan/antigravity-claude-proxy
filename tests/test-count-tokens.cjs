/**
 * Test Count Tokens - Tests for the /v1/messages/count_tokens endpoint
 *
 * Verifies token counting functionality:
 * - Local estimation using official tokenizers (@anthropic-ai/tokenizer for Claude, @lenml/tokenizer-gemini for Gemini)
 * - Request validation
 * - Different content types (text, tools, system prompts)
 */
const http = require('http');

// Server configuration
const BASE_URL = 'localhost';
const PORT = 8080;

/**
 * Make a request to the count_tokens endpoint
 * @param {Object} body - Request body
 * @returns {Promise<Object>} - Parsed JSON response with statusCode
 */
function countTokensRequest(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: BASE_URL,
            port: PORT,
            path: '/v1/messages/count_tokens',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'test',
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            let fullData = '';
            res.on('data', chunk => fullData += chunk.toString());
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(fullData);
                    resolve({ ...parsed, statusCode: res.statusCode });
                } catch (e) {
                    reject(new Error(`Parse error: ${e.message}\nRaw: ${fullData.substring(0, 500)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           COUNT TOKENS ENDPOINT TEST SUITE                   ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        return fn()
            .then(() => {
                console.log(`✓ ${name}`);
                passed++;
            })
            .catch(e => {
                console.log(`✗ ${name}`);
                console.log(`  Error: ${e.message}`);
                failed++;
            });
    }

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    function assertType(value, type, name) {
        if (typeof value !== type) {
            throw new Error(`${name} should be ${type}, got ${typeof value}`);
        }
    }

    function assertGreater(value, min, name) {
        if (value <= min) {
            throw new Error(`${name} should be greater than ${min}, got ${value}`);
        }
    }

    // Test 1: Simple text message
    await test('Simple text message returns token count', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Hello, how are you?' }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 0, 'input_tokens');
    });

    // Test 2: Multi-turn conversation
    await test('Multi-turn conversation counts all messages', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'What is the capital of France?' },
                { role: 'assistant', content: 'The capital of France is Paris.' },
                { role: 'user', content: 'And what about Germany?' }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        // Multi-turn should have more tokens than single message
        assertGreater(response.input_tokens, 10, 'input_tokens for multi-turn');
    });

    // Test 3: System prompt
    await test('System prompt tokens are counted', async () => {
        const responseWithSystem = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            system: 'You are a helpful assistant that speaks like a pirate.',
            messages: [
                { role: 'user', content: 'Hello' }
            ]
        });

        const responseWithoutSystem = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Hello' }
            ]
        });

        assert(responseWithSystem.statusCode === 200, `Expected 200, got ${responseWithSystem.statusCode}`);
        // With system prompt should have more tokens
        assertGreater(responseWithSystem.input_tokens, responseWithoutSystem.input_tokens,
            'tokens with system prompt');
    });

    // Test 4: System prompt as array
    await test('System prompt as array is counted', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            system: [
                { type: 'text', text: 'You are a helpful assistant.' },
                { type: 'text', text: 'Be concise and clear.' }
            ],
            messages: [
                { role: 'user', content: 'Hello' }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 5, 'input_tokens');
    });

    // Test 5: With tools
    await test('Tool definitions are counted', async () => {
        const responseWithTools = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Get the weather in Tokyo' }
            ],
            tools: [
                {
                    name: 'get_weather',
                    description: 'Get the current weather for a location',
                    input_schema: {
                        type: 'object',
                        properties: {
                            location: { type: 'string', description: 'City name' }
                        },
                        required: ['location']
                    }
                }
            ]
        });

        const responseWithoutTools = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Get the weather in Tokyo' }
            ]
        });

        assert(responseWithTools.statusCode === 200, `Expected 200, got ${responseWithTools.statusCode}`);
        // With tools should have more tokens
        assertGreater(responseWithTools.input_tokens, responseWithoutTools.input_tokens,
            'tokens with tools');
    });

    // Test 6: Content as array with text blocks
    await test('Content array with text blocks', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'First part of the message.' },
                        { type: 'text', text: 'Second part of the message.' }
                    ]
                }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 5, 'input_tokens');
    });

    // Test 7: Tool use and tool result blocks
    await test('Tool use and tool result blocks are counted', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'What is the weather in Paris?' },
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tool_123',
                            name: 'get_weather',
                            input: { location: 'Paris' }
                        }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool_123',
                            content: 'The weather in Paris is sunny with 22°C'
                        }
                    ]
                }
            ],
            tools: [
                {
                    name: 'get_weather',
                    description: 'Get weather for a location',
                    input_schema: {
                        type: 'object',
                        properties: {
                            location: { type: 'string' }
                        }
                    }
                }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 20, 'input_tokens for tool conversation');
    });

    // Test 8: Thinking blocks
    await test('Thinking blocks are counted', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Solve this problem step by step' },
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'thinking',
                            thinking: 'Let me think about this problem carefully. First, I need to understand what is being asked...'
                        },
                        { type: 'text', text: 'Here is my solution.' }
                    ]
                },
                { role: 'user', content: 'Can you explain further?' }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 20, 'input_tokens with thinking');
    });

    // Test 9: Long text
    await test('Long text message', async () => {
        const longText = 'This is a test message. '.repeat(100);
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: longText }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        // Long text should have many tokens
        assertGreater(response.input_tokens, 100, 'input_tokens for long text');
    });

    // Test 10: Missing messages field (error case)
    await test('Missing messages returns error', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5'
        });

        assert(response.statusCode === 400, `Expected 400, got ${response.statusCode}`);
        assert(response.type === 'error', 'Should return error type');
        assert(response.error.type === 'invalid_request_error',
            `Expected invalid_request_error, got ${response.error?.type}`);
    });

    // Test 11: Missing model field (error case)
    await test('Missing model returns error', async () => {
        const response = await countTokensRequest({
            messages: [
                { role: 'user', content: 'Hello' }
            ]
        });

        assert(response.statusCode === 400, `Expected 400, got ${response.statusCode}`);
        assert(response.type === 'error', 'Should return error type');
        assert(response.error.type === 'invalid_request_error',
            `Expected invalid_request_error, got ${response.error?.type}`);
    });

    // Test 12: Invalid messages type (error case)
    await test('Invalid messages type returns error', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: 'not an array'
        });

        assert(response.statusCode === 400, `Expected 400, got ${response.statusCode}`);
        assert(response.type === 'error', 'Should return error type');
    });

    // Test 13: Empty messages array
    await test('Empty messages array returns token count', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: []
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
    });

    // Test 14: Multiple tools with complex schemas
    await test('Multiple tools with complex schemas', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Help me with file operations' }
            ],
            tools: [
                {
                    name: 'read_file',
                    description: 'Read a file from the filesystem',
                    input_schema: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Path to the file' },
                            encoding: { type: 'string', description: 'File encoding' }
                        },
                        required: ['path']
                    }
                },
                {
                    name: 'write_file',
                    description: 'Write content to a file',
                    input_schema: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Path to the file' },
                            content: { type: 'string', description: 'Content to write' },
                            append: { type: 'boolean', description: 'Append mode' }
                        },
                        required: ['path', 'content']
                    }
                },
                {
                    name: 'list_directory',
                    description: 'List files in a directory',
                    input_schema: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Directory path' },
                            recursive: { type: 'boolean', description: 'List recursively' }
                        },
                        required: ['path']
                    }
                }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        // Multiple tools should have significant token count
        assertGreater(response.input_tokens, 50, 'input_tokens for multiple tools');
    });

    // Test 15: Tool result as array content
    await test('Tool result with array content', async () => {
        const response = await countTokensRequest({
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Search for files' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'tool_456', name: 'search', input: { query: 'test' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool_456',
                            content: [
                                { type: 'text', text: 'Found file1.txt' },
                                { type: 'text', text: 'Found file2.txt' }
                            ]
                        }
                    ]
                }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 10, 'input_tokens');
    });

    // Test 16: Gemini model token counting
    await test('Gemini model returns token count', async () => {
        const response = await countTokensRequest({
            model: 'gemini-3-flash',
            messages: [
                { role: 'user', content: 'Hello, how are you?' }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 0, 'input_tokens');
    });

    // Test 17: Gemini model with system prompt and tools
    await test('Gemini model with system prompt and tools', async () => {
        const response = await countTokensRequest({
            model: 'gemini-3-flash',
            system: 'You are a helpful assistant.',
            messages: [
                { role: 'user', content: 'What is the weather in Tokyo?' }
            ],
            tools: [
                {
                    name: 'get_weather',
                    description: 'Get weather for a location',
                    input_schema: {
                        type: 'object',
                        properties: {
                            location: { type: 'string' }
                        }
                    }
                }
            ]
        });

        assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}`);
        assertType(response.input_tokens, 'number', 'input_tokens');
        assertGreater(response.input_tokens, 10, 'input_tokens for Gemini with tools');
    });

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
