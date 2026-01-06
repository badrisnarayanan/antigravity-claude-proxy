/**
 * init command
 *
 * Setup wizard for initial configuration.
 */

import * as p from "@clack/prompts";
import { readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";

import { DEFAULT_PORT, ACCOUNT_CONFIG_PATH } from "../../constants.js";
import { loadAccounts } from "../../account-manager/storage.js";
import { accountsAddCommand } from "./accounts-add.js";
import { banner, keyValue, symbols } from "../ui.js";

// Resolve package.json path for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
const VERSION: string = packageJson.version;

/**
 * Log level options for the select prompt.
 */
const LOG_LEVEL_OPTIONS = [
  { value: "silent", label: "silent", hint: "no output at all" },
  { value: "error", label: "error", hint: "errors only" },
  { value: "warn", label: "warn", hint: "warnings and errors" },
  { value: "info", label: "info", hint: "general information (default)" },
  { value: "debug", label: "debug", hint: "detailed debugging info" },
  { value: "trace", label: "trace", hint: "everything including traces" },
] as const;

/**
 * Save option choices.
 */
const SAVE_OPTIONS = [
  { value: "none", label: "Don't save", hint: "just show the command" },
  { value: "env", label: "Create .env file", hint: "save as environment variables" },
  { value: "alias", label: "Show shell alias", hint: "display alias command" },
] as const;

/**
 * Configuration gathered during the wizard.
 */
interface WizardConfig {
  port: number;
  fallback: boolean;
  logLevel: string;
  logFile: string | null;
}

/**
 * Execute the init command.
 */
export async function initCommand(): Promise<void> {
  // Show banner
  console.log(banner("Antigravity Claude Proxy", VERSION, "Setup Wizard"));
  p.intro("Let's configure your proxy server");

  // Check existing accounts
  const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
  if (accounts.length > 0) {
    p.log.success(`${symbols.success} Found ${accounts.length} configured account(s)`);
  } else {
    p.log.warn(`${symbols.warning} No accounts configured yet`);
  }

  // Port configuration
  const portInput = await p.text({
    message: "Server port:",
    placeholder: String(DEFAULT_PORT),
    defaultValue: String(DEFAULT_PORT),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num)) return "Port must be a number";
      if (num < 1 || num > 65535) return "Port must be between 1 and 65535";
      return undefined;
    },
  });

  if (p.isCancel(portInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const port = parseInt(portInput, 10);

  // Model fallback toggle
  const fallbackChoice = await p.confirm({
    message: "Enable model fallback on quota exhaustion?",
    initialValue: false,
  });

  if (p.isCancel(fallbackChoice)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const fallback = fallbackChoice;

  // Log level selection
  const logLevelChoice = await p.select({
    message: "Log level:",
    options: LOG_LEVEL_OPTIONS.map((opt) => ({
      value: opt.value,
      label: opt.label,
      hint: opt.hint,
    })),
    initialValue: "info",
  });

  if (p.isCancel(logLevelChoice)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const logLevel = logLevelChoice;

  // Log file option
  const useLogFile = await p.confirm({
    message: "Write logs to a file?",
    initialValue: false,
  });

  if (p.isCancel(useLogFile)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let logFile: string | null = null;
  if (useLogFile) {
    const logFileInput = await p.text({
      message: "Log file path:",
      placeholder: "proxy.log",
      defaultValue: "proxy.log",
    });

    if (p.isCancel(logFileInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    logFile = logFileInput;
  }

  // Add account prompt (if no accounts exist)
  if (accounts.length === 0) {
    const addAccount = await p.confirm({
      message: "Would you like to add an account now?",
      initialValue: true,
    });

    if (p.isCancel(addAccount)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (addAccount) {
      await accountsAddCommand({});
    }
  }

  // Build configuration object
  const config: WizardConfig = {
    port,
    fallback,
    logLevel,
    logFile,
  };

  // Generate start command string
  const startCommand = buildStartCommand(config);

  // Summary display
  console.log(); // Add spacing
  p.log.info(pc.bold("Configuration Summary:"));
  console.log(
    keyValue({
      Port: String(config.port),
      Fallback: config.fallback ? "enabled" : "disabled",
      "Log Level": config.logLevel,
      "Log File": config.logFile ?? "none",
    })
  );

  // Display the start command in a note
  p.note(startCommand, "Start command");

  // Save option
  const saveChoice = await p.select({
    message: "How would you like to save this configuration?",
    options: SAVE_OPTIONS.map((opt) => ({
      value: opt.value,
      label: opt.label,
      hint: opt.hint,
    })),
  });

  if (p.isCancel(saveChoice)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  switch (saveChoice) {
    case "none":
      p.log.info("Run the command above to start the server.");
      break;

    case "env":
      await saveEnvFile(config);
      p.log.success(`${symbols.success} Created .env file`);
      p.log.info("Start the server with: npm start");
      break;

    case "alias":
      showShellAlias(startCommand);
      break;
  }

  p.outro("Setup complete!");
}

/**
 * Build the start command string based on configuration.
 */
function buildStartCommand(config: WizardConfig): string {
  const parts = ["npm start --"];

  if (config.port !== DEFAULT_PORT) {
    parts.push(`--port ${config.port}`);
  }

  if (config.fallback) {
    parts.push("--fallback");
  }

  if (config.logLevel !== "info") {
    parts.push(`--log-level ${config.logLevel}`);
  }

  if (config.logFile) {
    parts.push(`--log-file ${config.logFile}`);
  }

  return parts.join(" ");
}

/**
 * Save configuration as environment variables in .env file.
 */
async function saveEnvFile(config: WizardConfig): Promise<void> {
  const lines: string[] = [
    "# Antigravity Claude Proxy Configuration",
    `PORT=${config.port}`,
    `FALLBACK=${config.fallback ? "true" : "false"}`,
    `LOG_LEVEL=${config.logLevel}`,
  ];

  if (config.logFile) {
    lines.push(`LOG_FILE=${config.logFile}`);
  }

  await writeFile(".env", lines.join("\n") + "\n");
}

/**
 * Display shell alias command.
 */
function showShellAlias(startCommand: string): void {
  const alias = `alias acp='${startCommand}'`;
  p.note(alias, "Add this to your shell profile (.bashrc, .zshrc, etc.)");
}
