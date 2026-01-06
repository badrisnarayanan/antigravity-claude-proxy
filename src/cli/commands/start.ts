/**
 * start command
 *
 * Start the proxy server.
 */

import { getLogger } from "../../utils/logger-new.js";

/**
 * Command options for the start command.
 */
export interface StartCommandOptions {
  port?: number;
  fallback?: boolean;
  debug?: boolean;
}

/**
 * Execute the start command.
 *
 * @param options - Command options
 */
export function startCommand(options: StartCommandOptions): void {
  const logger = getLogger();
  logger.info("start command - to be implemented");
  logger.debug("options: %o", options);
}
