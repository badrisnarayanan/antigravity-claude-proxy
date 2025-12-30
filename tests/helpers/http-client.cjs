/**
 * Shared Test HTTP Client Utilities
 *
 * Provides common HTTP request functions for integration tests.
 * Eliminates code duplication across test files.
 */
const http = require('http');

// Server configuration
const BASE_URL = 'localhost';
const PORT = process.env.PORT || 8080;

/**
 * Make a streaming SSE request to the API
 * @param {Object} body - Request body
 * @returns {Promise<{content: Array, events: Array, statusCode: number, raw: string}>}
 */
function streamRequest(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: BASE_URL,
            port: PORT,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'test',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'interleaved-thinking-2025-05-14',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            const events = [];
            let fullData = '';

            res.on('data', chunk => {
                fullData += chunk.toString();
            });

            res.on('end', () => {
                // Parse SSE events
                const parts = fullData.split('\n\n').filter(e => e.trim());
                for (const part of parts) {
                    const lines = part.split('\n');
                    const eventLine = lines.find(l => l.startsWith('event:'));
                    const dataLine = lines.find(l => l.startsWith('data:'));
                    if (eventLine && dataLine) {
                        try {
                            const eventType = eventLine.replace('event:', '').trim();
                            const eventData = JSON.parse(dataLine.replace('data:', '').trim());
                            events.push({ type: eventType, data: eventData });
                        } catch (e) { }
                    }
                }

                // Build content from events
                const content = [];
                let currentBlock = null;

                for (const event of events) {
                    if (event.type === 'content_block_start') {
                        currentBlock = { ...event.data.content_block };
                        if (currentBlock.type === 'thinking') {
                            currentBlock.thinking = '';
                            currentBlock.signature = '';
                        }
                        if (currentBlock.type === 'text') currentBlock.text = '';
                    } else if (event.type === 'content_block_delta') {
                        const delta = event.data.delta;
                        if (delta.type === 'thinking_delta' && currentBlock) {
                            currentBlock.thinking += delta.thinking || '';
                        }
                        if (delta.type === 'signature_delta' && currentBlock) {
                            currentBlock.signature += delta.signature || '';
                        }
                        if (delta.type === 'text_delta' && currentBlock) {
                            currentBlock.text += delta.text || '';
                        }
                        if (delta.type === 'input_json_delta' && currentBlock) {
                            currentBlock.partial_json = (currentBlock.partial_json || '') + delta.partial_json;
                        }
                    } else if (event.type === 'content_block_stop') {
                        if (currentBlock?.type === 'tool_use' && currentBlock.partial_json) {
                            try { currentBlock.input = JSON.parse(currentBlock.partial_json); } catch (e) { }
                            delete currentBlock.partial_json;
                        }
                        if (currentBlock) content.push(currentBlock);
                        currentBlock = null;
                    }
                }

                resolve({ content, events, statusCode: res.statusCode, raw: fullData });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

/**
 * Make a non-streaming JSON request to the API
 * @param {Object} body - Request body
 * @returns {Promise<Object>} - Parsed JSON response with statusCode
 */
function makeRequest(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: BASE_URL,
            port: PORT,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'test',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'interleaved-thinking-2025-05-14',
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

/**
 * Analyze content blocks from a response
 * @param {Array} content - Array of content blocks
 * @returns {Object} - Analysis results
 */
function analyzeContent(content) {
    const thinking = content.filter(b => b.type === 'thinking');
    const toolUse = content.filter(b => b.type === 'tool_use');
    const text = content.filter(b => b.type === 'text');

    // Check for signatures in thinking blocks (Claude style)
    const thinkingHasSignature = thinking.some(t => t.signature && t.signature.length >= 50);

    // Check for signatures in tool_use blocks (Gemini 3+ style)
    const toolUseHasSignature = toolUse.some(t => t.thoughtSignature && t.thoughtSignature.length >= 50);

    return {
        thinking,
        toolUse,
        text,
        hasThinking: thinking.length > 0,
        hasToolUse: toolUse.length > 0,
        hasText: text.length > 0,
        thinkingHasSignature: thinkingHasSignature,
        toolUseHasSignature: toolUseHasSignature,
        // Combined check: signature exists somewhere (thinking or tool_use)
        hasSignature: thinkingHasSignature || toolUseHasSignature
    };
}

/**
 * Analyze SSE events from a streaming response
 * @param {Array} events - Array of SSE events
 * @returns {Object} - Event counts by type
 */
function analyzeEvents(events) {
    return {
        messageStart: events.filter(e => e.type === 'message_start').length,
        blockStart: events.filter(e => e.type === 'content_block_start').length,
        blockDelta: events.filter(e => e.type === 'content_block_delta').length,
        blockStop: events.filter(e => e.type === 'content_block_stop').length,
        messageDelta: events.filter(e => e.type === 'message_delta').length,
        messageStop: events.filter(e => e.type === 'message_stop').length,
        thinkingDeltas: events.filter(e => e.data?.delta?.type === 'thinking_delta').length,
        signatureDeltas: events.filter(e => e.data?.delta?.type === 'signature_delta').length,
        textDeltas: events.filter(e => e.data?.delta?.type === 'text_delta').length,
        inputJsonDeltas: events.filter(e => e.data?.delta?.type === 'input_json_delta').length
    };
}

/**
 * Extract usage metadata from SSE events
 * @param {Array} events - Array of SSE events
 * @returns {Object} - Usage info with input/output/cache tokens
 */
function extractUsage(events) {
    const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
    };

    // Get usage from message_start
    const messageStart = events.find(e => e.type === 'message_start');
    if (messageStart?.data?.message?.usage) {
        const startUsage = messageStart.data.message.usage;
        usage.input_tokens = startUsage.input_tokens || 0;
        usage.cache_read_input_tokens = startUsage.cache_read_input_tokens || 0;
        usage.cache_creation_input_tokens = startUsage.cache_creation_input_tokens || 0;
    }

    // Get output tokens from message_delta
    const messageDelta = events.find(e => e.type === 'message_delta');
    if (messageDelta?.data?.usage) {
        const deltaUsage = messageDelta.data.usage;
        usage.output_tokens = deltaUsage.output_tokens || 0;
        // Also check for cache tokens in delta (may be updated)
        if (deltaUsage.cache_read_input_tokens !== undefined) {
            usage.cache_read_input_tokens = deltaUsage.cache_read_input_tokens;
        }
    }

    return usage;
}

// Common tool definitions for tests
const commonTools = {
    getWeather: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        input_schema: {
            type: 'object',
            properties: {
                location: { type: 'string', description: 'City name' }
            },
            required: ['location']
        }
    },
    searchFiles: {
        name: 'search_files',
        description: 'Search for files matching a pattern',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern to search' },
                path: { type: 'string', description: 'Directory to search in' }
            },
            required: ['pattern']
        }
    },
    readFile: {
        name: 'read_file',
        description: 'Read contents of a file',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to file' }
            },
            required: ['path']
        }
    },
    executeCommand: {
        name: 'execute_command',
        description: 'Execute a shell command',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command to execute' },
                cwd: { type: 'string', description: 'Working directory' }
            },
            required: ['command']
        }
    },
    writeFile: {
        name: 'write_file',
        description: 'Write to a file',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' }
            },
            required: ['path', 'content']
        }
    },
    runTests: {
        name: 'run_tests',
        description: 'Run test suite',
        input_schema: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern']
        }
    }
};

module.exports = {
    BASE_URL,
    PORT,
    streamRequest,
    makeRequest,
    analyzeContent,
    analyzeEvents,
    extractUsage,
    commonTools
};
