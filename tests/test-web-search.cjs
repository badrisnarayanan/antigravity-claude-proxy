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

async function runTests() {
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    const { convertGoogleToAnthropic, mergeGroundingMetadata } = await import('../src/format/response-converter.js');
    const { streamSSEResponse } = await import('../src/cloudcode/sse-streamer.js');
    const { parseThinkingSSEResponse } = await import('../src/cloudcode/sse-parser.js');

    // 1. Standalone web_search_20250305 maps to googleSearch grounding
    {
        const req = convertAnthropicToGoogle({
            model: 'gemini-3.8-flash-low',
            messages: [{ role: 'user', content: 'Latest Node.js LTS?' }],
            max_tokens: 1024,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]
        });
        assert.deepEqual(req.tools, [{ googleSearch: {} }]);
        assert.equal(req.toolConfig, undefined);
        console.log('PASS: standalone web_search maps to googleSearch');
    }

    // 2. allowed_domains and blocked_domains add domain hints to systemInstruction
    {
        const req = convertAnthropicToGoogle({
            model: 'gemini-3.8-flash-low',
            messages: [{ role: 'user', content: 'Docs search' }],
            max_tokens: 1024,
            tools: [{
                type: 'web_search_20250305',
                name: 'web_search',
                allowed_domains: ['nodejs.org'],
                blocked_domains: ['example.com']
            }]
        });
        const sysText = req.systemInstruction.parts.map(p => p.text).join(' ');
        assert.match(sysText, /nodejs\.org/);
        assert.match(sysText, /example\.com/);
        console.log('PASS: domain constraints propagated');
    }

    // 3. Mixed web_search + client tools keeps client functionDeclarations only
    {
        const req = convertAnthropicToGoogle({
            model: 'gemini-3.8-flash-low',
            messages: [{ role: 'user', content: 'Use tool' }],
            max_tokens: 1024,
            tools: [
                { type: 'web_search_20250305', name: 'web_search' },
                { name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }
            ],
            tool_choice: { type: 'tool', name: 'read_file' }
        });
        assert.equal(req.tools.length, 1);
        assert.ok(Array.isArray(req.tools[0].functionDeclarations));
        assert.equal(req.tools[0].functionDeclarations.length, 1);
        assert.equal(req.tools[0].functionDeclarations[0].name, 'read_file');
        assert.deepEqual(req.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['read_file'] });
        console.log('PASS: mixed tools keeps client functionDeclarations and valid tool_choice');
    }

    // 4. Mixed tools with tool_choice explicitly forcing web_search routes to googleSearch without invalid allowedFunctionNames
    {
        const req = convertAnthropicToGoogle({
            model: 'gemini-3.8-flash-low',
            messages: [{ role: 'user', content: 'Search web' }],
            max_tokens: 1024,
            tools: [
                { type: 'web_search_20250305', name: 'web_search' },
                { name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }
            ],
            tool_choice: { type: 'tool', name: 'web_search' }
        });
        assert.deepEqual(req.tools, [{ googleSearch: {} }]);
        assert.equal(req.toolConfig, undefined);
        console.log('PASS: mixed tools forcing web_search maps to googleSearch without 400 toolConfig');
    }

    // 5. Non-streaming response-converter places server_tool_use + web_search_tool_result before text (after thinking)
    {
        const resp = convertGoogleToAnthropic({
            candidates: [{
                content: {
                    parts: [
                        { thought: true, text: 'checking...', thoughtSignature: 'x'.repeat(60) },
                        { text: 'Node 26 is LTS.' }
                    ]
                },
                finishReason: 'STOP',
                groundingMetadata: {
                    webSearchQueries: ['Node.js LTS'],
                    groundingChunks: [
                        { web: { uri: 'https://nodejs.org/en', title: 'nodejs.org' } },
                        { web: { uri: 'https://nodejs.org/en', title: 'duplicate' } }
                    ]
                }
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
        }, 'gemini-3.8-flash-low');

        assert.deepEqual(
            resp.content.map(b => b.type),
            ['thinking', 'server_tool_use', 'web_search_tool_result', 'text']
        );
        assert.equal(resp.content[1].name, 'web_search');
        assert.deepEqual(resp.content[1].input, { query: 'Node.js LTS' });
        assert.equal(resp.content[2].tool_use_id, resp.content[1].id);
        assert.equal(resp.content[2].content.length, 1);
        assert.equal(resp.content[2].content[0].url, 'https://nodejs.org/en');
        console.log('PASS: convertGoogleToAnthropic places web search blocks canonically');
    }

    // 6. Progressive groundingMetadata merges queries and chunks across SSE chunks
    {
        let acc = null;
        acc = mergeGroundingMetadata(acc, { webSearchQueries: ['query one'] });
        acc = mergeGroundingMetadata(acc, {
            groundingChunks: [{ web: { uri: 'https://a.example/1', title: 'A' } }]
        });
        acc = mergeGroundingMetadata(acc, {
            webSearchQueries: ['query one', 'query two'],
            groundingChunks: [
                { web: { uri: 'https://a.example/1', title: 'A dup' } },
                { web: { uri: 'https://b.example/2', title: 'B' } }
            ]
        });
        assert.deepEqual(acc.webSearchQueries, ['query one', 'query two']);
        assert.equal(acc.groundingChunks.length, 2);
        console.log('PASS: mergeGroundingMetadata accumulates progressive chunks without wiping queries');
    }

    // 7. SSE streamer merges progressive groundingMetadata and emits server_tool_use + web_search_tool_result
    {
        const sseEvents = [
            {
                response: {
                    candidates: [{
                        content: { parts: [{ text: 'Result summary.' }] },
                        groundingMetadata: { webSearchQueries: ['mercusys halo h50g'] }
                    }]
                }
            },
            {
                response: {
                    candidates: [{
                        content: { parts: [{ text: '' }] },
                        finishReason: 'STOP',
                        groundingMetadata: {
                            groundingChunks: [
                                { web: { uri: 'https://www.mercusys.com/en/product/mesh/halo-h50g/', title: 'mercusys.com' } }
                            ]
                        }
                    }],
                    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 }
                }
            }
        ];

        const emitted = [];
        for await (const ev of streamSSEResponse(makeSSEResponse(sseEvents), 'gemini-3.8-flash-low')) {
            emitted.push(ev);
        }

        const starts = emitted.filter(e => e.type === 'content_block_start');
        assert.deepEqual(
            starts.map(s => s.content_block.type),
            ['text', 'server_tool_use', 'web_search_tool_result']
        );
        const queryDelta = emitted.find(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
        assert.deepEqual(JSON.parse(queryDelta.delta.partial_json), { query: 'mercusys halo h50g' });
        const resultBlock = starts[2].content_block;
        assert.equal(resultBlock.tool_use_id, starts[1].content_block.id);
        assert.equal(resultBlock.content[0].url, 'https://www.mercusys.com/en/product/mesh/halo-h50g/');
        console.log('PASS: streamSSEResponse merges progressive groundingMetadata and emits web search blocks');
    }

    // 8. parseThinkingSSEResponse merges progressive groundingMetadata and places blocks canonically
    {
        const sseEvents = [
            {
                response: {
                    candidates: [{
                        content: { parts: [{ text: 'Found it.' }] },
                        groundingMetadata: { webSearchQueries: ['test query'] }
                    }]
                }
            },
            {
                response: {
                    candidates: [{
                        content: { parts: [{ text: '' }] },
                        finishReason: 'STOP',
                        groundingMetadata: {
                            groundingChunks: [{ web: { uri: 'https://example.org/doc', title: 'example.org' } }]
                        }
                    }],
                    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 }
                }
            }
        ];

        const parsed = await parseThinkingSSEResponse(makeSSEResponse(sseEvents), 'gemini-3.8-flash-low');
        assert.deepEqual(
            parsed.content.map(b => b.type),
            ['server_tool_use', 'web_search_tool_result', 'text']
        );
        assert.deepEqual(parsed.content[0].input, { query: 'test query' });
        assert.equal(parsed.content[1].content[0].url, 'https://example.org/doc');
        console.log('PASS: parseThinkingSSEResponse merges groundingMetadata canonically');
    }

    // 9. Web-search-only requests on a Claude model are routed to a Gemini model
    {
        const { routeWebSearchModel, pickWebSearchModel } = await import('../src/format/web-search.js');
        const available = new Set([
            'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gemini-3.5-flash-lite',
            'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-4-hydrogen-low'
        ]);
        const ws = { type: 'web_search_20250305', name: 'web_search' };
        const weather = { name: 'get_weather', input_schema: { type: 'object' } };

        assert.equal(pickWebSearchModel(available), 'gemini-3.8-flash-low');
        assert.equal(pickWebSearchModel(new Set(['gemini-4-hydrogen-high', 'gemini-3.5-flash-lite'])), 'gemini-4-hydrogen-high');
        assert.equal(pickWebSearchModel(new Set(['claude-sonnet-4-6'])), null);

        assert.equal(routeWebSearchModel('claude-sonnet-4-6', { tools: [ws] }, available), 'gemini-3.8-flash-low');
        assert.equal(
            routeWebSearchModel('claude-sonnet-4-6', { tools: [ws, weather], tool_choice: { type: 'tool', name: 'web_search' } }, available),
            'gemini-3.8-flash-low'
        );
        // Mixed tools without forcing web_search, no tools, a Gemini model, or no Gemini model: unchanged
        assert.equal(routeWebSearchModel('claude-sonnet-4-6', { tools: [ws, weather] }, available), 'claude-sonnet-4-6');
        assert.equal(routeWebSearchModel('claude-sonnet-4-6', { tools: [weather] }, available), 'claude-sonnet-4-6');
        assert.equal(routeWebSearchModel('claude-sonnet-4-6', {}, available), 'claude-sonnet-4-6');
        assert.equal(routeWebSearchModel('gemini-4-hydrogen-low', { tools: [ws] }, available), 'gemini-4-hydrogen-low');
        assert.equal(routeWebSearchModel('claude-sonnet-4-6', { tools: [ws] }, new Set(['claude-sonnet-4-6'])), 'claude-sonnet-4-6');
        assert.equal(routeWebSearchModel('claude-sonnet-4-6', { tools: [ws] }, null), 'claude-sonnet-4-6');
        console.log('PASS: web-search-only requests on Claude models route to a Gemini model');
    }

    console.log('All 9 web search tests passed');
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
