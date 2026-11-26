/**
 * Test outbound proxy support (issue #337)
 *
 * Starts a local target HTTP server and two local forward proxies, then checks that
 * throttledFetch goes through the right proxy, honours NO_PROXY, and keeps using the
 * proxy even when the global dispatcher slot that Node's built-in fetch reads points
 * somewhere else (the bug: Node 26 bundles undici 8, older releases shipped undici 7).
 */
const http = require('http');
const net = require('net');

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startConnectProxy(name, seen) {
    // Plain http:// targets arrive as absolute-form requests, https:// ones as CONNECT
    const server = http.createServer((req, res) => {
        const url = new URL(req.url);
        seen.push(`${name} ${url.host}`);
        const upstream = http.request(url, { method: req.method, headers: req.headers }, up => {
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    });
    server.on('connect', (req, client, head) => {
        seen.push(`${name} ${req.url}`);
        const [host, port] = req.url.split(':');
        const upstream = net.connect(Number(port), host, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    return server;
}

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               OUTBOUND PROXY SUPPORT TEST SUITE              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { initProxy, getProxyDispatcher, redactProxyUrl } = await import('../src/utils/proxy.js');
    const { throttledFetch } = await import('../src/utils/helpers.js');
    const { Agent } = await import('undici');

    const seen = [];
    const target = http.createServer((req, res) => res.end('ok'));
    const proxyA = startConnectProxy('A', seen);
    const proxyB = startConnectProxy('B', seen);
    const targetPort = await listen(target);
    const portA = await listen(proxyA);
    const portB = await listen(proxyB);
    const targetUrl = `http://127.0.0.1:${targetPort}/`;

    let passed = 0;
    let failed = 0;
    async function test(name, fn) {
        seen.length = 0;
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}\n  ${e.message}`);
            failed++;
        }
    }
    function assert(cond, msg) { if (!cond) throw new Error(msg); }

    await test('no proxy env: no dispatcher, request goes direct', async () => {
        assert(initProxy({}) === null, 'expected no dispatcher');
        assert(getProxyDispatcher() === null, 'getProxyDispatcher should be null');
        const r = await throttledFetch(targetUrl);
        assert(await r.text() === 'ok', 'bad body');
        assert(seen.length === 0, `proxy should not be used, saw ${seen.join(', ')}`);
    });

    await test('HTTP_PROXY: requests go through the proxy', async () => {
        initProxy({ HTTP_PROXY: `http://127.0.0.1:${portA}` });
        const r = await throttledFetch(targetUrl);
        assert(await r.text() === 'ok', 'bad body');
        assert(seen.length === 1 && seen[0] === `A 127.0.0.1:${targetPort}`, `saw ${seen.join(', ')}`);
    });

    await test('lowercase http_proxy is honoured', async () => {
        initProxy({ http_proxy: `http://127.0.0.1:${portB}` });
        await (await throttledFetch(targetUrl)).text();
        assert(seen.length === 1 && seen[0].startsWith('B '), `saw ${seen.join(', ')}`);
    });

    await test('HTTPS_PROXY wins over HTTP_PROXY for https URLs', async () => {
        initProxy({ HTTP_PROXY: `http://127.0.0.1:${portA}`, HTTPS_PROXY: `http://127.0.0.1:${portB}` });
        // The target speaks plain HTTP, so the TLS handshake fails; only the CONNECT matters here
        await throttledFetch(`https://127.0.0.1:${targetPort}/`).catch(() => {});
        assert(seen.length === 1 && seen[0] === `B 127.0.0.1:${targetPort}`, `saw ${seen.join(', ')}`);
    });

    await test('NO_PROXY bypasses the proxy for listed hosts', async () => {
        initProxy({ HTTP_PROXY: `http://127.0.0.1:${portA}`, NO_PROXY: 'localhost,127.0.0.1' });
        const r = await throttledFetch(targetUrl);
        assert(await r.text() === 'ok', 'bad body');
        assert(seen.length === 0, `proxy should be bypassed, saw ${seen.join(', ')}`);
    });

    await test('still proxied when the built-in fetch global slot points elsewhere', async () => {
        initProxy({ HTTP_PROXY: `http://127.0.0.1:${portA}` });
        // Simulate a Node whose bundled undici reads a slot we did not fill
        const slot = Symbol.for('undici.globalDispatcher.2');
        const saved = globalThis[slot];
        globalThis[slot] = new Agent();
        try {
            await (await throttledFetch(targetUrl)).text();
        } finally {
            globalThis[slot] = saved;
        }
        assert(seen.length === 1 && seen[0].startsWith('A '), `saw ${seen.join(', ')}`);
    });

    await test('POST body and headers pass through the proxy', async () => {
        initProxy({ HTTP_PROXY: `http://127.0.0.1:${portA}` });
        const echo = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => res.end(`${req.headers['x-test']}:${body}`));
        });
        const echoPort = await listen(echo);
        try {
            const r = await throttledFetch(`http://127.0.0.1:${echoPort}/`, {
                method: 'POST', headers: { 'X-Test': 'yes' }, body: 'a=1'
            });
            assert(await r.text() === 'yes:a=1', 'body/headers not forwarded');
        } finally {
            echo.close();
        }
        assert(seen.length === 1, `saw ${seen.join(', ')}`);
    });

    await test('credentials in the proxy URL are redacted for logs', async () => {
        const out = redactProxyUrl('http://user:secret@proxy.example:8080');
        assert(!out.includes('secret') && !out.includes('user'), out);
        assert(out.includes('proxy.example:8080'), out);
        assert(redactProxyUrl('http://proxy.example:3128') === 'http://proxy.example:3128/', 'plain URL changed');
    });

    initProxy({});
    target.close(); proxyA.close(); proxyB.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
