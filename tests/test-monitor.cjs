const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const PORT = 3004;
const BASE_URL = `http://localhost:${PORT}`;

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : null;
                    resolve({ statusCode: res.statusCode, body: parsed });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, body: null, raw: data });
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('Starting server...');
    const serverProcess = spawn('node', ['src/index.js'], {
        env: { ...process.env, PORT: PORT, NODE_ENV: 'test' },
        cwd: process.cwd()
    });

    serverProcess.stdout.on('data', (data) => {
        // Uncomment to see server output
        // console.log(data.toString());
    });
    serverProcess.stderr.on('data', (data) => {
        console.error(data.toString());
    });

    try {
        // Wait for server to be ready
        let ready = false;
        for (let i = 0; i < 20; i++) {
            try {
                await request('GET', '/health');
                ready = true;
                break;
            } catch (e) {
                await sleep(500);
            }
        }

        if (!ready) throw new Error('Server failed to start');
        console.log('Server ready.');

        // Get initial logs
        const initialLogsRes = await request('GET', '/api/monitor/logs');
        assert.strictEqual(initialLogsRes.statusCode, 200);
        const initialCount = initialLogsRes.body.logs.length;
        console.log(`Initial log count: ${initialCount}`);

        // Trigger a 404
        console.log('Triggering 404...');
        await request('GET', '/api/non-existent-' + Date.now());

        // Wait a bit for db write
        await sleep(1000);

        // Verify log
        console.log('Verifying log...');
        const logsRes = await request('GET', '/api/monitor/logs');
        assert.strictEqual(logsRes.statusCode, 200);

        console.log('Logs found:', logsRes.body.logs.length);
        const logs = logsRes.body.logs;

        // We might get more logs if something else is hitting the server (like the health check loop potentially if it overlapped, or internal requests)
        // But we are single threaded here mostly.
        // Let's just check that at least one log exists and it is the 404.

        const found404 = logs.find(l => l.status === 404 && l.url.includes('/api/non-existent'));
        assert(found404, 'Should find the 404 log entry');

        console.log('Monitor test passed!');

    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    } finally {
        serverProcess.kill();
    }
}

runTests();
