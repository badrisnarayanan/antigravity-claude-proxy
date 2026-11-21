/**
 * Test Model Registry & Routing
 *
 * Offline tests (mocked fetch, no server needed) for metadata-driven model
 * detection: a model the backend lists as an agent model under a codename id
 * (no "gemini"/"claude" in the name) must be listed, validated, routed with
 * its exact id and handled as its reported family - while existing Gemini and
 * Claude ids keep their name-based behavior.
 *
 * 'fixture-codename-model' is a synthetic id; it is NOT a real backend model.
 */

const CODENAME = 'fixture-codename-model';
const NON_AGENT = 'gemini-4-non-agent-fixture';

// Shape mirrors a real fetchAvailableModels response (trimmed)
const FIXTURE = {
    models: {
        'gemini-3.8-flash-tiered': {
            supportsThinking: true, thinkingBudget: -1, maxOutputTokens: 65536,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE',
            quotaInfo: { remainingFraction: 0.9, resetTime: '2026-01-01T00:00:00Z' }
        },
        'claude-sonnet-5-5-low': {
            displayName: 'Claude Sonnet 5.5 (Low)', supportsThinking: true, maxOutputTokens: 128000,
            apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX', modelProvider: 'MODEL_PROVIDER_ANTHROPIC'
        },
        'gemini-2.5-pro': {
            displayName: 'Gemini 2.5 Pro', supportsThinking: true,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI'
        },
        [NON_AGENT]: {
            displayName: 'Synthetic non-agent fixture', supportsThinking: true,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            quotaInfo: { remainingFraction: 1 }
        },
        [CODENAME]: {
            displayName: 'Fixture Codename Model', supportsThinking: true, maxOutputTokens: 65536,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE',
            quotaInfo: { remainingFraction: 0.5, resetTime: '2026-01-01T00:00:00Z' }
        },
        'tab_flash_lite_preview': {
            maxOutputTokens: 4096, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI'
        },
        'chat_23310': { apiProvider: 'API_PROVIDER_INTERNAL' },
        'gpt-oss-120b-medium': {
            displayName: 'GPT-OSS 120B (Medium)', supportsThinking: true,
            apiProvider: 'API_PROVIDER_OPENAI_VERTEX'
        }
    },
    agentModelSorts: [{
        displayName: 'Recommended',
        // The old Gemini id is still explicitly available to this account,
        // even though listModels suppresses old generations in the menu.
        groups: [{ modelIds: [CODENAME, 'claude-sonnet-5-5-low', 'gemini-2.5-pro', 'gpt-oss-120b-medium'] }]
    }],
    tieredModelIds: { flash: ['gemini-3.8-flash-tiered'], pro: ['gemini-3.8-flash-tiered'] }
};

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body)
    };
}

