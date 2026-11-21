/** Offline account-eligibility integration tests. Only metadata and mocked inference. */
const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-account-models-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.XDG_CONFIG_HOME = path.join(testHome, '.config');
process.env.ANTIGRAVITY_SIGNATURE_STORE = path.join(testHome, 'signatures.json');
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const moduleIntervals = [];
// Imported production modules own background maintenance intervals. Track only
// this isolated test process's intervals so teardown can stop them cleanly.
globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args);
    moduleIntervals.push(timer);
    return timer;
};
const FLASH = 'gemini-3.8-flash-medium';
const SONNET = 'claude-sonnet-5-5-high';
const MEDIUM = 'claude-sonnet-5-5-medium';
const BASE_REQUEST = { model: SONNET, max_tokens: 48000, messages: [{ role: 'user', content: 'Reply ready.' }] };
const ACCOUNT_FIXTURES = [
    { email: 'restricted-pro@example.test', source: 'manual', apiKey: 'fixture-restricted-token', projectId: 'restricted-project', subscription: { tier: 'pro', projectId: 'restricted-project' } },
    { email: 'ultra@example.test', source: 'manual', apiKey: 'fixture-ultra-token', projectId: 'ultra-project', subscription: { tier: 'ultra', projectId: 'ultra-project' } }
];
let AccountManager, sendMessage, sendMessageStream, clearMetadataCache, configPath;
let modelCalls, generationCalls, metadataFails;
let server;

