const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real persisted signature store.
if (!process.env.ANTIGRAVITY_SIGNATURE_STORE) {
    process.env.ANTIGRAVITY_SIGNATURE_STORE = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'trailing-sig-')), 'store.json');
}

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

    // Multi-block assistant turn: reorder/sanitize must keep the restored signature
    const multiHistory = [{ role: 'user', content: 'two paragraphs please' }];
    const multiSignature = 'D'.repeat(96);
    convertGoogleToAnthropic({
        candidates: [{
            content: { parts: [{ text: 'first paragraph. ' }, { text: answer, thoughtSignature: multiSignature }] },
            finishReason: 'STOP'
        }]
    }, model, { messages: multiHistory, system });
    const multiRequest = convertAnthropicToGoogle({
        model, system, max_tokens: 1024,
        messages: makeFollowup(multiHistory, [
            { type: 'text', text: 'first paragraph. ' },
            { type: 'text', text: answer }
        ])
    });
    const multiParts = multiRequest.contents.find(content => content.role === 'model').parts;
    assert.strictEqual(multiParts[multiParts.length - 1].thoughtSignature, multiSignature);
    assert.strictEqual(multiParts[0].thoughtSignature, undefined);

    // Claude Code replays a turn sent as [{type:'text', cache_control}] as a plain string
    const shapeHistory = [
        { role: 'user', content: [{ type: 'text', text: 'pick a number', cache_control: { type: 'ephemeral', ttl: '1h' } }] }
    ];
    const shapeSignature = 'E'.repeat(96);
    convertGoogleToAnthropic({
        candidates: [{ content: { parts: [{ text: 'Even' }, { text: '', thoughtSignature: shapeSignature }] }, finishReason: 'STOP' }]
    }, model, { messages: shapeHistory, system });
    const shapeRequest = convertAnthropicToGoogle({
        model, system, max_tokens: 1024,
        messages: [{ role: 'user', content: 'pick a number' }, { role: 'assistant', content: 'Even' }, { role: 'user', content: 'next' }]
    });
    assert.strictEqual(shapeRequest.contents.find(content => content.role === 'model').parts[0].thoughtSignature, shapeSignature);

    // Claude targets never get a Gemini text signature
    const claudeRequest = convertAnthropicToGoogle({
        model: 'claude-sonnet-4-6', system, max_tokens: 1024,
        messages: makeFollowup(streamHistory, streamedContent)
    });
    const claudeParts = claudeRequest.contents.find(content => content.role === 'model').parts;
    assert.ok(claudeParts.every(part => part.thoughtSignature === undefined));

    // Survives a restart via the persisted store
    const { flushSignatureStore } = await import('../src/format/signature-cache.js');
    await flushSignatureStore();
    const childScript = `
        (async () => {
            const { convertAnthropicToGoogle } = await import(${JSON.stringify(path.join(__dirname, '../src/format/request-converter.js'))});
            const request = convertAnthropicToGoogle(${JSON.stringify({
                model, system, max_tokens: 1024,
                messages: makeFollowup(streamHistory, [{ type: 'text', text: answer }])
            })});
            const part = request.contents.find(c => c.role === 'model').parts.find(p => p.text === ${JSON.stringify(answer)});
            process.stdout.write('\\nRESULT=' + (part.thoughtSignature || 'none'));
        })();
    `;
    const childOut = execFileSync('node', ['-e', childScript], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.strictEqual((childOut.match(/RESULT=([A-Za-z0-9+/=_-]+)/) || [])[1], streamSignature);

    // Long history: restore stays linear in conversation length
    const longHistory = [];
    for (let i = 0; i < 400; i++) {
        longHistory.push({ role: 'user', content: [{ type: 'text', text: `question ${i} ` + 'x'.repeat(4000) }] });
        longHistory.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] });
    }
    longHistory.push({ role: 'user', content: 'last' });
    const started = Date.now();
    convertAnthropicToGoogle({ model, system, max_tokens: 1024, messages: longHistory });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `restore over 801 messages took ${elapsed}ms`);

    console.log('PASS trailing Gemini signature restored for JSON, SSE non-streaming, and SSE streaming responses');
    console.log('PASS multi-block turns keep the signature; Claude targets never get it');
    console.log(`PASS signature survives a restart; 801-message history converted in ${elapsed}ms`);
    console.log('PASS identical answer text is isolated by preceding conversation history');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
