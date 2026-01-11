import { sendMessage, sendMessageStream } from "../cloudcode/index.js";
import { config } from "../config.js";
import { DEFAULT_MAX_TOKENS } from "../constants.js";
import { logger } from "../utils/logger.js";

export const createMessagesController = (accountManager, fallbackEnabled) => {
  return {
    handleMessages: async (req, res, next) => {
      try {
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
        if (
          modelMapping[requestedModel] &&
          modelMapping[requestedModel].mapping
        ) {
          const targetModel = modelMapping[requestedModel].mapping;
          logger.info(
            `[Server] Mapping model ${requestedModel} -> ${targetModel}`
          );
          requestedModel = targetModel;
        }

        const modelId = requestedModel;

        // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
        // If we have some available accounts, we try them first.
        if (accountManager.isAllRateLimited(modelId)) {
          logger.warn(
            `[${req.requestId}] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`
          );
          accountManager.resetAllRateLimits();
        }

        // Build the request object
        const request = {
          model: modelId,
          messages,
          max_tokens: max_tokens || DEFAULT_MAX_TOKENS,
          stream,
          system,
          tools,
          tool_choice,
          thinking,
          top_p,
          top_k,
          temperature,
          _requestId: req.requestId, // Internal: for logging correlation
        };

        logger.info(
          `[${req.requestId}] Request for model: ${request.model}, stream: ${!!stream}`
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
              fallbackEnabled
            )) {
              res.write(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
              );
              // Flush after each event for real-time streaming
              if (res.flush) res.flush();
            }
            res.end();
          } catch (streamError) {
            logger.error("[API] Stream error:", streamError);
            // Pass the error to the next middleware, but since headers are sent,
            // the error handler needs to know it should send an SSE error event
            // or we handle it here specifically for SSE.
            // The existing server.js handled it inline. Let's replicate that logic or rely on a smart error handler.
            // For now, let's keep the inline SSE error handling as it is specific to the protocol.
            // However, to reuse the parseError logic which we will move to a helper/middleware,
            // we might need to export it or pass it.
            // Let's assume we can call next(streamError) and the error handler deals with headersSent.
            // BUT standard express error handler doesn't do SSE format.
            // So we should handle it here or have a specialized error handler.
            // Let's re-throw to be caught by the outer catch block which calls next(error)
            throw streamError;
          }
        } else {
          // Handle non-streaming response
          const response = await sendMessage(
            request,
            accountManager,
            fallbackEnabled
          );
          res.json(response);
        }
      } catch (error) {
        next(error);
      }
    },

    countTokens: (req, res, next) => {
        const error = new Error("Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.");
        error.type = "not_implemented";
        error.statusCode = 501;
        next(error);
    }
  };
};
