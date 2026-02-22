/**
 * Test: Sensitive Data Redaction in Logs
 * 
 * Verifies that:
 * 1. Full message content is not stored in logs when debug mode is disabled
 * 2. System prompts are truncated to length only
 * 3. Tool definitions only show names, not full schemas
 * 4. Log data is size-capped to prevent memory bloat
 */

import { logger, sanitizeMessages, sanitizeTools, sanitizeRequestMetadata, sanitizeLogData, truncateLogData } from '../src/utils/logger.js';

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║        SENSITIVE DATA REDACTION TEST SUITE                 ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (error) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
        failed++;
    }
}

// Ensure debug mode is OFF for these tests
logger.setDebug(false);

// Test data simulating a real API request with sensitive content
const sensitiveRequest = {
    model: 'claude-sonnet-4-20250514',
    stream: true,
    messages: [
        {
            role: 'user',
            content: 'My email is john.doe@example.com and my API key is sk-1234567890abcdef'
        },
        {
            role: 'assistant',
            content: 'I understand your email is john.doe@example.com'
        },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Process this data' },
                { type: 'tool_use', name: 'search', input: { query: 'sensitive query' } }
            ]
        }
    ],
    system: 'You are a helpful assistant. User secret: ABC123XYZ',
    tools: [
        {
            function: {
                name: 'search',
                description: 'Search the web',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        apiKey: { type: 'string', description: 'API key for search' }
                    },
                    required: ['query']
                }
            }
        }
    ],
    thinking: { type: 'enabled', budget_tokens: 1024 }
};

// ─── Test 1: Sanitize Messages ───
test('Messages are sanitized - only metadata kept', () => {
    const sanitized = sanitizeMessages(sensitiveRequest.messages);
    
    if (!Array.isArray(sanitized)) throw new Error('Should return an array');
    if (sanitized.length !== 3) throw new Error('Should have 3 messages');
    
    // Check that only metadata is present
    const firstMsg = sanitized[0];
    if (firstMsg.role !== 'user') throw new Error('Should have role');
    if (typeof firstMsg.contentLength !== 'number') throw new Error('Should have contentLength');
    if (!firstMsg.contentTypes) throw new Error('Should have contentTypes');
    
    // Verify actual content is NOT present
    if (firstMsg.content !== undefined) throw new Error('Should NOT have actual content');
    if (JSON.stringify(firstMsg).includes('john.doe@example.com')) throw new Error('Should not contain email');
    if (JSON.stringify(firstMsg).includes('sk-')) throw new Error('Should not contain API key');
});

// ─── Test 2: Sanitize Tools ───
test('Tools are sanitized - only names kept', () => {
    const sanitized = sanitizeTools(sensitiveRequest.tools);
    
    if (!Array.isArray(sanitized)) throw new Error('Should return an array');
    if (sanitized.length !== 1) throw new Error('Should have 1 tool');
    
    const tool = sanitized[0];
    if (tool.name !== 'search') throw new Error('Should have tool name');
    if (tool.description !== '[present]') throw new Error('Should indicate description present');
    
    // Verify parameters are NOT present
    if (tool.parameters !== undefined) throw new Error('Should NOT have parameters');
    if (JSON.stringify(sanitized).includes('apiKey')) throw new Error('Should not contain apiKey in params');
});

// ─── Test 3: Sanitize Request Metadata ───
test('Request metadata is sanitized in non-debug mode', () => {
    const sanitized = sanitizeRequestMetadata(sensitiveRequest);
    
    if (sanitized.model !== 'claude-sonnet-4-20250514') throw new Error('Should have model');
    if (sanitized.stream !== true) throw new Error('Should have stream flag');
    if (typeof sanitized.messageCount !== 'number') throw new Error('Should have messageCount');
    if (sanitized.messageCount !== 3) throw new Error('Should have correct message count');
    if (typeof sanitized.hasSystem !== 'boolean') throw new Error('Should have hasSystem');
    if (typeof sanitized.toolCount !== 'number') throw new Error('Should have toolCount');
    if (sanitized.toolCount !== 1) throw new Error('Should have correct tool count');
    
    // Verify sensitive data is NOT present
    if (sanitized.messages !== undefined) throw new Error('Should NOT have messages array');
    if (sanitized.system !== undefined) throw new Error('Should NOT have system prompt');
    if (sanitized.tools !== undefined) throw new Error('Should NOT have tools array');
});

// ─── Test 4: Full Log Data Sanitization ───
test('Full log data is sanitized via sanitizeLogData', () => {
    const logData = { request: sensitiveRequest };
    const sanitized = sanitizeLogData(logData, false); // non-debug mode
    
    // Verify sensitive data is removed
    const sanitizedStr = JSON.stringify(sanitized);
    if (sanitizedStr.includes('john.doe@example.com')) throw new Error('Should not contain email');
    if (sanitizedStr.includes('sk-1234567890abcdef')) throw new Error('Should not contain API key');
    if (sanitizedStr.includes('ABC123XYZ')) throw new Error('Should not contain system secret');
    if (sanitizedStr.includes('sensitive query')) throw new Error('Should not contain tool input');
    
    // Verify metadata is preserved
    if (!sanitizedStr.includes('claude-sonnet')) throw new Error('Should contain model name');
    if (!sanitizedStr.includes('messageCount')) throw new Error('Should contain message count');
    if (!sanitizedStr.includes('toolCount')) throw new Error('Should contain tool count');
});

// ─── Test 5: Debug Mode Preserves Full Data ───
test('Debug mode preserves full request data', () => {
    const logData = { request: sensitiveRequest };
    const sanitized = sanitizeLogData(logData, true); // debug mode ON
    
    // In debug mode, request structure should be preserved
    if (!sanitized.request) throw new Error('Should have request object');
    if (sanitized.request.model !== sensitiveRequest.model) throw new Error('Should have model');
});

// ─── Test 6: Size Truncation ───
test('Large log data is truncated', () => {
    // Create a very large data object (> 10KB)
    const largeData = {
        messages: Array(100).fill(null).map((_, i) => ({
            role: 'user',
            content: 'A'.repeat(500) // 500 chars per message
        }))
    };
    
    const truncated = truncateLogData(largeData);
    
    // Large data should be truncated
    if (truncated._truncated !== true) throw new Error('Should be marked as truncated');
    if (typeof truncated._originalSize !== 'number') throw new Error('Should have original size');
    if (!truncated._warning) throw new Error('Should have warning message');
    if (!truncated._summary) throw new Error('Should have summary');
});

// ─── Test 7: Small Data Passes Through ───
test('Small log data passes through without truncation', () => {
    const smallData = { message: 'Hello', count: 1 };
    const result = truncateLogData(smallData);
    
    if (result._truncated !== undefined) throw new Error('Should not be marked as truncated');
    if (JSON.stringify(result) !== JSON.stringify(smallData)) throw new Error('Should be unchanged');
});

// ─── Summary ───
console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─────────────────────────────────────────────────────────────────\n');

if (failed > 0) {
    process.exit(1);
}
