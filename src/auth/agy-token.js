/**
 * Antigravity CLI (`agy`) token reader
 *
 * The standalone Antigravity CLI (`agy`, Google's Gemini/Antigravity coding
 * agent) stores its Google OAuth token separately from the Antigravity IDE.
 * Instead of the IDE's SQLite `state.vscdb`, `agy` writes a plain JSON bundle:
 *
 *   ~/.gemini/antigravity-cli/antigravity-oauth-token
 *   {
 *     "token": {
 *       "access_token":  "ya29....",
 *       "token_type":    "Bearer",
 *       "refresh_token": "1//0c....",
 *       "expiry":        "2026-07-14T11:59:37.185+03:00"
 *     },
 *     "auth_method": "consumer"
 *   }
 *
 * Crucially, `agy` uses the SAME Google OAuth client_id + client_secret that
 * this proxy already hardcodes in `OAUTH_CONFIG` (constants.js). Google only
 * lets the issuing client refresh a refresh_token, so the proxy can refresh
 * `agy`'s refresh_token directly — no separate browser OAuth flow and no full
 * Antigravity IDE install required. This mirrors how third-party Claude tools
 * reuse Claude Code's `~/.claude/.credentials.json`.
 *
 * This module is read-only by default. Optional write-back (so the `agy` CLI
 * also sees a freshly refreshed access token) is gated behind
 * AGY_TOKEN_WRITEBACK=1 to avoid racing with a running `agy` session.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

/**
 * Resolve the path to the agy CLI OAuth token file.
 * Priority: explicit arg > AGY_TOKEN_PATH env > GEMINI_HOME env > default.
 *
 * @param {string} [customPath] - Explicit path override (per-account)
 * @returns {string} Absolute path to the agy token file
 */
export function getAgyTokenPath(customPath) {
    if (customPath) return customPath;
    if (process.env.AGY_TOKEN_PATH) return process.env.AGY_TOKEN_PATH;
    const geminiHome = process.env.GEMINI_HOME || join(homedir(), '.gemini');
    return join(geminiHome, 'antigravity-cli', 'antigravity-oauth-token');
}

/**
 * Read and parse the agy CLI OAuth token file.
 * Tolerates both the wrapped `{ token: {...}, auth_method }` shape and a flat
 * `{ access_token, refresh_token, expiry }` shape.
 *
 * @param {string} [customPath] - Explicit path override
 * @returns {{accessToken: string|null, refreshToken: string|null, expiryMs: number|null, authMethod: string|null, path: string}|null}
 *          Parsed token info, or null if the file is missing/unreadable.
 */
export function readAgyToken(customPath) {
    const path = getAgyTokenPath(customPath);
    if (!existsSync(path)) {
        return null;
    }
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        const t = raw && typeof raw.token === 'object' && raw.token ? raw.token : raw;

        const accessToken = t.access_token || null;
        const refreshToken = t.refresh_token || null;

        let expiryMs = null;
        if (t.expiry) {
            const parsed = Date.parse(t.expiry);
            if (!Number.isNaN(parsed)) expiryMs = parsed;
        } else if (typeof t.expiry_date === 'number') {
            // google-auth-library style (ms since epoch)
            expiryMs = t.expiry_date;
        }

        return {
            accessToken,
            refreshToken,
            expiryMs,
            authMethod: raw.auth_method || t.auth_method || null,
            path
        };
    } catch (error) {
        logger.warn(`[AgyToken] Failed to read/parse agy token at ${path}: ${error.message}`);
        return null;
    }
}

/**
 * Whether an access token is still usable, with a safety margin.
 *
 * @param {number|null} expiryMs - Absolute expiry time in ms since epoch
 * @param {number} [marginMs=60000] - Treat as expired this long before actual expiry
 * @returns {boolean} True if the token is present-in-time and safe to use
 */
export function isAgyAccessTokenFresh(expiryMs, marginMs = 60_000) {
    if (!expiryMs) return false;
    return expiryMs - Date.now() > marginMs;
}

/**
 * Optionally write a freshly refreshed access token back into the agy token
 * file so a concurrently running `agy` CLI also benefits. No-op unless
 * AGY_TOKEN_WRITEBACK=1. Preserves the existing file structure (including the
 * refresh_token, which Google does not rotate on refresh) and writes atomically.
 *
 * @param {string|undefined} customPath - Explicit path override
 * @param {string} accessToken - New access token
 * @param {number} [expiresInSec] - Lifetime in seconds (from the token endpoint)
 */
export function writeAgyToken(customPath, accessToken, expiresInSec) {
    if (process.env.AGY_TOKEN_WRITEBACK !== '1') return;

    const path = getAgyTokenPath(customPath);
    try {
        let existing;
        if (existsSync(path)) {
            existing = JSON.parse(readFileSync(path, 'utf-8'));
        } else {
            existing = { token: {}, auth_method: 'consumer' };
        }
        if (!existing.token || typeof existing.token !== 'object') {
            existing.token = {};
        }

        existing.token.access_token = accessToken;
        existing.token.token_type = existing.token.token_type || 'Bearer';
        if (expiresInSec) {
            existing.token.expiry = new Date(Date.now() + expiresInSec * 1000).toISOString();
        }

        const tmp = path + '.tmp';
        writeFileSync(tmp, JSON.stringify(existing), { mode: 0o600 });
        renameSync(tmp, path);
        logger.debug('[AgyToken] Wrote refreshed access token back to agy token file');
    } catch (error) {
        logger.warn(`[AgyToken] Write-back failed: ${error.message}`);
    }
}

export default { getAgyTokenPath, readAgyToken, isAgyAccessTokenFresh, writeAgyToken };
