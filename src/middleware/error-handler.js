import { logger } from "../utils/logger.js";
import { forceRefresh } from "../auth/token-extractor.js";

/**
 * Parse error message to extract error type, status code, and user-friendly message
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
    errorType = "rate_limit_error";
    statusCode = 429; // Proper HTTP status code for rate limiting

    // Try to extract the quota reset time from the error
    const resetMatch = error.message.match(
      /quota will reset after ([\dh\dm\ds]+)/i
    );
    // Try to extract model from our error format "Rate limited on <model>" or JSON format
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
    error.message.includes("INVALID_ARGUMENT") ||
    (error.statusCode === 400) // Catch 400 errors passed manually
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
  } else if (error.type === "not_implemented") {
      errorType = "not_implemented";
      statusCode = 501;
  } else if (error.statusCode) {
      statusCode = error.statusCode;
      if (error.type) errorType = error.type;
  }

  return { errorType, statusCode, errorMessage };
}

export const createErrorHandler = (accountManager) => {
  return async (error, req, res, next) => {
    logger.error("[API] Error:", error);

    let { errorType, statusCode, errorMessage } = parseError(error);

    // For auth errors, try to refresh token
    if (errorType === "authentication_error") {
      logger.warn("[API] Token might be expired, attempting refresh...");
      try {
        if (accountManager) {
            accountManager.clearProjectCache();
            accountManager.clearTokenCache();
        }
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
      // If content-type is event-stream, send SSE error
      const contentType = res.getHeader('content-type');
      if (contentType && contentType.includes('text/event-stream')) {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: errorType, message: errorMessage },
            })}\n\n`
          );
      }
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
  };
};

export { parseError };
