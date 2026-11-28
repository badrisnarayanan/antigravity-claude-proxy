/**
 * Write an Anthropic-format event stream to an HTTP response.
 *
 * Headers wait for the first upstream event, so an upstream failure that
 * comes at once (429, 503, 400) still reaches the client as a real HTTP
 * status. But a long prompt at high effort can keep Google silent for minutes
 * before its first chunk, and clients give up on a response that sends no
 * headers: Claude Code aborts after its first-byte window
 * (CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS) and sends the same request again, so
 * the request never completes. When no event has come after `graceMs`, the
 * headers go out with an SSE `ping` (as the Anthropic API sends), and a ping
 * follows every `pingMs` until the first event. An upstream error after that
 * point goes out as an SSE `error` event.
 *
 * The pings continue for the whole stream: a ping goes out when nothing has
 * been written for `pingMs`. Google can be silent for minutes in the middle of
 * a stream while it generates a large tool call, and idle watchdogs in clients
 * and gateways drop a stream that sends no bytes. The Anthropic API sends
 * pings at any point in a stream, and clients ignore them.
 */

const PING = `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`;

/**
 * @param {import('express').Response} res
 */
function startEventStream(res) {
    if (res.headersSent) return;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
}

/**
 * @param {import('express').Response} res
 * @param {string} chunk
 */
function send(res, chunk) {
    res.write(chunk);
    if (res.flush) res.flush();
}

/**
 * Send a ping every `pingMs` until `stop()`. `reset()` restarts the wait after
 * a real event, so a ping goes out only when the stream has been idle. Events
 * are written whole by `send()`, so a ping never lands inside one.
 *
 * @param {import('express').Response} res
 * @param {number} pingMs
 */
function heartbeat(res, pingMs) {
    const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        send(res, PING);
    }, pingMs);
    return {
        reset: () => timer.refresh(),
        stop: () => clearInterval(timer)
    };
}

/**
 * Pull the first event, sending headers and pings while it is slow.
 * Rejects with the generator's error; the caller decides how to report it.
 *
 * @param {import('express').Response} res
 * @param {AsyncGenerator<Object>} generator
 * @param {{ graceMs: number, pingMs: number, onSlowStart?: () => void }} options
 * @returns {Promise<IteratorResult<Object>>}
 */
export async function firstEvent(res, generator, { graceMs, pingMs, onSlowStart }) {
    const first = generator.next();
    const GRACE = Symbol('grace');
    let graceTimer;
    const grace = new Promise(resolve => { graceTimer = setTimeout(resolve, graceMs, GRACE); });
    let result;
    try {
        result = await Promise.race([first, grace]);
    } finally {
        clearTimeout(graceTimer);
    }
    if (result !== GRACE) return result;

    onSlowStart?.();
    startEventStream(res);
    send(res, PING);
    const pings = heartbeat(res, pingMs);
    try {
        return await first;
    } finally {
        pings.stop();
    }
}

/**
 * Stream every event of `generator` to `res`, starting with `firstResult`.
 * Sends a ping when no event has been written for `pingMs`. Rejects with the
 * generator's error; no ping follows the error or `res.end()`.
 *
 * @param {import('express').Response} res
 * @param {AsyncGenerator<Object>} generator
 * @param {IteratorResult<Object>} firstResult
 * @param {{ pingMs: number }} options
 */
export async function writeEvents(res, generator, firstResult, { pingMs }) {
    startEventStream(res);
    const pings = heartbeat(res, pingMs);
    const write = (event) => {
        send(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        pings.reset();
    };
    try {
        if (!firstResult.done) write(firstResult.value);
        for await (const event of generator) write(event);
    } finally {
        pings.stop();
    }
    res.end();
}
