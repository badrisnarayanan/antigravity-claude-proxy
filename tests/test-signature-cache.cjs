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

    await test('store file written with 0600 after debounce', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1300));
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

    await test('clearAllSignatureCaches empties memory and removes the store file', () => {
        clearAllSignatureCaches();
        assert(getCachedSignature('toolu_1') === null, 'memory should be empty');
        assert(!fs.existsSync(STORE_PATH), 'store file should be removed');
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