function catalog(ids) {
    return {
        models: Object.fromEntries(ids.map(id => [id, {
            displayName: id, supportsThinking: true,
            apiProvider: id.startsWith('claude-') ? 'API_PROVIDER_ANTHROPIC_VERTEX' : 'API_PROVIDER_GOOGLE_GEMINI'
        }])),
        agentModelSorts: [{ groups: [{ modelIds: ids }] }]
    };
}
function mockFetch(url, options = {}) {
    const auth = options.headers?.Authorization || options.headers?.authorization;
    if (String(url).endsWith(':fetchAvailableModels')) {
        modelCalls.push(auth);
        if (metadataFails) return Promise.resolve(new Response('metadata unavailable', { status: 503 }));
        const ids = auth === 'Bearer fixture-ultra-token' ? [FLASH, SONNET, MEDIUM] : [FLASH];
        return Promise.resolve(Response.json(catalog(ids)));
    }
    if (String(url).includes(':streamGenerateContent') || String(url).endsWith(':generateContent')) {
        generationCalls.push({ auth, payload: JSON.parse(options.body) });
        const chunk = { response: { candidates: [{ content: { parts: [{ text: 'ready' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } } };
        return Promise.resolve(new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    }
    throw new Error('Unexpected request: metadata-only preparation must not onboard or infer');
}
async function managerWith(accounts = ACCOUNT_FIXTURES, strategy = 'sticky') {
    const file = path.join(testHome, `accounts-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ accounts, activeIndex: 0 }));
    const manager = new AccountManager(file);
    manager.fixturePath = file;
    manager.saveToDisk = async () => {}; // Selection persistence is asserted separately below.
    await manager.initialize(strategy);
    return manager;
}
async function assertBothHandlersReject(manager, pattern) {
    const beforeGeneration = generationCalls.length;
    await assert.rejects(sendMessage(BASE_REQUEST, manager), pattern);
    await assert.rejects(async () => {
        for await (const _event of sendMessageStream(BASE_REQUEST, manager)) {}
    }, pattern);
    assert.equal(generationCalls.length, beforeGeneration, 'denial must happen before any generation');
}

before(async () => {
    ({ AccountManager } = await import('../src/account-manager/index.js'));
    ({ sendMessage } = await import('../src/cloudcode/message-handler.js'));
    ({ sendMessageStream } = await import('../src/cloudcode/streaming-handler.js'));
    ({ clearMetadataCache } = await import('../src/cloudcode/metadata-cache.js'));
    ({ ACCOUNT_CONFIG_PATH: configPath } = await import('../src/constants.js'));
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ accounts: ACCOUNT_FIXTURES, activeIndex: 0 }));
});
beforeEach(() => {
    clearMetadataCache();
    modelCalls = [];
    generationCalls = [];
    metadataFails = false;
    globalThis.fetch = mockFetch;
});
after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    moduleIntervals.forEach(clearInterval);
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(testHome, { recursive: true, force: true });
});

test('unprepared model-specific selection fails closed', async () => {
    const manager = await managerWith();
    assert.deepEqual(manager.getAvailableAccounts(SONNET), []);
    assert.equal(manager.selectAccount(SONNET).account, null);
    assert.equal(modelCalls.length, 0);
    assert.equal(generationCalls.length, 0);
});

test('metadata preparation returns a union without spending generation quota', async () => {
    const manager = await managerWith();
    const models = await manager.prepareModelAccess();
    assert.deepEqual(models.data.map(m => m.id).sort(), [FLASH, SONNET, MEDIUM].sort());
    assert.equal(modelCalls.length, 2);
    assert.equal(generationCalls.length, 0);
    const publicData = JSON.stringify(models);
    assert.ok(!publicData.includes('fixture-ultra-token'));
    assert.ok(!publicData.includes('ultra@example.test'));
});

for (const strategy of ['sticky', 'round-robin', 'hybrid']) {
    test(`${strategy}: restricted Pro cannot be selected for an Ultra-only variant`, async () => {
        const manager = await managerWith(ACCOUNT_FIXTURES, strategy);
        await manager.prepareModelAccess(SONNET);
        assert.deepEqual(manager.getAvailableAccounts(SONNET).map(a => a.email), ['ultra@example.test']);
        assert.equal(manager.selectAccount(SONNET).account.email, 'ultra@example.test');
        // The next unrestricted selection remains on original account index 1.
        if (strategy === 'sticky') assert.equal(manager.selectAccount().account.email, 'ultra@example.test');
        assert.equal(generationCalls.length, 0);
    });
}

test('streaming and non-streaming handlers reject a restricted account before generation', async () => {
    const manager = await managerWith([ACCOUNT_FIXTURES[0]]);
    await assertBothHandlersReject(manager, /invalid_request_error/);
    assert.equal(modelCalls.length, 1, 'repeated entry guards use cached account metadata');
});

test('unknown metadata cannot grant access in either handler', async () => {
    metadataFails = true;
    const manager = await managerWith();
    await assertBothHandlersReject(manager, /MODEL_METADATA_UNAVAILABLE/);
    assert.deepEqual(manager.getAvailableAccounts(SONNET), []);
    assert.equal(generationCalls.length, 0);
});

test('both actual handlers generate only with the eligible account and exact tier ID', async () => {
    const manager = await managerWith();
    const result = await sendMessage(BASE_REQUEST, manager);
    assert.equal(result.model, SONNET);
    const events = [];
    for await (const event of sendMessageStream(BASE_REQUEST, manager)) events.push(event);
    assert.ok(events.some(event => event.type === 'message_stop'));
    assert.equal(generationCalls.length, 2);
    for (const call of generationCalls) {
        assert.equal(call.auth, 'Bearer fixture-ultra-token');
        assert.equal(call.payload.model, SONNET);
        assert.equal(call.payload.project, 'ultra-project');
    }
    assert.equal(modelCalls.length, 2, 'entry and selected-account checks reuse metadata');
});

test('expired eligibility snapshots cannot be selected until metadata is refreshed', async () => {
    const manager = await managerWith();
    await manager.prepareModelAccess(SONNET);
    const realNow = Date.now;
    const later = realNow() + 5 * 60 * 1000 + 1;
    Date.now = () => later;
    try {
        assert.deepEqual(manager.getAvailableAccounts(SONNET), []);
        assert.equal(manager.selectAccount(SONNET).account, null);
        await manager.prepareModelAccess(SONNET);
        assert.equal(manager.selectAccount(SONNET).account.email, 'ultra@example.test');
        assert.equal(modelCalls.length, 4);
    } finally { Date.now = realNow; }
});

test('rate-limit wait calculation excludes accounts lacking model entitlement', async () => {
    const manager = await managerWith();
    await manager.prepareModelAccess(SONNET);
    const accounts = manager.getAllAccounts();
    const now = Date.now();
    accounts[0].modelRateLimits[SONNET] = { isRateLimited: true, resetTime: now + 1000 };
    accounts[1].modelRateLimits[SONNET] = { isRateLimited: true, resetTime: now + 60000 };
    assert.equal(manager.isAllRateLimited(SONNET), true);
    assert.ok(manager.getMinWaitTimeMs(SONNET) > 50000, 'an ineligible Pro must not shorten the wait');
});

test('disabled and invalid accounts never trigger metadata discovery', async () => {
    const manager = await managerWith([
        ...ACCOUNT_FIXTURES,
        { ...ACCOUNT_FIXTURES[0], email: 'disabled@example.test', apiKey: 'fixture-disabled', enabled: false },
        { ...ACCOUNT_FIXTURES[0], email: 'invalid@example.test', apiKey: 'fixture-invalid', isInvalid: true, verifyUrl: 'https://example.test/verify' }
    ]);
    await manager.prepareModelAccess(SONNET);
    assert.deepEqual(modelCalls.sort(), ['Bearer fixture-restricted-token', 'Bearer fixture-ultra-token'].sort());
});

test('empty account pools return a clear error without metadata or generation requests', async () => {
    const manager = await managerWith();
    manager.getAllAccounts().length = 0;
    await assert.rejects(manager.prepareModelAccess(SONNET), /No accounts available/);
    assert.equal(manager.isAllRateLimited(SONNET), false);
    assert.equal(modelCalls.length, 0);
    assert.equal(generationCalls.length, 0);
});

test('HTTP model list exposes the union and both request modes resolve a bare 5.5 alias correctly', async () => {
    const { default: app, accountManager } = await import('../src/server.js');
    accountManager.saveToDisk = async () => {};
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const listed = await originalFetch(base + '/v1/models');
    assert.equal(listed.status, 200);
    const modelData = await listed.json();
    assert.deepEqual(modelData.data.map(m => m.id).sort(), [FLASH, SONNET, MEDIUM].sort());
    assert.equal(generationCalls.length, 0);
    for (const stream of [false, true]) {
        const response = await originalFetch(base + '/v1/messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...BASE_REQUEST, model: 'claude-sonnet-5-5', stream })
        });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(body.includes(MEDIUM));
    }
    assert.equal(generationCalls.length, 2);
    for (const call of generationCalls) {
        assert.equal(call.auth, 'Bearer fixture-ultra-token');
        assert.equal(call.payload.model, MEDIUM);
    }
    for (const stream of [false, true]) {
        const response = await originalFetch(base + '/v1/messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...BASE_REQUEST, model: 'claude-sonnet-5-5-xhigh', stream })
        });
        assert.equal(response.status, 400);
        await response.json();
    }
    assert.equal(generationCalls.length, 2, 'unsupported HTTP requests must not generate');
});


test('explicit backend-supported legacy IDs work without reappearing in the public list', async () => {
    const legacy = 'gemini-3.1-pro-low';
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith(':fetchAvailableModels')) {
            modelCalls.push(options.headers?.Authorization);
            return Response.json(catalog([FLASH, legacy]));
        }
        return mockFetch(url, options);
    };
    const manager = await managerWith([ACCOUNT_FIXTURES[0]]);
    const publicModels = await manager.prepareModelAccess(legacy);
    assert.ok(!publicModels.data.some(model => model.id === legacy));
    assert.equal(manager.selectAccount(legacy).account.email, 'restricted-pro@example.test');
    const response = await sendMessage({ ...BASE_REQUEST, model: legacy }, manager);
    assert.equal(response.model, legacy);
    assert.equal(generationCalls.length, 1);
    assert.equal(modelCalls.length, 1);
});

test('HTTP metadata failures return 503, while a healthy account still supplies a partial union', async () => {
    const { accountManager } = await import('../src/server.js');
    const base = `http://127.0.0.1:${server.address().port}`;
    metadataFails = true;
    let response = await originalFetch(base + '/v1/models');
    assert.equal(response.status, 503);
    await response.json();
    for (const stream of [false, true]) {
        response = await originalFetch(base + '/v1/messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...BASE_REQUEST, stream })
        });
        assert.equal(response.status, 503);
        const data = await response.json();
        assert.equal(data.error.type, 'api_error');
        assert.ok(!JSON.stringify(data).includes('fixture-'));
    }
    assert.equal(generationCalls.length, 0);
    metadataFails = false;
    clearMetadataCache();
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith(':fetchAvailableModels') && options.headers?.Authorization === 'Bearer fixture-restricted-token') {
            return new Response('metadata unavailable', { status: 503 });
        }
        return mockFetch(url, options);
    };
    response = await originalFetch(base + '/v1/models');
    assert.equal(response.status, 200);
    const partial = await response.json();
    assert.deepEqual(partial.data.map(model => model.id).sort(), [FLASH, SONNET, MEDIUM].sort());
    const pool = accountManager.getAllAccounts();
    const originalAccounts = pool.splice(0);
    try {
        response = await originalFetch(base + '/v1/models');
        assert.equal(response.status, 503);
        await response.json();
        response = await originalFetch(base + '/v1/messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BASE_REQUEST)
        });
        assert.equal(response.status, 503);
        assert.match((await response.json()).error.message, /No enabled, valid accounts/);
    } finally { pool.push(...originalAccounts); }
    assert.equal(generationCalls.length, 0);
});

test('a token-refresh deadline cannot block healthy accounts or later grant access', async () => {
    const manager = await managerWith();
    const tokenGetter = manager.getTokenForAccount.bind(manager);
    let finishStalledToken;
    manager.getTokenForAccount = account => account.email === 'restricted-pro@example.test'
        ? new Promise(resolve => { finishStalledToken = resolve; }) : tokenGetter(account);
    await manager.prepareModelAccess(SONNET);
    assert.deepEqual(manager.getAvailableAccounts(FLASH).map(account => account.email), ['ultra@example.test']);
    finishStalledToken('fixture-restricted-token');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.getAvailableAccounts(FLASH).map(account => account.email), ['ultra@example.test']);
    assert.equal(modelCalls.length, 1, 'a late token must not start another metadata request');
    assert.equal(generationCalls.length, 0);
});


