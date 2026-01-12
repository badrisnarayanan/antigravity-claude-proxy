/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import {
  sendMessage,
  sendMessageStream,
  listModels,
  getModelQuotas,
  getSubscriptionTier,
} from "./cloudcode/index.js";
import { mountWebUI } from "./webui/index.js";
import { config, loadConfig } from "./config.js";
import { forceRefresh } from "./auth/token-extractor.js";
import {
  REQUEST_BODY_LIMIT,
  DEFAULT_PORT,
  MODEL_FALLBACK_MAP,
} from "./constants.js";
import {
  requestIdMiddleware,
  contentTypeMiddleware,
  messagesValidationMiddleware,
  errorHandlerMiddleware,
} from "./middleware/index.js";
import {
  createModelsController,
  createSystemController,
  createMessagesController,
} from "./controllers/index.js";
import AccountManager from "./account-manager/index.js";
import { logger } from "./utils/logger.js";
import usageStats from "./modules/usage-stats.js";
import { formatDuration } from "./utils/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global state
let accountManager;
let server;
let initPromise = null;

/**
 * Initialize the system
 */
async function initialize() {
  loadConfig();
  logger.info("[Server] Configuration loaded");

  // Initialize account manager
  accountManager = new AccountManager(config.accountConfigPath);
  await accountManager.loadAccounts();
  await accountManager.initialize();

  logger.info(
    `[Server] Account manager initialized with ${accountManager.getAccountCount()} accounts`
  );

  return true;
}

/**
 * Ensure the system is initialized before handling requests
 */
async function ensureInitialized(req, res, next) {
  if (!initPromise) {
    initPromise = initialize().catch((err) => {
      logger.error("[Server] Initialization failed:", err);
      process.exit(1);
    });
  }

  try {
    await initPromise;
    if (next) next();
  } catch (error) {
    logger.error("[Server] Failed to ensure initialization:", error);
    if (res) {
      res.status(503).json({
        error: {
          type: "server_error",
          message: "Server failed to initialize",
        },
      });
    }
  }
}

// Parse fallback flag directly from command line args
const args = process.argv.slice(2);
const FALLBACK_ENABLED =
  args.includes("--fallback") || process.env.FALLBACK === "true";

const app = express();

