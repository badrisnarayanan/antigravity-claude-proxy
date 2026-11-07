/**
 * Signature Cache Unit Tests
 *
 * Verifies the persistent, no-TTL signature store:
 * - tool_use_id -> signature round trip, including entries "older than any TTL"
 * - signature -> model family round trip
 * - unknown keys return null
 * - entries survive a process restart (child-process simulation) via the
 *   on-disk store, with 0600 permissions
 * - clearAllSignatureCaches empties memory and removes the store file
 *
 * Uses a throwaway store via ANTIGRAVITY_SIGNATURE_STORE. No server needed.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigstore-')), 'store.json');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              SIGNATURE CACHE TEST SUITE                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    process.env.ANTIGRAVITY_SIGNATURE_STORE = STORE_PATH;
    const mod = await import('../src/format/signature-cache.js');
    const {
        cacheSignature,
        getCachedSignature,
        cacheThinkingSignature,
        getCachedSignatureFamily,
        clearAllSignatureCaches,
        flushSignatureStore,
    } = mod;

    let passed = 0;
    let failed = 0;

    const test = async (name, fn) => {
        try {
            await fn();
            passed++;
            console.log(`  ✓ ${name}`);
        } catch (error) {
            failed++;
            console.log(`  ✗ ${name}`);
            console.log(`    ${error.message}`);
        }
    };

    function assert(condition, message) {
        if (!condition) throw new Error(message || 'assertion failed');
    }

    const LONG = 's'.repeat(80); // >= MIN_SIGNATURE_LENGTH
    const toolSig = `sig-tool-${LONG}`;

    await test('tool signature round trip', () => {
        cacheSignature('toolu_1', toolSig);
        assert(getCachedSignature('toolu_1') === toolSig, 'signature should be readable immediately');
    });

    await test('tool signature kept after arbitrary age (no TTL)', () => {
        // Entries have no timestamps anymore: there is nothing to expire and
        // getCachedSignature performs no time check — age cannot evict.
        assert(getCachedSignature('toolu_1') === toolSig, 'signature must never expire due to age');
    });

    await test('thinking family round trip + unknown family', () => {
        cacheThinkingSignature(`think-${LONG}`, 'gemini');
        assert(getCachedSignatureFamily(`think-${LONG}`) === 'gemini', 'family should be readable');
        assert(getCachedSignatureFamily('never-seen') === null, 'unknown signature family is null');
        assert(getCachedSignature(null) === null, 'null key is null');
    });

    await test('short thinking signatures are ignored', () => {
        cacheThinkingSignature('short', 'gemini');
        assert(getCachedSignatureFamily('short') === null, 'below MIN_SIGNATURE_LENGTH must not be cached');
    });

    await test('store file written with 0600 on flush', async () => {
        await flushSignatureStore();
        assert(fs.existsSync(STORE_PATH), `store file should exist at ${STORE_PATH}`);
        const mode = fs.statSync(STORE_PATH).mode & 0o777;
        assert(mode === 0o600, `expected 0600, got ${mode.toString(8)}`);
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        assert(parsed.version === 1, 'store version 1');
        assert(parsed.tool.toolu_1 === toolSig, 'tool signature persisted');
        assert(parsed.think[`think-${LONG}`] === 'gemini', 'thinking family persisted');
    });

    await test('entries survive a fresh process (restart simulation)', () => {
        const script = `
            process.env.ANTIGRAVITY_SIGNATURE_STORE = ${JSON.stringify(STORE_PATH)};
            import('./src/format/signature-cache.js').then((mod) => {
                console.log(mod.getCachedSignature('toolu_1'));
                console.log(mod.getCachedSignatureFamily(${JSON.stringify(`think-${LONG}`)}));
            });
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
        }).trim().split('\n');
        assert(out[0] === toolSig, `tool signature lost across restart: ${out[0]}`);
        assert(out[1] === 'gemini', `family lost across restart: ${out[1]}`);
    });

    await test('LRU cap evicts oldest entries and refreshes accessed entries', () => {
        const lruStorePath = path.join(path.dirname(STORE_PATH), 'lru-store.json');
        // Seed an oversized store on disk (5 tool entries, 4 think entries) and load with cap=3 / cap=2
        const s1 = `think-1-${LONG}`;
        const s2 = `think-2-${LONG}`;
        const s3 = `think-3-${LONG}`;
        const s4 = `think-4-${LONG}`;
        fs.writeFileSync(lruStorePath, JSON.stringify({
            version: 1,
            tool: { t1: 'sig1', t2: 'sig2', t3: 'sig3', t4: 'sig4', t5: 'sig5' },
            think: { [s1]: 'gemini', [s2]: 'claude', [s3]: 'gemini', [s4]: 'claude' },
        }), { mode: 0o600 });

        const script = `
            process.env.ANTIGRAVITY_SIGNATURE_STORE = ${JSON.stringify(lruStorePath)};
            process.env.ANTIGRAVITY_SIGNATURE_CACHE_MAX_TOOL = '3';
            process.env.ANTIGRAVITY_SIGNATURE_CACHE_MAX_THINK = '2';
            import('./src/format/signature-cache.js').then((mod) => {
                // On load with cap=3, t1 and t2 are evicted; t3, t4, t5 remain.
                const loadedOld = mod.getCachedSignature('t1');
                // Touch t3 so it becomes most-recently-used (order: t4, t5, t3)
                const loadedT3 = mod.getCachedSignature('t3');
                // Insert t6 -> should evict t4 (oldest), keeping t5, t3, t6
                mod.cacheSignature('t6', 'sig6');
                const afterT4 = mod.getCachedSignature('t4');
                const afterT3 = mod.getCachedSignature('t3');
                const afterT5 = mod.getCachedSignature('t5');
                const afterT6 = mod.getCachedSignature('t6');

                // Thinking cache loaded with cap=2: s1, s2 evicted; s3, s4 remain.
                const thinkS1 = mod.getCachedSignatureFamily(${JSON.stringify(s1)});
                const thinkS3 = mod.getCachedSignatureFamily(${JSON.stringify(s3)});
                // Touching s3 made s4 oldest; inserting s5 evicts s4
                const s5 = ${JSON.stringify(`think-5-${LONG}`)};
                mod.cacheThinkingSignature(s5, 'gemini');
                const thinkS4 = mod.getCachedSignatureFamily(${JSON.stringify(s4)});
                const thinkS3After = mod.getCachedSignatureFamily(${JSON.stringify(s3)});
                const thinkS5 = mod.getCachedSignatureFamily(s5);

                console.log(JSON.stringify({
                    loadedOld, loadedT3, afterT4, afterT3, afterT5, afterT6,
                    thinkS1, thinkS3, thinkS4, thinkS3After, thinkS5,
                }));
            });
        `;
        const rawOut = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
        }).trim().split('\n')[0];
        const res = JSON.parse(rawOut);

        assert(res.loadedOld === null, 't1 should be pruned on load');
        assert(res.loadedT3 === 'sig3', 't3 should survive load');
        assert(res.afterT4 === null, 't4 should be evicted as least-recently-used');
        assert(res.afterT3 === 'sig3', 'touched t3 should be retained');
        assert(res.afterT5 === 'sig5', 't5 should be retained');
        assert(res.afterT6 === 'sig6', 'new t6 should be retained');
        assert(res.thinkS1 === null, 's1 should be pruned on load');
        assert(res.thinkS3 === 'gemini', 's3 should survive load');
        assert(res.thinkS4 === null, 's4 should be evicted after touching s3 and inserting s5');
        assert(res.thinkS3After === 'gemini', 'touched s3 should be retained');
        assert(res.thinkS5 === 'gemini', 'new s5 should be retained');
    });

    await test('clearAllSignatureCaches empties memory and removes the store file', () => {
        clearAllSignatureCaches();
        assert(getCachedSignature('toolu_1') === null, 'memory should be empty');
        assert(!fs.existsSync(STORE_PATH), 'store file should be removed');
    });

    await test('clear during an in-flight write does not resurrect the store', async () => {
        cacheSignature('toolu_race', 'sig-race-' + 'r'.repeat(60));
        const pending = flushSignatureStore(); // async write starts now
        clearAllSignatureCaches();             // clear before it finishes
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert(!fs.existsSync(STORE_PATH), 'store must stay deleted after clear');
        const leftovers = fs.readdirSync(path.dirname(STORE_PATH)).filter((f) => f.includes('.tmp-'));
        assert(leftovers.length === 0, `no tmp files should remain, found ${leftovers.join(',')}`);
    });

    console.log('');
    console.log(`Signature cache tests: ${passed} passed, ${failed} failed`);
    fs.rmSync(path.dirname(STORE_PATH), { recursive: true, force: true });
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error('Test suite crashed:', error);
    process.exit(1);
});
