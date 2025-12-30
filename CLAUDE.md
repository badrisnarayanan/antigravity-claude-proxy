# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude models (`claude-sonnet-4-5-thinking`, `claude-opus-4-5-thinking`) and Gemini models (`gemini-3-flash`, `gemini-3-pro-low`, `gemini-3-pro-high`) with Claude Code CLI.

The proxy translates requests from Anthropic Messages API format → Google Generative AI format → Antigravity Cloud Code API, then converts responses back to Anthropic format with full thinking/streaming support.

## Commands

```bash
# Install dependencies
npm install

# Start server (runs on port 8080 by default)
npm start
# Start on custom port
npm start -- --port 9000
PORT=9000 npm start

# Start with file watching for development
npm run dev

# Account management
npm run accounts         # Interactive account management
npm run accounts:add     # Add a new Google account via OAuth
npm run accounts:list    # List configured accounts
npm run accounts:verify  # Verify account tokens are valid

# Run all tests (server must be running)
npm test
# Run tests on custom port
PORT=9000 npm test

# Run individual tests
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
```

## Architecture

**Request Flow:**
```
Claude Code CLI → Express Server (server.js) → CloudCode Client → Antigravity Cloud Code API
```

**Key Modules:**

- **src/server.js**: Express server exposing Anthropic-compatible endpoints (`/v1/messages`, `/v1/models`, `/health`, `/account-limits`)
- **src/cloudcode-client.js**: Makes requests to Antigravity Cloud Code API with retry/failover logic, handles both streaming and non-streaming
- **src/format/**: Format conversion module (Anthropic ↔ Google Generative AI)
  - `index.js` - Re-exports all converters
  - `request-converter.js` - Anthropic → Google request conversion
  - `response-converter.js` - Google → Anthropic response conversion
  - `content-converter.js` - Message content and role conversion
  - `schema-sanitizer.js` - JSON Schema cleaning for Gemini API compatibility (preserves constraints/enums as hints)
  - `thinking-utils.js` - Thinking block validation, filtering, reordering, and recovery logic
  - `signature-cache.js` - In-memory cache for Gemini thoughtSignatures
- **src/account-manager.js**: Multi-account pool with sticky selection, rate limit handling, and automatic cooldown
- **src/oauth.js**: Google OAuth implementation for adding accounts
- **src/token-extractor.js**: Extracts tokens from local Antigravity app installation (legacy single-account mode)
- **src/constants.js**: API endpoints, model mappings, OAuth config, and all configuration values
- **src/errors.js**: Custom error classes (`RateLimitError`, `AuthError`, `ApiError`, etc.) for structured error handling
- **src/utils/helpers.js**: Shared utility functions (`formatDuration`, `sleep`)

**Multi-Account Load Balancing:**
- Sticky account selection for prompt caching (stays on same account across turns)
- Automatic switch only when rate-limited for > 2 minutes
- Session ID derived from first user message hash for cache continuity
- Account state persisted to `~/.config/antigravity-proxy/accounts.json`

**Prompt Caching:**
- Cache is organization-scoped (requires same account + session ID)
- Session ID is SHA256 hash of first user message content (stable across turns)
- `cache_read_input_tokens` returned in usage metadata when cache hits
- Token calculation: `input_tokens = promptTokenCount - cachedContentTokenCount`

## Testing Notes

- Tests require the server to be running (`npm start` in separate terminal)
- Tests are CommonJS files (`.cjs`) that make HTTP requests to the local proxy
- Shared test utilities are in `tests/helpers/http-client.cjs`
- Test runner supports filtering: `node tests/run-all.cjs <filter>` to run matching tests

## Code Organization

**Constants:** All configuration values are centralized in `src/constants.js`:
- API endpoints and headers
- Model mappings and model family detection (`getModelFamily()`, `isThinkingModel()`)
- OAuth configuration
- Rate limit thresholds
- Thinking model settings

**Model Family Handling:**
- `getModelFamily(model)` returns `'claude'` or `'gemini'` based on model name
- Claude models use `signature` field on thinking blocks
- Gemini models use `thoughtSignature` field on functionCall parts (cached or sentinel value)
- When Claude Code strips `thoughtSignature`, the proxy tries to restore from cache, then falls back to `skip_thought_signature_validator`

**Error Handling:** Use custom error classes from `src/errors.js`:
- `RateLimitError` - 429/RESOURCE_EXHAUSTED errors
- `AuthError` - Authentication failures
- `ApiError` - Upstream API errors
- Helper functions: `isRateLimitError()`, `isAuthError()`

**Utilities:** Shared helpers in `src/utils/helpers.js`:
- `formatDuration(ms)` - Format milliseconds as "1h23m45s"
- `sleep(ms)` - Promise-based delay

## Maintenance

When making significant changes to the codebase (new modules, refactoring, architectural changes), update this CLAUDE.md and the README.md file to keep documentation in sync.
