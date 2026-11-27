#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { spawn, exec } from 'child_process';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

// PID file location for background process management
const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'antigravity-proxy');
const PID_FILE = join(CONFIG_DIR, 'server.pid');

const args = process.argv.slice(2);
const command = args[0];

/**
 * Check if the service is running by reading PID file and verifying process
 */
function isServiceRunning() {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pidStr = readFileSync(PID_FILE, 'utf-8');
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      cleanupPidFile();
      return false;
    }

    // Check if process is running (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist
    cleanupPidFile();
    return false;
  }
}

/**
 * Get the PID of the running service
 */
function getServicePid() {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Save PID to file
 */
function savePid(pid) {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(PID_FILE, pid.toString());
  } catch (e) {
    console.warn(`   Could not write PID file ${PID_FILE}: ${e.message}`);
    console.warn('   acc stop and acc status may not find this proxy.');
  }
}

/**
 * Clean up PID file
 */
function cleanupPidFile() {
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch (e) {
      console.warn(`Could not remove PID file ${PID_FILE}: ${e.message}`);
    }
  }
}

/**
 * Get current port from environment or default
 */
function getPort() {
  return process.env.PORT || 8080;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Host to probe when checking the port. The server binds 0.0.0.0 by default,
 * which is reachable on 127.0.0.1.
 */
function getProbeHost() {
  const host = process.env.HOST;
  if (!host || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }
  return host;
}

/**
 * Check whether something is accepting connections on the port
 */
function isPortInUse(port, timeout = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({ port: Number(port), host: getProbeHost() });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Wait until the server accepts connections on its port.
 * Stops early if the server process exits, instead of waiting out the timeout (#409).
 */
async function waitForService(child, port, timeout = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (child.exited) {
      return { ready: false, exited: true };
    }
    if (await isPortInUse(port)) {
      return { ready: true };
    }
    await sleep(250);
  }
  return { ready: false, exited: child.exited };
}

/**
 * Print the port-in-use message
 */
function printPortInUse(port) {
  console.error('');
  console.error(`⚠️  Port ${port} is already in use`);
  console.error('   Another program (maybe another copy of the proxy) is listening there.');
  console.error(`   • If it is the proxy, its dashboard is at http://localhost:${port}`);
  console.error('   • Otherwise stop that program, or pick another port with PORT');
  console.error('     (for example PORT=8081 acc start)');
  console.error('');
}

/**
 * Start the server as a background process (or foreground with --log)
 */
async function startServer() {
  // Check for --log flag
  const logMode = args.includes('--log');

  if (isServiceRunning() && !logMode) {
    console.log('');
    console.log('╭' + '─'.repeat(48) + '╮');
    console.log('│  🛸 Antigravity Proxy is already in orbit      │');
    console.log('╰' + '─'.repeat(48) + '╯');
    console.log('');

    const pid = getServicePid();
    const port = getPort();
    console.log(`   ┌─ PID: ${pid}`);
    console.log(`   ├─ Local: http://localhost:${port}`);
    console.log(`   └─ Dashboard: http://localhost:${port}`);
    console.log('');
    return;
  }

  console.log('');
  if (logMode) {
    console.log('🌌 Launching Antigravity Proxy (foreground mode)...');
    console.log('   Press Ctrl+C to stop');
    console.log('');
  } else {
    console.log('🌌 Launching Antigravity Proxy...');
  }

  const serverScript = join(__dirname, '..', 'src', 'index.js');
  const port = getPort();

  // Filter out --log from args passed to server
  const serverArgs = args.slice(1).filter(arg => arg !== '--log');

  if (logMode) {
    // Foreground mode - show logs directly
    // process.execPath: the Node binary running this CLI. Plain 'node' can resolve
    // to a version-manager shim (Volta, nvm-windows) that fails silently (#409).
    const serverProcess = spawn(process.execPath, [serverScript, ...serverArgs], {
      stdio: 'inherit', // Show output in current terminal
      windowsHide: true,
      env: { ...process.env, PORT: port.toString() }
    });

    serverProcess.on('error', (error) => {
      console.error('');
      console.error('⚠️  Launch failed:', error.message);
      console.error('');
      process.exit(1);
    });

    serverProcess.on('exit', (code) => {
      console.log('');
      console.log('🌙 Proxy has exited');
      console.log('');
      process.exit(code || 0);
    });

    // Keep process running
    return;
  }

  // Background mode - check the port first, since the detached server's own
  // error output is not visible here
  if (await isPortInUse(port)) {
    printPortInUse(port);
    process.exitCode = 1;
    return;
  }

  // Background mode - detached process (process.execPath, see foreground note)
  const serverProcess = spawn(process.execPath, [serverScript, ...serverArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PORT: port.toString() }
  });

  serverProcess.exited = false;
  serverProcess.once('exit', (code, signal) => {
    serverProcess.exited = true;
    serverProcess.exitInfo = signal ? `signal ${signal}` : `exit code ${code}`;
  });

  serverProcess.on('error', (error) => {
    console.error('');
    console.error('⚠️  Launch failed:', error.message);
    console.error('');
    process.exit(1);
  });

  // Save PID and detach
  savePid(serverProcess.pid);
  serverProcess.unref();

  // Wait for service to be ready
  const result = await waitForService(serverProcess, port);
  if (result.exited) {
    cleanupPidFile();
    console.error('');
    console.error(`⚠️  Proxy stopped right after launch (${serverProcess.exitInfo})`);
    console.error('   Run acc start --log to see the error.');
    console.error('');
    process.exitCode = 1;
  } else if (result.ready) {
    console.log('╭' + '─'.repeat(48) + '╮');
    console.log('│ ⚡ Proxy is now in orbit!                      │');
    console.log('╰' + '─'.repeat(48) + '╯');

    console.log('');
    console.log('   ┌─ Process ID:', serverProcess.pid);
    console.log('   ├─ Local:', `http://localhost:${port}`);
    console.log('   └─ Dashboard:', `http://localhost:${port}/`);
    console.log('');
    console.log('   Next steps:');
    console.log('   • acc ui       → Open dashboard');
    console.log('   • acc status   → View proxy health');
    console.log('   • acc stop     → Shut down proxy');
    console.log('');
  } else {
    console.error('');
    console.error('⚠️  Proxy launched but health check timed out');
    console.log(`   Try: curl http://localhost:${port}/health`);
    console.log('   Or run acc start --log to see its output.');
    console.error('');
    process.exitCode = 1;
  }
}

/**
 * Stop the running server
 */
function stopServer() {
  if (!isServiceRunning()) {
    console.log('');
    console.log('🌑 Proxy is not running');
    console.log('');
    cleanupPidFile();
    return;
  }

  const pid = getServicePid();
  try {
    process.kill(pid, 'SIGTERM');
    cleanupPidFile();
    console.log('');
    console.log('🌙 Proxy has been taken offline');
    console.log('');
  } catch (e) {
    console.error('');
    console.error('⚠️  Shutdown failed:', e.message);
    console.error('');
    cleanupPidFile();
  }
}

/**
 * Restart the server
 */
async function restartServer() {
  console.log('');
  console.log('♻️  Restarting proxy...');
  console.log('');

  // Stop if running
  if (isServiceRunning()) {
    const pid = getServicePid();
    try {
      process.kill(pid, 'SIGTERM');
      cleanupPidFile();
      console.log('   └─ Existing instance stopped');
      console.log('');
      // Wait for the process to terminate and release the port
      const port = getPort();
      const deadline = Date.now() + 10000;
      await sleep(500);
      while (Date.now() < deadline && await isPortInUse(port)) {
        await sleep(250);
      }
    } catch {
      console.log('   └─ No previous instance found');
      console.log('');
      cleanupPidFile();
    }
  }

  // Start fresh
  await startServer();
}

/**
 * Show server status
 */
function showStatus() {
  console.log('');
  console.log('╭' + '─'.repeat(48) + '╮');
  console.log('│  🛸 Antigravity Claude Proxy                   │');
  console.log('╰' + '─'.repeat(48) + '╯');
  console.log('');

  if (isServiceRunning()) {
    const pid = getServicePid();
    const port = getPort();
    console.log('  STATUS');
    console.log('  ⚡ Proxy is active');
    console.log('');
    console.log('  DETAILS');
    console.log(`  ├─ PID: ${pid}`);
    console.log(`  ├─ Port: ${port}`);
    console.log(`  ├─ API: http://localhost:${port}`);
    console.log(`  └─ Dashboard: http://localhost:${port}/`);
    console.log('');
    console.log('  AVAILABLE COMMANDS');
    console.log('  • acc ui         Open dashboard');
    console.log('  • acc restart    Relaunch proxy');
    console.log('  • acc stop       Take offline');
  } else {
    console.log('  STATUS');
    console.log('  🌑 Proxy is offline');
    console.log('');
    console.log('  TO LAUNCH');
    console.log('  • acc start      Bring proxy online');
  }
  console.log('');
}

/**
 * Open WebUI in browser
 */
async function openUI() {
  // Start server if not running
  if (!isServiceRunning()) {
    console.log('');
    console.log('🌌 Proxy offline - launching now...');
    await startServer();
    // Wait for it to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const port = getPort();
  const uiUrl = `http://localhost:${port}/`;

  console.log('');
  console.log(`🖥️  Opening dashboard → ${uiUrl}`);
  console.log('');

  // Open URL in browser based on platform
  const platform = process.platform;
  let openCommand = '';

  if (platform === 'win32') {
    openCommand = `start ${uiUrl}`;
  } else if (platform === 'darwin') {
    openCommand = `open ${uiUrl}`;
  } else if (platform === 'linux') {
    openCommand = `xdg-open ${uiUrl}`;
  } else {
    console.error('⚠️  Cannot auto-open browser on this platform');
    console.log(`   Manual URL: ${uiUrl}`);
    console.log('');
    return;
  }

  exec(openCommand, (error) => {
    if (error) {
      console.error('⚠️  Browser launch failed:', error.message);
      console.log(`   Manual URL: ${uiUrl}`);
      console.log('');
    }
  });
}

function showHelp() {
  console.log(`
╭${'─'.repeat(58)}╮
│  🛸 Antigravity Claude Proxy v${packageJson.version.padEnd(27)}│
╰${'─'.repeat(58)}╯

Route Claude Code CLI through Antigravity's multi-model API
with intelligent load balancing across Google accounts.

USAGE
  antigravity-claude-proxy <command> [options]
  acc <command> [options]                 ← shorthand

━━━ PROXY CONTROL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  start              Launch proxy as background service
  stop               Shut down the proxy
  restart            Relaunch the proxy
  status             View proxy health and details
  ui                 Open dashboard in browser

━━━ ACCOUNT MANAGEMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  accounts           Interactive account menu
  accounts add       Add Google account via OAuth
  accounts list      Show all linked accounts
  accounts remove    Unlink accounts
  accounts verify    Check account health
  accounts clear     Remove all accounts

━━━ OPTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  --help, -h         Show this help
  --version, -v      Show version
  --log              Run in foreground with visible logs
  --strategy=NAME    Load balancing: hybrid (default),
                     sticky (cache-optimized), round-robin
  --fallback         Enable model fallback on errors

━━━ ENVIRONMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PORT              Custom port (default: 8080)

━━━ EXAMPLES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  acc start                    Launch proxy
  acc start --log              Launch with visible logs
  acc ui                       Open dashboard
  PORT=3000 acc start          Use custom port
  acc start --strategy=sticky  Optimize for prompt caching
  acc accounts add             Link new Google account

━━━ CLAUDE CODE SETUP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Edit ~/.claude/settings.json:
  {
    "env": {
      "ANTHROPIC_BASE_URL": "http://localhost:8080"
    }
  }

Docs: https://github.com/badrisnarayanan/antigravity-claude-proxy
`);
}

function showVersion() {
  console.log(packageJson.version);
}

async function main() {
  // Handle flags
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  // Handle commands
  switch (command) {
    case 'start':
      await startServer();
      break;

    case 'stop':
      stopServer();
      break;

    case 'restart':
      await restartServer();
      break;

    case 'status':
      showStatus();
      break;

    case 'ui':
      await openUI();
      break;

    case 'accounts': {
      // Pass remaining args to accounts CLI
      const subCommand = args[1] || 'add';
      process.argv = ['node', 'accounts-cli.js', subCommand, ...args.slice(2)];
      await import('../src/cli/accounts.js');
      break;
    }

    case 'help':
      showHelp();
      break;

    case 'version':
      showVersion();
      break;

    case undefined:
      // No command - show help
      showHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "acc --help" for usage information.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