function sseResponse(chunks) {
    const encoder = new TextEncoder();
    const payload = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
    let sent = false;
    return {
        body: {
            getReader: () => ({
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: encoder.encode(payload) };
                }
            })
        }
    };
}

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           MODEL REGISTRY & ROUTING TEST SUITE                ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    let fetchMode = 'ok';
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls++;
        if (fetchMode === 'fail') return jsonResponse({ error: 'unavailable' }, 503);
        return jsonResponse(FIXTURE);
    };

    // Keep the persisted signature store out of the real home directory:
    // the streaming test below caches a fake signature.
    const sigStoreDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'sigstore-registry-'));
    process.env.ANTIGRAVITY_SIGNATURE_STORE = require('path').join(sigStoreDir, 'store.json');

    const { getModelFamily, isThinkingModel, GEMINI_MAX_OUTPUT_TOKENS } = await import('../src/constants.js');
    const { clearModelRegistry, getRegisteredModel } = await import('../src/cloudcode/model-registry.js');
    const { listModels, isValidModel, getModelQuotas } = await import('../src/cloudcode/model-api.js');
    const { clearMetadataCache } = await import('../src/cloudcode/metadata-cache.js');
    const { buildCloudCodeRequest, buildHeaders } = await import('../src/cloudcode/request-builder.js');
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    const { streamSSEResponse } = await import('../src/cloudcode/sse-streamer.js');
    const { getCachedSignatureFamily } = await import('../src/format/signature-cache.js');
    clearMetadataCache();

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
        }
    }

    // --- Before any backend data: name-based behavior only ---

    await test('Codename id is unknown before backend metadata is loaded', () => {
        clearModelRegistry();
        assertEqual(getModelFamily(CODENAME), 'unknown');
        assertEqual(isThinkingModel(CODENAME), false);
    });

    await test('Existing ids keep name-based family/thinking (no registry)', () => {
        assertEqual(getModelFamily('gemini-3.8-flash-tiered'), 'gemini');
        assertEqual(isThinkingModel('gemini-3.8-flash-tiered'), true);
        assertEqual(getModelFamily('claude-sonnet-5-5-low'), 'claude');
        assertEqual(isThinkingModel('claude-sonnet-5-5-low'), true, 'Claude 5.5 tiers support thinking');
        assertEqual(isThinkingModel('claude-opus-4-6-thinking'), true);
        assertEqual(isThinkingModel('claude-sonnet-4-6'), false, 'Legacy non-thinking Claude remains unchanged');
    });

    // --- Listing ---

    const listing = await listModels('fake-token');
    const listedIds = listing.data.map(m => m.id).sort();

    await test('/v1/models lists Gemini, Claude and the codename agent model', () => {
        assertEqual(listedIds, [CODENAME, 'claude-sonnet-5-5-low', 'gemini-3.8-flash-tiered'].sort());
    });

    await test('/v1/models hides internal, non-agent, other-provider and old Gemini ids', () => {
        for (const hidden of ['tab_flash_lite_preview', 'chat_23310', 'gpt-oss-120b-medium', 'gemini-2.5-pro', NON_AGENT]) {
            if (listedIds.includes(hidden)) throw new Error(`${hidden} should not be listed`);
        }
    });

    await test('Listing uses backend displayName, falls back to id', () => {
        const byId = Object.fromEntries(listing.data.map(m => [m.id, m.description]));
        assertEqual(byId[CODENAME], 'Fixture Codename Model');
        assertEqual(byId['gemini-3.8-flash-tiered'], 'gemini-3.8-flash-tiered');
    });

    // --- Family / thinking from metadata ---

    await test('Codename model resolves to backend-reported family and thinking', () => {
        assertEqual(getModelFamily(CODENAME), 'gemini');
        assertEqual(isThinkingModel(CODENAME), true);
        assertEqual(getRegisteredModel(CODENAME).maxOutputTokens, 65536);
    });

    await test('Non-agent / non-Gemini ids are not registered', () => {
        assertEqual(getRegisteredModel('tab_flash_lite_preview'), undefined);
        assertEqual(getRegisteredModel('gpt-oss-120b-medium'), undefined);
        assertEqual(getModelFamily('gpt-oss-120b-medium'), 'unknown');
    });

    // --- Validation / error handling ---

    await test('isValidModel accepts current and menu-hidden legacy ids explicitly offered to the account', async () => {
        assertEqual(await isValidModel(CODENAME, 'fake-token'), true);
        assertEqual(await isValidModel('gemini-3.8-flash-tiered', 'fake-token'), true);
        assertEqual(await isValidModel('gemini-2.5-pro', 'fake-token'), true);
    });

    await test('isValidModel rejects ids the backend does not list', async () => {
        assertEqual(await isValidModel('gemini-4-argon', 'fake-token'), false);
        assertEqual(await isValidModel('tab_flash_lite_preview', 'fake-token'), false);
        assertEqual(await isValidModel('gpt-oss-120b-medium', 'fake-token'), false);
    });

    await test('A supported family in the wider models map does not grant agent access', async () => {
        assertEqual(await isValidModel(NON_AGENT, 'fake-token'), false);
        const quotas = await getModelQuotas('fake-token');
        assertEqual(quotas[NON_AGENT], undefined, 'Non-agent model must not be quota-tracked');
    });

    await test('Quotas include the codename model', async () => {
        const quotas = await getModelQuotas('fake-token');
        assertEqual(quotas[CODENAME].remainingFraction, 0.5);
        if (quotas['gpt-oss-120b-medium']) throw new Error('gpt-oss should not be quota-tracked');
    });

    await test('A warm account catalog is reused during a backend outage', async () => {
        const callsBefore = fetchCalls;
        fetchMode = 'fail';
        try {
            const cachedListing = await listModels('fake-token');
            assertEqual(cachedListing.data.map(m => m.id).sort(), listedIds);
            assertEqual(await isValidModel(CODENAME, 'fake-token'), true);
            assertEqual(fetchCalls, callsBefore, 'An unexpired account cache must avoid another metadata request');
        } finally {
            fetchMode = 'ok';
        }
    });

    await test('An uncached account surfaces backend failure instead of borrowing the warm catalog', async () => {
        const callsBefore = fetchCalls;
        fetchMode = 'fail';
        try {
            let threw = false;
            try { await listModels('fake-uncached-account-token'); } catch { threw = true; }
            assertEqual(threw, true, 'listModels should throw when all endpoints fail for an uncached account');
            assertEqual(fetchCalls > callsBefore, true, 'The failure case must actually reach the mocked backend');
        } finally {
            fetchMode = 'ok';
        }
    });

    // --- Routing / request conversion ---

    const baseRequest = {
        max_tokens: 64000,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]
    };

    await test('Cloud Code payload keeps the exact requested model id', () => {
        const payload = buildCloudCodeRequest({ ...baseRequest, model: CODENAME }, 'proj', 'a@example.com');
        assertEqual(payload.model, CODENAME);
        const tiered = buildCloudCodeRequest({ ...baseRequest, model: 'gemini-3.8-flash-tiered' }, 'proj', 'a@example.com');
        assertEqual(tiered.model, 'gemini-3.8-flash-tiered');
    });

    await test('Codename model gets Gemini thinkingConfig, token cap and tools', () => {
        const req = convertAnthropicToGoogle({ ...baseRequest, model: CODENAME });
        assertEqual(req.generationConfig.thinkingConfig.includeThoughts, true);
        assertEqual(typeof req.generationConfig.thinkingConfig.thinkingBudget, 'number');
        assertEqual(req.generationConfig.maxOutputTokens, Math.min(64000, GEMINI_MAX_OUTPUT_TOKENS));
        assertEqual(req.tools[0].functionDeclarations[0].name, 'get_weather');
        assertEqual(req.toolConfig, undefined, 'VALIDATED mode is Claude-only');
    });

    await test('gemini-3.8-flash-tiered conversion is unchanged', () => {
        const req = convertAnthropicToGoogle({ ...baseRequest, model: 'gemini-3.8-flash-tiered' });
        assertEqual(req.generationConfig.thinkingConfig.includeThoughts, true);
        assertEqual(req.generationConfig.maxOutputTokens, Math.min(64000, GEMINI_MAX_OUTPUT_TOKENS));
    });

    await test('Headers: no anthropic-beta for Gemini-family models', () => {
        assertEqual(buildHeaders('t', CODENAME)['anthropic-beta'], undefined);
        assertEqual(buildHeaders('t', 'claude-opus-4-6-thinking')['anthropic-beta'], 'interleaved-thinking-2025-05-14');
    });

    // --- Streaming ---

    await test('Streaming: thinking, text and tool_use events for codename model', async () => {
        const signature = 'sig-' + 'x'.repeat(80);
        const response = sseResponse([
            { response: { candidates: [{ content: { parts: [{ text: 'plan', thought: true, thoughtSignature: signature }] } }] } },
            { response: { candidates: [{ content: { parts: [{ text: 'Checking.' }] } }] } },
            { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }
        ]);

        const events = [];
        for await (const ev of streamSSEResponse(response, CODENAME)) events.push(ev);

        const starts = events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type);
        assertEqual(starts, ['thinking', 'text', 'tool_use']);
        assertEqual(events[0].type, 'message_start');
        assertEqual(events[0].message.model, CODENAME);
        const toolInput = events.find(e => e.delta?.type === 'input_json_delta');
        assertEqual(JSON.parse(toolInput.delta.partial_json), { city: 'Paris' });
        const msgDelta = events.find(e => e.type === 'message_delta');
        assertEqual(msgDelta.delta.stop_reason, 'tool_use');
        assertEqual(events[events.length - 1].type, 'message_stop');
        assertEqual(getCachedSignatureFamily(signature), 'gemini', 'signature cached under backend family');
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(60));
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
