/** Offline regression coverage for Antigravity's published model variants.
 * IDs and effort levels: https://antigravity.google/docs/enterprise
 * No Google account, running proxy, or inference requests are needed.
 */
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-model-tiers-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.XDG_CONFIG_HOME = path.join(testHome, '.config');
process.env.ANTIGRAVITY_SIGNATURE_STORE = path.join(testHome, 'signatures.json');

const CLAUDE_VARIANTS = ['opus', 'sonnet'].flatMap(family =>
    ['low', 'medium', 'high', 'max'].map(level => `claude-${family}-5-5-${level}`));
const GEMINI_VARIANTS = [
    ...['low', 'medium', 'high', 'xhigh'].map(level => `gemini-4-neon-${level}`),
    ...['low', 'medium', 'high'].map(level => `gemini-4-carbon-${level}`),
    ...['low', 'medium', 'high', 'xhigh'].map(level => `gemini-4-hydrogen-${level}`),
    ...['low', 'medium', 'high'].map(level => `gemini-3.8-flash-${level}`)
];
const baseRequest = {
    max_tokens: 48000,
    messages: [{ role: 'user', content: 'Check the weather.' }],
    tools: [{ name: 'get_weather', description: 'Get weather', input_schema: {
        type: 'object', properties: { city: { type: 'string' } }, required: ['city']
    } }]
};
let constants, buildCloudCodeRequest, buildHeaders, listModels, isValidModel;
const originalFetch = globalThis.fetch;

before(async () => {
    constants = await import('../src/constants.js');
    ({ buildCloudCodeRequest, buildHeaders } = await import('../src/cloudcode/request-builder.js'));
    ({ listModels, isValidModel } = await import('../src/cloudcode/model-api.js'));
});
after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(testHome, { recursive: true, force: true });
});

for (const family of ['opus', 'sonnet']) {
    test(`Claude ${family} 5.5 bare alias selects its own medium variant`, () => {
        const canonical = constants.BUILTIN_MODEL_MAPPINGS[`claude-${family}-5-5`];
        assert.equal(canonical, `claude-${family}-5-5-medium`);
        const payload = buildCloudCodeRequest({ ...baseRequest, model: canonical }, 'fixture-project', 'fixture@example.test');
        assert.equal(payload.model, `claude-${family}-5-5-medium`);
        assert.equal(payload.request.generationConfig.thinkingConfig.include_thoughts, true);
    });
}

for (const model of CLAUDE_VARIANTS) {
    test(`${model}: exact tier, Claude thinking, tools and headers`, () => {
        assert.equal(constants.isThinkingModel(model), true);
        const payload = buildCloudCodeRequest({ ...baseRequest, model }, 'fixture-project', 'fixture@example.test');
        assert.equal(payload.model, model);
        assert.equal(payload.request.generationConfig.thinkingConfig.include_thoughts, true);
        assert.equal(payload.request.generationConfig.thinkingConfig.thinking_budget, 32000);
        assert.equal(payload.request.toolConfig.functionCallingConfig.mode, 'VALIDATED');
        assert.equal(payload.request.tools[0].functionDeclarations[0].name, 'get_weather');
        assert.equal(buildHeaders('fake-token', model)['anthropic-beta'], 'interleaved-thinking-2025-05-14');
    });
}

for (const model of GEMINI_VARIANTS) {
    test(`${model}: exact tier and Gemini thinking conversion`, () => {
        const payload = buildCloudCodeRequest({ ...baseRequest, model }, 'fixture-project', 'fixture@example.test');
        assert.equal(payload.model, model);
        assert.equal(payload.request.generationConfig.thinkingConfig.includeThoughts, true);
        assert.equal(payload.request.tools[0].functionDeclarations[0].name, 'get_weather');
        assert.equal(payload.request.toolConfig, undefined);
        assert.equal(buildHeaders('fake-token', model)['anthropic-beta'], undefined);
    });
}

test('Claude tiers preserve explicit thinking budgets and output headroom', () => {
    for (const model of CLAUDE_VARIANTS) {
        const payload = buildCloudCodeRequest({ ...baseRequest, model, max_tokens: 16000,
            thinking: { type: 'enabled', budget_tokens: 16000 } }, 'fixture-project', 'fixture@example.test');
        assert.equal(payload.model, model);
        assert.equal(payload.request.generationConfig.thinkingConfig.thinking_budget, 16000);
        assert.ok(payload.request.generationConfig.maxOutputTokens > 16000);
    }
});

test('legacy non-thinking Claude and unsupported Claude tier names are unchanged', () => {
    assert.equal(constants.isThinkingModel('claude-sonnet-4-6'), false);
    assert.equal(constants.isThinkingModel('claude-opus-4-6-thinking'), true);
    for (const model of ['claude-sonnet-5-5-xhigh', 'claude-opus-5-5-extra', 'claude-haiku-5-5-max']) {
        assert.equal(constants.isThinkingModel(model), false);
    }
});

test('listing and validation follow the backend when an older model disappears', async () => {
    let models = Object.fromEntries([...CLAUDE_VARIANTS, ...GEMINI_VARIANTS, 'gemini-4-argon-medium']
        .map(id => [id, { displayName: id, supportsThinking: true }]));
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ models }) });
    assert.ok((await listModels('fake-token')).data.some(m => m.id === 'gemini-4-argon-medium'));
    delete models['gemini-4-argon-medium'];
    const listing = await listModels('fake-token');
    assert.deepEqual(listing.data.map(m => m.id).sort(), [...CLAUDE_VARIANTS, ...GEMINI_VARIANTS].sort());
    assert.equal(await isValidModel('gemini-4-argon-medium', 'fake-token'), false);
    for (const id of [...CLAUDE_VARIANTS, ...GEMINI_VARIANTS]) {
        assert.equal(await isValidModel(id, 'fake-token'), true);
    }
    for (const id of ['claude-opus-5-5-xhigh', 'gemini-4-carbon-xhigh', 'gemini-4-neon-max']) {
        assert.equal(await isValidModel(id, 'fake-token'), false);
    }
});
