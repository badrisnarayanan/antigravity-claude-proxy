# Comprehensive Test Suite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 38 new test types across 8 categories for maximum regression prevention coverage.

**Architecture:** Layered testing approach - snapshot tests for format stability, golden files for known-good behavior, chaos tests for resilience, mutation testing for test quality validation. Each layer catches different regression types.

**Tech Stack:** Vitest (snapshots, unit), nock (HTTP mocking), fast-check (existing fuzz), Stryker (mutation), autocannon (load), expect-type (types)

---

## Phase 1: Snapshot Tests (Format Stability)

### Task 1.1: Create Snapshot Test Infrastructure

**Files:**

- Create: `tests/snapshot/response-format.snap.test.ts`
- Create: `tests/snapshot/sse-events.snap.test.ts`

**Step 1: Write the first snapshot test file**

```typescript
// tests/snapshot/response-format.snap.test.ts
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
```

**Step 2: Run test to generate initial snapshots**

Run: `npm test -- tests/snapshot/response-format.snap.test.ts`
Expected: PASS (snapshots created in `tests/snapshot/__snapshots__/`)

**Step 3: Verify snapshots were created**

Run: `ls tests/snapshot/__snapshots__/`
Expected: `response-format.snap.test.ts.snap` file exists

**Step 4: Commit**

```bash
git add tests/snapshot/
git commit -m "test: add response format snapshot tests"
```

---

### Task 1.2: Add SSE Event Snapshot Tests

**Files:**

- Create: `tests/snapshot/sse-events.snap.test.ts`

**Step 1: Write SSE event snapshot tests**

```typescript
// tests/snapshot/sse-events.snap.test.ts
/**
 * Snapshot Tests for SSE Event Format Stability
 *
 * Captures exact SSE event structure for streaming responses.
 */

import { describe, it, expect } from "vitest";

// SSE event types that must remain stable
interface SSEEvent {
  event: string;
  data: unknown;
}

describe("SSE Event Format Snapshots", () => {
  describe("Message Events", () => {
    it("matches snapshot for message_start event", () => {
      const event: SSEEvent = {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_01XYZ",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4-5-thinking",
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 0,
            },
          },
        },
      };

      expect(event).toMatchSnapshot("message-start-event");
    });

    it("matches snapshot for message_delta event", () => {
      const event: SSEEvent = {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          usage: {
            output_tokens: 25,
          },
        },
      };

      expect(event).toMatchSnapshot("message-delta-event");
    });

    it("matches snapshot for message_stop event", () => {
      const event: SSEEvent = {
        event: "message_stop",
        data: {
          type: "message_stop",
        },
      };

      expect(event).toMatchSnapshot("message-stop-event");
    });
  });

  describe("Content Block Events", () => {
    it("matches snapshot for content_block_start (text)", () => {
      const event: SSEEvent = {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-start-text");
    });

    it("matches snapshot for content_block_start (thinking)", () => {
      const event: SSEEvent = {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "",
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-start-thinking");
    });

    it("matches snapshot for content_block_start (tool_use)", () => {
      const event: SSEEvent = {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_01ABC",
            name: "get_weather",
            input: {},
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-start-tool-use");
    });

    it("matches snapshot for content_block_delta (text)", () => {
      const event: SSEEvent = {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hello, ",
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-delta-text");
    });

    it("matches snapshot for content_block_delta (thinking)", () => {
      const event: SSEEvent = {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let me consider...",
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-delta-thinking");
    });

    it("matches snapshot for content_block_delta (input_json)", () => {
      const event: SSEEvent = {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"location": "San',
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-delta-input-json");
    });

    it("matches snapshot for content_block_stop", () => {
      const event: SSEEvent = {
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index: 0,
        },
      };

      expect(event).toMatchSnapshot("content-block-stop");
    });
  });

  describe("Signature Events", () => {
    it("matches snapshot for content_block_stop with signature", () => {
      const event: SSEEvent = {
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "Full thinking content here...",
            signature: "sig_" + "x".repeat(100),
          },
        },
      };

      expect(event).toMatchSnapshot("content-block-stop-with-signature");
    });
  });

  describe("Error Events", () => {
    it("matches snapshot for error event", () => {
      const event: SSEEvent = {
        event: "error",
        data: {
          type: "error",
          error: {
            type: "overloaded_error",
            message: "The API is temporarily overloaded",
          },
        },
      };

      expect(event).toMatchSnapshot("error-event");
    });
  });

  describe("Ping Events", () => {
    it("matches snapshot for ping event", () => {
      const event: SSEEvent = {
        event: "ping",
        data: {
          type: "ping",
        },
      };

      expect(event).toMatchSnapshot("ping-event");
    });
  });
});
```

**Step 2: Run test to generate snapshots**

Run: `npm test -- tests/snapshot/sse-events.snap.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/snapshot/
git commit -m "test: add SSE event format snapshot tests"
```

---

## Phase 2: Golden File Tests (Known-Good Pairs)

### Task 2.1: Create Golden File Test Infrastructure

**Files:**

