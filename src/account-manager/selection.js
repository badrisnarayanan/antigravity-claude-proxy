/**
 * Account Selection
 *
 * Handles account picking logic (round-robin, sticky) for cache continuity.
 * All rate limit checks are model-specific.
 *
 * Load balancing strategy:
 * - Within a conversation: stay on same account (cache continuity)
 * - New conversations: rotate to next available account (load distribution)
 */

import {
  MAX_WAIT_BEFORE_ERROR_MS,
  STICKY_COOLDOWN_THRESHOLD_MS,
  MAX_CONCURRENT_REQUESTS,
} from "../constants.js";
import { formatDuration } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { clearExpiredLimits, getAvailableAccounts } from "./rate-limits.js";

/**
 * Check if an account is usable for a specific model
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if account is usable
 */
function isAccountUsable(account, modelId) {
  if (!account || account.isInvalid) return false;

  // WebUI: Skip disabled accounts
  if (account.enabled === false) return false;

  // Check concurrency limit
  if ((account.activeRequests || 0) >= MAX_CONCURRENT_REQUESTS) return false;

  if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
    const limit = account.modelRateLimits[modelId];
    if (limit.isRateLimited && limit.resetTime > Date.now()) {
      return false;
    }
  }

  return true;
}

/**
 * Pick the next available account (fallback when current is unavailable).
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @returns {{account: Object|null, newIndex: number}} The next available account and new index
 */
export function pickNext(accounts, currentIndex, onSave, modelId = null) {
  clearExpiredLimits(accounts);

  const available = getAvailableAccounts(accounts, modelId);
  if (available.length === 0) {
    return { account: null, newIndex: currentIndex };
  }

  // Clamp index to valid range
  let index = currentIndex;
  if (index >= accounts.length) {
    index = 0;
  }

  // Find next available account starting from index AFTER current
  for (let i = 1; i <= accounts.length; i++) {
    const idx = (index + i) % accounts.length;
    const account = accounts[idx];

    if (isAccountUsable(account, modelId)) {
      account.lastUsed = Date.now();

      const position = idx + 1;
      const total = accounts.length;
      logger.info(
        `[AccountManager] Using account: ${account.email} (${position}/${total})`
      );

      // Trigger save (don't await to avoid blocking)
      if (onSave) onSave();

      return { account, newIndex: idx };
    }
  }

  return { account: null, newIndex: currentIndex };
}

/**
 * Get the current account without advancing the index (sticky selection).
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @returns {{account: Object|null, newIndex: number}} The current account and index
 */
export function getCurrentStickyAccount(
  accounts,
  currentIndex,
  onSave,
  modelId = null
) {
  clearExpiredLimits(accounts);

  if (accounts.length === 0) {
    return { account: null, newIndex: currentIndex };
  }

  // Clamp index to valid range
  let index = currentIndex;
  if (index >= accounts.length) {
    index = 0;
  }

  // Get current account directly (activeIndex = current account)
  const account = accounts[index];

  if (isAccountUsable(account, modelId)) {
    account.lastUsed = Date.now();
    // Trigger save (don't await to avoid blocking)
    if (onSave) onSave();
    return { account, newIndex: index };
  }

  return { account: null, newIndex: index };
}

/**
 * Check if we should wait for the current account's rate limit to reset.
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {string} [modelId] - Model ID to check rate limits for
 * @returns {{shouldWait: boolean, waitMs: number, account: Object|null}}
 */
export function shouldWaitForCurrentAccount(
  accounts,
  currentIndex,
  modelId = null
) {
  if (accounts.length === 0) {
    return { shouldWait: false, waitMs: 0, account: null };
  }

  // Clamp index to valid range
  let index = currentIndex;
  if (index >= accounts.length) {
    index = 0;
  }

  // Get current account directly (activeIndex = current account)
  const account = accounts[index];

  if (!account || account.isInvalid) {
    return { shouldWait: false, waitMs: 0, account: null };
  }

  let waitMs = 0;

  // Check model-specific limit
  if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
    const limit = account.modelRateLimits[modelId];
    if (limit.isRateLimited && limit.resetTime) {
      waitMs = limit.resetTime - Date.now();
    }
  }

  // If wait time is within threshold, recommend waiting
  if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
    return { shouldWait: true, waitMs, account };
  }

  return { shouldWait: false, waitMs: 0, account };
}

/**
 * Pick an account with sticky selection preference.
 * Prefers the current account for cache continuity.
 *
 * @param {Array} accounts - Array of account objects
 * @param {number} currentIndex - Current account index
 * @param {Function} onSave - Callback to save changes
 * @param {string} [modelId] - Model ID to check rate limits for
 * @param {string} [sessionId] - Current session ID
 * @param {Map} [sessionMap] - Map of sessionId -> accountEmail
 * @returns {{account: Object|null, waitMs: number, newIndex: number}}
 */
export function pickStickyAccount(
  accounts,
  currentIndex,
  onSave,
  modelId = null,
  sessionId = null,
  sessionMap = null
) {
  let stickyAccount = null;
  let stickyIndex = -1;

  // 1. Try to find mapped account for this session
  if (sessionId && sessionMap && sessionMap.has(sessionId)) {
    const email = sessionMap.get(sessionId);
    const index = accounts.findIndex(a => a.email === email);

    if (index !== -1) {
      const account = accounts[index];
      // Check if it's usable
      if (isAccountUsable(account, modelId)) {
        stickyAccount = account;
        stickyIndex = index;
      } else {
        // Mapped account is unusable (rate limited/invalid)
        // We must switch.
        logger.debug(`[AccountManager] Mapped account ${email} is unusable, switching.`);
      }
    }
  }

  // 2. If mapped account is found and usable, use it
  if (stickyAccount) {
    stickyAccount.lastUsed = Date.now();
    if (onSave) onSave();
    return { account: stickyAccount, waitMs: 0, newIndex: currentIndex };
  }

  // 3. Fallback: Pick NEXT available account (Round Robin)
  // This balances load for new sessions or when sticky account fails
  const { account: nextAccount, newIndex } = pickNext(
    accounts,
    currentIndex,
    onSave,
    modelId
  );

  if (nextAccount) {
    if (sessionId && sessionMap) {
      sessionMap.set(sessionId, nextAccount.email);
      logger.info(`[AccountManager] Assigned session ${sessionId.substring(0,8)}... to ${nextAccount.email}`);
    }
    return { account: nextAccount, waitMs: 0, newIndex };
  }

  // 4. No accounts available at all?
  // Check if we should wait for the *originally mapped* account if it exists
  if (sessionId && sessionMap && sessionMap.has(sessionId)) {
     const email = sessionMap.get(sessionId);
     const index = accounts.findIndex(a => a.email === email);
     if (index !== -1) {
         const account = accounts[index];
         const waitInfo = shouldWaitForCurrentAccount(accounts, index, modelId);
         if (waitInfo.shouldWait) {
             return { account: null, waitMs: waitInfo.waitMs, newIndex: currentIndex };
         }
     }
  }

  // Last resort: check global current index wait time
  const waitInfo = shouldWaitForCurrentAccount(accounts, currentIndex, modelId);
  return { account: null, waitMs: waitInfo.waitMs, newIndex: currentIndex };
}
