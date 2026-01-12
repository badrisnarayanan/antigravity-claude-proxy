/**
 * Request Validation Middleware
 * Validates incoming API requests before processing
 */

import crypto from "crypto";
import { logger } from "../utils/logger.js";

// Valid model prefixes - models must start with one of these
// Expanded list to support more providers
const VALID_MODEL_PREFIXES = ["claude", "gemini", "gpt"];

/**
 * Generate a unique request ID
 * @returns {string} A unique request ID
 */
export function generateRequestId() {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Request ID middleware - adds unique ID to each request
 */
export function requestIdMiddleware(req, res, next) {
  req.requestId = req.headers["x-request-id"] || generateRequestId();
  res.setHeader("x-request-id", req.requestId);
  next();
}

/**
 * Content-Type validation middleware for POST requests
 */
export function contentTypeMiddleware(req, res, next) {
  if (req.method === "POST") {
    const contentType = req.headers["content-type"];
    if (!contentType || !contentType.includes("application/json")) {
      return res.status(415).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Content-Type must be application/json",
        },
      });
    }
  }
  next();
}

/**
 * Validate a message object structure
 * @param {Object} msg - Message object to validate
 * @param {number} index - Index in the messages array
 * @returns {{valid: boolean, error?: string}}
 */
function validateMessage(msg, index) {
  if (!msg || typeof msg !== "object") {
    return { valid: false, error: `messages[${index}] must be an object` };
  }

  if (!msg.role || !["user", "assistant"].includes(msg.role)) {
    return {
      valid: false,
      error: `messages[${index}].role must be 'user' or 'assistant'`,
    };
  }

  if (msg.content === undefined || msg.content === null) {
    return { valid: false, error: `messages[${index}].content is required` };
  }

  // Content can be string or array
  if (typeof msg.content !== "string" && !Array.isArray(msg.content)) {
    return {
      valid: false,
      error: `messages[${index}].content must be a string or array`,
    };
  }

  // If array, validate each content block
  if (Array.isArray(msg.content)) {
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (!block || typeof block !== "object") {
        return {
          valid: false,
          error: `messages[${index}].content[${i}] must be an object`,
        };
      }
      if (!block.type) {
        return {
          valid: false,
          error: `messages[${index}].content[${i}].type is required`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate model name
 * @param {string} model - Model name to validate
 * @returns {{valid: boolean, error?: string, suggestion?: string}}
 */
function validateModel(model) {
  if (!model || typeof model !== "string") {
    return { valid: false, error: "model is required and must be a string" };
  }

  const lower = model.toLowerCase();
  const hasValidPrefix = VALID_MODEL_PREFIXES.some((prefix) =>
    lower.includes(prefix)
  );

  if (!hasValidPrefix) {
    // Warn but allow, to support new models without code changes
    logger.warn(
      `[Validation] Unknown model prefix for: ${model}. Proceeding anyway.`
    );
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Validate the /v1/messages request body
 * @param {Object} body - Request body
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateMessagesRequest(body) {
  const errors = [];

  // Validate model (optional, has default)
  if (body.model) {
    const modelValidation = validateModel(body.model);
    if (!modelValidation.valid) {
      errors.push(modelValidation.error);
    }
  }

  // Validate messages (required)
  if (!body.messages) {
    errors.push("messages is required");
  } else if (!Array.isArray(body.messages)) {
    errors.push("messages must be an array");
  } else if (body.messages.length === 0) {
    errors.push("messages must not be empty");
  } else {
    // Validate each message
    for (let i = 0; i < body.messages.length; i++) {
      const msgValidation = validateMessage(body.messages[i], i);
      if (!msgValidation.valid) {
        errors.push(msgValidation.error);
        // Stop after first message error to avoid flooding
        break;
      }
    }
  }

  // Validate max_tokens (optional)
  if (body.max_tokens !== undefined) {
    if (typeof body.max_tokens !== "number" || body.max_tokens < 1) {
      errors.push("max_tokens must be a positive number");
    }
  }

  // Validate temperature (optional)
  if (body.temperature !== undefined) {
    if (
      typeof body.temperature !== "number" ||
      body.temperature < 0 ||
      body.temperature > 2
    ) {
      errors.push("temperature must be a number between 0 and 2");
    }
  }

  // Validate top_p (optional)
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== "number" || body.top_p < 0 || body.top_p > 1) {
      errors.push("top_p must be a number between 0 and 1");
    }
  }

  // Validate top_k (optional)
  if (body.top_k !== undefined) {
    if (typeof body.top_k !== "number" || body.top_k < 1) {
      errors.push("top_k must be a positive integer");
    }
  }

  // Validate tools (optional)
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    errors.push("tools must be an array");
  }

  // Validate thinking (optional)
  if (body.thinking !== undefined) {
    if (typeof body.thinking !== "object") {
      errors.push("thinking must be an object");
    } else if (body.thinking.budget_tokens !== undefined) {
      if (
        typeof body.thinking.budget_tokens !== "number" ||
        body.thinking.budget_tokens < 1
      ) {
        errors.push("thinking.budget_tokens must be a positive number");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validation middleware for /v1/messages endpoint
 */
export function messagesValidationMiddleware(req, res, next) {
  const validation = validateMessagesRequest(req.body);

  if (!validation.valid) {
    return res.status(400).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: validation.errors.join("; "),
      },
    });
  }

  next();
}
