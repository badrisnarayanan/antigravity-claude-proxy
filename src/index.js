/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

// Initialize proxy support BEFORE any other imports that may use fetch
import './utils/proxy.js';

import app, { accountManager, warmUp } from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { STRATEGY_NAMES } from './account-manager/strategies/index.js';
import { getPackageVersion } from './utils/helpers.js';
import path from 'path';
import os from 'os';

const packageVersion = getPackageVersion();

const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || args.includes('--dev-mode') || process.env.DEBUG === 'true' || process.env.DEV_MODE === 'true';
const isFallbackEnabled = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let strategyOverride = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        strategyOverride = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        strategyOverride = args[i + 1];
    }
}
if (strategyOverride && !STRATEGY_NAMES.includes(strategyOverride.toLowerCase())) {
    logger.warn(`[Startup] Invalid strategy "${strategyOverride}". Valid options: ${STRATEGY_NAMES.join(', ')}. Using default.`);
    strategyOverride = null;
}

logger.setDebug(isDebug);

if (isDebug) {
    config.devMode = true;
    config.debug = true;
    logger.debug('Developer mode enabled');
}

if (isFallbackEnabled) {
    logger.info('Model fallback mode enabled');
}

// Export fallback flag for server to use
export const FALLBACK_ENABLED = isFallbackEnabled;

const PORT = process.env.PORT || DEFAULT_PORT;
const HOST = process.env.HOST || '0.0.0.0';

if (process.env.HOST) {
    logger.info(`[Startup] Using HOST environment variable: ${process.env.HOST}`);
}

// Home directory for account storage
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.antigravity-claude-proxy');

// Express 5 calls this callback with the error when listen fails (e.g. port in use),
// so handle that here instead of crashing on a null server.address() (#409).
const server = app.listen(PORT, HOST, (err) => {
    if (err) {
        if (err.code === 'EADDRINUSE') {
            logger.error(`[Startup] Port ${PORT} is already in use. Another program (maybe another copy of the proxy) is listening there.`);
            logger.error('[Startup] Stop it, or start on another port by setting PORT (for example PORT=8081).');
        } else if (err.code === 'EACCES') {
            logger.error(`[Startup] No permission to listen on ${HOST}:${PORT}. Try another port by setting PORT.`);
        } else {
            logger.error(`[Startup] Server failed to start: ${err.message}`);
        }
        process.exit(1);
    }

    const address = server.address();
    const boundHost = typeof address === 'string' ? address : (address?.address || HOST);
    const boundPort = typeof address === 'string' ? null : (address?.port || PORT);

    // Load accounts now and start the background model-list refresh (#420)
    warmUp();

    // Clear console for a clean start
    console.clear();

    const border = '║';
    // align for 2-space indent (60 chars), align4 for 4-space indent (58 chars)
    const align = (text) => text + ' '.repeat(Math.max(0, 60 - text.length));
    const align4 = (text) => text + ' '.repeat(Math.max(0, 58 - text.length));

    const strategyOptions = `(${STRATEGY_NAMES.join('/')})`;
    const strategyLine2 = '                       ' + strategyOptions;
    let controlSection = '║  Control:                                                    ║\n';
    controlSection += '║    --strategy=<s>     Set account selection strategy         ║\n';
    controlSection += `${border}  ${align(strategyLine2)}${border}\n`;
    if (!isDebug) {
        controlSection += '║    --dev-mode         Enable developer mode                  ║\n';
    }
    if (!isFallbackEnabled) {
        controlSection += '║    --fallback         Enable model fallback on quota exhaust ║\n';
    }
    controlSection += '║    Ctrl+C             Stop server                            ║';

    // Get the strategy label (accountManager will be initialized by now)
    const strategyLabel = accountManager.getStrategyLabel();

    // Build status section - always show strategy, plus any active modes
    let statusSection = '║                                                              ║\n';
    statusSection += '║  Active Modes:                                               ║\n';
    statusSection += `${border}    ${align4(`✓ Strategy: ${strategyLabel}`)}${border}\n`;
    if (isDebug) {
        statusSection += '║    ✓ Developer mode enabled                                   ║\n';
    }
    if (isFallbackEnabled) {
        statusSection += '║    ✓ Model fallback enabled                                  ║\n';
    }
    if (process.env.CLAUDE_CONFIG_PATH) {
        statusSection += `${border}    ${align4(`✓ Claude config: ${process.env.CLAUDE_CONFIG_PATH}`)}${border}\n`;
    }

    const environmentSection = `║  Environment Variables:                                      ║
║    PORT                Server port (default: 8080)           ║
║    HOST                Bind address (default: 0.0.0.0)       ║
║    HTTP_PROXY          Route requests through a proxy        ║
║    CLAUDE_CONFIG_PATH  Path to .claude dir (for systemd)     ║
║    See README.md for detailed configuration examples         ║`

    logger.log(`
╔══════════════════════════════════════════════════════════════╗
║            Antigravity Claude Proxy Server v${packageVersion}            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${border}  ${align(`Server and WebUI running at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)}${border}
${border}  ${align(`Bound to: ${boundHost}:${boundPort}`)}${border}
${statusSection}║                                                              ║
${controlSection}
║                                                              ║
║  Endpoints:                                                  ║
║    POST /v1/messages         - Anthropic Messages API        ║
║    GET  /v1/models           - List available models         ║
║    GET  /health              - Health check                  ║
║    GET  /account-limits      - Account status & quotas       ║
║    POST /refresh-token       - Force token refresh           ║
║                                                              ║
${border}  ${align(`Configuration:`)}${border}
${border}    ${align4(`Storage: ${CONFIG_DIR}`)}${border}
║                                                              ║
║  Usage with Claude Code:                                     ║
${border}    ${align4(`export ANTHROPIC_BASE_URL=http://localhost:${PORT}`)}${border}
${border}    ${align4(`export ANTHROPIC_API_KEY=${config.apiKey || 'dummy'}`)}${border}
║    claude                                                    ║
║                                                              ║
║  Add Google accounts:                                        ║
║    npm run accounts                                          ║
║                                                              ║
║  Prerequisites (if no accounts configured):                  ║
║    - Antigravity must be running                             ║
║    - Have a chat panel open in Antigravity                   ║
║                                                              ║
${environmentSection}
╚══════════════════════════════════════════════════════════════╝
  `);

    logger.success(`Server started successfully on port ${PORT}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !config.webuiPassword) {
        logger.warn('[Security] No WebUI password set: the WebUI only answers this machine. Set WEBUI_PASSWORD to use it from other devices. The /v1 API is not affected.');
    }
    if (isDebug) {
        logger.warn('Running in DEVELOPER mode - verbose logs enabled');
    }
});

// Graceful shutdown
const shutdown = () => {
    logger.info('Shutting down server...');
    server.close(() => {
        logger.success('Server stopped');
        process.exit(0);
    });

    // Force close if it takes too long
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);