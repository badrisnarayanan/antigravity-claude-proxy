/**
 * Request Converter
 * Converts Anthropic Messages API requests to Google Generative AI format
 */

import {
  GEMINI_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  getModelFamily,
  isThinkingModel,
} from "../constants.js";
import { convertContentToParts, convertRole } from "./content-converter.js";
import { sanitizeSchema, cleanSchema } from "./schema-sanitizer.js";
import { estimateTokens } from "../utils/helpers.js";
import { config } from "../config.js";
import {
  restoreThinkingSignatures,
  removeTrailingThinkingBlocks,
  reorderAssistantContent,
  filterUnsignedThinkingBlocks,
  hasGeminiHistory,
  needsThinkingRecovery,
  closeToolLoopForThinking,
} from "./thinking-utils.js";
import { logger } from "../utils/logger.js";

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 *
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 *
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertAnthropicToGoogle(anthropicRequest) {
  const {
    messages,
    system,
    max_tokens,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    tools,
    tool_choice,
    thinking,
  } = anthropicRequest;
  const modelName = anthropicRequest.model || "";
  const modelFamily = getModelFamily(modelName);
  const isClaudeModel = modelFamily === "claude";
  const isGeminiModel = modelFamily === "gemini";
  const isGptModel = modelFamily === "gpt";
  const isThinking = isThinkingModel(modelName);

  const googleRequest = {
    contents: [],
    generationConfig: {},
  };

  // Handle system instruction
  if (system) {
    let systemParts = [];
    if (typeof system === "string") {
      systemParts = [{ text: system }];
    } else if (Array.isArray(system)) {
      // Filter for text blocks as system prompts are usually text
      // Anthropic supports text blocks in system prompts
      systemParts = system
        .filter((block) => block.type === "text")
        .map((block) => ({ text: block.text }));
    }

    if (systemParts.length > 0) {
      googleRequest.systemInstruction = {
        parts: systemParts,
      };
    }
  }

  // Add interleaved thinking hint for Claude thinking models with tools
  if (isClaudeModel && isThinking && tools && tools.length > 0) {
    const hint =
      "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.";
    if (!googleRequest.systemInstruction) {
      googleRequest.systemInstruction = { parts: [{ text: hint }] };
    } else {
      const lastPart =
        googleRequest.systemInstruction.parts[
          googleRequest.systemInstruction.parts.length - 1
        ];
      if (lastPart && lastPart.text) {
        lastPart.text = `${lastPart.text}\n\n${hint}`;
      } else {
        googleRequest.systemInstruction.parts.push({ text: hint });
      }
    }
  }

  // Apply thinking recovery for Gemini thinking models when needed
  // Gemini needs recovery for tool loops/interrupted tools (stripped thinking)
  let processedMessages = messages;

  if (isGeminiModel && isThinking && needsThinkingRecovery(messages)) {
    logger.debug("[RequestConverter] Applying thinking recovery for Gemini");
    processedMessages = closeToolLoopForThinking(messages, "gemini");
  }

  // For Claude: apply recovery only for cross-model (Gemini→Claude) switch
  // Detected by checking if history has Gemini-style tool_use with thoughtSignature
  if (
    isClaudeModel &&
    isThinking &&
    hasGeminiHistory(messages) &&
    needsThinkingRecovery(messages)
  ) {
    logger.debug(
      "[RequestConverter] Applying thinking recovery for Claude (cross-model from Gemini)"
    );
    processedMessages = closeToolLoopForThinking(messages, "claude");
  }

  // --- Context Truncation Logic ---
  // Check if context limit is enabled (config takes precedence, then constant default)
  // Use nullish coalescing (??) because 0 is a valid value (unlimited)
  const maxContextTokens =
    config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  if (maxContextTokens > 0) {
    let currentTokens = 0;
    // Always include system prompt cost in the budget
    if (googleRequest.systemInstruction) {
      const systemTokens = estimateTokens(
        googleRequest.systemInstruction.parts
      );
      currentTokens += systemTokens;
    }

    const messagesToKeep = [];
    // Iterate backwards from the newest message
    for (let i = processedMessages.length - 1; i >= 0; i--) {
      const msg = processedMessages[i];
      const msgTokens = estimateTokens(msg);

      // Check if adding this message exceeds the budget
      if (currentTokens + msgTokens > maxContextTokens) {
        logger.warn(
          `[RequestConverter] Context limit (${maxContextTokens}) reached. Truncating history. Keeping last ${messagesToKeep.length} messages.`
        );
        break;
      }

      // TOOL LOOP PROTECTION:
      // If we keep a 'tool_result' (user), we MUST keep the preceding 'tool_use' (assistant)
      // regardless of token budget, otherwise the API call will fail.
      if (
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.some((c) => c.type === "tool_result")
      ) {
        // Current message is a tool result.
        // Add it.
        messagesToKeep.unshift(msg);
        currentTokens += msgTokens;

        // Look at the PREVIOUS message (which should be the assistant's tool_use)
        if (i > 0) {
          const prevMsg = processedMessages[i - 1];
          // Verify it's an assistant message
          if (prevMsg.role === "assistant" || prevMsg.role === "model") {
            const prevTokens = estimateTokens(prevMsg);
            // Force include the assistant message even if it goes slightly over budget
            messagesToKeep.unshift(prevMsg);
            currentTokens += prevTokens;
            i--; // Skip the previous message in the loop since we just added it
          }
        }
        continue; // Move to next iteration
      }

      // Normal message handling
      messagesToKeep.unshift(msg);
      currentTokens += msgTokens;
    }

    // ORPHANED ASSISTANT MESSAGE FIX:
    // If history starts with an assistant message (e.g. a tool use), it violates API rules
    // requiring function calls to follow a user turn. We must rescue the preceding user message.
    if (messagesToKeep.length > 0) {
      const firstMsg = messagesToKeep[0];
      if (firstMsg.role === "assistant" || firstMsg.role === "model") {
        const firstMsgIndex = processedMessages.indexOf(firstMsg);
        if (firstMsgIndex > 0) {
          const prevMsg = processedMessages[firstMsgIndex - 1];
          logger.warn(
            `[RequestConverter] History starts with assistant (role: ${firstMsg.role}). Prepending preceding ${prevMsg.role} message to maintain conversation flow.`
          );
          messagesToKeep.unshift(prevMsg);
        }
      }
    }

    // Replace processedMessages with our truncated list
    processedMessages = messagesToKeep;
  }

  // ORPHANED TOOL RESULT FIX:
  // The API requires that every 'tool_result' (functionResponse) is immediately preceded
  // by a 'tool_use' (functionCall). If we have a tool_result without a preceding tool_use
  // (e.g. due to context truncation or disjoint history), we must convert it to text
  // to prevent API 400 errors.
  processedMessages = processedMessages.map((msg, index) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResult = msg.content.some((c) => c.type === "tool_result");
      if (hasToolResult) {
        // Check previous message
        const prevMsg = index > 0 ? processedMessages[index - 1] : null;
        const hasPrecedingToolUse =
          prevMsg &&
          (prevMsg.role === "assistant" || prevMsg.role === "model") &&
          Array.isArray(prevMsg.content) &&
          prevMsg.content.some((c) => c.type === "tool_use");

        if (!hasPrecedingToolUse) {
          logger.warn(
            `[RequestConverter] Found orphaned tool_result at index ${index}. Converting to text to avoid API error.`
          );
          // Convert tool_result blocks to text blocks (and preserve images)
          const newContent = msg.content.flatMap((block) => {
            if (block.type === "tool_result") {
              const convertedBlocks = [];

              // Convert text content
              let contentStr = "";
              if (typeof block.content === "string") {
                contentStr = block.content;
              } else if (Array.isArray(block.content)) {
                contentStr = block.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");
              }

              convertedBlocks.push({
                type: "text",
                text: `[Orphaned Tool Result: ${
                  block.tool_use_id || "unknown"
                }]\n${contentStr}`,
              });

              // Preserve images
              if (Array.isArray(block.content)) {
                const images = block.content.filter((c) => c.type === "image");
                if (images.length > 0) {
                  convertedBlocks.push(...images);
                }
              }

              return convertedBlocks;
            }
            return [block];
          });
          return { ...msg, content: newContent };
        }
      }
    }
    return msg;
  });

  // -------------------------------

  // Convert messages to contents, then filter unsigned thinking blocks
  for (let i = 0; i < processedMessages.length; i++) {
    const msg = processedMessages[i];
    let msgContent = msg.content;

    // For assistant messages, process thinking blocks and reorder content
    if (
      (msg.role === "assistant" || msg.role === "model") &&
      Array.isArray(msgContent)
    ) {
      // First, try to restore signatures for unsigned thinking blocks from cache
      msgContent = restoreThinkingSignatures(msgContent);
      // Remove trailing unsigned thinking blocks
      msgContent = removeTrailingThinkingBlocks(msgContent);
      // Reorder: thinking first, then text, then tool_use
      msgContent = reorderAssistantContent(msgContent);
    }

    const parts = convertContentToParts(
      msgContent,
      isClaudeModel,
      isGeminiModel,
      isGptModel
    );

    // SAFETY: Google API requires at least one part per content message
    // This happens when all thinking blocks are filtered out (unsigned)
    if (parts.length === 0) {
      // Use '.' instead of '' because claude models reject empty text parts.
      // A single period is invisible in practice but satisfies the API requirement.
      logger.warn(
        "[RequestConverter] WARNING: Empty parts array after filtering, adding placeholder"
      );
      parts.push({ text: "." });
    }

    const content = {
      role: convertRole(msg.role),
      parts: parts,
    };
    googleRequest.contents.push(content);
  }

  // Filter unsigned thinking blocks for Claude models
  if (isClaudeModel) {
    googleRequest.contents = filterUnsignedThinkingBlocks(
      googleRequest.contents
    );
  }

  // Generation config
  if (max_tokens) {
    googleRequest.generationConfig.maxOutputTokens = max_tokens;
  }
  if (temperature !== undefined) {
    googleRequest.generationConfig.temperature = temperature;
  }
  if (top_p !== undefined) {
    googleRequest.generationConfig.topP = top_p;
  }
  if (top_k !== undefined) {
    googleRequest.generationConfig.topK = top_k;
  }
  if (stop_sequences && stop_sequences.length > 0) {
    googleRequest.generationConfig.stopSequences = stop_sequences;
  }

  // Enable thinking for thinking models (Claude and Gemini 3+)
  if (isThinking) {
    if (isClaudeModel) {
      // Claude thinking config
      const thinkingConfig = {
        include_thoughts: true,
      };

      // Only set thinking_budget if explicitly provided
      const thinkingBudget = thinking?.budget_tokens;
      if (thinkingBudget) {
        thinkingConfig.thinking_budget = thinkingBudget;
        logger.debug(
          `[RequestConverter] Claude thinking enabled with budget: ${thinkingBudget}`
        );

        // Validate max_tokens > thinking_budget as required by the API
        const currentMaxTokens = googleRequest.generationConfig.maxOutputTokens;
        if (currentMaxTokens && currentMaxTokens <= thinkingBudget) {
          // Bump max_tokens to allow for some response content
          // Default to budget + 8192 (standard output buffer)
          const adjustedMaxTokens = thinkingBudget + 8192;
          logger.warn(
            `[RequestConverter] max_tokens (${currentMaxTokens}) <= thinking_budget (${thinkingBudget}). Adjusting to ${adjustedMaxTokens} to satisfy API requirements`
          );
          googleRequest.generationConfig.maxOutputTokens = adjustedMaxTokens;
        }
      } else {
        logger.debug(
          "[RequestConverter] Claude thinking enabled (no budget specified)"
        );
      }

      googleRequest.generationConfig.thinkingConfig = thinkingConfig;
    } else if (isGeminiModel) {
      // Gemini thinking config (uses camelCase)
      const thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: thinking?.budget_tokens || 16000,
      };
      logger.debug(
        `[RequestConverter] Gemini thinking enabled with budget: ${thinkingConfig.thinkingBudget}`
      );

      googleRequest.generationConfig.thinkingConfig = thinkingConfig;
    }
  }

  // Convert tools to Google format
  if (tools && tools.length > 0) {
    const functionDeclarations = tools.map((tool, idx) => {
      // Extract name from various possible locations
      const name =
        tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

      // Extract description from various possible locations
      const description =
        tool.description ||
        tool.function?.description ||
        tool.custom?.description ||
        "";

      // Extract schema from various possible locations
      const schema = tool.input_schema ||
        tool.function?.input_schema ||
        tool.function?.parameters ||
        tool.custom?.input_schema ||
        tool.parameters || { type: "object" };

      // Sanitize schema for general compatibility
      let parameters = sanitizeSchema(schema);

      // Apply Google-format cleaning for ALL models since they all go through
      // Cloud Code API which validates schemas using Google's protobuf format.
      // This fixes issue #82: /compact command fails with schema transformation error
      // "Proto field is not repeating, cannot start list" for Claude models.
      parameters = cleanSchema(parameters);

      return {
        name: String(name)
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 64),
        description: description,
        parameters,
      };
    });

    googleRequest.tools = [{ functionDeclarations }];

    // Add toolConfig for Claude models to enforce VALIDATED mode
    // This improves tool use reliability as recommended in auth_repo
    if (isClaudeModel) {
      googleRequest.toolConfig = {
        functionCallingConfig: {
          mode: "VALIDATED",
        },
      };
    }

    logger.debug(
      `[RequestConverter] Tools: ${JSON.stringify(
        googleRequest.tools
      ).substring(0, 300)}`
    );
  }

  // Cap max tokens for Gemini models
  if (
    isGeminiModel &&
    googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS
  ) {
    logger.debug(
      `[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`
    );
    googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
  }

  return googleRequest;
}