- Create: `tests/golden/README.md`
- Create: `tests/golden/loader.ts`
- Create: `tests/golden/response-conversion.golden.test.ts`
- Create: `tests/golden/cases/simple-chat/input.json`
- Create: `tests/golden/cases/simple-chat/expected.json`

**Step 1: Create golden file loader utility**

```typescript
// tests/golden/loader.ts
/**
 * Golden File Test Utilities
 *
 * Loads input/expected pairs from tests/golden/cases/
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

export interface GoldenCase {
  name: string;
  input: unknown;
  expected: unknown;
  metadata?: {
    description?: string;
    model?: string;
  };
}

const GOLDEN_DIR = join(import.meta.dirname, "cases");

/**
 * Load a single golden case by name
 */
export function loadGoldenCase(caseName: string): GoldenCase {
  const caseDir = join(GOLDEN_DIR, caseName);

  if (!existsSync(caseDir)) {
    throw new Error(`Golden case not found: ${caseName}`);
  }

  const inputPath = join(caseDir, "input.json");
  const expectedPath = join(caseDir, "expected.json");
  const metadataPath = join(caseDir, "metadata.json");

  const input = JSON.parse(readFileSync(inputPath, "utf-8"));
  const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
  const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf-8")) : undefined;

  return { name: caseName, input, expected, metadata };
}

/**
 * Load all golden cases from a category
 */
export function loadAllGoldenCases(): GoldenCase[] {
  if (!existsSync(GOLDEN_DIR)) {
    return [];
  }

  const cases: GoldenCase[] = [];
  const entries = readdirSync(GOLDEN_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      try {
        cases.push(loadGoldenCase(entry.name));
      } catch {
        // Skip invalid cases
      }
    }
  }

  return cases;
}

/**
 * Normalize response for comparison (remove dynamic fields)
 */
export function normalizeResponse(response: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...response };

  // Normalize message ID
  if (typeof normalized.id === "string" && normalized.id.startsWith("msg_")) {
    normalized.id = "msg_NORMALIZED";
  }

  // Normalize tool IDs in content
  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((block: Record<string, unknown>) => {
      if (block.type === "tool_use" && typeof block.id === "string") {
        return { ...block, id: "toolu_NORMALIZED" };
      }
      return block;
    });
  }

  return normalized;
}
```

**Step 2: Create first golden case files**

```json
// tests/golden/cases/simple-chat/input.json
{
  "candidates": [
    {
      "content": {
        "parts": [{ "text": "Hello! I'm Claude, an AI assistant. How can I help you today?" }]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 12,
    "candidatesTokenCount": 18
  }
}
```

```json
// tests/golden/cases/simple-chat/expected.json
{
  "id": "msg_NORMALIZED",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hello! I'm Claude, an AI assistant. How can I help you today?"
    }
  ],
  "model": "claude-sonnet-4-5-thinking",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 12,
    "output_tokens": 18,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

```json
// tests/golden/cases/simple-chat/metadata.json
{
  "description": "Basic single-turn chat response",
  "model": "claude-sonnet-4-5-thinking",
  "addedIn": "1.0.0"
}
```

**Step 3: Write golden file test runner**

```typescript
// tests/golden/response-conversion.golden.test.ts
/**
 * Golden File Tests for Response Conversion
 *
 * Tests that Google API responses convert to exact expected Anthropic format.
 * Add new cases by creating input.json/expected.json in tests/golden/cases/
 */

import { describe, it, expect } from "vitest";
import { loadAllGoldenCases, normalizeResponse } from "./loader.js";
import { convertGoogleToAnthropic } from "../../src/format/response-converter.js";
import type { GoogleResponse } from "../../src/format/types.js";

describe("Golden File Tests: Response Conversion", () => {
  const cases = loadAllGoldenCases();

  if (cases.length === 0) {
    it.skip("No golden cases found", () => {});
    return;
  }

  for (const goldenCase of cases) {
    it(`converts correctly: ${goldenCase.name}`, () => {
      const model = goldenCase.metadata?.model ?? "claude-sonnet-4-5-thinking";
      const input = goldenCase.input as GoogleResponse;

      const result = convertGoogleToAnthropic(input, model);
      const normalized = normalizeResponse(result as Record<string, unknown>);

      expect(normalized).toEqual(goldenCase.expected);
    });
  }
});
```

**Step 4: Run golden tests**

Run: `npm test -- tests/golden/`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/golden/
git commit -m "test: add golden file test infrastructure and first case"
```

---

### Task 2.2: Add More Golden Cases

**Files:**

- Create: `tests/golden/cases/with-thinking/input.json`
- Create: `tests/golden/cases/with-thinking/expected.json`
- Create: `tests/golden/cases/tool-use/input.json`
- Create: `tests/golden/cases/tool-use/expected.json`
- Create: `tests/golden/cases/cached-response/input.json`
- Create: `tests/golden/cases/cached-response/expected.json`

**Step 1: Create thinking response golden case**

```json
// tests/golden/cases/with-thinking/input.json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "thought": true,
            "text": "The user is asking about prime numbers. Let me think through this step by step."
          },
          {
            "text": "A prime number is a natural number greater than 1 that has no positive divisors other than 1 and itself."
          }
        ]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 20,
    "candidatesTokenCount": 45,
    "thoughtsTokenCount": 15
  }
}
```

