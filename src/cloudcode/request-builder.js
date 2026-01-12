/**
 * Request Builder for Cloud Code
 *
 * Builds request payloads and headers for the Cloud Code API.
 */

import crypto from "crypto";
import {
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  getModelFamily,
  isThinkingModel,
} from "../constants.js";
import { convertAnthropicToGoogle } from "../format/index.js";
import { deriveSessionId } from "./session-manager.js";
import { config } from "../config.js";
import { resolveModelForHeaderMode, isGemini3Model } from "./model-mapper.js";

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId) {
  const requestedModel = anthropicRequest.model;

  // Resolve model name based on header mode
  const resolved = resolveModelForHeaderMode(requestedModel);
  const model = resolved.actualModel;

  const googleRequest = convertAnthropicToGoogle(anthropicRequest);

  // Use stable session ID derived from first user message for cache continuity
  googleRequest.sessionId = deriveSessionId(anthropicRequest);

  // Build system instruction parts array with [ignore] tags to prevent model from
  // identifying as "Antigravity" (fixes GitHub issue #76)
  // Reference: CLIProxyAPI, gcli2api, AIClient-2-API all use this approach
  const modelFamily = getModelFamily(model);
  const systemParts = [];

  // Only inject Antigravity identity for non-GPT models to avoid confusion
  if (modelFamily !== "gpt") {
    systemParts.push(
      { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
      {
        text: `Please ignore the following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]`,
      }
    );
  }

  // Append any existing system instructions from the request
  if (
    googleRequest.systemInstruction &&
    googleRequest.systemInstruction.parts
  ) {
    for (const part of googleRequest.systemInstruction.parts) {
      if (part.text) {
        systemParts.push({ text: part.text });
      }
    }
  }

  const payload = {
    project: projectId,
    model: model,
    request: googleRequest,
    userAgent: "antigravity",
    requestType: "agent", // CLIProxyAPI v6.6.89 compatibility
    requestId: "agent-" + crypto.randomUUID(),
  };

  // For CLI mode with Gemini 3 models, inject thinkingLevel into the request
  if (
    resolved.headerMode === "cli" &&
    isGemini3Model(requestedModel) &&
    resolved.thinkingLevel
  ) {
    payload.request.generationConfig = payload.request.generationConfig || {};
    payload.request.generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: resolved.thinkingLevel,
    };
  }

  // Inject systemInstruction with role: "user" at the top level (CLIProxyAPI v6.6.89 behavior)
  payload.request.systemInstruction = {
    role: "user",
    parts: systemParts,
  };

  return payload;
}

/**
 * Build headers for Cloud Code API requests
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @param {string} accept - Accept header value (default: 'application/json')
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = "application/json") {
  const modelFamily = getModelFamily(model);

  // Choose headers based on model family
  // Gemini models work best with the Node.js client headers, but can be toggled
  let baseHeaders = ANTIGRAVITY_HEADERS;

  if (modelFamily === "gemini") {
    baseHeaders =
      config.geminiHeaderMode === "antigravity"
        ? ANTIGRAVITY_HEADERS
        : GEMINI_CLI_HEADERS;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...baseHeaders,
  };

  // Add interleaved thinking header only for Claude thinking models
  if (modelFamily === "claude" && isThinkingModel(model)) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  if (accept !== "application/json") {
    headers["Accept"] = accept;
  }

  return headers;
}
