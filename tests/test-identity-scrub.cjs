/**
 * Test Identity Scrubbing - Tests for issue #375 (secondary trigger)
 *
 * Issue #375 identified two triggers for the opaque 429 RESOURCE_EXHAUSTED from
 * cloudcode-pa: (1) the "x-anthropic-billing-header" line, fixed in 2f6afae, and
 * (2) system prompts naming third-party AI products. The merged fix only covered
 * (1), so "Claude Code" and "Anthropic" survived into the outgoing system parts.
 *
 * These tests pin the scrub map in src/cloudcode/request-builder.js: the two
 * names must be neutralized, while legitimate uses of the same words (lower-case
 * header names, file names, model self-descriptions) must survive untouched.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           IDENTITY SCRUB TEST SUITE                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const { buildCloudCodeRequest } = await import('../src/cloudcode/request-builder.js');

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

    const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

    // The outgoing system instruction is what cloudcode-pa actually sees.
    function outgoingSystem(system) {
        const payload = buildCloudCodeRequest(
            { model: 'gemini-4-argon-medium', system, messages: [{ role: 'user', content: 'hi' }] },
            'project-id',
            'test@example.com'
        );
        return payload.request.systemInstruction.parts.map(p => p.text).join('\n');
    }

    test('Claude Code identity line is neutralized in the outgoing system prompt', () => {
        const out = outgoingSystem(IDENTITY);
        assert(!out.includes('Claude Code'), `"Claude Code" survived: ${out}`);
        assert(!out.includes('Anthropic'), `"Anthropic" survived: ${out}`);
    });

    test('Works for a plain string system prompt', () => {
        const out = outgoingSystem(IDENTITY);
        assert(out.includes('the assistant'), `expected replacement text, got: ${out}`);
        assert(out.includes('the vendor'), `expected vendor replacement, got: ${out}`);
    });

    test('Works for an array of text blocks', () => {
        const out = outgoingSystem([
            { type: 'text', text: IDENTITY },
            { type: 'text', text: 'Claude Code is made by Anthropic.' }
        ]);
        assert(!out.includes('Claude Code'), `"Claude Code" survived: ${out}`);
        assert(!out.includes('Anthropic'), `"Anthropic" survived: ${out}`);
    });

    test('Existing Hermes / Nous Research defaults still scrub', () => {
        const out = outgoingSystem('You are Hermes, an agent created by Nous Research.');
        assert(!out.includes('Hermes'), `"Hermes" survived: ${out}`);
        assert(!out.includes('Nous Research'), `"Nous Research" survived: ${out}`);
    });

    test('Lower-case header names are left alone', () => {
        const text = 'Example headers:\nx-anthropic-beta: foo\nanthropic-version: 2023-06-01';
        assert(outgoingSystem(text).includes(text), 'lower-case header names must not be scrubbed');
    });

    test('The bare word Claude is preserved in model self-descriptions', () => {
        const text = 'You are powered by the model named Claude.';
        assert(outgoingSystem(text).includes('Claude'), 'bare "Claude" must not be scrubbed');
    });

    test('Upper-case CLAUDE.md file references are left alone', () => {
        const text = 'See CLAUDE.md for project conventions.';
        assert(outgoingSystem(text).includes('CLAUDE.md'), 'CLAUDE.md must not be scrubbed');
    });

    test('Unrelated system prompts pass through unchanged', () => {
        const text = 'You are a helpful coding assistant. Always write tests first.';
        assert(outgoingSystem(text).includes(text), 'unrelated prompt must be unchanged');
    });

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
