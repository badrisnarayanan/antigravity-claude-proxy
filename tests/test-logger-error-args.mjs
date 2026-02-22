/**
 * Test: Logger - Error Positional Argument Bug Fix
 * 
 * Verifies that:
 * 1. logger.error(message, error, withData(...)) correctly captures structured data
 * 2. log.data is populated when withData is passed as third argument
 * 3. Error object is properly formatted in the message
 */

import { logger } from '../src/utils/logger.js';

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║        LOGGER ERROR ARGUMENT BUG FIX TEST                  ║');
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

// Clear history before tests
logger.history = [];

// ─── Test 1: Original usage pattern (message, withData) still works ───
test('Original pattern: logger.info(msg, withData(...)) works', () => {
    logger.history = [];
    logger.setDebug(true);
    
    logger.info('Test message', logger.withData({ key: 'value' }));
    
    const lastLog = logger.history[logger.history.length - 1];
    if (!lastLog.data) throw new Error('log.data should be populated');
    if (lastLog.data.key !== 'value') throw new Error('log.data should contain the data');
    if (!lastLog.message.includes('Test message')) throw new Error('Message should be formatted correctly');
});

// ─── Test 2: Error pattern (message, error, withData) now works ───
test('Error pattern: logger.error(msg, error, withData(...)) works', () => {
    logger.history = [];
    logger.setDebug(true);
    
    const testError = new Error('Test error message');
    logger.error('[API] Transaction failed', testError, logger.withData({
        request: { model: 'test' },
        error: { message: testError.message }
    }));
    
    const lastLog = logger.history[logger.history.length - 1];
    
    if (!lastLog.data) throw new Error('log.data should be populated');
    if (!lastLog.data.request) throw new Error('log.data should contain request');
    if (!lastLog.data.error) throw new Error('log.data should contain error info');
    if (lastLog.data.request.model !== 'test') throw new Error('request.model should be "test"');
    if (lastLog.data.error.message !== 'Test error message') throw new Error('error.message should match');
    
    // Verify error is in the formatted message
    if (!lastLog.message.includes('[API] Transaction failed')) throw new Error('Message should contain the log prefix');
});

// ─── Test 3: Error object is formatted in message ───
test('Error object appears in formatted message', () => {
    logger.history = [];
    logger.setDebug(true);
    
    const testError = new Error('Specific error text');
    logger.error('[TEST] Error:', testError, logger.withData({ extra: 'data' }));
    
    const lastLog = logger.history[logger.history.length - 1];
    
    // The error should be formatted into the message via util.format
    if (!lastLog.message.includes('[TEST] Error:')) throw new Error('Message should contain log prefix');
    if (!lastLog.message.includes('Specific error text')) throw new Error('Message should contain error message');
    
    // And data should still be captured
    if (!lastLog.data) throw new Error('log.data should be populated');
    if (lastLog.data.extra !== 'data') throw new Error('log.data should contain extra data');
});

// ─── Test 4: Multiple args with withData at end ───
test('Multiple format args with withData at end', () => {
    logger.history = [];
    logger.setDebug(true);
    
    logger.error('Error for %s: %s', 'user123', 'not found', logger.withData({ userId: '123' }));
    
    const lastLog = logger.history[logger.history.length - 1];
    
    if (!lastLog.message.includes('user123')) throw new Error('Message should contain first arg');
    if (!lastLog.message.includes('not found')) throw new Error('Message should contain second arg');
    if (!lastLog.data) throw new Error('log.data should be populated');
    if (lastLog.data.userId !== '123') throw new Error('log.data should contain userId');
});

// ─── Test 5: withData in middle position (edge case) ───
test('withData in middle position is handled', () => {
    logger.history = [];
    logger.setDebug(true);
    
    // This is an unusual pattern but should still work
    logger.info('Message', logger.withData({ first: 'data' }), 'extra');
    
    const lastLog = logger.history[logger.history.length - 1];
    
    if (!lastLog.data) throw new Error('log.data should be populated');
    if (lastLog.data.first !== 'data') throw new Error('log.data should contain first data');
});

// ─── Test 6: No withData - all args go to format ───
test('Without withData, all args are format args', () => {
    logger.history = [];
    logger.setDebug(true);
    
    logger.info('Message %s', 'test');
    
    const lastLog = logger.history[logger.history.length - 1];
    
    if (lastLog.data !== null && lastLog.data !== undefined) throw new Error('log.data should be null/empty');
    if (!lastLog.message.includes('Message test')) throw new Error('Message should be formatted');
});

// ─── Test 7: Real-world server.js pattern ───
test('Real-world server.js error logging pattern', () => {
    logger.history = [];
    logger.setDebug(true);
    
    const error = new Error('Transaction failed');
    error.stack = 'Stack trace here';
    
    // This is the exact pattern used in server.js:918
    logger.error(`[API] Transaction failed for model: claude-sonnet`, error, logger.withData({
        request: { model: 'claude-sonnet', stream: true },
        error: { message: error.message, stack: error.stack }
    }));
    
    const lastLog = logger.history[logger.history.length - 1];
    
    if (!lastLog.data) throw new Error('log.data should be populated (real-world pattern)');
    if (!lastLog.data.request) throw new Error('log.data.request should exist');
    if (!lastLog.data.error) throw new Error('log.data.error should exist');
    if (lastLog.data.request.model !== 'claude-sonnet') throw new Error('request.model should match');
    if (lastLog.data.error.message !== 'Transaction failed') throw new Error('error.message should match');
});

// ─── Summary ───
console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─────────────────────────────────────────────────────────────────\n');

if (failed > 0) {
    process.exit(1);
}
