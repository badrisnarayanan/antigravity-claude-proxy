/**
 * Test Stream Response - headers, pings and cancellation for streamed replies
 *
 * A fast first upstream event keeps the old behaviour: no ping, and an
 * immediate upstream error is still a real HTTP status. A slow first event
 * gets headers and SSE pings, so a client's first-byte timeout does not abort
 * and resend the request. A cancelled request stops before it calls upstream.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               STREAM RESPONSE TEST SUITE                     ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { firstEvent, writeEvents } = await import('../src/utils/stream-response.js');
    const { sendMessageStream } = await import('../src/cloudcode/streaming-handler.js');
    const { ClientDisconnectedError } = await import('../src/errors.js');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assert(cond, msg) {
        if (!cond) throw new Error(msg);
    }

    function fakeRes() {
        return {
            headersSent: false,
            statusCode: null,
            headers: {},
            chunks: [],
            ended: false,
            status(code) { this.statusCode = code; return this; },
            setHeader(k, v) { this.headers[k] = v; },
            flushHeaders() { this.headersSent = true; },
            write(chunk) { this.chunks.push(chunk); },
            end() { this.ended = true; }
        };
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pings = (res) => res.chunks.filter(c => c.startsWith('event: ping\n')).length;

    async function* events(delayMs, list) {
        await sleep(delayMs);
        for (const e of list) yield e;
    }

    async function* failing(delayMs, message) {
        await sleep(delayMs);
        throw new Error(message);
    }

    const opts = { graceMs: 40, pingMs: 15 };

    await test('fast first event: no ping, headers sent once, all events written', async () => {
        const res = fakeRes();
        let slow = false;
        const gen = events(0, [{ type: 'message_start' }, { type: 'message_stop' }]);
        const first = await firstEvent(res, gen, { ...opts, onSlowStart: () => { slow = true; } });
        assert(!res.headersSent, 'headers wait for the caller');
        await writeEvents(res, gen, first);
        assert(!slow, 'onSlowStart must not fire');
        assert(pings(res) === 0, `expected no ping, got ${pings(res)}`);
        assert(res.statusCode === 200 && res.headers['Content-Type'] === 'text/event-stream', 'SSE headers');
        assert(res.chunks.length === 2, `expected 2 events, got ${res.chunks.length}`);
        assert(res.chunks[0].startsWith('event: message_start\n'), 'first event first');
        assert(res.ended, 'response ended');
    });

    await test('slow first event: headers and pings before it, then the events', async () => {
        const res = fakeRes();
        let slow = false;
        const gen = events(100, [{ type: 'message_start' }, { type: 'message_stop' }]);
        const first = await firstEvent(res, gen, { ...opts, onSlowStart: () => { slow = true; } });
        assert(slow, 'onSlowStart fires');
        assert(res.headersSent && res.statusCode === 200, 'headers sent early');
        const pingsBefore = pings(res);
        assert(pingsBefore >= 2, `expected the first ping and at least one more, got ${pingsBefore}`);
        await writeEvents(res, gen, first);
        assert(res.chunks.slice(0, pingsBefore).every(c => c.startsWith('event: ping\n')), 'pings come first');
        assert(res.chunks[pingsBefore].startsWith('event: message_start\n'), 'then the first event');
        await sleep(40);
        assert(pings(res) === pingsBefore, 'pings stop after the first event');
    });

    await test('fast upstream error: rejects before headers, so the caller can send a status', async () => {
        const res = fakeRes();
        let error = null;
        try {
            await firstEvent(res, failing(0, '429 RESOURCE_EXHAUSTED'), opts);
        } catch (e) {
            error = e;
        }
        assert(error?.message === '429 RESOURCE_EXHAUSTED', 'error reaches the caller');
        assert(!res.headersSent, 'no headers sent');
    });

    await test('slow upstream error: rejects after headers, and pings stop', async () => {
        const res = fakeRes();
        let error = null;
        try {
            await firstEvent(res, failing(80, '503 UNAVAILABLE'), opts);
        } catch (e) {
            error = e;
        }
        assert(error?.message === '503 UNAVAILABLE', 'error reaches the caller');
        assert(res.headersSent, 'headers already sent, so the caller sends an SSE error');
        const count = pings(res);
        await sleep(40);
        assert(pings(res) === count, 'pings stop after the error');
    });

    await test('a cancelled request stops before it calls upstream', async () => {
        const controller = new AbortController();
        controller.abort(new ClientDisconnectedError());
        let called = false;
        const accountManager = {
            getAccountCount: () => 1,
            getAvailableAccounts: () => { called = true; return []; }
        };
        let error = null;
        try {
            const gen = sendMessageStream({ model: 'gemini-4-neon-high', messages: [] }, accountManager, false, { signal: controller.signal });
            await gen.next();
        } catch (e) {
            error = e;
        }
        assert(error instanceof ClientDisconnectedError, `expected ClientDisconnectedError, got ${error}`);
        assert(!called, 'no account was selected');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
