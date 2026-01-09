# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude models (`claude-sonnet-4-5-thinking`, `claude-opus-4-5-thinking`) and Gemini models (`gemini-3-flash`, `gemini-3-pro-low`, `gemini-3-pro-high`) with Claude Code CLI.

The proxy translates requests from Anthropic Messages API format → Google Generative AI format → Antigravity Cloud Code API, then converts responses back to Anthropic format with full thinking/streaming support.

## Commands

```bash
# Install dependencies
npm install

# Start server (runs on port 8080)
npm start

# Start with model fallback enabled (falls back to alternate model when quota exhausted)
npm start -- --fallback

# Start with debug logging
npm start -- --debug

# Start with file watching for development
npm run dev

# Account management
npm run accounts         # Interactive account management
npm run accounts:add     # Add a new Google account via OAuth
npm run accounts:add -- --no-browser  # Add account on headless server (manual code input)
npm run accounts:list    # List configured accounts
npm run accounts:verify  # Verify account tokens are valid

# Run all tests (server must be running on port 8080)
npm test

# Run individual tests
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
npm run test:crossmodel    # Cross-model thinking signatures
npm run test:oauth         # OAuth no-browser mode
```

## Architecture

**Request Flow:**
```
Claude Code CLI → Express Server (server.js) → CloudCode Client → Antigravity Cloud Code API
```

**Directory Structure:**

```
src/
├── index.js                    # Entry point
├── server.js                   # Express server
├── constants.js                # Configuration values
├── errors.js                   # Custom error classes
├── fallback-config.js          # Model fallback mappings and helpers
│
├── cloudcode/                  # Cloud Code API client
│   ├── index.js                # Public API exports
│   ├── session-manager.js      # Session ID derivation for caching
│   ├── rate-limit-parser.js    # Parse reset times from headers/errors
│   ├── request-builder.js      # Build API request payloads
│   ├── sse-parser.js           # Parse SSE for non-streaming
│   ├── sse-streamer.js         # Stream SSE events in real-time
│   ├── message-handler.js      # Non-streaming message handling
│   ├── streaming-handler.js    # Streaming message handling
│   └── model-api.js            # Model listing and quota APIs
│
├── account-manager/            # Multi-account pool management
│   ├── index.js                # AccountManager class facade
│   ├── storage.js              # Config file I/O and persistence
│   ├── selection.js            # Account picking (round-robin, sticky)
│   ├── rate-limits.js          # Rate limit tracking and state
│   └── credentials.js          # OAuth token and project handling
│
├── auth/                       # Authentication
│   ├── oauth.js                # Google OAuth with PKCE
│   ├── token-extractor.js      # Legacy token extraction from DB
│   └── database.js             # SQLite database access
│
├── webui/                      # Web Management Interface
│   └── index.js                # Express router and API endpoints
│
├── cli/                        # CLI tools
│   └── accounts.js             # Account management CLI
│
├── format/                     # Format conversion (Anthropic ↔ Google)
│   ├── index.js                # Re-exports all converters
│   ├── request-converter.js    # Anthropic → Google conversion
│   ├── response-converter.js   # Google → Anthropic conversion
│   ├── content-converter.js    # Message content conversion
│   ├── schema-sanitizer.js     # JSON Schema cleaning for Gemini
│   ├── thinking-utils.js       # Thinking block validation/recovery
│   └── signature-cache.js      # Signature cache (tool_use + thinking signatures)
│
└── utils/                      # Utilities
    ├── helpers.js              # formatDuration, sleep
    ├── logger.js               # Structured logging
    └── native-module-helper.js # Auto-rebuild for native modules
```

**Frontend Structure (public/):**

```
public/
├── index.html                  # Main entry point
├── js/
│   ├── app.js                  # Main application logic (Alpine.js)
│   ├── store.js                # Global state management
│   ├── components/             # UI Components
│   │   ├── dashboard.js        # Real-time stats & charts
│   │   ├── account-manager.js  # Account list & OAuth handling
│   │   ├── logs-viewer.js      # Live log streaming
│   │   └── claude-config.js    # CLI settings editor
│   └── utils/                  # Frontend utilities
└── views/                      # HTML partials (loaded dynamically)
    ├── dashboard.html
    ├── accounts.html
    ├── settings.html
    └── logs.html
```

**Key Modules:**

