/**
 * accounts add command
 *
 * Add a new Google account via OAuth.
 */

import { getLogger } from "../../utils/logger-new.js";

/**
 * Execute the accounts add command.
 *
 * @param options - Command options
 */
export function accountsAddCommand(options: {
  noBrowser?: boolean;
  refreshToken?: boolean;
}): void {
  const logger = getLogger();
  logger.info("accounts add command - to be implemented");
  logger.debug("options: %o", options);
}
