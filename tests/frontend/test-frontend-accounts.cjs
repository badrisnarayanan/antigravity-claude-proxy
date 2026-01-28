/**
 * Frontend Test Suite - Accounts Page
 * Tests the account manager component functionality
 *
 * Run: node tests/test-frontend-accounts.cjs
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
    {
        name: 'Accounts view loads successfully',
        async run() {
            const res = await request('/views/accounts.html');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            if (!res.data.includes('x-data="accountManager"')) {
                throw new Error('AccountManager component not found');
            }
            return 'Accounts HTML loads with component';
        }
    },
    {
        name: 'Accounts API endpoint exists',
        async run() {
            const res = await request('/api/accounts');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.accounts || !Array.isArray(data.accounts)) {
                throw new Error('accounts array not found in response');
            }
            if (!data.summary) {
                throw new Error('summary object not found in response');
            }
            return `API returns ${data.accounts.length} accounts`;
        }
    },
    {
        name: 'Accounts view has table with required columns',
        async run() {
            const res = await request('/views/accounts.html');
            // Updated column names to match current HTML: enabled, accountEmail, source, tier, quota, health, operations
            const columns = ['enabled', 'accountEmail', 'source', 'tier', 'health', 'operations'];

            const missing = columns.filter(col => !res.data.includes(col));
            if (missing.length > 0) {
                throw new Error(`Missing columns: ${missing.join(', ')}`);
            }
            return 'All table columns present';
        }
    },
    {
        name: 'Accounts view has toggle switch',
        async run() {
            const res = await request('/views/accounts.html');
            if (!res.data.includes('toggleAccount')) {
                throw new Error('Toggle account function not found');
            }
            if (!res.data.includes('acc.enabled')) {
                throw new Error('Enabled state binding not found');
            }
            return 'Account toggle switch present';
        }
    },
    {
        name: 'Accounts view has refresh button',
        async run() {
            const res = await request('/views/accounts.html');
            if (!res.data.includes('refreshAccount')) {
                throw new Error('Refresh account function not found');
            }
            return 'Refresh button present';
        }
    },
    {
        name: 'Accounts view has delete button',
        async run() {
            const res = await request('/views/accounts.html');
            // Function is now confirmDeleteAccount (opens confirmation modal)
            if (!res.data.includes('confirmDeleteAccount')) {
                throw new Error('Delete account function not found');
            }
            return 'Delete button present';
        }
    },
    {
        name: 'Accounts view has fix/re-auth button',
        async run() {
            const res = await request('/views/accounts.html');
            if (!res.data.includes('fixAccount')) {
                throw new Error('Fix account function not found');
            }
            return 'Fix/re-auth button present';
        }
    },
    {
        name: 'Accounts view has Add Node button',
        async run() {
            const res = await request('/views/accounts.html');
            if (!res.data.includes('addNode') && !res.data.includes('add_account_modal')) {
                throw new Error('Add account button not found');
            }
            return 'Add Node button present';
        }
    },
    {
        name: 'Main page has addAccountModal component',
        async run() {
            // The modal lives in index.html, not accounts.html
            const res = await request('/index.html');
            if (!res.data.includes('addAccountModal')) {
                throw new Error('addAccountModal component not found');
            }
            return 'addAccountModal component present';
        }
    },
    {
        name: 'Main page has manual auth UI elements',
        async run() {
            // Manual auth elements are in the modal in index.html
            const res = await request('/index.html');
            const elements = ['initManualAuth', 'completeManualAuth', 'callbackInput'];
            const missing = elements.filter(el => !res.data.includes(el));
            if (missing.length > 0) {
                throw new Error(`Missing manual auth elements: ${missing.join(', ')}`);
            }
            return 'All manual auth UI elements present';
        }
    },
    {
        name: 'Auth URL API endpoint works',
        async run() {
            const res = await request('/api/auth/url');
            if (res.status !== 200) {
                throw new Error(`Expected 200, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (data.status !== 'ok') {
                throw new Error(`API returned status: ${data.status}`);
            }
            if (!data.url || !data.state) {
                throw new Error('Missing url or state in response');
            }
            return `Auth URL generated with state: ${data.state.substring(0, 8)}...`;
        }
    },
    {
        name: 'Auth complete API validates required fields',
        async run() {
            const res = await request('/api/auth/complete', {
                method: 'POST',
                body: {}
            });
            if (res.status !== 400) {
                throw new Error(`Expected 400 for missing fields, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.error || !data.error.includes('Missing')) {
                throw new Error('Expected error about missing fields');
            }
            return 'API validates required fields';
        }
    },
    {
        name: 'Auth complete API rejects invalid state',
        async run() {
            const res = await request('/api/auth/complete', {
                method: 'POST',
                body: { callbackInput: 'fake-code', state: 'invalid-state' }
            });
            if (res.status !== 400) {
                throw new Error(`Expected 400 for invalid state, got ${res.status}`);
            }
            const data = JSON.parse(res.data);
            if (!data.error || !data.error.includes('not found')) {
                throw new Error('Expected error about flow not found');
            }
            return 'API rejects invalid state';
        }
    },
    {
        name: 'Account toggle API works',
        async run() {
            // First get an account
            const accountsRes = await request('/api/accounts');
            const accounts = JSON.parse(accountsRes.data).accounts;

            if (accounts.length === 0) {
                return 'Skipped: No accounts to test';
            }

            const email = accounts[0].email;
            const currentEnabled = accounts[0].isInvalid !== true;

            // Toggle the account (this is a real API call, be careful)
            const toggleRes = await request(`/api/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'POST',
                body: { enabled: !currentEnabled }
            });

            if (toggleRes.status !== 200) {
                throw new Error(`Toggle failed with status ${toggleRes.status}`);
            }

            // Toggle back to original state
            await request(`/api/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'POST',
                body: { enabled: currentEnabled }
            });

            return `Toggle API works for ${email.split('@')[0]}`;
        }
    },
    {
        name: 'Account refresh API works',
        async run() {
            const accountsRes = await request('/api/accounts');
            const accounts = JSON.parse(accountsRes.data).accounts;

            if (accounts.length === 0) {
                return 'Skipped: No accounts to test';
            }

            const email = accounts[0].email;
            const refreshRes = await request(`/api/accounts/${encodeURIComponent(email)}/refresh`, {
                method: 'POST'
            });

            if (refreshRes.status !== 200) {
                throw new Error(`Refresh failed with status ${refreshRes.status}`);
            }

            return `Refresh API works for ${email.split('@')[0]}`;
        }
    }
];

async function runTests() {
    console.log('🧪 Accounts Frontend Tests\n');
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