- **src/server.js**: Express server exposing Anthropic-compatible endpoints (`/v1/messages`, `/v1/models`, `/health`, `/account-limits`) and mounting WebUI
- **src/webui/index.js**: WebUI backend handling API routes (`/api/*`) for config, accounts, and logs
- **src/cloudcode/**: Cloud Code API client with retry/failover logic, streaming and non-streaming support
- **src/account-manager/**: Multi-account pool with sticky selection, rate limit handling, and automatic cooldown
- **src/auth/**: Authentication including Google OAuth, token extraction, database access, and auto-rebuild of native modules
- **src/format/**: Format conversion between Anthropic and Google Generative AI formats
- **src/constants.js**: API endpoints, model mappings, fallback config, OAuth config, and all configuration values
- **src/fallback-config.js**: Model fallback mappings (`getFallbackModel()`, `hasFallback()`)
- **src/errors.js**: Custom error classes (`RateLimitError`, `AuthError`, `ApiError`, etc.)

**Multi-Account Load Balancing:**
- Sticky account selection for prompt caching (stays on same account across turns)
- Model-specific rate limiting via `account.modelRateLimits[modelId]`
- Automatic switch only when rate-limited for > 2 minutes on the current model
- Session ID derived from first user message hash for cache continuity
- Account state persisted to `~/.config/antigravity-proxy/accounts.json`

**Prompt Caching:**
- Cache is organization-scoped (requires same account + session ID)
- Session ID is SHA256 hash of first user message content (stable across turns)
- `cache_read_input_tokens` returned in usage metadata when cache hits
- Token calculation: `input_tokens = promptTokenCount - cachedContentTokenCount`

**Model Fallback (--fallback flag):**
- When all accounts are exhausted for a model, automatically falls back to an alternate model
- Fallback mappings defined in `MODEL_FALLBACK_MAP` in `src/constants.js`
- Thinking models fall back to thinking models (e.g., `claude-sonnet-4-5-thinking` → `gemini-3-flash`)
- Fallback is disabled on recursive calls to prevent infinite chains
- Enable with `npm start -- --fallback` or `FALLBACK=true` environment variable

**Cross-Model Thinking Signatures:**
- Claude and Gemini use incompatible thinking signatures
- When switching models mid-conversation, incompatible signatures are detected and dropped
- Signature cache tracks model family ('claude' or 'gemini') for each signature
- `hasGeminiHistory()` detects Gemini→Claude cross-model scenarios
- Thinking recovery (`closeToolLoopForThinking()`) injects synthetic messages to close interrupted tool loops
- For Gemini targets: strict validation - drops unknown or mismatched signatures
- For Claude targets: lenient - lets Claude validate its own signatures

**Native Module Auto-Rebuild:**
- When Node.js is updated, native modules like `better-sqlite3` may become incompatible
- The proxy automatically detects `NODE_MODULE_VERSION` mismatch errors
- On detection, it attempts to rebuild the module using `npm rebuild`
- If rebuild succeeds, the module is reloaded; if reload fails, a server restart is required
- Implementation in `src/utils/native-module-helper.js` and lazy loading in `src/auth/database.js`

**Web Management UI:**

- **Stack**: Vanilla JS + Alpine.js + Tailwind CSS (via CDN)
- **Architecture**: Single Page Application (SPA) with dynamic view loading
- **State Management**: Alpine.store for global state (accounts, settings, logs)
- **Features**:
  - Real-time dashboard with Chart.js visualization
  - OAuth flow handling via popup window
  - Live log streaming via Server-Sent Events (SSE)
  - Config editor for both Proxy and Claude CLI (`~/.claude/settings.json`)
- **Security**: Optional password protection via `WEBUI_PASSWORD` env var

## Testing Notes

- Tests require the server to be running (`npm start` in separate terminal)
- Tests are CommonJS files (`.cjs`) that make HTTP requests to the local proxy
- Shared test utilities are in `tests/helpers/http-client.cjs`
- Test runner supports filtering: `node tests/run-all.cjs <filter>` to run matching tests

## Code Organization

**Constants:** All configuration values are centralized in `src/constants.js`:
- API endpoints and headers
- Model mappings and model family detection (`getModelFamily()`, `isThinkingModel()`)
- Model fallback mappings (`MODEL_FALLBACK_MAP`)
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
- `isNetworkError(error)` - Check if error is a transient network error

**Logger:** Structured logging via `src/utils/logger.js`:
- `logger.info(msg)` - Standard info (blue)
- `logger.success(msg)` - Success messages (green)
- `logger.warn(msg)` - Warnings (yellow)
- `logger.error(msg)` - Errors (red)
- `logger.debug(msg)` - Debug output (magenta, only when enabled)
- `logger.setDebug(true)` - Enable debug mode
- `logger.isDebugEnabled` - Check if debug mode is on

**WebUI APIs:**

- `/api/accounts/*` - Account management (list, add, remove, refresh)
- `/api/config/*` - Server configuration (read/write)
- `/api/claude/config` - Claude CLI settings
- `/api/logs/stream` - SSE endpoint for real-time logs
- `/api/auth/url` - Generate Google OAuth URL

## Maintenance

When making significant changes to the codebase (new modules, refactoring, architectural changes), update this CLAUDE.md and the README.md file to keep documentation in sync.