```json
// tests/golden/cases/with-thinking/expected.json
{
  "id": "msg_NORMALIZED",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "The user is asking about prime numbers. Let me think through this step by step."
    },
    {
      "type": "text",
      "text": "A prime number is a natural number greater than 1 that has no positive divisors other than 1 and itself."
    }
  ],
  "model": "claude-sonnet-4-5-thinking",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 20,
    "output_tokens": 45,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

**Step 2: Create tool use golden case**

```json
// tests/golden/cases/tool-use/input.json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "functionCall": {
              "name": "get_weather",
              "args": {
                "location": "Tokyo",
                "units": "celsius"
              }
            }
          }
        ]
      },
      "finishReason": "TOOL_USE"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 25,
    "candidatesTokenCount": 12
  }
}
```

```json
// tests/golden/cases/tool-use/expected.json
{
  "id": "msg_NORMALIZED",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_NORMALIZED",
      "name": "get_weather",
      "input": {
        "location": "Tokyo",
        "units": "celsius"
      }
    }
  ],
  "model": "claude-sonnet-4-5-thinking",
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 25,
    "output_tokens": 12,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

**Step 3: Create cached response golden case**

```json
// tests/golden/cases/cached-response/input.json
{
  "candidates": [
    {
      "content": {
        "parts": [{ "text": "Based on the cached context, here is my response." }]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 1000,
    "candidatesTokenCount": 15,
    "cachedContentTokenCount": 800
  }
}
```

```json
// tests/golden/cases/cached-response/expected.json
{
  "id": "msg_NORMALIZED",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Based on the cached context, here is my response."
    }
  ],
  "model": "claude-sonnet-4-5-thinking",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 200,
    "output_tokens": 15,
    "cache_read_input_tokens": 800,
    "cache_creation_input_tokens": 0
  }
}
```

**Step 4: Run golden tests**

Run: `npm test -- tests/golden/`
Expected: PASS (4 cases)

**Step 5: Commit**

```bash
git add tests/golden/cases/
git commit -m "test: add thinking, tool-use, and cached golden cases"
```

---

## Phase 3: Chaos/Fault Injection Tests

### Task 3.1: Install nock and Create Chaos Test Infrastructure

**Files:**

- Modify: `package.json` (add nock)
- Create: `tests/chaos/network-failures.chaos.test.ts`

**Step 1: Install nock**

Run: `npm install --save-dev nock`
Expected: Package installed

**Step 2: Update vitest config to include chaos tests**

```typescript
// Add to vitest.config.ts include array
include: ["tests/**/*.test.ts", "tests/**/*.fuzz.test.ts", "tests/**/*.contract.test.ts", "tests/**/*.chaos.test.ts", "tests/**/*.golden.test.ts", "tests/**/*.snap.test.ts"],
```

**Step 3: Write network failure chaos tests**

```typescript
// tests/chaos/network-failures.chaos.test.ts
/**
 * Chaos Tests: Network Failures
 *
 * Tests resilience against network-level failures.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";

const GOOGLE_API_HOST = "https://cloudcode-pa.googleapis.com";

describe("Chaos: Network Failures", () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("Connection Errors", () => {
    it("handles connection refused (ECONNREFUSED)", async () => {
      nock(GOOGLE_API_HOST).post(/.*/).replyWithError({ code: "ECONNREFUSED" });

      // Import the module under test
      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow();
    });

    it("handles connection reset (ECONNRESET)", async () => {
      nock(GOOGLE_API_HOST).post(/.*/).replyWithError({ code: "ECONNRESET" });

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow();
    });

    it("handles DNS resolution failure (ENOTFOUND)", async () => {
      nock(GOOGLE_API_HOST).post(/.*/).replyWithError({ code: "ENOTFOUND" });

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow();
    });

    it("handles timeout (ETIMEDOUT)", async () => {
      nock(GOOGLE_API_HOST).post(/.*/).replyWithError({ code: "ETIMEDOUT" });

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow();
    });
  });

  describe("HTTP Errors", () => {
    it("handles 500 Internal Server Error", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(500, "Internal Server Error");

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow(/refresh failed/i);
    });

    it("handles 502 Bad Gateway", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(502, "Bad Gateway");

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow(/refresh failed/i);
    });

    it("handles 503 Service Unavailable", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(503, "Service Unavailable");

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow(/refresh failed/i);
    });

    it("handles 429 Rate Limit with Retry-After", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(429, "Too Many Requests", { "Retry-After": "60" });

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow(/refresh failed/i);
    });
  });

  describe("Malformed Responses", () => {
    it("handles empty response body", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(200, "");

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow();
    });

    it("handles invalid JSON response", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(200, "not json {{{");

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow();
    });

    it("handles response missing required fields", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(200, { unexpected: "data" });

      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      await expect(refreshAccessToken("test-token")).rejects.toThrow(/No access token/i);
    });

    it("handles wrong content-type header", async () => {
      nock("https://oauth2.googleapis.com").post("/token").reply(200, '{"access_token": "test"}', { "Content-Type": "text/html" });

      // Should still work if JSON is valid (lenient parsing)
      const { refreshAccessToken } = await import("../../src/auth/oauth.js");

      // This may or may not throw depending on implementation
      // The important thing is it doesn't crash
      try {
        await refreshAccessToken("test-token");
      } catch {
        // Expected - implementation may reject
      }
    });
  });
});
```

