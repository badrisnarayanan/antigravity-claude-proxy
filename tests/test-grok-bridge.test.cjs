const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

function createChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.unref = () => {};
    child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
    };
    return child;
}

function createSpawnStub(plans) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
        const child = createChild();
        calls.push({ command, args, options, child });
        const plan = plans.shift();
        if (plan) queueMicrotask(() => plan(child));
        return child;
    };
    return { calls, spawnImpl };
}

function createAccountManager() {
    const account = { alias: 'test', dir: '.grok-test', homeDir: 'C:\\test-grok-home' };
    return {
        initialize: async () => {},
        selectAccount: () => account,
        getAccounts: () => [account],
        markSuccess: () => {},
        markRateLimited: () => {},
    };
}

async function loadBridge() {
    return import('../src/cloudcode/grok-bridge.js');
}

test('health check hides the Windows subprocess and does not use a shell for grok.exe', async () => {
    const { createGrokBridge } = await loadBridge();
    const stub = createSpawnStub([child => child.emit('close', 0)]);
    const bridge = createGrokBridge({
        accountManager: createAccountManager(),
        spawnImpl: stub.spawnImpl,
        platform: 'win32',
        grokCommand: { command: 'C:\\Users\\test\\.grok\\bin\\grok.exe', kind: 'executable' },
    });

    assert.equal(await bridge.checkGrokAvailable(), true);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].args, ['--version']);
    assert.equal(stub.calls[0].options.windowsHide, true);
    assert.equal(stub.calls[0].options.shell, false);
    assert.deepEqual(stub.calls[0].options.stdio, ['ignore', 'ignore', 'ignore']);
});

test('request buffers JSON output, keeps the process hidden, and preserves response conversion', async () => {
    const { createGrokBridge } = await loadBridge();
    const stub = createSpawnStub([child => {
        child.stdout.write('{"text":"hello",');
        child.stdout.write('"stopReason":"EndTurn","usage":{"input_tokens":2,"output_tokens":1}}');
        child.stdout.end();
        child.emit('close', 0);
    }]);
    const bridge = createGrokBridge({
        accountManager: createAccountManager(),
        spawnImpl: stub.spawnImpl,
        platform: 'win32',
        grokCommand: { command: 'C:\\Users\\test\\.grok\\bin\\grok.exe', kind: 'executable' },
    });

    const response = await bridge.sendGrokMessage({
        model: 'grok-4.5',
        messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(response.content[0].text, 'hello');
    assert.equal(response.stop_reason, 'end_turn');
    assert.deepEqual(response.usage, { input_tokens: 2, output_tokens: 1 });
    assert.equal(stub.calls[0].options.windowsHide, true);
    assert.equal(stub.calls[0].options.shell, false);
    assert.deepEqual(stub.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('buffered streaming emits a complete Anthropic SSE event sequence', async () => {
    const { createGrokBridge } = await loadBridge();
    const stub = createSpawnStub([child => {
        child.stdout.end('{"text":"streamed","stopReason":"EndTurn","usage":{"input_tokens":3,"output_tokens":1}}');
        child.emit('close', 0);
    }]);
    const bridge = createGrokBridge({
        accountManager: createAccountManager(),
        spawnImpl: stub.spawnImpl,
        platform: 'win32',
        grokCommand: { command: 'C:\\grok.exe', kind: 'executable' },
    });

    const events = [];
    for await (const event of bridge.sendGrokMessageStream({ model: 'grok-4.5', messages: [] })) {
        events.push(event);
    }

    assert.deepEqual(events.map(event => event.type), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
    ]);
    assert.equal(events[2].delta.text, 'streamed');
});

test('timeout kills the child and rejects with a timeout error', async () => {
    const { createGrokBridge } = await loadBridge();
    const stub = createSpawnStub([]);
    const bridge = createGrokBridge({
        accountManager: createAccountManager(),
        spawnImpl: stub.spawnImpl,
        grokCommand: { command: 'grok', kind: 'executable' },
        requestTimeoutMs: 10,
    });

    await assert.rejects(
        bridge.sendGrokMessage({ model: 'grok-4.5', messages: [] }),
        /timed out/i,
    );
    assert.equal(stub.calls[0].child.killed, true);
});

test('AbortSignal kills the child and propagates an abort error', async () => {
    const { createGrokBridge } = await loadBridge();
    const stub = createSpawnStub([]);
    const bridge = createGrokBridge({
        accountManager: createAccountManager(),
        spawnImpl: stub.spawnImpl,
        grokCommand: { command: 'grok', kind: 'executable' },
    });
    const controller = new AbortController();
    const pending = bridge.sendGrokMessage({ model: 'grok-4.5', messages: [] }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();

    await assert.rejects(pending, /aborted/i);
    assert.equal(stub.calls[0].child.killed, true);
});

test('spawn errors propagate without leaking a child process', async () => {
    const { createGrokBridge } = await loadBridge();
    const stub = createSpawnStub([child => child.emit('error', new Error('ENOENT'))]);
    const bridge = createGrokBridge({
        accountManager: createAccountManager(),
        spawnImpl: stub.spawnImpl,
        grokCommand: { command: 'grok', kind: 'executable' },
    });

    await assert.rejects(
        bridge.sendGrokMessage({ model: 'grok-4.5', messages: [] }),
        /Grok CLI unavailable: ENOENT/,
    );
});

test('grok.cmd fallback uses hidden cmd.exe with shell disabled and quoted arguments', async () => {
    const { buildGrokLaunch } = await loadBridge();
    const launch = buildGrokLaunch(
        { command: 'C:\\Program Files\\Grok\\grok.cmd', kind: 'cmd' },
        ['--prompt-file', 'C:\\Temp Folder\\prompt.txt'],
        { platform: 'win32', comSpec: 'C:\\Windows\\System32\\cmd.exe' },
    );

    assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(launch.args[3], /"C:\\Program Files\\Grok\\grok\.cmd"/);
    assert.match(launch.args[3], /"C:\\Temp Folder\\prompt\.txt"/);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.shell, false);
});
