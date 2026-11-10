import { generateSmartUserAgent, resolveClientVersion, resolveUserAgentVersion } from '../src/utils/version-detector.js';
import { getPlatformUserAgent } from '../src/constants.js';
import assert from 'assert';

async function testVersionDetection() {
    console.log('--- Testing Version Detection ---');

    // 1. Check User-Agent generation
    const ua = generateSmartUserAgent();
    console.log('Generated User-Agent:', ua);

    assert.ok(ua.startsWith('antigravity/hub/'), 'UA should use the Antigravity Hub format (antigravity/hub/)');
    assert.ok(/^antigravity\/hub\/\d+\.\d+\.\d+ (darwin|win32|linux)\/\S+$/.test(ua), 'UA should be "antigravity/hub/<version> <os>/<arch>"');

    // 2. Check integration in constants.js
    const constantsUA = getPlatformUserAgent();
    console.log('Constants User-Agent:', constantsUA);
    assert.strictEqual(ua, constantsUA, 'Constants UA should match generated UA');

    // 3. X-Client-Version source priority: env > config.json > product.json > fallback
    assert.deepStrictEqual(
        resolveClientVersion({ envVersion: '9.9.9', configVersion: '2.2.2', productVersion: '1.1.1' }),
        { version: '9.9.9', source: 'env' }
    );
    assert.deepStrictEqual(
        resolveClientVersion({ configVersion: '2.2.2', productVersion: '1.1.1' }),
        { version: '2.2.2', source: 'config' }
    );
    assert.deepStrictEqual(
        resolveClientVersion({ productVersion: '1.1.1' }),
        { version: '1.1.1', source: 'product.json' }
    );
    const fallback = resolveClientVersion({});
    assert.strictEqual(fallback.source, 'fallback');
    assert.ok(/^\d+\.\d+\.\d+/.test(fallback.version), 'Fallback should be a version number');
    console.log('Client version priority: OK');

    // 4. User-Agent version: detected installs are used as-is, fallback only when none detected
    assert.deepStrictEqual(resolveUserAgentVersion({ productVersion: '2.20.0' }), { version: '2.20.0', source: 'product.json' });
    assert.deepStrictEqual(resolveUserAgentVersion({ localVersion: '2.20.0' }), { version: '2.20.0', source: 'local' });
    assert.deepStrictEqual(resolveUserAgentVersion({ localVersion: '2.30.1' }), { version: '2.30.1', source: 'local' });
    if (!process.env.FALLBACK_ANTIGRAVITY_VERSION) {
        assert.deepStrictEqual(resolveUserAgentVersion({}), { version: '2.25.0', source: 'fallback' });
        assert.deepStrictEqual(resolveUserAgentVersion({ localVersion: '1.0.0' }), { version: '2.25.0', source: 'fallback' }, 'legacy installs are ignored');
    }
    console.log('User-Agent version resolution: OK');

    console.log('\n✓ Version detection tests passed!');
}

testVersionDetection().catch(err => {
    console.error('\n✗ Version detection tests failed:');
    console.error(err);
    process.exit(1);
});