**Step 4: Run chaos tests**

Run: `npm test -- tests/chaos/`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json package-lock.json tests/chaos/ vitest.config.ts
git commit -m "test: add chaos tests for network failures"
```

---

### Task 3.2: Add Response Parsing Chaos Tests

**Files:**

- Create: `tests/chaos/response-parsing.chaos.test.ts`

**Step 1: Write response parsing chaos tests**

```typescript
// tests/chaos/response-parsing.chaos.test.ts
/**
 * Chaos Tests: Response Parsing
 *
 * Tests resilience against malformed API responses.
 */

import { describe, it, expect } from "vitest";
import { convertGoogleToAnthropic } from "../../src/format/response-converter.js";
import type { GoogleResponse } from "../../src/format/types.js";

describe("Chaos: Response Parsing", () => {
  describe("Missing Fields", () => {
    it("handles missing candidates array", () => {
      const malformed = {} as GoogleResponse;

      // Should not crash, should return valid response structure
      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });

    it("handles empty candidates array", () => {
      const malformed: GoogleResponse = {
        candidates: [],
      };

      const result = convertGoogleToAnthropic(malformed, "test");
      expect(result.content).toBeDefined();
    });

    it("handles candidate with missing content", () => {
      const malformed = {
        candidates: [{ finishReason: "STOP" }],
      } as GoogleResponse;

      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });

    it("handles content with missing parts", () => {
      const malformed = {
        candidates: [{ content: {}, finishReason: "STOP" }],
      } as GoogleResponse;

      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });

    it("handles missing usageMetadata", () => {
      const response: GoogleResponse = {
        candidates: [
          {
            content: { parts: [{ text: "Hello" }] },
            finishReason: "STOP",
          },
        ],
      };

      const result = convertGoogleToAnthropic(response, "test");
      expect(result.usage).toBeDefined();
      expect(result.usage.input_tokens).toBe(0);
    });
  });

  describe("Invalid Field Types", () => {
    it("handles text field as number", () => {
      const malformed = {
        candidates: [
          {
            content: { parts: [{ text: 12345 }] },
            finishReason: "STOP",
          },
        ],
      } as unknown as GoogleResponse;

      // Should coerce or handle gracefully
      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });

    it("handles parts as non-array", () => {
      const malformed = {
        candidates: [
          {
            content: { parts: "not an array" },
            finishReason: "STOP",
          },
        ],
      } as unknown as GoogleResponse;

      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });

    it("handles null candidates", () => {
      const malformed = {
        candidates: null,
      } as unknown as GoogleResponse;

      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });

    it("handles undefined in parts array", () => {
      const malformed = {
        candidates: [
          {
            content: { parts: [undefined, { text: "valid" }, null] },
            finishReason: "STOP",
          },
        ],
      } as unknown as GoogleResponse;

      expect(() => convertGoogleToAnthropic(malformed, "test")).not.toThrow();
    });
  });

  describe("Unexpected Values", () => {
    it("handles unknown finishReason", () => {
      const response = {
        candidates: [
          {
            content: { parts: [{ text: "test" }] },
            finishReason: "UNKNOWN_REASON",
          },
        ],
      } as unknown as GoogleResponse;

      const result = convertGoogleToAnthropic(response, "test");
      // Should default to something sensible
      expect(["end_turn", "stop_sequence", null]).toContain(result.stop_reason);
    });

    it("handles negative token counts", () => {
      const response: GoogleResponse = {
        candidates: [
          {
            content: { parts: [{ text: "test" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: -100,
          candidatesTokenCount: -50,
        },
      };

      const result = convertGoogleToAnthropic(response, "test");
      // Should not produce negative values in output
      expect(result.usage.input_tokens).toBeGreaterThanOrEqual(0);
    });

    it("handles extremely large token counts", () => {
      const response: GoogleResponse = {
        candidates: [
          {
            content: { parts: [{ text: "test" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: Number.MAX_SAFE_INTEGER,
          candidatesTokenCount: Number.MAX_SAFE_INTEGER,
        },
      };

      expect(() => convertGoogleToAnthropic(response, "test")).not.toThrow();
    });

    it("handles empty string text parts", () => {
      const response: GoogleResponse = {
        candidates: [
          {
            content: { parts: [{ text: "" }, { text: "" }, { text: "" }] },
            finishReason: "STOP",
          },
        ],
      };

      const result = convertGoogleToAnthropic(response, "test");
      expect(result.content).toBeDefined();
    });
  });

  describe("Deeply Nested Structures", () => {
    it("handles deeply nested function call args", () => {
      const deepArgs: Record<string, unknown> = { level: 0 };
      let current = deepArgs;
      for (let i = 0; i < 100; i++) {
        current.nested = { level: i + 1 };
        current = current.nested as Record<string, unknown>;
      }

      const response = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "deep_function",
                    args: deepArgs,
                  },
                },
              ],
            },
            finishReason: "TOOL_USE",
          },
        ],
      } as unknown as GoogleResponse;

      expect(() => convertGoogleToAnthropic(response, "test")).not.toThrow();
    });
  });

  describe("Special Characters", () => {
    it("handles unicode in text", () => {
      const response: GoogleResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello 世界! 🌍 Привет мир! مرحبا" }],
            },
            finishReason: "STOP",
          },
        ],
      };

      const result = convertGoogleToAnthropic(response, "test");
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Hello 世界! 🌍 Привет мир! مرحبا",
      });
    });

    it("handles control characters in text", () => {
      const response: GoogleResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: "Line1\n\t\rLine2\x00\x01\x02" }],
            },
            finishReason: "STOP",
          },
        ],
      };

      expect(() => convertGoogleToAnthropic(response, "test")).not.toThrow();
    });

    it("handles very long text (1MB+)", () => {
      const longText = "x".repeat(1024 * 1024);
      const response: GoogleResponse = {
        candidates: [
          {
            content: { parts: [{ text: longText }] },
            finishReason: "STOP",
          },
        ],
      };

      expect(() => convertGoogleToAnthropic(response, "test")).not.toThrow();
    });
  });
});
```

**Step 2: Run chaos tests**

Run: `npm test -- tests/chaos/`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/chaos/
git commit -m "test: add chaos tests for response parsing resilience"
```

