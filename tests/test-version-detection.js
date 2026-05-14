import { generateSmartUserAgent } from '../src/utils/version-detector.js';
import { getPlatformUserAgent } from '../src/constants.js';
import assert from 'assert';

async function testVersionDetection() {
    console.log('--- Testing Version Detection ---');

    // 1. Check User-Agent generation
    const ua = generateSmartUserAgent();
    console.log('Generated User-Agent:', ua);

    assert.ok(ua.startsWith('antigravity/'), 'UA should start with antigravity/');
    assert.ok(/\d+\.\d+\.\d+/.test(ua), 'UA should contain a version number');

    // 2. Check integration in constants.js
    const constantsUA = getPlatformUserAgent();
    console.log('Constants User-Agent:', constantsUA);
    assert.strictEqual(ua, constantsUA, 'Constants UA should match generated UA');

    console.log('\n✓ Version detection tests passed!');
}

testVersionDetection().catch(err => {
    console.error('\n✗ Version detection tests failed:');
    console.error(err);
    process.exit(1);
});
