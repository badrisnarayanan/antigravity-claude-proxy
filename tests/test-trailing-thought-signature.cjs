const assert = require('assert');

async function main() {
    const { convertGoogleToAnthropic } = await import('../src/format/response-converter.js');
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    const { parseThinkingSSEResponse } = await import('../src/cloudcode/sse-parser.js');
    const { streamSSEResponse } = await import('../src/cloudcode/sse-streamer.js');

    const model = 'gemini-3.8-flash-high';
    const system = 'system prompt';
    const signatureA = 'A'.repeat(96);
    const signatureB = 'B'.repeat(96);
    const historyA = [{ role: 'user', content: [{
        type: 'text',
        text: 'question A',
        cache_control: { type: 'ephemeral' }
    }] }];
    const replayHistoryA = [{ role: 'user', content: [{ type: 'text', text: 'question A' }] }];
    const historyB = [{ role: 'user', content: 'question B' }];
    const answer = 'same final answer';

    const makeChunks = signature => [
        { candidates: [{ content: { parts: [{ thought: true, text: 'reasoning' }] } }] },
        { candidates: [{ content: { parts: [{ text: answer, thoughtSignature: signature }] }, finishReason: 'STOP' }] },
        { candidates: [{ content: { parts: [{ text: '', thoughtSignature: signature }] }, finishReason: 'STOP' }] }
    ];
    const asSse = chunks => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');
    const makeFollowup = (history, assistantContent) => [
        ...history,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: 'continue' }
    ];
    const sentSignature = (history, assistantContent) => {
        const request = convertAnthropicToGoogle({
            model,
            system,
            max_tokens: 1024,
            messages: makeFollowup(history, assistantContent)
        });
        const assistant = request.contents.find(content => content.role === 'model');
        return assistant.parts.find(part => part.text === answer)?.thoughtSignature;
    };

    const jsonResponse = {
        candidates: [{
            content: { parts: [
                { thought: true, text: 'reasoning' },
                { text: answer, thoughtSignature: signatureA }
            ] },
            finishReason: 'STOP'
        }]
    };
    const converted = convertGoogleToAnthropic(jsonResponse, model, { messages: historyA, system });
    assert.strictEqual(converted.content.find(block => block.type === 'thinking').signature, '');
    assert.strictEqual(sentSignature(replayHistoryA, converted.content), signatureA);
    assert.notStrictEqual(sentSignature(historyB, converted.content), signatureA);

    const parsed = await parseThinkingSSEResponse(
        new Response(asSse(makeChunks(signatureB))), model, { messages: historyB, system }
    );
    assert.strictEqual(sentSignature(historyB, parsed.content), signatureB);

    const streamHistory = [{ role: 'user', content: 'streamed question' }];
    const streamSignature = 'C'.repeat(96);
    const streamEvents = [];
    for await (const event of streamSSEResponse(
        new Response(asSse(makeChunks(streamSignature))), model, { messages: streamHistory, system }
    )) streamEvents.push(event);
    const blocks = new Map();
    for (const event of streamEvents) {
        if (event.type === 'content_block_start') blocks.set(event.index, { ...event.content_block });
        if (event.type === 'content_block_delta') {
            const block = blocks.get(event.index);
            if (event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking;
            if (event.delta.type === 'text_delta') block.text += event.delta.text;
            if (event.delta.type === 'signature_delta') block.signature = event.delta.signature;
        }
    }
    const streamedContent = [...blocks.values()];
    assert.strictEqual(streamEvents.filter(event => event.delta?.type === 'signature_delta').length, 0);
    assert.strictEqual(sentSignature(streamHistory, streamedContent), streamSignature);

    console.log('PASS trailing Gemini signature restored for JSON, SSE non-streaming, and SSE streaming responses');
    console.log('PASS identical answer text is isolated by preceding conversation history');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
