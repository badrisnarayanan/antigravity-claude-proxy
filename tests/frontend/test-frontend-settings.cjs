/**
 * Frontend Test Suite - Settings Page
 * Tests the settings and Claude configuration components
 *
 * Run: node tests/test-frontend-settings.cjs
 */

const http = require('http');

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 8080}`;

function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, data, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
    });
}

const tests = [
    // ==================== VIEW TESTS ====================
    {
        name: 'Settings view loads successfully',
        async run() {
            const res = await request('/views/settings.html');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            return 'Settings HTML loads successfully';
        }
    },
    {
        name: 'Settings view has UI preferences section',
        async run() {
            const res = await request('/views/settings.html');
            const html = res.data;

            const uiElements = [
                'language',           // Language selector
                'refreshInterval',    // Polling interval
                'logLimit',           // Log buffer size
                'showExhausted',      // Show exhausted models toggle
                'compact'             // Compact mode toggle
            ];

            const missing = uiElements.filter(el => !html.includes(el));
            if (missing.length > 0) {
                throw new Error(`Missing UI elements: ${missing.join(', ')}`);
            }
            return 'All UI preference elements present';
        }
    },
    {
        name: 'Settings view has Claude CLI config section',
        async run() {
            const res = await request('/views/settings.html');
            const html = res.data;

            if (!html.includes('x-data="claudeConfig"')) {
                throw new Error('ClaudeConfig component not found');
            }

            const claudeElements = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_MODEL',
                'ANTHROPIC_AUTH_TOKEN'
            ];

            const missing = claudeElements.filter(el => !html.includes(el));
            if (missing.length > 0) {
                throw new Error(`Missing Claude config elements: ${missing.join(', ')}`);
            }
            return 'Claude CLI config section present';
        }
    },
    {
        name: 'Settings view has save buttons',
        async run() {
            const res = await request('/views/settings.html');
            const html = res.data;

            if (!html.includes('saveSettings')) {
                throw new Error('Settings save function not found');
            }
            if (!html.includes('saveClaudeConfig')) {
                throw new Error('Claude config save function not found');
            }
            return 'Save buttons present for both sections';
        }
    },

    // ==================== API TESTS ====================
    {
        name: 'Server config API GET works',
        async run() {
            const res = await request('/api/config');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.config) {
                throw new Error('config object not found in response');
            }
            return `Config API returns: debug=${data.config.debug}, logLevel=${data.config.logLevel}`;
        }
    },
    {
        name: 'Claude config API GET works',
        async run() {
            const res = await request('/api/claude/config');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.config) {
                throw new Error('config object not found in response');
            }
            if (!data.path) {
                throw new Error('config path not found in response');
            }
            return `Claude config loaded from: ${data.path}`;
        }
    },
    {
        name: 'Claude config has env section',
        async run() {
            const res = await request('/api/claude/config');
            const data = JSON.parse(res.data);

            if (!data.config.env) {
                throw new Error('env section not found in config');
            }

            const envKeys = Object.keys(data.config.env);
            return `Config has ${envKeys.length} env vars: ${envKeys.slice(0, 3).join(', ')}${envKeys.length > 3 ? '...' : ''}`;
        }
    },
    {
        name: 'Claude config API POST works (read-back test)',
        async run() {
            // First, read current config
            const getRes = await request('/api/claude/config');
            const originalConfig = JSON.parse(getRes.data).config;

            // POST the same config back (safe operation)
            const postRes = await request('/api/claude/config', {
                method: 'POST',
                body: originalConfig
            });

            if (postRes.status !== 200) {
                throw new Error(`POST failed with status ${postRes.status}`);
            }

            const postData = JSON.parse(postRes.data);
            if (postData.status !== 'ok') {
                throw new Error(`POST returned error: ${postData.error}`);
            }

            return 'Claude config POST API works (config preserved)';
        }
    },
    {
        name: 'Server config API POST validates input',
        async run() {
            // Test with invalid logLevel
            const res = await request('/api/config', {
                method: 'POST',
                body: { logLevel: 'invalid_level' }
            });

            if (res.status === 200) {
                const data = JSON.parse(res.data);
                // Check if the invalid value was rejected
                if (data.updates && data.updates.logLevel === 'invalid_level') {
                    throw new Error('Invalid logLevel was accepted');
                }
            }

            return 'Config API properly validates logLevel input';
        }
    },
    {
        name: 'Server config accepts valid debug value',
        async run() {
            // Get current config
            const getRes = await request('/api/config');
            const currentDebug = JSON.parse(getRes.data).config.debug;

            // Toggle debug
            const postRes = await request('/api/config', {
                method: 'POST',
                body: { debug: !currentDebug }
            });

            if (postRes.status !== 200) {
                throw new Error(`POST failed with status ${postRes.status}`);
            }

            // Restore original value
            await request('/api/config', {
                method: 'POST',
                body: { debug: currentDebug }
            });

            return 'Config API accepts valid debug boolean';
        }
    },

    // ==================== SETTINGS STORE TESTS ====================
    {
        name: 'Settings API returns server port',
        async run() {
            const res = await request('/api/settings');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.settings || !data.settings.port) {
                throw new Error('port not found in settings');
            }
            return `Server port: ${data.settings.port}`;
        }
    },

    // ==================== INTEGRATION TESTS ====================
    {
        name: 'All views are accessible',
        async run() {
            const views = ['dashboard', 'logs', 'accounts', 'settings'];
            const results = [];

            for (const view of views) {
                const res = await request(`/views/${view}.html`);
                if (res.status !== 200) {
                    throw new Error(`${view} view returned ${res.status}`);
                }
                results.push(`${view}: OK`);
            }

            return results.join(', ');
        }
    },
    {
        name: 'All component JS files load',
        async run() {
            const components = [
                'js/components/dashboard.js',
                'js/components/account-manager.js',
                'js/components/claude-config.js',
                'js/components/logs-viewer.js'
            ];

            for (const comp of components) {
                const res = await request(`/${comp}`);
                if (res.status !== 200) {
                    throw new Error(`${comp} returned ${res.status}`);
                }
                if (!res.data.includes('window.Components')) {
                    throw new Error(`${comp} doesn't register to window.Components`);
                }
            }

            return 'All component files load and register correctly';
        }
    },
    {
        name: 'All store JS files load',
        async run() {
            const stores = [
                'js/store.js',
                'js/data-store.js',
                'js/settings-store.js',
                'js/utils.js'
            ];

            for (const store of stores) {
                const res = await request(`/${store}`);
                if (res.status !== 200) {
                    throw new Error(`${store} returned ${res.status}`);
                }
            }

            return 'All store files load correctly';
        }
    },
    {
        name: 'Main app.js loads',
        async run() {
            const res = await request('/app.js');
            if (res.status !== 200) {
                throw new Error(`app.js returned ${res.status}`);
            }
            if (!res.data.includes('alpine:init')) {
                throw new Error('app.js missing alpine:init listener');
            }
            if (!res.data.includes('load-view')) {
                throw new Error('app.js missing load-view directive');
            }
            return 'app.js loads with all required components';
        }
    },

    // ==================== PRESETS API TESTS ====================
    {
        name: 'Presets API GET returns presets array',
        async run() {
            const res = await request('/api/claude/presets');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (data.status !== 'ok') {
                throw new Error(`Expected status ok, got ${data.status}`);
            }
            if (!Array.isArray(data.presets)) {
                throw new Error('presets should be an array');
            }
            return `Presets API returns ${data.presets.length} preset(s)`;
        }
    },
    {
        name: 'Presets API POST creates new preset',
        async run() {
            const testPreset = {
                name: '__test_preset__',
                config: {
                    ANTHROPIC_BASE_URL: 'http://localhost:8080',
                    ANTHROPIC_MODEL: 'test-model'
                }
            };

            // Create preset
            const postRes = await request('/api/claude/presets', {
                method: 'POST',
                body: testPreset
            });
            if (postRes.status !== 200) {
                throw new Error(`POST failed with status ${postRes.status}`);
            }
            const postData = JSON.parse(postRes.data);
            if (postData.status !== 'ok') {
                throw new Error(`POST returned error: ${postData.error}`);
            }

            // Verify it exists
            const getRes = await request('/api/claude/presets');
            const getData = JSON.parse(getRes.data);
            const found = getData.presets.find(p => p.name === '__test_preset__');
            if (!found) {
                throw new Error('Created preset not found in list');
            }

            return 'Preset created and verified';
        }
    },
    {
        name: 'Presets API DELETE removes preset',
        async run() {
            // Delete the test preset created above
            const deleteRes = await request('/api/claude/presets/__test_preset__', {
                method: 'DELETE'
            });
            if (deleteRes.status !== 200) {
                throw new Error(`DELETE failed with status ${deleteRes.status}`);
            }

            // Verify it's gone
            const getRes = await request('/api/claude/presets');
            const getData = JSON.parse(getRes.data);
            const found = getData.presets.find(p => p.name === '__test_preset__');
            if (found) {
                throw new Error('Deleted preset still exists');
            }

            return 'Preset deleted and verified';
        }
    },
    {
        name: 'Settings view has presets UI elements',
        async run() {
            const res = await request('/views/settings.html');
            const html = res.data;

            const presetElements = [
                'selectedPresetName',    // Preset dropdown binding
                'saveCurrentAsPreset',   // Save button function
                'deleteSelectedPreset',  // Delete button function
                'save_preset_modal',     // Save modal
                'configPresets'          // Translation key for section title
            ];

            const missing = presetElements.filter(el => !html.includes(el));
            if (missing.length > 0) {
                throw new Error(`Missing preset UI elements: ${missing.join(', ')}`);
            }
            return 'All preset UI elements present';
        }
    }
];

async function runTests() {
    console.log('🧪 Settings Frontend Tests\n');
    console.log('='.repeat(50));

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            const result = await test.run();
            console.log(`✅ ${test.name}`);
            console.log(`   ${result}\n`);
            passed++;
        } catch (error) {
            console.log(`❌ ${test.name}`);
            console.log(`   Error: ${error.message}\n`);
            failed++;
        }
    }

    console.log('='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