// Basic Middleware
app.use(cors());
app.use(requestIdMiddleware);
app.use(
  express.json({
    limit: REQUEST_BODY_LIMIT,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(contentTypeMiddleware);

// Request Logging
app.use((req, res, next) => {
  if (req.path === "/api/event_logging/batch") {
    if (logger.isDebugEnabled) {
      logger.debug(`[${req.requestId}] ${req.method} ${req.path}`);
    }
  } else if (req.path !== "/health") {
    logger.info(`[${req.requestId}] ${req.method} ${req.path}`);
  }
  next();
});

// Serve WebUI static files
// Only mount if WebUI is enabled (default true)
// Note: WebUI mounting happens before API routes to avoid conflicts if we ever have root routes
mountWebUI(app, __dirname, accountManager);

/**
 * Validate the fallback map for cycles at startup
 */
function validateFallbackMap() {
  for (const [model, fallback] of Object.entries(MODEL_FALLBACK_MAP)) {
    const visited = new Set([model]);
    let current = fallback;

    while (current && MODEL_FALLBACK_MAP[current]) {
      if (visited.has(current)) {
        const cycle = [...visited, current].join(" -> ");
        throw new Error(`Fallback cycle detected: ${cycle}`);
      }
      visited.add(current);
      current = MODEL_FALLBACK_MAP[current];
    }
  }
  logger.debug("[Server] Fallback map validated - no cycles detected");
}

// Validate fallback map at module load time
try {
  validateFallbackMap();
} catch (error) {
  logger.error(`[Server] ${error.message}`);
  process.exit(1);
}

// Setup usage statistics middleware
usageStats.setupMiddleware(app);

/**
 * Parse error into appropriate response format
 */
function parseError(error) {
  let errorType = "api_error";
  let statusCode = 500;
  let errorMessage = error.message;

  if (
    error.message.includes("401") ||
    error.message.includes("UNAUTHENTICATED")
  ) {
    errorType = "authentication_error";
    statusCode = 401;
    errorMessage =
      "Authentication failed. Make sure Antigravity is running with a valid token.";
  } else if (
    error.message.includes("429") ||
    error.message.includes("RESOURCE_EXHAUSTED") ||
    error.message.includes("QUOTA_EXHAUSTED")
  ) {
    errorType = "invalid_request_error";
    statusCode = 400;

    const resetMatch = error.message.match(
      /quota will reset after ([\dh\dm\ds]+)/i
    );
    const modelMatch =
      error.message.match(/Rate limited on ([^.]+)\./) ||
      error.message.match(/"model":\s*"([^"]+)"/);
    const model = modelMatch ? modelMatch[1] : "the model";

    if (resetMatch) {
      errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
    } else {
      errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
    }
  } else if (
    error.message.includes("invalid_request_error") ||
    error.message.includes("INVALID_ARGUMENT")
  ) {
    errorType = "invalid_request_error";
    statusCode = 400;
    const msgMatch = error.message.match(/"message":"([^"]+)"/);
    if (msgMatch) errorMessage = msgMatch[1];
  } else if (error.message.includes("All endpoints failed")) {
    errorType = "api_error";
    statusCode = 503;
    errorMessage =
      "Unable to connect to Claude API. Check that Antigravity is running.";
  } else if (error.message.includes("PERMISSION_DENIED")) {
    errorType = "permission_error";
    statusCode = 403;
    errorMessage = "Permission denied. Check your Antigravity license.";
  }

  return { errorType, statusCode, errorMessage };
}

/**
 * Health check endpoint - Detailed status
 * Returns status of all accounts including rate limits and model quotas
 */
app.get("/health", async (req, res) => {
  try {
    await ensureInitialized();
    const start = Date.now();

    // Get high-level status first
    const status = accountManager.getStatus();
    const allAccounts = accountManager.getAllAccounts();

    // Fetch quotas for each account in parallel to get detailed model info
    const accountDetails = await Promise.allSettled(
      allAccounts.map(async (account) => {
        // Check model-specific rate limits
        const activeModelLimits = Object.entries(
          account.modelRateLimits || {}
        ).filter(
          ([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now()
        );
        const isRateLimited = activeModelLimits.length > 0;
        const soonestReset =
          activeModelLimits.length > 0
            ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
            : null;

        const baseInfo = {
          email: account.email,
          lastUsed: account.lastUsed
            ? new Date(account.lastUsed).toISOString()
            : null,
          modelRateLimits: account.modelRateLimits || {},
          rateLimitCooldownRemaining: soonestReset
            ? Math.max(0, soonestReset - Date.now())
            : 0,
        };

        // Skip invalid accounts for quota check
        if (account.isInvalid) {
          return {
            ...baseInfo,
            status: "invalid",
            error: account.invalidReason,
            models: {},
          };
        }

        try {
          const token = await accountManager.getTokenForAccount(account);
          const quotas = await getModelQuotas(token);

          // Format quotas for readability
          const formattedQuotas = {};
          for (const [modelId, info] of Object.entries(quotas)) {
            formattedQuotas[modelId] = {
              remaining:
                info.remainingFraction !== null
                  ? `${Math.round(info.remainingFraction * 100)}%`
                  : "N/A",
              remainingFraction: info.remainingFraction,
              resetTime: info.resetTime || null,
            };
          }

          return {
            ...baseInfo,
            status: isRateLimited ? "rate-limited" : "ok",
            models: formattedQuotas,
          };
        } catch (error) {
          return {
            ...baseInfo,
            status: "error",
            error: error.message,
            models: {},
          };
        }
      })
    );

    // Process results
    const detailedAccounts = accountDetails.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        const acc = allAccounts[index];
        return {
          email: acc.email,
          status: "error",
          error: result.reason?.message || "Unknown error",
          modelRateLimits: acc.modelRateLimits || {},
        };
      }
    });

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - start,
      summary: status.summary,
      counts: {
        total: status.total,
        available: status.available,
        rateLimited: status.rateLimited,
        invalid: status.invalid,
      },
      accounts: detailedAccounts,
    });
  } catch (error) {
    logger.error("[API] Health check failed:", error);
    res.status(503).json({
      status: "error",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts × all models
 * Returns a table showing remaining quota and reset time for each combination
 * Use ?format=table for ASCII table output, default is JSON
 */
app.get("/account-limits", async (req, res) => {
  try {
    await ensureInitialized();
    const allAccounts = accountManager.getAllAccounts();
    const format = req.query.format || "json";
    const includeHistory = req.query.includeHistory === "true";

    // Fetch quotas for each account in parallel
    const results = await Promise.allSettled(
      allAccounts.map(async (account) => {
        // Skip invalid accounts
        if (account.isInvalid) {
          return {
            email: account.email,
            status: "invalid",
            error: account.invalidReason,
            models: {},
          };
        }

        try {
          const token = await accountManager.getTokenForAccount(account);

          // Fetch both quotas and subscription tier in parallel
          const [quotas, subscription] = await Promise.all([
            getModelQuotas(token),
            getSubscriptionTier(token),
          ]);

          // Update account object with fresh data
          account.subscription = {
            tier: subscription.tier,
            projectId: subscription.projectId,
            detectedAt: Date.now(),
          };
          account.quota = {
            models: quotas,
            lastChecked: Date.now(),
          };

          // Save updated account data to disk (async, don't wait)
          accountManager.saveToDisk().catch((err) => {
            logger.error("[Server] Failed to save account data:", err);
          });

          return {
            email: account.email,
            status: "ok",
            subscription: account.subscription,
            models: quotas,
          };
        } catch (error) {
          return {
            email: account.email,
            status: "error",
            error: error.message,
            subscription: account.subscription || {
              tier: "unknown",
              projectId: null,
            },
            models: {},
          };
        }
      })
    );

    // Process results
    const accountLimits = results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        return {
          email: allAccounts[index].email,
          status: "error",
          error: result.reason?.message || "Unknown error",
          models: {},
        };
      }
    });

    // Collect all unique model IDs
    const allModelIds = new Set();
    for (const account of accountLimits) {
      for (const modelId of Object.keys(account.models || {})) {
        allModelIds.add(modelId);
      }
    }

    const sortedModels = Array.from(allModelIds).sort();

    // Return ASCII table format
    if (format === "table") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");

      // Build table
      const lines = [];
      const timestamp = new Date().toLocaleString();
      lines.push(`Account Limits (${timestamp})`);

      // Get account status info
      const status = accountManager.getStatus();
      lines.push(
        `Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`
      );
      lines.push("");

      // Table 1: Account status
      const accColWidth = 25;
      const statusColWidth = 15;
      const lastUsedColWidth = 25;
      const resetColWidth = 25;

      let accHeader =
        "Account".padEnd(accColWidth) +
        "Status".padEnd(statusColWidth) +
        "Last Used".padEnd(lastUsedColWidth) +
        "Quota Reset";
      lines.push(accHeader);
      lines.push(
        "─".repeat(
          accColWidth + statusColWidth + lastUsedColWidth + resetColWidth
        )
      );

      for (const acc of status.accounts) {
        const shortEmail = acc.email.split("@")[0].slice(0, 22);
        const lastUsed = acc.lastUsed
          ? new Date(acc.lastUsed).toLocaleString()
          : "never";

        // Get status and error from accountLimits
        const accLimit = accountLimits.find((a) => a.email === acc.email);
        let accStatus;
        if (acc.isInvalid) {
          accStatus = "invalid";
        } else if (accLimit?.status === "error") {
          accStatus = "error";
        } else {
          // Count exhausted models (0% or null remaining)
          const models = accLimit?.models || {};
          const modelCount = Object.keys(models).length;
          const exhaustedCount = Object.values(models).filter(
            (q) => q.remainingFraction === 0 || q.remainingFraction === null
          ).length;

          if (exhaustedCount === 0) {
            accStatus = "ok";
          } else {
            accStatus = `(${exhaustedCount}/${modelCount}) limited`;
          }
        }

        // Get reset time from quota API
        const claudeModel = sortedModels.find((m) => m.includes("claude"));
        const quota = claudeModel && accLimit?.models?.[claudeModel];
        const resetTime = quota?.resetTime
          ? new Date(quota.resetTime).toLocaleString()
          : "-";

        let row =
          shortEmail.padEnd(accColWidth) +
          accStatus.padEnd(statusColWidth) +
          lastUsed.padEnd(lastUsedColWidth) +
          resetTime;

        // Add error on next line if present
        if (accLimit?.error) {
          lines.push(row);
          lines.push("  └─ " + accLimit.error);
        } else {
          lines.push(row);
        }
      }
      lines.push("");

      // Calculate column widths - need more space for reset time info
      const modelColWidth =
        Math.max(28, ...sortedModels.map((m) => m.length)) + 2;
      const accountColWidth = 30;

      // Header row
      let header = "Model".padEnd(modelColWidth);
      for (const acc of accountLimits) {
        const shortEmail = acc.email.split("@")[0].slice(0, 26);
        header += shortEmail.padEnd(accountColWidth);
      }
      lines.push(header);
      lines.push(
        "─".repeat(modelColWidth + accountLimits.length * accountColWidth)
      );

      // Data rows
      for (const modelId of sortedModels) {
        let row = modelId.padEnd(modelColWidth);
        for (const acc of accountLimits) {
          const quota = acc.models?.[modelId];
          let cell;
          if (acc.status !== "ok" && acc.status !== "rate-limited") {
            cell = `[${acc.status}]`;
          } else if (!quota) {
            cell = "-";
          } else if (
            quota.remainingFraction === 0 ||
            quota.remainingFraction === null
          ) {
            // Show reset time for exhausted models
            if (quota.resetTime) {
              const resetMs = new Date(quota.resetTime).getTime() - Date.now();
              if (resetMs > 0) {
                cell = `0% (wait ${formatDuration(resetMs)})`;
              } else {
                cell = "0% (resetting...)";
              }
            } else {
              cell = "0% (exhausted)";
            }
          } else {
            const pct = Math.round(quota.remainingFraction * 100);
            cell = `${pct}%`;
          }
          row += cell.padEnd(accountColWidth);
        }
        lines.push(row);
      }

      return res.send(lines.join("\n"));
    }

    // Get account metadata from AccountManager
    const accountStatus = accountManager.getStatus();
    const accountMetadataMap = new Map(
      accountStatus.accounts.map((a) => [a.email, a])
    );

    // Build response data
    const responseData = {
      timestamp: new Date().toLocaleString(),
      totalAccounts: allAccounts.length,
      models: sortedModels,
      modelConfig: config.modelMapping || {},
      accounts: accountLimits.map((acc) => {
        // Merge quota data with account metadata
        const metadata = accountMetadataMap.get(acc.email) || {};
        return {
          email: acc.email,
          status: acc.status,
          error: acc.error || null,
          // Include metadata from AccountManager (WebUI needs these)
          source: metadata.source || "unknown",
          enabled: metadata.enabled !== false,
          projectId: metadata.projectId || null,
          isInvalid: metadata.isInvalid || false,
          invalidReason: metadata.invalidReason || null,
          lastUsed: metadata.lastUsed || null,
          modelRateLimits: metadata.modelRateLimits || {},
          // Subscription data (new)
          subscription: acc.subscription ||
            metadata.subscription || { tier: "unknown", projectId: null },
          // Quota limits
          limits: Object.fromEntries(
            sortedModels.map((modelId) => {
              const quota = acc.models?.[modelId];
              if (!quota) {
                return [modelId, null];
              }
              return [
                modelId,
                {
                  remaining:
                    quota.remainingFraction !== null
                      ? `${Math.round(quota.remainingFraction * 100)}%`
                      : "N/A",
                  remainingFraction: quota.remainingFraction,
                  resetTime: quota.resetTime || null,
                },
              ];
            })
          ),
        };
      }),
    };

    // Optionally include usage history (for dashboard performance optimization)
    if (includeHistory) {
      responseData.history = usageStats.getHistory();
    }

    res.json(responseData);
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message,
    });
  }
});

/**
 * Force token refresh endpoint
 */
app.post("/refresh-token", async (req, res) => {
  try {
    await ensureInitialized();
    // Clear all caches
    accountManager.clearTokenCache();
    accountManager.clearProjectCache();
    // Force refresh default token
    const token = await forceRefresh();
    res.json({
      status: "ok",
      message: "Token caches cleared and refreshed",
      tokenPrefix: token.substring(0, 10) + "...",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message,
    });
  }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get("/v1/models", async (req, res) => {
  try {
    await ensureInitialized();
    const account = accountManager.pickNext();
    if (!account) {
      return res.status(503).json({
        type: "error",
        error: {
          type: "api_error",
          message: "No accounts available",
        },
      });
    }
    const token = await accountManager.getTokenForAccount(account);
    const models = await listModels(token);
    res.json(models);
  } catch (error) {
    logger.error("[API] Error listing models:", error);
    res.status(500).json({
      type: "error",
      error: {
        type: "api_error",
        message: error.message,
      },
    });
  }
});

/**
 * Count tokens endpoint (not supported)
 */
app.post("/v1/messages/count_tokens", (req, res) => {
  res.status(501).json({
    type: "error",
    error: {
      type: "not_implemented",
      message:
        "Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.",
    },
  });
});

/**
 * Anthropic-compatible Messages API
 * POST /v1/messages
 */
app.post("/v1/messages", async (req, res) => {
  try {
    // Ensure account manager is initialized
    await ensureInitialized();

    const {
      model,
      messages,
      stream,
      system,
      max_tokens,
      tools,
      tool_choice,
      thinking,
      top_p,
      top_k,
      temperature,
    } = req.body;

    // Resolve model mapping if configured
    let requestedModel = model || "claude-3-5-sonnet-20241022";
    const modelMapping = config.modelMapping || {};
    if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
      const targetModel = modelMapping[requestedModel].mapping;
      logger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
      requestedModel = targetModel;
    }

    const modelId = requestedModel;

    // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
    // If we have some available accounts, we try them first.
    if (accountManager.isAllRateLimited(modelId)) {
      logger.warn(
        `[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`
      );
      accountManager.resetAllRateLimits();
    }

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages is required and must be an array",
        },
      });
    }

    // Build the request object
    const request = {
      model: modelId,
      messages,
      max_tokens: max_tokens || 4096,
      stream,
      system,
      tools,
      tool_choice,
      thinking,
      top_p,
      top_k,
      temperature,
    };

    // Determine header mode for Gemini models
    const isGeminiModel = request.model.toLowerCase().startsWith("gemini");
    const headerMode = isGeminiModel
      ? config.geminiHeaderMode || "cli"
      : "antigravity";
    logger.info(
      `[API] Request for model: ${
        request.model
      }, stream: ${!!stream}, headers: ${headerMode}`
    );

    // Debug: Log message structure to diagnose tool_use/tool_result ordering
    if (logger.isDebugEnabled) {
      logger.debug("[API] Message structure:");
      messages.forEach((msg, i) => {
        const contentTypes = Array.isArray(msg.content)
          ? msg.content.map((c) => c.type || "text").join(", ")
          : typeof msg.content === "string"
          ? "text"
          : "unknown";
        logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
      });
    }

    if (stream) {
      // Handle streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // Flush headers immediately to start the stream
      res.flushHeaders();

      try {
        // Use the streaming generator with account manager
        for await (const event of sendMessageStream(
          request,
          accountManager,
          FALLBACK_ENABLED
        )) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          // Flush after each event for real-time streaming
          if (res.flush) res.flush();
        }
        res.end();
      } catch (streamError) {
        logger.error("[API] Stream error:", streamError);

        const { errorType, errorMessage } = parseError(streamError);

        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: errorType, message: errorMessage },
          })}\n\n`
        );
        res.end();
      }
    } else {
      // Handle non-streaming response
      const response = await sendMessage(
        request,
        accountManager,
        FALLBACK_ENABLED
      );
      res.json(response);
    }
  } catch (error) {
    logger.error("[API] Error:", error);

    let { errorType, statusCode, errorMessage } = parseError(error);

    // For auth errors, try to refresh token
    if (errorType === "authentication_error") {
      logger.warn("[API] Token might be expired, attempting refresh...");
      try {
        accountManager.clearProjectCache();
        accountManager.clearTokenCache();
        await forceRefresh();
        errorMessage =
          "Token was expired and has been refreshed. Please retry your request.";
      } catch (refreshError) {
        errorMessage =
          "Could not refresh token. Make sure Antigravity is running.";
      }
    }

    logger.warn(
      `[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`
    );

    // Check if headers have already been sent (for streaming that failed mid-way)
    if (res.headersSent) {
      logger.warn("[API] Headers already sent, writing error as SSE event");
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: errorType, message: errorMessage },
        })}\n\n`
      );
      res.end();
    } else {
      res.status(statusCode).json({
        type: "error",
        error: {
          type: errorType,
          message: errorMessage,
        },
      });
    }
  }
});

// Event Logging (for Cline/WebUI clients)
app.post("/api/event_logging/batch", (req, res) => {
  // Silent success for now, logic to be implemented
  res.status(200).send("OK");
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      type: "not_found_error",
      message: "Route not found",
    },
  });
});

// Central Error Handler
app.use(errorHandlerMiddleware);

/**
 * Start the server
 */
async function startServer() {
  try {
    // Start listening immediately
    // Initialization happens lazily on first request via ensureInitialized
    server = app.listen(config.port || DEFAULT_PORT, () => {
      logger.info(`[Server] Listening on port ${config.port || DEFAULT_PORT}`);
      logger.info(
        `[Server] WebUI available at http://localhost:${
          config.port || DEFAULT_PORT
        }`
      );
    });

    // Handle graceful shutdown
    const cleanup = async () => {
      logger.info("[Server] Shutting down...");
      if (server) server.close();
      if (accountManager) {
        // cleanup logic
      }
      process.exit(0);
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  } catch (error) {
    logger.error("[Server] Failed to start:", error);
    process.exit(1);
  }
}

// Start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export { app, startServer };
