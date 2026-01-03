#!/usr/bin/env node

/**
 * Reset Trigger CLI
 *
 * CLI tool to trigger the 5-hour quota reset timer for all accounts.
 * Sends minimal API requests to consume a tiny bit of quota and start
 * the countdown timer.
 *
 * Usage:
 *   node src/cli/reset-trigger.js           # Trigger reset for all accounts now
 *   node src/cli/reset-trigger.js --help    # Show help
 */

import net from 'net';
import { AccountManager } from '../account-manager/index.js';
import {
    triggerResetForAllAccounts,
    formatTriggerResults
} from '../cloudcode/reset-trigger.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_PORT } from '../constants.js';

const SERVER_PORT = process.env.PORT || DEFAULT_PORT;

/**
 * Check if the Antigravity Proxy server is running
 * Returns true if port is occupied
 */
function isServerRunning() {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true); // Server is running
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(false); // Port free
        });

        socket.connect(SERVER_PORT, 'localhost');
    });
}

/**
 * Main CLI function
 */
async function main() {
    const args = process.argv.slice(2);

    // Handle help flag
    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }

    // Enable debug mode if requested
    if (args.includes('--debug')) {
        logger.setDebug(true);
    }

    console.log('╔════════════════════════════════════════╗');
    console.log('║    Antigravity Reset Trigger           ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');

    // Check if server is running - warn user that lastUsed updates may be overwritten
    const serverRunning = await isServerRunning();
    if (serverRunning) {
        console.log('\x1b[33m⚠ Warning: Proxy server is running on port ' + SERVER_PORT + '\x1b[0m');
        console.log('\x1b[33m  The server may overwrite lastUsed timestamps when it saves state.\x1b[0m');
        console.log('\x1b[33m  For accurate lastUsed tracking, stop the server first or use the\x1b[0m');
        console.log('\x1b[33m  /trigger-reset API endpoint instead.\x1b[0m');
        console.log('');
    }

    console.log('This will send minimal API requests to all accounts to');
    console.log('trigger the 5-hour quota reset countdown timer.');
    console.log('');

    try {
        // Initialize account manager
        const accountManager = new AccountManager();
        await accountManager.initialize();

        const accountCount = accountManager.getAccountCount();

        if (accountCount === 0) {
            console.log('No accounts configured.');
            console.log('Run "antigravity-claude-proxy accounts add" to add accounts first.');
            process.exit(1);
        }

        console.log(`Found ${accountCount} account(s). Triggering reset timers...`);
        console.log('');

        // Trigger resets
        const results = await triggerResetForAllAccounts(accountManager);

        // Display results
        console.log(formatTriggerResults(results));

        // Exit with error code if any failed
        const allSuccessful = results.every(r => r.status === 'ok');
        process.exit(allSuccessful ? 0 : 1);

    } catch (error) {
        console.error(`\nError: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Show help message
 */
function showHelp() {
    console.log(`
Reset Trigger - Trigger 5-hour quota reset for all accounts

USAGE:
  antigravity-claude-proxy trigger-reset [options]
  node src/cli/reset-trigger.js [options]

DESCRIPTION:
  Sends minimal API requests to all configured accounts to trigger
  the 5-hour quota reset countdown timer. This is useful for:

  1. Starting the reset timer at a specific time so quotas reset
     predictably (e.g., trigger at 9 PM so quotas reset at 2 AM)

  2. Ensuring all accounts start their reset timers together for
     synchronized quota availability

  The requests use minimal tokens (just "Hi" with 1 max output token)
  to consume as little quota as possible while still triggering the
  reset timer.

OPTIONS:
  --help, -h     Show this help message
  --debug        Enable debug logging

QUOTA GROUPS TRIGGERED:
  Each account has 3 independent quota groups with separate reset timers:

  1. Claude Group
     - claude-sonnet-4-5-thinking, claude-opus-4-5-thinking
     - claude-sonnet-4-5, GPT-OSS 120B
     - Triggering ANY model resets the timer for ALL models in this group

  2. Gemini Pro Group
     - gemini-3-pro-high, gemini-3-pro-low
     - Triggering either model resets both

  3. Gemini Flash Group
     - gemini-3-flash (separate from Pro)

EXAMPLES:
  # Trigger reset now
  antigravity-claude-proxy trigger-reset

  # Schedule daily reset trigger at 9 PM using cron
  0 21 * * * antigravity-claude-proxy trigger-reset

  # With debug output
  antigravity-claude-proxy trigger-reset --debug
`);
}

main().catch(console.error);
