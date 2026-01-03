/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

import app from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import path from 'path';
import os from 'os';

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || process.env.DEBUG === 'true';

// Initialize logger
logger.setDebug(isDebug);

if (isDebug) {
    logger.debug('Debug mode enabled');
}

const PORT = process.env.PORT || DEFAULT_PORT;

// Home directory for account storage
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.antigravity-claude-proxy');

app.listen(PORT, () => {
    // Clear console for a clean start
    console.clear();

    const width = 62;
    const border = '║';
    const align = (text) => text + ' '.repeat(Math.max(0, width - text.length));
    
    // Build Control section dynamically
    let controlSection = '║  Control:                                                    ║\n';
    if (!isDebug) {
        controlSection += '║    --debug            Enable debug logging                   ║\n';
    }
    controlSection += '║    Ctrl+C             Stop server                            ║';

    // Build status section if debug mode is active
    let statusSection = '';
    if (isDebug) {
        statusSection = '║                                                              ║\n';
        statusSection += '║  Active Modes:                                               ║\n';
        statusSection += '║    ✓ Debug mode enabled                                      ║\n';
    }

    logger.log(`
╔══════════════════════════════════════════════════════════════╗
║           Antigravity Claude Proxy Server                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${border}  ${align(`Server running at: http://localhost:${PORT}`)}${border}
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
${border}    ${align(`Storage: ${CONFIG_DIR}`)}${border}
║                                                              ║
║  Usage with Claude Code:                                     ║
${border}    ${align(`export ANTHROPIC_BASE_URL=http://localhost:${PORT}`)}${border}
║    export ANTHROPIC_API_KEY=dummy                            ║
║    claude                                                    ║
║                                                              ║
║  Add Google accounts:                                        ║
║    npm run accounts                                          ║
║                                                              ║
║  Prerequisites (if no accounts configured):                  ║
║    - Antigravity must be running                             ║
║    - Have a chat panel open in Antigravity                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
    
    logger.success(`Server started successfully on port ${PORT}`);
    if (isDebug) {
        logger.warn('Running in DEBUG mode - verbose logs enabled');
    }
});
