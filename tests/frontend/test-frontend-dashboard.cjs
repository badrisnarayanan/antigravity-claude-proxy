/**
 * Frontend Test Suite - Dashboard Page
 * Tests the dashboard component functionality
 *
 * Run: node tests/test-frontend-dashboard.cjs
 */

const http = require('http');

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 8080}`;

// Helper to make HTTP requests
function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: options.headers || {}
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

// Test cases
const tests = [
    {
        name: 'Dashboard view loads successfully',
        async run() {
            const res = await request('/views/dashboard.html');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            if (!res.data.includes('x-data="dashboard"')) {
                throw new Error('Dashboard component not found in HTML');
            }
            if (!res.data.includes('quotaChart')) {
                throw new Error('Quota chart canvas not found');
            }
            return 'Dashboard HTML loads with component and chart';
        }
    },
    {
        name: 'Account limits API returns data',
        async run() {
            const res = await request('/account-limits');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.accounts || !Array.isArray(data.accounts)) {
                throw new Error('accounts array not found in response');
            }
            if (!data.models || !Array.isArray(data.models)) {
                throw new Error('models array not found in response');
            }
            return `API returns ${data.accounts.length} accounts and ${data.models.length} models`;
        }
    },
    {
        name: 'Dashboard has stats grid elements',
        async run() {
            const res = await request('/views/dashboard.html');
            const html = res.data;

            const requiredElements = [
                'totalAccounts',      // Total accounts stat
                'stats.total',        // Total stat binding
                'stats.active',       // Active stat binding
                'stats.limited',      // Limited stat binding
                'quotaChart'          // Chart canvas
            ];

            const missing = requiredElements.filter(el => !html.includes(el));
            if (missing.length > 0) {
                throw new Error(`Missing elements: ${missing.join(', ')}`);
            }
            return 'All required dashboard elements present';
        }
    },
    {
        name: 'Dashboard has filter controls',
        async run() {
            const res = await request('/views/dashboard.html');
            const html = res.data;

            // Dashboard uses dropdown-based filters for time range, display mode, and model selection
            const filterElements = [
                'showTimeRangeDropdown',  // Time range dropdown toggle
                'showDisplayModeDropdown', // Display mode dropdown toggle
                'showModelFilter',         // Model/family filter dropdown toggle
                'setTimeRange'             // Time range action
            ];

            const missing = filterElements.filter(el => !html.includes(el));
            if (missing.length > 0) {
                throw new Error(`Missing filter elements: ${missing.join(', ')}`);
            }
            return 'All filter controls present';
        }
    },
    {
        name: 'Dashboard has chart and visualization elements',
        async run() {
            const res = await request('/views/dashboard.html');
            const html = res.data;

            // Dashboard now uses charts instead of tables
            const visualElements = [
                'quotaChart',           // Quota distribution pie chart
                'usageTrendChart',      // Usage trend line chart
                'usageStats.total',     // Total usage stat
                'selectedFamilies'      // Family selection for chart
            ];

            const missing = visualElements.filter(col => !html.includes(col));
            if (missing.length > 0) {
                throw new Error(`Missing visualization elements: ${missing.join(', ')}`);
            }
            return 'All chart and visualization elements present';
        }
    }
];

// Run tests
async function runTests() {
    console.log('🧪 Dashboard Frontend Tests\n');
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