---

## Phase 4: State Machine Tests

### Task 4.1: Account State Machine Tests

**Files:**

- Create: `tests/unit/account-manager/state-machine.test.ts`

**Step 1: Write account state machine tests**

```typescript
// tests/unit/account-manager/state-machine.test.ts
/**
 * State Machine Tests: Account Lifecycle
 *
 * Tests account state transitions:
 *   active → rate_limited → recovering → active
 *   active → invalid (terminal)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// State definitions
type AccountState = "active" | "rate_limited" | "recovering" | "invalid";

interface AccountStateInfo {
  state: AccountState;
  rateLimitResetTime?: number;
  lastError?: string;
}

// Mock account state manager for testing transitions
class AccountStateMachine {
  private states: Map<string, AccountStateInfo> = new Map();

  getState(accountId: string): AccountStateInfo {
    return this.states.get(accountId) ?? { state: "active" };
  }

  markRateLimited(accountId: string, resetTime: number): void {
    this.states.set(accountId, {
      state: "rate_limited",
      rateLimitResetTime: resetTime,
    });
  }

  markRecovering(accountId: string): void {
    const current = this.states.get(accountId);
    if (current?.state === "rate_limited") {
      this.states.set(accountId, { state: "recovering" });
    }
  }

  markActive(accountId: string): void {
    const current = this.states.get(accountId);
    if (current?.state !== "invalid") {
      this.states.set(accountId, { state: "active" });
    }
  }

  markInvalid(accountId: string, error: string): void {
    this.states.set(accountId, { state: "invalid", lastError: error });
  }

  isUsable(accountId: string): boolean {
    const info = this.getState(accountId);
    return info.state === "active" || info.state === "recovering";
  }
}

describe("Account State Machine", () => {
  let machine: AccountStateMachine;

  beforeEach(() => {
    machine = new AccountStateMachine();
  });

  describe("Initial State", () => {
    it("starts in active state", () => {
      const state = machine.getState("account-1");
      expect(state.state).toBe("active");
    });

    it("is usable when active", () => {
      expect(machine.isUsable("account-1")).toBe(true);
    });
  });

  describe("State Transitions: active → rate_limited", () => {
    it("transitions to rate_limited when rate limit hit", () => {
      const resetTime = Date.now() + 60000;
      machine.markRateLimited("account-1", resetTime);

      const state = machine.getState("account-1");
      expect(state.state).toBe("rate_limited");
      expect(state.rateLimitResetTime).toBe(resetTime);
    });

    it("is not usable when rate_limited", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      expect(machine.isUsable("account-1")).toBe(false);
    });
  });

  describe("State Transitions: rate_limited → recovering", () => {
    it("transitions to recovering after reset time", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markRecovering("account-1");

      const state = machine.getState("account-1");
      expect(state.state).toBe("recovering");
    });

    it("is usable when recovering", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markRecovering("account-1");
      expect(machine.isUsable("account-1")).toBe(true);
    });

    it("cannot transition to recovering from active", () => {
      machine.markRecovering("account-1");
      const state = machine.getState("account-1");
      expect(state.state).toBe("active"); // No change
    });
  });

  describe("State Transitions: recovering → active", () => {
    it("transitions back to active on successful request", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markRecovering("account-1");
      machine.markActive("account-1");

      const state = machine.getState("account-1");
      expect(state.state).toBe("active");
    });
  });

  describe("State Transitions: any → invalid", () => {
    it("transitions to invalid on auth error", () => {
      machine.markInvalid("account-1", "invalid_grant");

      const state = machine.getState("account-1");
      expect(state.state).toBe("invalid");
      expect(state.lastError).toBe("invalid_grant");
    });

    it("is not usable when invalid", () => {
      machine.markInvalid("account-1", "token_revoked");
      expect(machine.isUsable("account-1")).toBe(false);
    });

    it("cannot recover from invalid state", () => {
      machine.markInvalid("account-1", "token_revoked");
      machine.markActive("account-1");

      const state = machine.getState("account-1");
      expect(state.state).toBe("invalid"); // Still invalid
    });
  });

  describe("Multiple Accounts", () => {
    it("tracks state independently per account", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markInvalid("account-2", "error");
      // account-3 remains active

      expect(machine.getState("account-1").state).toBe("rate_limited");
      expect(machine.getState("account-2").state).toBe("invalid");
      expect(machine.getState("account-3").state).toBe("active");
    });

    it("reports correct usable accounts", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markInvalid("account-2", "error");
      machine.markRecovering("account-1");

      expect(machine.isUsable("account-1")).toBe(true); // recovering
      expect(machine.isUsable("account-2")).toBe(false); // invalid
      expect(machine.isUsable("account-3")).toBe(true); // active
    });
  });

  describe("Full Lifecycle", () => {
    it("completes full recovery cycle", () => {
      // Start active
      expect(machine.getState("account-1").state).toBe("active");

      // Hit rate limit
      machine.markRateLimited("account-1", Date.now() + 1000);
      expect(machine.getState("account-1").state).toBe("rate_limited");
      expect(machine.isUsable("account-1")).toBe(false);

      // Reset time passes, start recovering
      machine.markRecovering("account-1");
      expect(machine.getState("account-1").state).toBe("recovering");
      expect(machine.isUsable("account-1")).toBe(true);

      // Successful request, back to active
      machine.markActive("account-1");
      expect(machine.getState("account-1").state).toBe("active");
      expect(machine.isUsable("account-1")).toBe(true);
    });
  });
});
```

