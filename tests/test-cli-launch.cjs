#!/usr/bin/env node
/**
 * CLI launch tests (#409)
 *
 * Runs the real `acc` CLI and server in a temporary HOME on spare ports:
 * - server exits with a clear message (not a TypeError) when the port is taken
 * - `acc start` reports a taken port instead of timing out
 * - `acc start` reports a server that dies right after launch
 * - `acc start` / `restart` / `stop` work on a free port
 *
 * No Google accounts or running proxy needed.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const SERVER = path.join(ROOT, 'src', 'index.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-cli-test-'));
const PID_FILE = path.join(HOME, '.config', 'antigravity-proxy', 'server.pid');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}`);
        if (detail) console.log(`    ${String(detail).split('\n').join('\n    ')}`);
    }
}

function env(extra) {
    const e = { ...process.env, HOME, USERPROFILE: HOME, ...extra };
    delete e.HOST;
    return { ...e, ...extra };
}

function run(file, args, extra, timeout = 40000) {
    const start = Date.now();
    const r = spawnSync(process.execPath, [file, ...args], { env: env(extra), encoding: 'utf8', timeout });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - start };
}

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

function occupy(port) {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(port, '0.0.0.0', () => resolve(s));
    });
}

function portOpen(port) {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host: '127.0.0.1' });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('CLI launch tests (#409)');

    // 1. Server on a taken port
    let port = await freePort();
    let blocker = await occupy(port);
    let r = run(SERVER, [], { PORT: String(port) });
    check('server exits with code 1 when the port is taken', r.code === 1, `code=${r.code}\n${r.out.slice(-600)}`);
    check('server says the port is in use', /already in use/.test(r.out), r.out.slice(-600));
    check('server does not crash with a TypeError', !/TypeError/.test(r.out), r.out.slice(-600));

    // 2. acc start on a taken port
    r = run(CLI, ['start'], { PORT: String(port) });
    check('acc start reports the taken port', /Port \d+ is already in use/.test(r.out), r.out);
    check('acc start exits with code 1', r.code === 1, `code=${r.code}`);
    check('acc start answers quickly (no 10s timeout)', r.ms < 5000, `took ${r.ms}ms`);
    check('acc start leaves no PID file', !fs.existsSync(PID_FILE));
    blocker.close();

    // 3. Server that dies right after launch (unusable bind address)
    port = await freePort();
    r = run(CLI, ['start'], { PORT: String(port), HOST: '203.0.113.1' });
    check('acc start reports a server that stopped at launch', /stopped right after launch/.test(r.out), r.out);
    check('acc start points to --log', /acc start --log/.test(r.out), r.out);
    check('acc start exits with code 1', r.code === 1, `code=${r.code}`);
    check('PID file is cleaned up', !fs.existsSync(PID_FILE));

    // 4. Normal start / start again / restart / stop on a free port
    port = await freePort();
    const p = { PORT: String(port) };
    try {
        r = run(CLI, ['start'], p);
        check('acc start succeeds on a free port', /now in orbit/.test(r.out) && r.code === 0, `code=${r.code}\n${r.out}`);
        check('proxy is listening', await portOpen(port));
        const pid = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) : NaN;
        check('PID file written', !isNaN(pid));

        r = run(CLI, ['start'], p);
        check('second acc start says already running', /already in orbit/.test(r.out), r.out);

        r = run(CLI, ['restart'], p);
        check('acc restart succeeds', /now in orbit/.test(r.out) && r.code === 0, `code=${r.code}\n${r.out}`);
        const pid2 = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) : NaN;
        check('restart started a new process', !isNaN(pid2) && pid2 !== pid, `old=${pid} new=${pid2}`);
    } finally {
        r = run(CLI, ['stop'], p);
        check('acc stop takes it offline', /taken offline/.test(r.out), r.out);
        await sleep(1500);
        check('port is free after stop', !(await portOpen(port)));
    }

    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
