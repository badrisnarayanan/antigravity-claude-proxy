/**
 * Test System Prompt Placement - Tests for issues #408 / #410
 *
 * cloudcode-pa returns an opaque 429 RESOURCE_EXHAUSTED when parts of Claude
 * Code's default system prompt (its security-testing policy line, its
 * <pasted_content> guidance) appear in systemInstruction. The same text is
 * accepted inside contents, so buildCloudCodeRequest moves the caller's system
 * prompt into the first user turn and leaves only the Antigravity instruction
 * in systemInstruction.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           SYSTEM PROMPT PLACEMENT TEST SUITE                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { buildCloudCodeRequest } = await import('../src/cloudcode/request-builder.js');
    const { ANTIGRAVITY_SYSTEM_INSTRUCTION } = await import('../src/constants.js');

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

    const TRIGGER = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts.';

    function build(request) {
        return buildCloudCodeRequest(
            { model: 'gemini-3.8-flash-high', max_tokens: 64, ...request },
            'project-id',
            'test@example.com'
        ).request;
    }

    function systemInstructionText(req) {
        return req.systemInstruction.parts.map(p => p.text).join('\n');
    }

    test('Caller system prompt is kept out of systemInstruction', () => {
        const req = build({ system: TRIGGER, messages: [{ role: 'user', content: 'hi' }] });
        const sys = systemInstructionText(req);
        assert(!sys.includes('security testing'), `caller text leaked into systemInstruction: ${sys}`);
        assert(sys.includes(ANTIGRAVITY_SYSTEM_INSTRUCTION), 'Antigravity instruction missing from systemInstruction');
    });

    test('Caller system prompt is prepended to the first user turn as its own part', () => {
        const req = build({ system: TRIGGER, messages: [{ role: 'user', content: 'hi' }] });
        assert(req.contents.length === 1, `expected 1 content, got ${req.contents.length}`);
        const [first] = req.contents;
        assert(first.role === 'user', `expected user role, got ${first.role}`);
        assert(first.parts.length === 2, `expected 2 parts, got ${first.parts.length}`);
        assert(first.parts[0].text === `<system-instructions>\n${TRIGGER}\n</system-instructions>`, `unexpected wrapper: ${first.parts[0].text}`);
        assert(first.parts[1].text === 'hi', `user text changed: ${first.parts[1].text}`);
    });

    test('Multiple system blocks are joined into one part', () => {
        const req = build({
            system: [{ type: 'text', text: 'Block one.' }, { type: 'text', text: 'Block two.' }],
            messages: [{ role: 'user', content: 'hi' }]
        });
        assert(req.contents[0].parts[0].text.includes('Block one.\n\nBlock two.'), `got: ${req.contents[0].parts[0].text}`);
    });

    test('No system prompt leaves contents untouched', () => {
        const req = build({ messages: [{ role: 'user', content: 'hi' }] });
        assert(req.contents[0].parts.length === 1, `expected 1 part, got ${req.contents[0].parts.length}`);
        assert(req.contents[0].parts[0].text === 'hi', `got: ${req.contents[0].parts[0].text}`);
    });

    test('System prompt that is only the billing header adds nothing', () => {
        const req = build({
            system: 'x-anthropic-billing-header: cc_version=2.1.325; cc_entrypoint=sdk-cli;',
            messages: [{ role: 'user', content: 'hi' }]
        });
        assert(req.contents[0].parts.length === 1, `expected 1 part, got ${req.contents[0].parts.length}`);
    });

    test('Image-first user turn keeps the image after the system part', () => {
        const req = build({
            system: 'Be brief.',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
                    { type: 'text', text: 'what is this' }
                ]
            }]
        });
        const parts = req.contents[0].parts;
        assert(parts[0].text?.startsWith('<system-instructions>'), 'system part not first');
        assert(parts[1].inlineData, `expected image second, got ${JSON.stringify(parts[1])}`);
    });

    test('Conversation starting with a model turn gets a new leading user turn', () => {
        const req = build({
            system: 'Be brief.',
            messages: [
                { role: 'assistant', content: 'Hello.' },
                { role: 'user', content: 'hi' }
            ]
        });
        assert(req.contents[0].role === 'user', `expected user, got ${req.contents[0].role}`);
        assert(req.contents[0].parts[0].text.startsWith('<system-instructions>'), 'system part missing');
        assert(req.contents[1].role === 'model', `expected model second, got ${req.contents[1].role}`);
    });

    test('Function-response-first turn is not mixed with the system part', () => {
        const req = build({
            system: 'Be brief.',
            messages: [{
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
            }]
        });
        assert(req.contents[0].parts.length === 1, `expected lone system part, got ${JSON.stringify(req.contents[0].parts)}`);
        assert(req.contents[0].parts[0].text.startsWith('<system-instructions>'), 'system part missing');
        assert(req.contents[1].parts[0].functionResponse, `expected functionResponse, got ${JSON.stringify(req.contents[1].parts[0])}`);
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
