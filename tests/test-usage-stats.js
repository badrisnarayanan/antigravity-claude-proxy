import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the home directory at a throwaway folder before loading the module, so
// setupMiddleware() loads, migrates and saves a temporary usage-history.json
// instead of the user's real ~/.config/antigravity-proxy/usage-history.json.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { default: usageStats, normalizeHistory } = await import('../src/modules/usage-stats.js');
const { BUILTIN_MODEL_MAPPINGS, USAGE_HISTORY_PATH } = await import('../src/constants.js');

assert.ok(USAGE_HISTORY_PATH.startsWith(tmpHome), `history path must be under the temp home, got ${USAGE_HISTORY_PATH}`);

async function testUsageStats() {
    console.log('--- Testing Usage Stats & Model Mapping ---');

    // 1. Model family and short name extraction
    assert.strictEqual(usageStats.getFamily('claude-opus-4-6-thinking'), 'claude');
    assert.strictEqual(usageStats.getFamily('gemini-2.5-pro'), 'gemini');
    assert.strictEqual(usageStats.getFamily('custom-model'), 'other');

    assert.strictEqual(usageStats.getShortName('claude-opus-4-6-thinking', 'claude'), 'opus-4-6-thinking');
    assert.strictEqual(usageStats.getShortName('gemini-2.5-pro', 'gemini'), '2.5-pro');
    assert.strictEqual(usageStats.getShortName('custom-model', 'other'), 'custom-model');
    console.log('✓ Model family and short name helpers: OK');

    // 2. Tracking resolved models
    usageStats.track('claude-opus-4-6-thinking');
    const history = usageStats.getHistory();
    const timestamps = Object.keys(history);
    assert.ok(timestamps.length > 0, 'History should have at least one timestamp');

    const latestHour = history[timestamps[timestamps.length - 1]];
    assert.ok(latestHour.claude, 'Should contain claude family');
    assert.ok(latestHour.claude['opus-4-6-thinking'] >= 1, 'Should track opus-4-6-thinking');
    assert.ok(latestHour.claude._subtotal >= 1, 'Should track claude subtotal');
    assert.ok(latestHour._total >= 1, 'Should track global total');
    console.log('✓ Model usage tracking: OK');

    // 3. Normalization / Migration of legacy/phantom model names
    const mockHistory = {
        '2026-11-01T12:00:00.000Z': {
            claude: {
                'opus-5-5': 52,
                'sonnet-5-5': 24,
                'haiku-5-5': 8,
                'opus-4-6-thinking': 10,
                _subtotal: 94
            },
            _total: 94
        }
    };

    const modified = normalizeHistory(mockHistory);
    assert.strictEqual(modified, true, 'normalizeHistory should return true when migrations occur');

    const migratedHour = mockHistory['2026-11-01T12:00:00.000Z'].claude;
    assert.strictEqual(migratedHour['opus-5-5'], undefined, 'opus-5-5 should be removed');
    assert.strictEqual(migratedHour['sonnet-5-5'], undefined, 'sonnet-5-5 should be removed');
    assert.strictEqual(migratedHour['haiku-5-5'], undefined, 'haiku-5-5 should be removed');
    assert.strictEqual(migratedHour['opus-4-6-thinking'], 62, 'opus-5-5 (52) + existing (10) should equal 62');
    assert.strictEqual(migratedHour['sonnet-4-6'], 32, 'sonnet-5-5 (24) + haiku-5-5 (8) should equal 32');

    // Idempotent check
    const secondPass = normalizeHistory(mockHistory);
    assert.strictEqual(secondPass, false, 'normalizeHistory should return false when no migrations needed');
    console.log('✓ Legacy model normalization & migration: OK');

    // 4. Built-in model mappings check
    assert.strictEqual(BUILTIN_MODEL_MAPPINGS['claude-opus-5-5'], 'claude-opus-4-6-thinking');
    assert.strictEqual(BUILTIN_MODEL_MAPPINGS['claude-sonnet-5-5'], 'claude-sonnet-4-6');
    assert.strictEqual(BUILTIN_MODEL_MAPPINGS['claude-haiku-5-5'], 'claude-sonnet-4-6');
    assert.strictEqual(BUILTIN_MODEL_MAPPINGS['claude-3-5-sonnet-20241022'], 'claude-sonnet-4-6');
    console.log('✓ Built-in model mappings: OK');

    // 5. Middleware inspection: ensures no premature request interceptor
    const dummyApp = {
        middlewareCount: 0,
        use(fn) {
            this.middlewareCount++;
        }
    };
    usageStats.setupMiddleware(dummyApp);
    assert.strictEqual(dummyApp.middlewareCount, 0, 'setupMiddleware should not register premature interceptor middleware');
    console.log('✓ Middleware does not prematurely intercept requests: OK');

    console.log('\n✓ All usage stats tests passed!');
}

testUsageStats()
    .catch(err => {
        console.error('\n✗ Usage stats tests failed:');
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });
