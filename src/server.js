/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { mountWebUI } from "./webui/index.js";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { REQUEST_BODY_LIMIT, MODEL_FALLBACK_MAP } from "./constants.js";
import { AccountManager } from "./account-manager/index.js";
import { logger } from "./utils/logger.js";
import usageStats from "./modules/usage-stats.js";
import {
  requestIdMiddleware,
  contentTypeMiddleware,
  messagesValidationMiddleware,
} from "./middleware/validation.js";

// Import Controllers and Middleware
import { createMessagesController } from "./controllers/messages.controller.js";
import { createModelsController } from "./controllers/models.controller.js";
import { createSystemController } from "./controllers/system.controller.js";
import { createErrorHandler } from "./middleware/error-handler.js";

// Parse fallback flag directly from command line args
const args = process.argv.slice(2);
const FALLBACK_ENABLED =
  args.includes("--fallback") || process.env.FALLBACK === "true";

const app = express();

// Initialize account manager
const accountManager = new AccountManager();

// Track initialization
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await accountManager.initialize();
      const status = accountManager.getStatus();
      logger.success(`[Server] Account pool initialized: ${status.summary}`);
    } catch (error) {
      initPromise = null;
      logger.error(
        "[Server] Failed to initialize account manager:",
        error.message
      );
      throw error;
    }
  })();

  return initPromise;
}

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

// Instantiate Controllers
const messagesController = createMessagesController(
  accountManager,
  FALLBACK_ENABLED
);
const modelsController = createModelsController(accountManager);
const systemController = createSystemController(
  accountManager,
  ensureInitialized
);

// Middleware
app.use(requestIdMiddleware);

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:*";
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1")
      ) {
        return callback(null, true);
      }
      if (corsOrigin === "*") {
        return callback(null, true);
      }
      if (origin === corsOrigin) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// Setup usage statistics middleware
usageStats.setupMiddleware(app);

// Request logging middleware
app.use((req, res, next) => {
  if (req.path === "/api/event_logging/batch") {
    if (logger.isDebugEnabled) {
      logger.debug(`[${req.requestId}] ${req.method} ${req.path}`);
    }
  } else {
    logger.info(`[${req.requestId}] ${req.method} ${req.path}`);
  }
  next();
});

// Mount WebUI
mountWebUI(app, __dirname, accountManager);

// Messages Routes
app.use("/v1/messages", contentTypeMiddleware);
app.post(
  "/v1/messages",
  messagesValidationMiddleware,
  messagesController.handleMessages
);
app.post("/v1/messages/count_tokens", messagesController.countTokens);

// Models Routes
app.get("/v1/models", modelsController.listModels);

// System Routes
app.get("/health", systemController.healthCheck);
app.get("/account-limits", systemController.getAccountLimits);
app.post("/refresh-token", systemController.refreshToken);

// Event Logging (Client-side analytics/logs)
app.post("/api/event_logging/batch", (req, res) => {
  // Silently accept events
  res.status(200).json({ status: "ok" });
});

// Catch-all for unsupported endpoints
usageStats.setupRoutes(app);

app.use("*", (req, res, next) => {
  if (logger.isDebugEnabled) {
    logger.debug(`[API] 404 Not Found: ${req.method} ${req.originalUrl}`);
  }
  const error = new Error(
    `Endpoint ${req.method} ${req.originalUrl} not found`
  );
  error.type = "not_found_error";
  error.statusCode = 404;
  next(error);
});

// Error Handler
app.use(createErrorHandler(accountManager));

export default app;
