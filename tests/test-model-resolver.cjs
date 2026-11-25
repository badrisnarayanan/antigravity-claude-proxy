/**
 * Test Model Resolver - offline, no server needed.
 *
 * Client aliases (claude-sonnet-5, claude-opus-5-5[1m], ...) must resolve to
 * the newest model the account's live catalog offers, on both a paid catalog
 * (Claude 5.5 effort variants) and a free catalog (Claude 4.6), and fall back
 * to the static table only when no catalog is available. Also covers the
 * catalog-aware quota fallback in fallback-config.js.
 *
 * The free catalog mirrors a real fetchAvailableModels response from a
 * free-tier account (Nov 2026); the paid one follows the ids PR #414 reported.
 */

const FREE = [
    'claude-sonnet-4-6', 'claude-opus-4-6-thinking',
    'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.8-flash-tiered',
    'gemini-3-flash', 'gemini-2.5-flash', 'gemini-4-argon-disabled'
];

const PAID = [
    'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
    'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
    'gemini-4-hydrogen-high', 'gemini-3.8-flash-low'
];

async function runTests() {
    const { resolveModelAlias, parseBackendClaudeId, pickNewestInFamily } = await import('../src/cloudcode/model-resolver.js');
    const { BUILTIN_MODEL_MAPPINGS } = await import('../src/constants.js');
    const { recordModels, clearModelRegistry } = await import('../src/cloudcode/model-registry.js');
    const { getFallbackModel } = await import('../src/fallback-config.js');

    let passed = 0;
    let failed = 0;
    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}\n  ${e.message}`);
            failed++;
        }
    }
    function eq(actual, expected, msg = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    }
    const resolve = (id, catalog) => resolveModelAlias(id, catalog, BUILTIN_MODEL_MAPPINGS);

    // --- Parsing ---
    test('parses backend Claude ids', () => {
        eq(parseBackendClaudeId('claude-opus-5-5-medium'), { family: 'opus', version: [5, 5], effort: 'medium' });
        eq(parseBackendClaudeId('claude-opus-4-6-thinking'), { family: 'opus', version: [4, 6], effort: 'thinking' });
        eq(parseBackendClaudeId('claude-sonnet-4-6'), { family: 'sonnet', version: [4, 6], effort: '' });
        eq(parseBackendClaudeId('gemini-3.8-flash-low'), null);
    });

    // --- Paid catalog (Claude 5.5) ---
    test('paid: Claude Code aliases resolve to 5.5 variants', () => {
        eq(resolve('claude-opus-5-5', PAID), { model: 'claude-opus-5-5-medium', source: 'live' });
        eq(resolve('claude-opus-5-5[1m]', PAID), { model: 'claude-opus-5-5-medium', source: 'live' });
        eq(resolve('claude-sonnet-5-5', PAID), { model: 'claude-sonnet-5-5-medium', source: 'live' });
        eq(resolve('claude-haiku-5-5', PAID), { model: 'claude-sonnet-5-5-low', source: 'live' });
        eq(resolve('claude-fable-5-2[1m]', PAID), { model: 'claude-opus-5-5-high', source: 'live' });
        eq(resolve('claude-3-7-sonnet-20250219', PAID), { model: 'claude-sonnet-5-5-medium', source: 'live' });
    });
    test('paid: Auto Mode classifier (claude-sonnet-5) gets low-effort Sonnet', () => {
        eq(resolve('claude-sonnet-5', PAID).model, 'claude-sonnet-5-5-low');
        eq(resolve('claude-sonnet-5[1m]', PAID).model, 'claude-sonnet-5-5-low');
    });
    test('paid: retired 4.6 ids from old configs resolve to 5.5', () => {
        eq(resolve('claude-opus-4-6-thinking', PAID), { model: 'claude-opus-5-5-medium', source: 'live' });
        eq(resolve('claude-sonnet-4-6', PAID), { model: 'claude-sonnet-5-5-medium', source: 'live' });
    });
    test('paid: exact backend ids are never rewritten', () => {
        eq(resolve('claude-opus-5-5-high', PAID), { model: 'claude-opus-5-5-high', source: 'exact' });
        eq(resolve('claude-sonnet-5-5-low', PAID), { model: 'claude-sonnet-5-5-low', source: 'exact' });
    });

    // --- Free catalog (Claude 4.6) ---
    test('free: Claude Code aliases resolve to 4.6 models', () => {
        eq(resolve('claude-opus-5-5', FREE), { model: 'claude-opus-4-6-thinking', source: 'live' });
        eq(resolve('claude-sonnet-5-5[1m]', FREE), { model: 'claude-sonnet-4-6', source: 'live' });
        eq(resolve('claude-sonnet-5', FREE), { model: 'claude-sonnet-4-6', source: 'live' });
        eq(resolve('claude-haiku-5-5', FREE), { model: 'claude-sonnet-4-6', source: 'live' });
        eq(resolve('claude-fable-5-2', FREE), { model: 'claude-opus-4-6-thinking', source: 'live' });
    });
    test('free: 4.6 ids pass through unchanged', () => {
        eq(resolve('claude-sonnet-4-6', FREE), { model: 'claude-sonnet-4-6', source: 'exact' });
        eq(resolve('claude-opus-4-6-thinking', FREE), { model: 'claude-opus-4-6-thinking', source: 'exact' });
    });

    // --- Future-proofing ---
    test('a newer generation wins automatically', () => {
        const future = [...PAID, 'claude-opus-6-0-medium', 'claude-opus-6-0-high'];
        eq(resolve('claude-opus-5-5', future).model, 'claude-opus-6-0-medium');
        eq(resolve('claude-fable-5-2', future).model, 'claude-opus-6-0-high');
        eq(pickNewestInFamily('sonnet', 'medium', future), 'claude-sonnet-5-5-medium');
    });
    test('version compare is numeric (5-10 beats 5-9)', () => {
        eq(pickNewestInFamily('opus', 'medium', ['claude-opus-5-9-medium', 'claude-opus-5-10-medium']), 'claude-opus-5-10-medium');
    });
    test('disabled placeholders are ignored', () => {
        eq(pickNewestInFamily('opus', 'medium', ['claude-opus-6-0-disabled', 'claude-opus-5-5-medium']), 'claude-opus-5-5-medium');
    });

    // --- Non-Claude and edge cases ---
    test('Gemini ids are untouched; [1m] is stripped when the base id exists', () => {
        eq(resolve('gemini-3.8-flash-low', FREE), { model: 'gemini-3.8-flash-low', source: 'exact' });
        eq(resolve('gemini-3.8-flash-high[1m]', FREE), { model: 'gemini-3.8-flash-high', source: 'exact' });
        eq(resolve('gemini-9-unknown', FREE), { model: 'gemini-9-unknown', source: 'none' });
    });
    test('no Claude in catalog: alias falls back to static table', () => {
        eq(resolve('claude-sonnet-5', ['gemini-3.8-flash-low']), { model: 'claude-sonnet-5-5-low', source: 'static' });
    });
    test('no catalog (fetch failed): static table, then unchanged', () => {
        eq(resolve('claude-opus-5-5', null), { model: 'claude-opus-5-5-medium', source: 'static' });
        eq(resolve('claude-opus-5[1m]', new Set()), { model: 'claude-opus-5-5-medium', source: 'static' });
        eq(resolve('gemini-3.8-flash-low', null), { model: 'gemini-3.8-flash-low', source: 'none' });
    });

    // --- Quota fallback (fallback-config.js) ---
    function catalog(ids, defaultAgentModelId) {
        const models = {};
        for (const id of ids) {
            models[id] = { apiProvider: id.startsWith('claude') ? 'API_PROVIDER_ANTHROPIC_VERTEX' : 'API_PROVIDER_GOOGLE_GEMINI' };
        }
        return { models, defaultAgentModelId };
    }
    test('fallback: no catalog yet uses the static map', () => {
        clearModelRegistry();
        eq(getFallbackModel('claude-sonnet-4-6'), 'gemini-3-flash');
        eq(getFallbackModel('claude-opus-5-5-medium'), null);
    });
    test('fallback: static target still offered is kept', () => {
        clearModelRegistry();
        recordModels(catalog(FREE, 'gemini-4-hydrogen-high'));
        eq(getFallbackModel('claude-sonnet-4-6'), 'gemini-3-flash');
    });
    test('fallback: models missing from the static map derive from the catalog', () => {
        clearModelRegistry();
        recordModels(catalog(PAID, 'gemini-4-hydrogen-high'));
        eq(getFallbackModel('claude-opus-5-5-medium'), 'gemini-4-hydrogen-high');
        eq(getFallbackModel('gemini-4-hydrogen-high'), 'claude-opus-5-5-medium');
        eq(getFallbackModel('gemini-3.8-flash-low'), 'claude-sonnet-5-5-medium');
    });
    test('fallback: stale static target is replaced', () => {
        clearModelRegistry();
        recordModels(catalog(PAID, 'gemini-4-hydrogen-high'));
        // static map says claude-opus-4-6-thinking -> gemini-3.1-pro-high, which is gone
        eq(getFallbackModel('claude-opus-4-6-thinking'), 'gemini-4-hydrogen-high');
        clearModelRegistry();
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
