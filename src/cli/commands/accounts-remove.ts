/**
 * accounts remove command
 *
 * Remove accounts interactively.
 */

import { getLogger } from "../../utils/logger-new.js";

/**
 * Execute the accounts remove command.
 *
 * @param email - Optional email of account to remove
 */
export function accountsRemoveCommand(email?: string): void {
  const logger = getLogger();
  logger.info("accounts remove command - to be implemented");
  if (email) {
    logger.debug("target email: %s", email);
  }
}
