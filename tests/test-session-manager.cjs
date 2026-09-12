/**
 * Session Manager Unit Tests
 *
 * Verifies per-conversation session ID derivation:
 * - Same conversation (same first user text) maps to the same session ID
 * - Different conversations map to different session IDs
 * - First user *text* is found even when earlier user messages are tool_result-only
 * - IDs keep the binary's `uuid + Date.now()` shape
 * - No user text at all falls back to the per-account process-lifetime ID
 * - No account and no user text yields a fresh random ID per call
 *
 * No server needed.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              SESSION MANAGER TEST SUITE                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { deriveSessionId } = await import('../src/cloudcode/session-manager.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            passed++;
            console.log(`  ✓ ${name}`);
        } catch (error) {
            failed++;
            console.log(`  ✗ ${name}`);
            console.log(`    ${error.message}`);
        }
    }

    function assert(condition, message) {
        if (!condition) throw new Error(message || 'assertion failed');
    }

    const convA = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Help me refactor the parser.' }] }] };
    const convAWithToolResultsFirst = {
        messages: [
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
            { role: 'user', content: [{ type: 'text', text: 'Help me refactor the parser.' }] },
        ],
    };
    const convAStringContent = { messages: [{ role: 'user', content: 'Help me refactor the parser.' }] };
    const convB = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a poem about llamas.' }] }] };

    test('same first user text -> same session ID (repeat calls)', () => {
        const a = deriveSessionId(convA, 'user@example.com');
        const b = deriveSessionId(convA, 'user@example.com');
        assert(a === b, `expected stable ID, got ${a} vs ${b}`);
    });

    test('same first user text -> same session ID (string content form)', () => {
        const a = deriveSessionId(convA, 'user@example.com');
        const c = deriveSessionId(convAStringContent, 'user@example.com');
        assert(a === c, 'string content and block content should hash identically');
    });

    test('tool_result-only leading user messages are skipped', () => {
        const a = deriveSessionId(convA, 'user@example.com');
        const t = deriveSessionId(convAWithToolResultsFirst, 'user@example.com');
        assert(a === t, 'conversation with tool_result preamble should still hash its first user text');
    });

    test('different conversations -> different session IDs', () => {
        const a = deriveSessionId(convA, 'user@example.com');
        const b = deriveSessionId(convB, 'user@example.com');
        assert(a !== b, 'distinct conversations must not share a session ID');
    });

    test('different accounts -> different session IDs for same conversation', () => {
        const a = deriveSessionId(convA, 'one@example.com');
        const b = deriveSessionId(convA, 'two@example.com');
        assert(a !== b, 'account is part of the namespace');
    });

    test('ID shape matches binary format (uuid + decimal tail)', () => {
        const id = deriveSessionId(convA, 'user@example.com');
        assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\d{13,16}$/.test(id), `bad shape: ${id}`);
    });

    test('deterministic across processes (simulated restart)', () => {
        const script = `
            import('./src/cloudcode/session-manager.js').then(({ deriveSessionId }) => {
                const id = deriveSessionId(${JSON.stringify(convA)}, 'user@example.com');
                console.log(id);
            });
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
        }).trim();
        const here = deriveSessionId(convA, 'user@example.com');
        assert(out === here, `child ${out} != parent ${here}`);
    });

    test('no user text -> per-account fallback stays stable', () => {
        const none = { messages: [{ role: 'assistant', content: 'hi' }] };
        const a = deriveSessionId(none, 'user@example.com');
        const b = deriveSessionId(none, 'user@example.com');
        assert(a === b, 'per-account fallback should be stable within the process');
    });

    test('no user text and no account -> fresh random ID per call', () => {
        const none = { messages: [] };
        const a = deriveSessionId(none, null);
        const b = deriveSessionId(none, null);
        assert(a !== b, 'account-less no-text requests should not share an ID');
    });

    console.log('');
    console.log(`Session manager tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error('Test suite crashed:', error);
    process.exit(1);
});
