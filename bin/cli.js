#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
antigravity-claude-proxy v${packageJson.version}

Proxy server for using Antigravity's Claude models with Claude Code CLI.

USAGE:
  antigravity-claude-proxy <command> [options]

COMMANDS:
  start                 Start the proxy server (default port: 8080)
  start --trigger-reset Start server and trigger 5hr quota reset
  accounts              Manage Google accounts (interactive)
  accounts add          Add a new Google account via OAuth
  accounts list         List all configured accounts
  accounts remove       Remove accounts interactively
  accounts verify       Verify account tokens are valid
  accounts clear        Remove all accounts
  trigger-reset         Trigger 5hr quota reset for all accounts

OPTIONS:
  --help, -h            Show this help message
  --version, -v         Show version number
  --debug               Enable debug logging
  --trigger-reset       Trigger quota reset on server startup

ENVIRONMENT:
  PORT                  Server port (default: 8080)
  TRIGGER_RESET=true    Trigger reset on startup

EXAMPLES:
  antigravity-claude-proxy start
  antigravity-claude-proxy start --trigger-reset
  PORT=3000 antigravity-claude-proxy start
  antigravity-claude-proxy accounts add
  antigravity-claude-proxy accounts list
  antigravity-claude-proxy trigger-reset

RESET TIMER:
  The quota resets 5 hours after first API usage. Use trigger-reset to:
  - Start the countdown at a predictable time (e.g., 9 PM for 2 AM reset)
  - Sync all account reset timers together
  - Schedule via cron: 0 21 * * * antigravity-claude-proxy trigger-reset

CONFIGURATION:
  Claude Code CLI (~/.claude/settings.json):
    {
      "env": {
        "ANTHROPIC_BASE_URL": "http://localhost:8080"
      }
    }
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
    case undefined:
      // Default to starting the server
      await import('../src/index.js');
      break;

    case 'accounts': {
      // Pass remaining args to accounts CLI
      const subCommand = args[1] || 'add';
      process.argv = ['node', 'accounts-cli.js', subCommand, ...args.slice(2)];
      await import('../src/cli/accounts.js');
      break;
    }

    case 'trigger-reset': {
      // Trigger quota reset for all accounts
      process.argv = ['node', 'reset-trigger.js', ...args.slice(1)];
      await import('../src/cli/reset-trigger.js');
      break;
    }

    case 'help':
      showHelp();
      break;

    case 'version':
      showVersion();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "antigravity-proxy --help" for usage information.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
