/**
 * WebUI Module - Optional web interface for account management
 *
 * This module provides a web-based UI for:
 * - Dashboard with real-time model quota visualization
 * - Account management (add via OAuth, enable/disable, refresh, remove)
 * - Live server log streaming with filtering
 * - Claude CLI configuration editor
 *
 * Usage in server.js:
 *   import { mountWebUI } from './webui/index.js';
 *   mountWebUI(app, __dirname, accountManager);
 */

import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import express from "express";
import fs from "fs";
import crypto from "crypto";
import { getPublicConfig, saveConfig, config } from "../config.js";
import { DEFAULT_PORT, ANTIGRAVITY_AUTH_PORT } from "../constants.js";
import { logger } from "../utils/logger.js";
import {
  readClaudeConfig,
  updateClaudeConfig,
  replaceClaudeConfig,
  getClaudeConfigPath,
} from "../utils/claude-config.js";
import {
  getAuthorizationUrl,
  startCallbackServer,
  completeOAuthFlow,
} from "../auth/oauth.js";

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let packageVersion = "1.0.0";
try {
  const packageJsonPath = path.join(__dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  packageVersion = packageJson.version;
} catch (error) {
  logger.warn("[WebUI] Could not read package.json version, using default");
}

// OAuth state storage (state -> { server, verifier, state, timestamp })
// Maps state ID to active OAuth flow data
const pendingOAuthFlows = new Map();

// Rate limiting for auth attempts (IP -> { count, lockedUntil })
const authAttempts = new Map();
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000; // 15 mins

/**
 * Authentication Middleware
 * Protects routes with Basic Auth based on password in config
 */
export function createAuthMiddleware() {
  return (req, res, next) => {
    // If no password set, everything is open
    if (!config.webuiPassword) {
      return next();
    }

    // Check rate limit
    const ip = req.ip;
    const now = Date.now();
    const state = authAttempts.get(ip);

    if (state && state.lockedUntil > now) {
      const waitMinutes = Math.ceil((state.lockedUntil - now) / 60000);
      return res.status(429).json({
        error: {
          type: "rate_limit_error",
          message: `Too many failed attempts. Try again in ${waitMinutes} minutes.`,
        },
      });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Antigravity WebUI"');
      return res.sendStatus(401);
    }

    const auth = Buffer.from(authHeader.split(" ")[1], "base64")
      .toString()
      .split(":");
    const pass = auth[1];

    if (pass === config.webuiPassword) {
      // Reset attempts on success
      authAttempts.delete(ip);
      next();
    } else {
      // Record failed attempt
      const attempts = (state?.count || 0) + 1;
      if (attempts >= MAX_AUTH_ATTEMPTS) {
        authAttempts.set(ip, {
          count: attempts,
          lockedUntil: now + AUTH_LOCKOUT_MS,
        });
        logger.warn(
          `[Auth] IP ${ip} locked out after ${attempts} failed attempts`
        );
      } else {
        authAttempts.set(ip, { count: attempts, lockedUntil: 0 });
      }
      res.setHeader("WWW-Authenticate", 'Basic realm="Antigravity WebUI"');
      return res.sendStatus(401);
    }
  };
}

/**
 * Mount WebUI routes and middleware on Express app
 * @param {Express} app - Express application instance
 * @param {string} dirname - __dirname of the calling module (for static file path)
 * @param {AccountManager} accountManager - Account manager instance
 */
export function mountWebUI(app, dirname, accountManager) {
  // Apply auth middleware
  app.use(createAuthMiddleware());

  // Serve static files from public directory
  app.use(express.static(path.join(dirname, "../public")));

  // Periodic cleanup of stale OAuth flows (every minute)
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, val] of pendingOAuthFlows.entries()) {
      if (now - val.timestamp > 10 * 60 * 1000) {
        // 10 minutes
        pendingOAuthFlows.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[WebUI] Cleaned up ${cleaned} stale OAuth flows`);
    }
  }, 60000);

  // ==========================================
  // Account Management API
  // ==========================================

  /**
   * GET /api/accounts - List all accounts with status
   */
  app.get("/api/accounts", async (req, res) => {
    try {
      const status = accountManager.getStatus();
      res.json({
        status: "ok",
        accounts: status.accounts,
        summary: {
          total: status.total,
          available: status.available,
          rateLimited: status.rateLimited,
          invalid: status.invalid,
        },
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/accounts/:email/refresh - Refresh specific account token
   */
  app.post("/api/accounts/:email/refresh", async (req, res) => {
    try {
      const { email } = req.params;
      accountManager.clearTokenCache(email);
      accountManager.clearProjectCache(email);
      res.json({
        status: "ok",
        message: `Token cache cleared for ${email}`,
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/accounts/:email/toggle - Enable/disable account
   */
  app.post("/api/accounts/:email/toggle", async (req, res) => {
    try {
      const { email } = req.params;
      const { enabled } = req.body;
      await accountManager.toggleAccount(email, enabled);
      res.json({
        status: "ok",
        message: `Account ${email} ${enabled ? "enabled" : "disabled"}`,
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * DELETE /api/accounts/:email - Remove account
   */
  app.delete("/api/accounts/:email", async (req, res) => {
    try {
      const { email } = req.params;
      await accountManager.removeAccount(email);

      res.json({
        status: "ok",
        message: `Account ${email} removed`,
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/accounts/reload - Reload accounts from disk
   */
  app.post("/api/accounts/reload", async (req, res) => {
    try {
      // Reload AccountManager from disk
      await accountManager.reload();

      const status = accountManager.getStatus();
      res.json({
        status: "ok",
        message: "Accounts reloaded from disk",
        summary: status.summary,
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  // ==========================================
  // Configuration API
  // ==========================================

  /**
   * GET /api/config - Get server configuration
   */
  app.get("/api/config", (req, res) => {
    try {
      const publicConfig = getPublicConfig();
      res.json({
        status: "ok",
        config: publicConfig,
        version: packageVersion,
        note: "Edit ~/.config/antigravity-proxy/config.json or use env vars to change these values",
      });
    } catch (error) {
      logger.error("[WebUI] Error getting config:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/config - Update server configuration
   */
  app.post("/api/config", (req, res) => {
    try {
      const {
        debug,
        logLevel,
        maxRetries,
        retryBaseMs,
        retryMaxMs,
        persistTokenCache,
        defaultCooldownMs,
        maxWaitBeforeErrorMs,
        geminiHeaderMode,
      } = req.body;

      // Only allow updating specific fields (security)
      const updates = {};
      if (typeof debug === "boolean") updates.debug = debug;
      if (logLevel && ["info", "warn", "error", "debug"].includes(logLevel)) {
        updates.logLevel = logLevel;
      }
      if (
        typeof maxRetries === "number" &&
        maxRetries >= 1 &&
        maxRetries <= 20
      ) {
        updates.maxRetries = maxRetries;
      }
      if (
        typeof retryBaseMs === "number" &&
        retryBaseMs >= 100 &&
        retryBaseMs <= 10000
      ) {
        updates.retryBaseMs = retryBaseMs;
      }
      if (
        typeof retryMaxMs === "number" &&
        retryMaxMs >= 1000 &&
        retryMaxMs <= 120000
      ) {
        updates.retryMaxMs = retryMaxMs;
      }
      if (typeof persistTokenCache === "boolean") {
        updates.persistTokenCache = persistTokenCache;
      }
      if (
        typeof defaultCooldownMs === "number" &&
        defaultCooldownMs >= 1000 &&
        defaultCooldownMs <= 300000
      ) {
        updates.defaultCooldownMs = defaultCooldownMs;
      }
      if (
        typeof maxWaitBeforeErrorMs === "number" &&
        maxWaitBeforeErrorMs >= 0 &&
        maxWaitBeforeErrorMs <= 600000
      ) {
        updates.maxWaitBeforeErrorMs = maxWaitBeforeErrorMs;
      }
      if (
        geminiHeaderMode &&
        ["cli", "antigravity"].includes(geminiHeaderMode)
      ) {
        updates.geminiHeaderMode = geminiHeaderMode;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          status: "error",
          error: "No valid configuration updates provided",
        });
      }

      const success = saveConfig(updates);

      if (success) {
        res.json({
          status: "ok",
          message: "Configuration updated",
          config: {
            webuiPassword: config.webuiPassword ? "******" : "",
            debug: config.debug,
            logLevel: config.logLevel,
            maxRetries: config.maxRetries,
            retryBaseMs: config.retryBaseMs,
            retryMaxMs: config.retryMaxMs,
            maxContextTokens: config.maxContextTokens,
            geminiHeaderMode: config.geminiHeaderMode,
          },
        });
      } else {
        res.status(500).json({
          status: "error",
          error: "Failed to save configuration",
        });
      }
    } catch (error) {
      logger.error("[WebUI] Error updating config:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/config/password - Change WebUI password
   */
  app.post("/api/config/password", (req, res) => {
    try {
      const { oldPassword, newPassword } = req.body;

      // Validate input
      if (!newPassword || typeof newPassword !== "string") {
        return res.status(400).json({
          status: "error",
          error: "New password is required",
        });
      }

      // If current password exists, verify old password
      if (config.webuiPassword && config.webuiPassword !== oldPassword) {
        return res.status(403).json({
          status: "error",
          error: "Invalid current password",
        });
      }

      // Save new password
      const success = saveConfig({ webuiPassword: newPassword });

      if (success) {
        // Update in-memory config
        config.webuiPassword = newPassword;
        res.json({
          status: "ok",
          message: "Password changed successfully",
        });
      } else {
        throw new Error("Failed to save password to config file");
      }
    } catch (error) {
      logger.error("[WebUI] Error changing password:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * GET /api/settings - Get runtime settings
   */
  app.get("/api/settings", async (req, res) => {
    try {
      const settings = accountManager.getSettings
        ? accountManager.getSettings()
        : {};
      res.json({
        status: "ok",
        settings: {
          ...settings,
          port: process.env.PORT || DEFAULT_PORT,
        },
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  // ==========================================
  // Claude CLI Configuration API
  // ==========================================

  /**
   * GET /api/claude/config - Get Claude CLI configuration
   */
  app.get("/api/claude/config", async (req, res) => {
    try {
      const claudeConfig = await readClaudeConfig();
      res.json({
        status: "ok",
        config: claudeConfig,
        path: getClaudeConfigPath(),
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/claude/config - Update Claude CLI configuration
   */
  app.post("/api/claude/config", async (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        return res
          .status(400)
          .json({ status: "error", error: "Invalid config updates" });
      }

      const newConfig = await updateClaudeConfig(updates);
      res.json({
        status: "ok",
        config: newConfig,
        message: "Claude configuration updated",
      });
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/claude/config/restore - Restore Claude CLI to default (remove proxy settings)
   */
  app.post("/api/claude/config/restore", async (req, res) => {
    try {
      const claudeConfig = await readClaudeConfig();

      // Proxy-related environment variables to remove when restoring defaults
      const PROXY_ENV_VARS = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ENABLE_EXPERIMENTAL_MCP_CLI",
      ];

      // Remove proxy-related environment variables to restore defaults
      if (claudeConfig.env) {
        for (const key of PROXY_ENV_VARS) {
          delete claudeConfig.env[key];
        }
        // Remove env entirely if empty to truly restore defaults
        if (Object.keys(claudeConfig.env).length === 0) {
          delete claudeConfig.env;
        }
      }

      // Use replaceClaudeConfig to completely overwrite the config (not merge)
      const newConfig = await replaceClaudeConfig(claudeConfig);

      logger.info(
        `[WebUI] Restored Claude CLI config to defaults at ${getClaudeConfigPath()}`
      );

      res.json({
        status: "ok",
        config: newConfig,
        message: "Claude CLI configuration restored to defaults",
      });
    } catch (error) {
      logger.error("[WebUI] Error restoring Claude config:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * POST /api/models/config - Update model configuration (hidden/pinned/alias)
   */
  app.post("/api/models/config", (req, res) => {
    try {
      const { modelId, config: newModelConfig } = req.body;

      if (!modelId || typeof newModelConfig !== "object") {
        return res
          .status(400)
          .json({ status: "error", error: "Invalid parameters" });
      }

      // Validate modelId format (alphanumeric, dashes, underscores, dots only)
      if (!/^[a-zA-Z0-9._-]+$/.test(modelId)) {
        return res
          .status(400)
          .json({ status: "error", error: "Invalid model ID format" });
      }

      // Sanitize config - only allow specific keys with validated types
      const allowedKeys = ["hidden", "pinned", "mapping", "alias"];
      const sanitizedConfig = {};
      for (const key of allowedKeys) {
        if (key in newModelConfig) {
          const value = newModelConfig[key];
          // Validate types
          if (
            (key === "hidden" || key === "pinned") &&
            typeof value === "boolean"
          ) {
            sanitizedConfig[key] = value;
          } else if (
            (key === "mapping" || key === "alias") &&
            (typeof value === "string" || value === null)
          ) {
            // Validate mapping/alias format if provided
            if (value !== null && !/^[a-zA-Z0-9._-]*$/.test(value)) {
              return res
                .status(400)
                .json({ status: "error", error: `Invalid ${key} format` });
            }
            sanitizedConfig[key] = value;
          }
        }
      }

      if (Object.keys(sanitizedConfig).length === 0) {
        return res.status(400).json({
          status: "error",
          error: "No valid configuration fields provided",
        });
      }

      // Load current config
      const currentMapping = config.modelMapping || {};

      // Update specific model config
      currentMapping[modelId] = {
        ...currentMapping[modelId],
        ...sanitizedConfig,
      };

      // Save back to main config
      const success = saveConfig({ modelMapping: currentMapping });

      if (success) {
        // Update in-memory config reference
        config.modelMapping = currentMapping;
        res.json({ status: "ok", modelConfig: currentMapping[modelId] });
      } else {
        throw new Error("Failed to save configuration");
      }
    } catch (error) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  // ==========================================
  // Logs API
  // ==========================================

  /**
   * GET /api/logs - Get log history
   */
  app.get("/api/logs", (req, res) => {
    res.json({
      status: "ok",
      logs: logger.getHistory ? logger.getHistory() : [],
    });
  });

  /**
   * GET /api/logs/stream - Stream logs via SSE
   */
  app.get("/api/logs/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendLog = (log) => {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    };

    // Send recent history if requested
    if (req.query.history === "true" && logger.getHistory) {
      const history = logger.getHistory();
      history.forEach((log) => sendLog(log));
    }

    // Subscribe to new logs
    if (logger.on) {
      logger.on("log", sendLog);
    }

    // Cleanup on disconnect
    req.on("close", () => {
      if (logger.off) {
        logger.off("log", sendLog);
      }
    });
  });

  // ==========================================
  // OAuth API
  // ==========================================

  /**
   * GET /api/auth/url - Get OAuth URL to start the flow
   * Uses CLI's OAuth flow (localhost:51121) instead of WebUI's port
   * to match Google OAuth Console's authorized redirect URIs
   */
  app.get("/api/auth/url", async (req, res) => {
    try {
      // Clean up old flows (> 10 mins)
      const now = Date.now();
      for (const [key, val] of pendingOAuthFlows.entries()) {
        if (now - val.timestamp > 10 * 60 * 1000) {
          pendingOAuthFlows.delete(key);
        }
      }

      // Generate OAuth URL using default redirect URI (localhost:51121)
      const { url, verifier, state } = getAuthorizationUrl();

      // Start callback server on port 51121 (same as CLI)
      const serverPromise = startCallbackServer(state, 120000); // 2 min timeout

      // Store the flow data
      pendingOAuthFlows.set(state, {
        serverPromise,
        verifier,
        state,
        timestamp: Date.now(),
      });

      // Start async handler for the OAuth callback
      serverPromise
        .then(async (code) => {
          try {
            logger.info("[WebUI] Received OAuth callback, completing flow...");
            const accountData = await completeOAuthFlow(code, verifier);

            // Add or update the account
            await accountManager.addAccount({
              email: accountData.email,
              refreshToken: accountData.refreshToken,
              projectId: accountData.projectId,
              source: "oauth",
            });

            logger.success(
              `[WebUI] Account ${accountData.email} added successfully`
            );
          } catch (err) {
            logger.error("[WebUI] OAuth flow completion error:", err);
          } finally {
            pendingOAuthFlows.delete(state);
          }
        })
        .catch((err) => {
          logger.error("[WebUI] OAuth callback server error:", err);
          pendingOAuthFlows.delete(state);
        });

      res.json({ status: "ok", url, state });
    } catch (error) {
      logger.error("[WebUI] Error generating auth URL:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  /**
   * GET /api/auth/status/:state - Poll OAuth flow status
   * Allows frontend to check if OAuth flow completed or failed
   */
  app.get("/api/auth/status/:state", (req, res) => {
    const flow = pendingOAuthFlows.get(req.params.state);

    if (!flow) {
      // Flow doesn't exist - either completed, expired, or never existed
      return res.json({
        status: "not_found",
        message: "OAuth flow not found or already completed",
      });
    }

    // Flow exists and is still pending
    const elapsed = Date.now() - flow.timestamp;
    const remainingMs = Math.max(0, 120000 - elapsed); // 2 minute timeout

    res.json({
      status: "pending",
      elapsedMs: elapsed,
      remainingMs: remainingMs,
    });
  });

  /**
   * Note: /oauth/callback route removed
   * OAuth callbacks are now handled by the temporary server on port 51121
   * (same as CLI) to match Google OAuth Console's authorized redirect URIs
   */

  logger.info("[WebUI] Mounted at /");
}