test('preparation uses the same known project priority as inference, ignoring stale subscription metadata', async () => {
    const { knownProjectForAccount } = await import('../src/account-manager/credentials.js');
    const account = { ...ACCOUNT_FIXTURES[1],
        refreshToken: 'fixture-refresh|billing-origin|managed-project',
        projectId: 'old-account-project',
        subscription: { tier: 'ultra', projectId: 'stale-subscription-project' }
    };
    assert.equal(knownProjectForAccount(account), 'managed-project');
    assert.equal(knownProjectForAccount(account, new Map([[account.email, 'cached-project']])), 'cached-project');
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith(':fetchAvailableModels')) {
            modelCalls.push(options.headers?.Authorization);
            assert.equal(JSON.parse(options.body).project, 'managed-project');
            return Response.json(catalog([SONNET]));
        }
        return mockFetch(url, options);
    };
    const manager = await managerWith([account]);
    await manager.prepareModelAccess(SONNET);
    const result = await sendMessage(BASE_REQUEST, manager);
    assert.equal(result.model, SONNET);
    assert.equal(generationCalls[0].payload.project, 'managed-project');
    assert.equal(modelCalls.length, 1);
});

test('disabling an account during preparation cannot publish its capabilities', async () => {
    const manager = await managerWith([ACCOUNT_FIXTURES[1]]);
    let releaseMetadata;
    let metadataStarted;
    const started = new Promise(resolve => { metadataStarted = resolve; });
    globalThis.fetch = async () => {
        metadataStarted();
        return new Promise(resolve => { releaseMetadata = resolve; });
    };
    const preparing = manager.prepareModelAccess(SONNET);
    await started;
    manager.getAllAccounts()[0].enabled = false;
    releaseMetadata(Response.json(catalog([SONNET])));
    await assert.rejects(preparing, /No accounts available/);
    assert.equal(manager.selectAccount(SONNET).account, null);
    assert.equal(generationCalls.length, 0);
});

