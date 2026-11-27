/**
 * Non-streaming stop_reason mapping (unit, no server needed)
 *
 * Gemini reports finishReason "STOP" even when the reply is a function call.
 * Non-streaming responses must still say stop_reason "tool_use" then, matching
 * the streaming path in sse-streamer.js.
 */
const assert = require('node:assert/strict');

function makeSSEResponse(events) {
    const payload = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(payload));
            controller.close();
        }
    });
    return { body: stream };
}

const candidate = (parts, finishReason) => ({ response: { candidates: [{ content: { role: 'model', parts }, finishReason }] } });
const call = { functionCall: { name: 'get_weather', args: { city: 'Paris' } } };

async function runTests() {
    const { convertGoogleToAnthropic } = await import('../src/format/response-converter.js');
    const { parseThinkingSSEResponse } = await import('../src/cloudcode/sse-parser.js');
    const { streamSSEResponse } = await import('../src/cloudcode/sse-streamer.js');

    const cases = [
        { name: 'function call + STOP -> tool_use', parts: [call], finish: 'STOP', want: 'tool_use' },
        { name: 'text then function call + STOP -> tool_use', parts: [{ text: 'Checking.' }, call], finish: 'STOP', want: 'tool_use' },
        { name: 'function call + no finishReason -> tool_use', parts: [call], finish: undefined, want: 'tool_use' },
        { name: 'function call + MAX_TOKENS -> tool_use (same as streaming)', parts: [call], finish: 'MAX_TOKENS', want: 'tool_use' },
        { name: 'text + STOP -> end_turn', parts: [{ text: 'Hello' }], finish: 'STOP', want: 'end_turn' },
        { name: 'text + MAX_TOKENS -> max_tokens', parts: [{ text: 'Hel' }], finish: 'MAX_TOKENS', want: 'max_tokens' },
        { name: 'text + TOOL_USE -> tool_use', parts: [{ text: 'x' }], finish: 'TOOL_USE', want: 'tool_use' }
    ];

    // 1. convertGoogleToAnthropic (non-streaming, non-thinking path)
    for (const c of cases) {
        const res = convertGoogleToAnthropic(candidate(c.parts, c.finish), 'gemini-3.8-flash-low');
        assert.equal(res.stop_reason, c.want, `convert: ${c.name}`);
        console.log(`PASS: convert: ${c.name}`);
    }

    // 2. parseThinkingSSEResponse (non-streaming path that reads SSE from Cloud Code)
    {
        const res = await parseThinkingSSEResponse(makeSSEResponse([
            candidate([{ text: 'Let me check.', thought: true }], undefined),
            candidate([call], undefined),
            candidate([{ text: '' }], 'STOP')
        ]), 'gemini-3.8-flash-low');
        assert.equal(res.stop_reason, 'tool_use');
        assert.ok(res.content.some(b => b.type === 'tool_use' && b.name === 'get_weather'));
        console.log('PASS: sse-parser: Gemini function call with STOP -> tool_use');

        const text = await parseThinkingSSEResponse(makeSSEResponse([
            candidate([{ text: 'Hi there' }], 'STOP')
        ]), 'gemini-3.8-flash-low');
        assert.equal(text.stop_reason, 'end_turn');
        console.log('PASS: sse-parser: plain text with STOP -> end_turn');
    }

    // 3. Streaming and non-streaming agree for the same Gemini reply
    {
        const events = [candidate([call], undefined), candidate([{ text: '' }], 'STOP')];
        let streamed = null;
        for await (const ev of streamSSEResponse(makeSSEResponse(events), 'gemini-3.8-flash-low')) {
            if (ev.type === 'message_delta') streamed = ev.delta.stop_reason;
        }
        const nonStreamed = await parseThinkingSSEResponse(makeSSEResponse(events), 'gemini-3.8-flash-low');
        assert.equal(streamed, 'tool_use');
        assert.equal(nonStreamed.stop_reason, streamed);
        console.log('PASS: streaming and non-streaming agree on tool_use');
    }

    console.log('\nAll non-streaming stop_reason tests passed');
}

runTests().catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
});
