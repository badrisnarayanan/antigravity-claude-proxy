#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { spawn, exec } from 'child_process';

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

// Ensure config directory exists
function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

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
  } catch (e) {
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
  } catch (e) {
    return null;
  }
}

/**
 * Save PID to file
 */
function savePid(pid) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(PID_FILE, pid.toString());
}

/**
 * Clean up PID file
 */
function cleanupPidFile() {
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get current port from environment or default
 */
function getPort() {
  return process.env.PORT || 8080;
}

/**
 * Wait for service to be ready
 */
async function waitForService(timeout = 10000, initialDelay = 1000) {
  await new Promise(resolve => setTimeout(resolve, initialDelay));

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (isServiceRunning()) {
      // Additional wait to ensure service is fully ready
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
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
    const serverProcess = spawn('node', [serverScript, ...serverArgs], {
      stdio: 'inherit', // Show output in current terminal
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

  // Background mode - detached process
  const serverProcess = spawn('node', [serverScript, ...serverArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: port.toString() }
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
  if (await waitForService()) {
    console.log('╭' + '─'.repeat(48) + '╮');
    console.log('│⚡ Proxy is now in orbit!');
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
    console.error('');
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
      // Wait for process to fully terminate
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
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
│  🛸 Antigravity Claude Proxy v${packageJson.version.padEnd(28)}│
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