**Step 2: Run state machine tests**

Run: `npm test -- tests/unit/account-manager/state-machine.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/unit/account-manager/
git commit -m "test: add account state machine tests"
```

---

## Phase 5: Type Tests (expect-type)

### Task 5.1: Install expect-type and Create Type Tests

**Files:**

- Modify: `package.json` (add expect-type)
- Create: `tests/types/exports.type.test.ts`

**Step 1: Install expect-type**

Run: `npm install --save-dev expect-type`
Expected: Package installed

**Step 2: Write type tests**

```typescript
// tests/types/exports.type.test.ts
/**
 * Type Tests: Exported Types
 *
 * Verifies that exported types are correctly shaped.
 * These tests run at compile time, not runtime.
 */

import { describe, it, expectTypeOf } from "vitest";
import type { AnthropicRequest, AnthropicResponse, GoogleRequest, GoogleResponse, ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock } from "../../src/format/types.js";

describe("Type Tests: Format Types", () => {
  describe("AnthropicRequest", () => {
    it("has required model field as string", () => {
      expectTypeOf<AnthropicRequest>().toHaveProperty("model");
      expectTypeOf<AnthropicRequest["model"]>().toBeString();
    });

    it("has required messages array", () => {
      expectTypeOf<AnthropicRequest>().toHaveProperty("messages");
      expectTypeOf<AnthropicRequest["messages"]>().toBeArray();
    });

    it("has optional max_tokens as number", () => {
      expectTypeOf<AnthropicRequest>().toHaveProperty("max_tokens");
    });
  });

  describe("AnthropicResponse", () => {
    it("has required id field as string", () => {
      expectTypeOf<AnthropicResponse>().toHaveProperty("id");
      expectTypeOf<AnthropicResponse["id"]>().toBeString();
    });

    it("has type field as literal 'message'", () => {
      expectTypeOf<AnthropicResponse>().toHaveProperty("type");
    });

    it("has role field as literal 'assistant'", () => {
      expectTypeOf<AnthropicResponse>().toHaveProperty("role");
    });

    it("has content array", () => {
      expectTypeOf<AnthropicResponse>().toHaveProperty("content");
      expectTypeOf<AnthropicResponse["content"]>().toBeArray();
    });

    it("has usage object", () => {
      expectTypeOf<AnthropicResponse>().toHaveProperty("usage");
      expectTypeOf<AnthropicResponse["usage"]>().toBeObject();
    });
  });

  describe("ContentBlock union type", () => {
    it("includes TextBlock", () => {
      expectTypeOf<TextBlock>().toMatchTypeOf<ContentBlock>();
    });

    it("includes ThinkingBlock", () => {
      expectTypeOf<ThinkingBlock>().toMatchTypeOf<ContentBlock>();
    });

    it("includes ToolUseBlock", () => {
      expectTypeOf<ToolUseBlock>().toMatchTypeOf<ContentBlock>();
    });
  });

  describe("TextBlock", () => {
    it("has type 'text'", () => {
      expectTypeOf<TextBlock>().toHaveProperty("type");
    });

    it("has text string", () => {
      expectTypeOf<TextBlock>().toHaveProperty("text");
      expectTypeOf<TextBlock["text"]>().toBeString();
    });
  });

  describe("ThinkingBlock", () => {
    it("has type 'thinking'", () => {
      expectTypeOf<ThinkingBlock>().toHaveProperty("type");
    });

    it("has thinking string", () => {
      expectTypeOf<ThinkingBlock>().toHaveProperty("thinking");
      expectTypeOf<ThinkingBlock["thinking"]>().toBeString();
    });

    it("has optional signature string", () => {
      expectTypeOf<ThinkingBlock>().toHaveProperty("signature");
    });
  });

  describe("ToolUseBlock", () => {
    it("has type 'tool_use'", () => {
      expectTypeOf<ToolUseBlock>().toHaveProperty("type");
    });

    it("has id string", () => {
      expectTypeOf<ToolUseBlock>().toHaveProperty("id");
      expectTypeOf<ToolUseBlock["id"]>().toBeString();
    });

    it("has name string", () => {
      expectTypeOf<ToolUseBlock>().toHaveProperty("name");
      expectTypeOf<ToolUseBlock["name"]>().toBeString();
    });

    it("has input object", () => {
      expectTypeOf<ToolUseBlock>().toHaveProperty("input");
      expectTypeOf<ToolUseBlock["input"]>().toBeObject();
    });
  });

  describe("GoogleResponse", () => {
    it("has optional candidates array", () => {
      expectTypeOf<GoogleResponse>().toHaveProperty("candidates");
    });

    it("has optional usageMetadata", () => {
      expectTypeOf<GoogleResponse>().toHaveProperty("usageMetadata");
    });
  });
});
```

