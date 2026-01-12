/**
 * OpenAI Format Converter
 * Converts OpenAI Chat Completion API requests/responses to/from Anthropic/Google formats
 */

import crypto from "crypto";

/**
 * Convert OpenAI Chat Completion request to Anthropic Messages API format
 *
 * @param {Object} openaiRequest - OpenAI format request
 * @returns {Object} Anthropic format request
 */
export function convertOpenAIToAnthropic(openaiRequest) {
  const {
    model,
    messages,
    temperature,
    top_p,
    n,
    stream,
    stop,
    max_tokens,
    presence_penalty,
    frequency_penalty,
    logit_bias,
    user,
    tools,
    tool_choice,
  } = openaiRequest;

  // Extract system message
  let system = undefined;
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (system === undefined) {
        system = msg.content;
      } else {
        // If multiple system messages, append
        system += "\n\n" + msg.content;
      }
    } else if (msg.role === "user" || msg.role === "assistant") {
      // Handle content
      let content = msg.content;

      // OpenAI function calling (tool_calls)
      if (msg.tool_calls) {
        // If we have tool calls, content might be null in OpenAI, but Anthropic expects content or tool blocks
        if (content === null) {
          content = [];
        } else if (typeof content === "string") {
          content = [{ type: "text", text: content }];
        }

        // Add tool calls as tool_use blocks
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type === "function") {
            content.push({
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments),
            });
          }
        }
      } else if (msg.tool_call_id) {
        // Tool response (role=tool in OpenAI, role=user with tool_result in Anthropic)
        // This logic needs to be handled carefully as Anthropic expects tool_result inside user blocks
        // But since we are iterating messages, we might need to map 'tool' role to 'user' role with 'tool_result' content
      }

      anthropicMessages.push({
        role: msg.role,
        content: content,
      });
    } else if (msg.role === "tool") {
      // Handle tool response
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      });
    }
  }

  // Convert tools format
  let anthropicTools = undefined;
  if (tools) {
    anthropicTools = tools
      .map((t) => {
        if (t.type === "function") {
          return {
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  // Convert tool_choice
  let anthropicToolChoice = undefined;
  if (tool_choice) {
    if (typeof tool_choice === "string") {
      if (tool_choice === "auto") {
        anthropicToolChoice = { type: "auto" };
      } else if (tool_choice === "none") {
        // No direct equivalent in Anthropic, usually omitted
      } else if (tool_choice === "required") {
        anthropicToolChoice = { type: "any" };
      }
    } else if (
      typeof tool_choice === "object" &&
      tool_choice.type === "function"
    ) {
      anthropicToolChoice = {
        type: "tool",
        name: tool_choice.function.name,
      };
    }
  }

  const anthropicRequest = {
    model,
    messages: anthropicMessages,
    system,
    max_tokens: max_tokens || 4096,
    stream,
    temperature,
    top_p,
    tools: anthropicTools,
    tool_choice: anthropicToolChoice,
  };

  // Handle stop sequences
  if (stop) {
    anthropicRequest.stop_sequences = Array.isArray(stop) ? stop : [stop];
  }

  return anthropicRequest;
}

/**
 * Convert Anthropic Messages API response to OpenAI Chat Completion format
 *
 * @param {Object} anthropicResponse - Anthropic format response
 * @param {Object} originalRequest - Original OpenAI request (for echoing model, etc.)
 * @returns {Object} OpenAI format response
 */
export function convertAnthropicToOpenAI(anthropicResponse, originalRequest) {
  const timestamp = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;

  // Handle streaming chunks
  if (
    anthropicResponse.type === "message_start" ||
    anthropicResponse.type === "content_block_start" ||
    anthropicResponse.type === "content_block_delta" ||
    anthropicResponse.type === "content_block_stop" ||
    anthropicResponse.type === "message_delta" ||
    anthropicResponse.type === "message_stop"
  ) {
    return convertAnthropicStreamToOpenAI(
      anthropicResponse,
      id,
      timestamp,
      originalRequest.model
    );
  }

  // Handle full response
  const choices = [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
      },
      finish_reason: mapFinishReason(anthropicResponse.stop_reason),
    },
  ];

  // Process content
  const contentBlocks = anthropicResponse.content || [];
  let textContent = "";
  const toolCalls = [];

  for (const block of contentBlocks) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  if (textContent) {
    choices[0].message.content = textContent;
  }

  if (toolCalls.length > 0) {
    choices[0].message.tool_calls = toolCalls;
  }

  return {
    id: id,
    object: "chat.completion",
    created: timestamp,
    model: originalRequest.model, // Echo back requested model
    choices: choices,
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) +
        (anthropicResponse.usage?.output_tokens || 0),
    },
  };
}

/**
 * Convert Anthropic stream events to OpenAI stream chunks
 */
function convertAnthropicStreamToOpenAI(event, id, timestamp, model) {
  // Determine the delta based on event type
  let delta = {};
  let finish_reason = null;

  switch (event.type) {
    case "message_start":
      delta = { role: "assistant", content: "" };
      break;
    case "content_block_start":
      if (event.content_block.type === "tool_use") {
        delta = {
          tool_calls: [
            {
              index: event.index,
              id: event.content_block.id,
              type: "function",
              function: {
                name: event.content_block.name,
                arguments: "",
              },
            },
          ],
        };
      }
      break;
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        delta = { content: event.delta.text };
      } else if (event.delta.type === "input_json_delta") {
        delta = {
          tool_calls: [
            {
              index: event.index,
              function: {
                arguments: event.delta.partial_json,
              },
            },
          ],
        };
      }
      break;
    case "message_delta":
      if (event.delta.stop_reason) {
        finish_reason = mapFinishReason(event.delta.stop_reason);
      }
      break;
    case "message_stop":
      finish_reason = "stop"; // Fallback
      break;
    default:
      return null; // Ignore other events
  }

  return {
    id: id,
    object: "chat.completion.chunk",
    created: timestamp,
    model: model,
    choices: [
      {
        index: 0,
        delta: delta,
        finish_reason: finish_reason,
      },
    ],
  };
}

function mapFinishReason(reason) {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
      return "stop";
    default:
      return null;
  }
}
