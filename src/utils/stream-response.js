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
    const heartbeat = setInterval(() => send(res, PING), pingMs);
    try {
        return await first;
    } finally {
        clearInterval(heartbeat);
    }
}

/**
 * Stream every event of `generator` to `res`, starting with `firstResult`.
 *
 * @param {import('express').Response} res
 * @param {AsyncGenerator<Object>} generator
 * @param {IteratorResult<Object>} firstResult
 */
export async function writeEvents(res, generator, firstResult) {
    startEventStream(res);
    if (!firstResult.done) {
        send(res, `event: ${firstResult.value.type}\ndata: ${JSON.stringify(firstResult.value)}\n\n`);
    }
    for await (const event of generator) {
        send(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
}