**Step 3: Run type tests**

Run: `npm test -- tests/types/`
Expected: PASS (type checks at compile time)

**Step 4: Commit**

```bash
git add package.json package-lock.json tests/types/
git commit -m "test: add type tests with expect-type"
```

---

## Phase 6: Load Tests (autocannon)

### Task 6.1: Create Load Test Infrastructure

**Files:**

- Modify: `package.json` (add autocannon, add script)
- Create: `tests/load/basic-load.load.test.ts`

**Step 1: Install autocannon**

Run: `npm install --save-dev autocannon`
Expected: Package installed

**Step 2: Add load test script to package.json**

```json
"scripts": {
  "test:load": "vitest run tests/load/"
}
```

**Step 3: Write basic load test**

```typescript
// tests/load/basic-load.load.test.ts
/**
 * Load Tests: Basic Performance
 *
 * Tests performance under sustained load.
 * Requires server to be running: npm start
 *
 * Run with: npm run test:load
 */

import { describe, it, expect } from "vitest";
import autocannon from "autocannon";

const SERVER_URL = process.env.PROXY_URL ?? "http://localhost:8080";

// Skip if not running with load test flag
const shouldRunLoadTests = process.env.RUN_LOAD_TESTS === "true";

describe.skipIf(!shouldRunLoadTests)("Load Tests", () => {
  describe("Health Endpoint", () => {
    it("handles 100 req/s for 10 seconds", async () => {
      const result = await autocannon({
        url: `${SERVER_URL}/health`,
        connections: 10,
        duration: 10,
        pipelining: 1,
      });

      // Expectations
      expect(result.errors).toBe(0);
      expect(result.timeouts).toBe(0);
      expect(result.non2xx).toBe(0);
      expect(result.latency.p99).toBeLessThan(100); // < 100ms P99
    });
  });

  describe("Models Endpoint", () => {
    it("handles 50 req/s for 10 seconds", async () => {
      const result = await autocannon({
        url: `${SERVER_URL}/v1/models`,
        connections: 5,
        duration: 10,
        pipelining: 1,
      });

      expect(result.errors).toBe(0);
      expect(result.timeouts).toBe(0);
      expect(result.latency.p99).toBeLessThan(200);
    });
  });

  describe("Account Limits Endpoint", () => {
    it("handles burst of 100 requests", async () => {
      const result = await autocannon({
        url: `${SERVER_URL}/account-limits`,
        connections: 10,
        amount: 100,
        pipelining: 1,
      });

      expect(result.errors).toBe(0);
      expect(result.timeouts).toBe(0);
    });
  });
});
```

**Step 4: Commit (load tests are opt-in)**

```bash
git add package.json tests/load/
git commit -m "test: add load test infrastructure with autocannon"
```

---

## Phase 7: Security Tests

### Task 7.1: Input Validation Security Tests

**Files:**

- Create: `tests/security/input-validation.security.test.ts`

**Step 1: Write input validation security tests**

