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
  accounts              Manage Google accounts (interactive)
  accounts add          Add a new Google account via OAuth
  accounts list         List all configured accounts
  accounts remove       Remove accounts interactively
  accounts verify       Verify account tokens are valid
  accounts clear        Remove all accounts

OPTIONS:
  --port, -p <port>     Set the server port
  --help, -h            Show this help message
  --version, -v         Show version number

ENVIRONMENT:
  PORT                  Server port (default: 8080)

EXAMPLES:
  antigravity-claude-proxy start --port 9000
  PORT=3000 antigravity-claude-proxy start
  antigravity-claude-proxy accounts add
  antigravity-claude-proxy accounts list

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
      await import('../src/accounts-cli.js');
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
