/**
 * Snapshot Tests for Response Format Stability
 *
 * These tests capture the exact structure of Anthropic API responses.
 * Any format change will cause test failure - intentional changes require
 * updating snapshots with: npm test -- -u
 */

import { describe, it, expect } from "vitest";
import { convertGoogleToAnthropic } from "../../src/format/response-converter.js";
import { createGoogleResponse, createGoogleThinkingPart, createGoogleFunctionCallPart } from "../helpers/factories.js";
import type { GoogleResponse, GooglePart } from "../../src/format/types.js";

// Helper to create deterministic IDs for snapshots
const mockId = "msg_01XYZ789ABC";
const mockToolId = "toolu_01ABC123";

describe("Response Format Snapshots", () => {
  describe("Simple Text Response", () => {
    it("matches snapshot for basic text response", () => {
      const googleResponse = createGoogleResponse({
        candidates: [
          {
            content: { parts: [{ text: "Hello! How can I help you today?" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 12,
        },
      });

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      // Normalize dynamic fields for snapshot stability
      const normalized = {
        ...result,
        id: mockId,
      };

      expect(normalized).toMatchSnapshot("simple-text-response");
    });
  });

  describe("Thinking Block Response", () => {
    it("matches snapshot for response with thinking", () => {
      const thinkingPart = createGoogleThinkingPart("Let me analyze this step by step...", "sig_" + "a".repeat(100));

      const googleResponse: GoogleResponse = {
        candidates: [
          {
            content: {
              parts: [thinkingPart as GooglePart, { text: "Based on my analysis, the answer is 42." }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 25,
        },
      };

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      const normalized = {
        ...result,
        id: mockId,
      };

      expect(normalized).toMatchSnapshot("thinking-block-response");
    });
  });

  describe("Tool Use Response", () => {
    it("matches snapshot for single tool use", () => {
      const functionCallPart = createGoogleFunctionCallPart("get_weather", { location: "San Francisco", units: "celsius" }, "sig_" + "b".repeat(100));

      const googleResponse: GoogleResponse = {
        candidates: [
          {
            content: {
              parts: [functionCallPart as GooglePart],
            },
            finishReason: "TOOL_USE",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 15,
        },
      };

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      // Normalize tool IDs for snapshot stability
      const normalized = {
        ...result,
        id: mockId,
        content: result.content.map((block) => (block.type === "tool_use" ? { ...block, id: mockToolId } : block)),
      };

      expect(normalized).toMatchSnapshot("single-tool-use-response");
    });

    it("matches snapshot for multiple tool uses", () => {
      const tool1 = createGoogleFunctionCallPart("search", { query: "weather" });
      const tool2 = createGoogleFunctionCallPart("get_time", { timezone: "UTC" });

      const googleResponse: GoogleResponse = {
        candidates: [
          {
            content: {
              parts: [tool1 as GooglePart, tool2 as GooglePart],
            },
            finishReason: "TOOL_USE",
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          candidatesTokenCount: 20,
        },
      };

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      const normalized = {
        ...result,
        id: mockId,
        content: result.content.map((block, i) => (block.type === "tool_use" ? { ...block, id: `${mockToolId}_${i}` } : block)),
      };

      expect(normalized).toMatchSnapshot("multiple-tool-use-response");
    });
  });

  describe("Mixed Content Response", () => {
    it("matches snapshot for thinking + text + tool", () => {
      const thinkingPart = createGoogleThinkingPart("Planning my approach...", "sig_think");
      const toolPart = createGoogleFunctionCallPart("execute", { cmd: "test" }, "sig_tool");

      const googleResponse: GoogleResponse = {
        candidates: [
          {
            content: {
              parts: [thinkingPart as GooglePart, { text: "I'll execute that for you." }, toolPart as GooglePart],
            },
            finishReason: "TOOL_USE",
          },
        ],
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 35,
        },
      };

      const result = convertGoogleToAnthropic(googleResponse, "claude-opus-4-5-thinking");

      const normalized = {
        ...result,
        id: mockId,
        content: result.content.map((block, i) => (block.type === "tool_use" ? { ...block, id: `${mockToolId}_${i}` } : block)),
      };

      expect(normalized).toMatchSnapshot("mixed-content-response");
    });
  });

  describe("Edge Cases", () => {
    it("matches snapshot for empty response", () => {
      const googleResponse: GoogleResponse = {
        candidates: [
          {
            content: { parts: [] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 0,
        },
      };

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      const normalized = { ...result, id: mockId };

      expect(normalized).toMatchSnapshot("empty-response");
    });

    it("matches snapshot for max_tokens stop reason", () => {
      const googleResponse = createGoogleResponse({
        candidates: [
          {
            content: { parts: [{ text: "This response was truncat" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      });

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      const normalized = { ...result, id: mockId };

      expect(normalized).toMatchSnapshot("max-tokens-response");
    });

    it("matches snapshot for cached response", () => {
      const googleResponse = createGoogleResponse({
        candidates: [
          {
            content: { parts: [{ text: "Cached response" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 80,
        },
      });

      const result = convertGoogleToAnthropic(googleResponse, "claude-sonnet-4-5-thinking");

      const normalized = { ...result, id: mockId };

      expect(normalized).toMatchSnapshot("cached-response");
    });
  });
});