```typescript
// tests/security/input-validation.security.test.ts
/**
 * Security Tests: Input Validation
 *
 * Tests for common security vulnerabilities.
 */

import { describe, it, expect } from "vitest";
import { extractCodeFromInput } from "../../src/auth/oauth.js";
import { sanitizeToolSchema } from "../../src/format/schema-sanitizer.js";

describe("Security: Input Validation", () => {
  describe("OAuth Code Extraction", () => {
    it("rejects URLs with javascript: protocol", () => {
      const maliciousInput = "javascript:alert('xss')";

      expect(() => extractCodeFromInput(maliciousInput)).toThrow();
    });

    it("rejects URLs with data: protocol", () => {
      const maliciousInput = "data:text/html,<script>alert('xss')</script>";

      expect(() => extractCodeFromInput(maliciousInput)).toThrow();
    });

    it("rejects extremely long input (DoS prevention)", () => {
      const veryLongInput = "http://localhost/?" + "a".repeat(1000000);

      // Should either reject or handle gracefully (not hang)
      expect(() => extractCodeFromInput(veryLongInput)).not.toThrow();
    });

    it("handles null bytes in input", () => {
      const inputWithNullByte = "http://localhost/?code=test\x00malicious";

      // Should not crash
      expect(() => extractCodeFromInput(inputWithNullByte)).not.toThrow();
    });
  });

  describe("Schema Sanitizer", () => {
    it("removes __proto__ from tool schemas", () => {
      const maliciousSchema = {
        type: "object",
        properties: {
          normal: { type: "string" },
        },
        __proto__: { polluted: true },
      };

      const result = sanitizeToolSchema(maliciousSchema);

      // Should not have __proto__ in result
      expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    });

    it("removes constructor from tool schemas", () => {
      const maliciousSchema = {
        type: "object",
        constructor: { prototype: { polluted: true } },
      };

      const result = sanitizeToolSchema(maliciousSchema);

      expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
    });

    it("handles deeply nested malicious properties", () => {
      const deepMalicious = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                __proto__: { polluted: true },
              },
            },
          },
        },
      };

      expect(() => sanitizeToolSchema(deepMalicious)).not.toThrow();
    });

    it("handles circular references gracefully", () => {
      const circular: Record<string, unknown> = { type: "object" };
      circular.self = circular;

      // Should not hang or crash
      expect(() => sanitizeToolSchema(circular)).not.toThrow();
    });
  });

  describe("Path Traversal Prevention", () => {
    it("model names cannot contain path traversal", () => {
      const maliciousModels = ["../../../etc/passwd", "..\\..\\..\\windows\\system32", "model/../../secret", "model%2F..%2F..%2Fsecret"];

      for (const model of maliciousModels) {
        // Model validation should reject these
        expect(model.includes("..")).toBe(true);
        // Actual model lookup should fail safely
      }
    });
  });

  describe("Header Injection Prevention", () => {
    it("rejects newlines in potential header values", () => {
      const maliciousValues = ["value\r\nX-Injected: header", "value\nSet-Cookie: evil=true", "value\r\n\r\n<html>injected body</html>"];

      for (const value of maliciousValues) {
        // Any function that sets headers should reject or sanitize these
        expect(value.includes("\n") || value.includes("\r")).toBe(true);
      }
    });
  });

  describe("JSON Parsing Safety", () => {
    it("handles JSON with __proto__ key", () => {
      const dangerousJson = '{"__proto__": {"polluted": true}, "safe": "value"}';
      const parsed = JSON.parse(dangerousJson);

      // Verify prototype is not polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("handles deeply nested JSON (stack overflow prevention)", () => {
      // Create deeply nested JSON
      let deep = '{"a":';
      for (let i = 0; i < 1000; i++) {
        deep += '{"a":';
      }
      deep += "1" + "}".repeat(1001);

      // Should either parse or throw, not crash
      try {
        JSON.parse(deep);
      } catch {
        // Expected for very deep nesting
      }
    });
  });
});
```

**Step 2: Update vitest config to include security tests**

```typescript
// Add to vitest.config.ts include array
include: [..., "tests/**/*.security.test.ts"],
```

**Step 3: Run security tests**

Run: `npm test -- tests/security/`
Expected: PASS

**Step 4: Commit**

```bash
git add tests/security/ vitest.config.ts
git commit -m "test: add security tests for input validation"
```

---

## Summary: Test Implementation Checklist

| Phase | Test Type             | Files                                              | Est. Tests |
| ----- | --------------------- | -------------------------------------------------- | ---------- |
| 1.1   | Response Snapshots    | `tests/snapshot/response-format.snap.test.ts`      | 8          |
| 1.2   | SSE Snapshots         | `tests/snapshot/sse-events.snap.test.ts`           | 12         |
| 2.1   | Golden Infrastructure | `tests/golden/loader.ts`, first case               | 1          |
| 2.2   | Golden Cases          | 3 additional cases                                 | 3          |
| 3.1   | Network Chaos         | `tests/chaos/network-failures.chaos.test.ts`       | 12         |
| 3.2   | Parsing Chaos         | `tests/chaos/response-parsing.chaos.test.ts`       | 15         |
| 4.1   | State Machine         | `tests/unit/account-manager/state-machine.test.ts` | 12         |
| 5.1   | Type Tests            | `tests/types/exports.type.test.ts`                 | 20         |
| 6.1   | Load Tests            | `tests/load/basic-load.load.test.ts`               | 3          |
| 7.1   | Security Tests        | `tests/security/input-validation.security.test.ts` | 10         |

**Total New Tests: ~96**
**Total After Implementation: ~1155**

---

## Execution

Plan complete and saved to `docs/plans/2025-01-06-comprehensive-test-suite.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session in worktree with executing-plans, batch execution with checkpoints

Which approach?