test('both handlers stop if the selected account is disabled during its final metadata check', async () => {
    for (const stream of [false, true]) {
        clearMetadataCache();
        const manager = await managerWith([ACCOUNT_FIXTURES[1]]);
        let selectedCheck = false;
        let releaseMetadata;
        let checkStarted;
        const started = new Promise(resolve => { checkStarted = resolve; });
        const originalProject = manager.getProjectForAccount.bind(manager);
        manager.getProjectForAccount = async (account, token) => {
            const project = await originalProject(account, token);
            clearMetadataCache();
            selectedCheck = true;
            return project;
        };
        globalThis.fetch = async (url, options = {}) => {
            if (selectedCheck && String(url).endsWith(':fetchAvailableModels')) {
                checkStarted();
                return new Promise(resolve => { releaseMetadata = resolve; });
            }
            return mockFetch(url, options);
        };
        const running = stream ? (async () => {
            for await (const _event of sendMessageStream(BASE_REQUEST, manager)) {}
        })() : sendMessage(BASE_REQUEST, manager);
        await started;
        manager.getAllAccounts()[0].enabled = false;
        releaseMetadata(Response.json(catalog([SONNET])));
        await assert.rejects(running, /MODEL_METADATA_UNAVAILABLE/);
        assert.equal(manager.selectAccount(SONNET).account, null);
    }
    assert.equal(generationCalls.length, 0);
});

test('reloading changed credentials for the same email revokes token, project and capability caches', async () => {
    const manager = await managerWith([ACCOUNT_FIXTURES[1]]);
    await manager.prepareModelAccess(SONNET);
    const previous = manager.getAllAccounts()[0];
    await manager.getProjectForAccount(previous, await manager.getTokenForAccount(previous));
    fs.writeFileSync(manager.fixturePath, JSON.stringify({ accounts: [{
        ...ACCOUNT_FIXTURES[0], email: previous.email
    }], activeIndex: 0 }));
    await manager.reload();
    await assert.rejects(manager.prepareModelAccess(SONNET), /invalid_request_error/);
    const current = manager.getAllAccounts()[0];
    assert.equal(await manager.getTokenForAccount(current), 'fixture-restricted-token');
    assert.equal(await manager.getProjectForAccount(current, 'fixture-restricted-token'), 'restricted-project');
    assert.equal(manager.selectAccount(SONNET).account, null);
    assert.deepEqual(modelCalls, ['Bearer fixture-ultra-token', 'Bearer fixture-restricted-token']);
    assert.equal(generationCalls.length, 0);
});
