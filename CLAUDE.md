# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude models (`claude-sonnet-4-5-thinking`, `claude-opus-4-5-thinking`) and Gemini models (`gemini-3-flash`, `gemini-3-pro-low`, `gemini-3-pro-high`) with Claude Code CLI.

The proxy translates requests from Anthropic Messages API format → Google Generative AI format → Antigravity Cloud Code API, then converts responses back to Anthropic format with full thinking/streaming support.

## Commands

```bash
# Install dependencies (automatically builds CSS via prepare hook)
npm install

# Start server (runs on port 8672)
# Start server (runs on port 8672)
npm start

# Start with model fallback enabled (falls back to alternate model when quota exhausted)
npm start -- --fallback

# Start with debug logging
npm start -- --debug

# Development mode (file watching)
npm run dev              # Watch server files only
npm run dev:full         # Watch both CSS and server files (recommended for frontend dev)

# CSS build commands
npm run build:css        # Build CSS once (minified)
npm run watch:css        # Watch CSS files for changes

# Account management
npm run accounts         # Interactive account management
npm run accounts:add     # Add a new Google account via OAuth
npm run accounts:add -- --no-browser  # Add account on headless server (manual code input)
npm run accounts:list    # List configured accounts
npm run accounts:remove  # Remove an account
npm run accounts:verify  # Verify account tokens are valid

# Run all tests (server must be running on port 8672)
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
npm run test:emptyretry    # Empty response retry logic
npm run test:sanitizer     # JSON Schema sanitizer
```

## Architecture

**Request Flow:**

```
Claude Code CLI → Server (server.js) → Middleware → Controllers → CloudCode Client → Antigravity API
```

**Directory Structure:**

```
bin/
└── cli.js                      # CLI entry point

src/
├── index.js                    # Programmatic entry point
├── server.js                   # Express server setup
├── config.js                   # Dynamic configuration
├── constants.js                # Static configuration values
├── errors.js                   # Custom error classes
├── fallback-config.js          # Model fallback mappings
│
├── controllers/                # Route controllers
│   ├── messages.controller.js  # Messages API logic
│   ├── models.controller.js    # Models API logic
│   └── system.controller.js    # System/Health routes
│
├── middleware/                 # Express middleware
│   ├── error-handler.js        # Global error handling
│   └── validation.js           # Request validation
│
├── modules/                    # Feature modules
│   └── usage-stats.js          # Usage statistics tracking
│
├── cloudcode/                  # Cloud Code API client
│   ├── index.js                # Public API exports
│   ├── session-manager.js      # Session ID derivation for caching
│   ├── rate-limit-parser.js    # Parse reset times
│   ├── request-builder.js      # Build API payloads
│   ├── sse-parser.js           # Parse SSE for non-streaming
│   ├── sse-streamer.js         # Stream SSE events
│   ├── message-handler.js      # Non-streaming handling
│   ├── streaming-handler.js    # Streaming handling
│   └── model-api.js            # Model listing/quota
│
├── account-manager/            # Multi-account pool
│   ├── index.js                # Facade
│   ├── storage.js              # Persistence
│   ├── selection.js            # Account picking
│   ├── rate-limits.js          # Rate tracking
│   └── credentials.js          # OAuth/Tokens
│
├── auth/                       # Authentication
│   ├── oauth.js                # Google OAuth
│   ├── token-extractor.js      # Legacy token extraction
│   └── database.js             # SQLite access
│
├── webui/                      # Web Management Interface
│   └── index.js                # Express router
│
├── modules/                    # Feature modules
│   └── usage-stats.js          # Request tracking and history persistence
│
├── cli/                        # CLI tools
│   └── accounts.js             # Account management
│
├── format/                     # Format conversion
│   ├── index.js                # Exports
│   ├── request-converter.js    # Anthropic -> Google
│   ├── response-converter.js   # Google -> Anthropic
│   ├── content-converter.js    # Content formatting
│   ├── schema-sanitizer.js     # JSON Schema cleaning
│   ├── thinking-utils.js       # Thinking block handling
│   ├── signature-cache.js      # Signature caching
│   └── response-utils.js       # Response formatting helpers
│
└── utils/                      # Utilities
    ├── claude-config.js        # Claude CLI config utils
    ├── fetch-with-timeout.js   # Network utility
    ├── helpers.js              # General helpers
    ├── logger.js               # Logging
    ├── native-module-helper.js # Rebuild helper
    └── retry.js                # Retry logic
```

**Frontend Structure (public/):**

```
public/
├── index.html                  # Main entry point
├── css/
│   ├── style.css               # Compiled Tailwind CSS (generated, do not edit)
│   └── src/
│       └── input.css           # Tailwind source with @apply directives
├── js/
│   ├── app-init.js             # Alpine.js initialization & Main Controller
│   ├── utils.js                # Shared utilities (window.utils)
│   ├── config/                 # Application configuration
│   │   └── constants.js        # Centralized UI constants and limits
│   ├── store.js                # Global store registration
│   ├── data-store.js           # Data store (accounts, models, quotas)
│   ├── settings-store.js       # Settings store
│   ├── config/
│   │   └── constants.js        # App constants
│   ├── components/             # UI Components
│   │   ├── dashboard.js        # Dashboard controller
│   │   ├── account-manager.js  # Account management
│   │   ├── logs-viewer.js      # Log viewer
│   │   ├── claude-config.js    # Claude config editor
│   │   ├── model-manager.js    # Model config UI
│   │   ├── models.js           # Models list UI
│   │   ├── server-config.js    # Server config UI
│   │   └── dashboard/          # Dashboard sub-modules
│   │       ├── stats.js        # Statistics logic
│   │       ├── charts.js       # Chart.js logic
│   │       └── filters.js      # Filter logic
│   └── utils/                  # Utility modules
│       ├── error-handler.js    # Error handling
│       ├── account-actions.js  # Account service layer
│       ├── validators.js       # Input validation
│       └── model-config.js     # Model config helpers
└── views/                      # HTML partials (loaded dynamically)
    ├── dashboard.html
    ├── accounts.html
    ├── models.html
    ├── settings.html
    └── logs.html
```

**Key Modules:**

- **src/server.js**: Express server setup, middleware registration, and route mounting
- **src/controllers/**: Request handlers for API endpoints
  - `messages.controller.js`: Core chat completion logic (`/v1/messages`)
  - `models.controller.js`: Model listing and info (`/v1/models`)
  - `system.controller.js`: Health checks and system status
- **src/middleware/**: Express middleware
  - `validation.js`: Schema validation for requests
  - `error-handler.js`: Centralized error handling
- **src/webui/index.js**: WebUI backend handling API routes (`/api/*`) for config, accounts, and logs
- **src/cloudcode/**: Cloud Code API client with retry/failover logic, streaming and non-streaming support
  - `model-api.js`: Model listing, quota retrieval (`getModelQuotas()`), and subscription tier detection (`getSubscriptionTier()`)
- **src/account-manager/**: Multi-account pool with sticky selection, rate limit handling, and automatic cooldown
- **src/auth/**: Authentication including Google OAuth, token extraction, database access, and auto-rebuild of native modules
- **src/format/**: Format conversion between Anthropic and Google Generative AI formats
- **src/config.js**: Dynamic configuration and environment variable parsing
- **src/constants.js**: Static configuration values (API endpoints, model mappings)
- **src/modules/usage-stats.js**: Tracks request volume by model/family, persists 30-day history to JSON, and auto-prunes old data.
- **src/fallback-config.js**: Model fallback mappings (`getFallbackModel()`, `hasFallback()`)
- **src/modules/usage-stats.js**: Tracking and persistence of usage statistics

**Multi-Account Load Balancing:**

- Sticky account selection for prompt caching (stays on same account across turns)
- Model-specific rate limiting via `account.modelRateLimits[modelId]`
- Automatic switch only when rate-limited for > 2 minutes on the current model
- Session ID derived from first user message hash for cache continuity
- Account state persisted to `~/.config/antigravity-proxy/accounts.json`

**Account Data Model:**
Each account object in `accounts.json` contains:

- **Basic Info**: `email`, `source` (oauth/manual/database), `enabled`, `lastUsed`
- **Credentials**: `refreshToken` (OAuth) or `apiKey` (manual)
- **Subscription**: `{ tier, projectId, detectedAt }` - automatically detected via `loadCodeAssist` API
  - `tier`: 'free' | 'pro' | 'ultra' (detected from `paidTier` or `currentTier`)
- **Quota**: `{ models: {}, lastChecked }` - model-specific quota cache
  - `models[modelId]`: `{ remainingFraction, resetTime }` from `fetchAvailableModels` API
- **Rate Limits**: `modelRateLimits[modelId]` - temporary rate limit state (in-memory during runtime)
- **Validity**: `isInvalid`, `invalidReason` - tracks accounts needing re-authentication

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

- **Stack**: Vanilla JS + Alpine.js + Tailwind CSS (local build with PostCSS)
- **Build System**:
  - Tailwind CLI with JIT compilation
  - PostCSS + Autoprefixer
  - DaisyUI component library
  - Custom `@apply` directives in `public/css/src/input.css`
  - Compiled output: `public/css/style.css` (auto-generated on `npm install`)
- **Architecture**: Single Page Application (SPA) with dynamic view loading
- **State Management**:
  - Alpine.store for global state (accounts, settings, logs)
  - Layered architecture: Service Layer (`account-actions.js`) → Component Layer → UI
- **Features**:
  - Real-time dashboard with Chart.js visualization and subscription tier distribution
  - Account list with tier badges (Ultra/Pro/Free) and quota progress bars
  - OAuth flow handling via popup window
  - Live log streaming via Server-Sent Events (SSE)
  - Config editor for both Proxy and Claude CLI (`~/.claude/settings.json`)
  - Skeleton loading screens for improved perceived performance
  - Empty state UX with actionable prompts
  - Loading states for all async operations
- **Accessibility**:
  - ARIA labels on search inputs and icon buttons
  - Keyboard navigation support (Escape to clear search)
- **Security**: Optional password protection via `WEBUI_PASSWORD` env var
- **Smart Refresh**: Client-side polling with ±20% jitter and tab visibility detection (3x slower when hidden)

## Testing Notes

- Tests require the server to be running (`npm start` in separate terminal)
- Tests are CommonJS files (`.cjs`) that make HTTP requests to the local proxy
- Shared test utilities are in `tests/helpers/http-client.cjs`
- Test runner supports filtering: `node tests/run-all.cjs <filter>` to run matching tests

## Code Organization

**Configuration:** Split between static constants and dynamic config:

- **`src/constants.js`**: Static values (API endpoints, headers, default timeouts, model mappings)
- **`src/config.js`**: Dynamic configuration loaded from `~/.config/antigravity-proxy/config.json` and environment variables
  - Supports hot-reloading for some values
  - Manages `modelMapping` for aliasing and hiding models

**Model Family Handling:**

- `getModelFamily(model)` returns `'claude'`, `'gemini'`, or `'gpt'` based on model name
- Claude models use `signature` field on thinking blocks
- Gemini models use `thoughtSignature` field on functionCall parts (cached or sentinel value)
- When Claude Code strips `thoughtSignature`, the proxy tries to restore from cache, then falls back to `skip_thought_signature_validator`

**Error Handling:**

- **Classes**: Custom errors in `src/errors.js` (`RateLimitError`, `AuthError`, `ApiError`)
- **Middleware**: Centralized handler in `src/middleware/error-handler.js`
  - Parses upstream errors into user-friendly messages
  - Handles SSE error events for streaming responses
  - Auto-refreshes tokens on 401/Authentication errors

**Utilities:** Shared helpers in `src/utils/`:

- `helpers.js`: General utilities (`formatDuration`, `sleep`, `isNetworkError`)
- `retry.js`: Configurable retry logic with exponential backoff
- `fetch-with-timeout.js`: Fetch wrapper with timeout support
- `claude-config.js`: Interaction with local Claude CLI configuration
- `logger.js`: Structured logging
- `native-module-helper.js`: Auto-rebuild for native modules

**Data Persistence:**

- Subscription and quota data are automatically fetched when `/account-limits` is called
- Updated data is saved to `accounts.json` asynchronously (non-blocking)
- On server restart, accounts load with last known subscription/quota state
- Quota is refreshed on each WebUI poll (default: 30s with jitter)

**Logger:** Structured logging via `src/utils/logger.js`:

- `logger.info(msg)` - Standard info (blue)
- `logger.success(msg)` - Success messages (green)
- `logger.warn(msg)` - Warnings (yellow)
- `logger.error(msg)` - Errors (red)
- `logger.debug(msg)` - Debug output (magenta, only when enabled)
- `logger.setDebug(true)` - Enable debug mode
- `logger.isDebugEnabled` - Check if debug mode is on

**WebUI APIs:**

- `/api/accounts/*` - Account management (list, toggle, remove, refresh)
- `/api/config` - Server configuration (read/write)
- `/api/config/password` - Update WebUI password
- `/api/claude/config` - Claude CLI settings
- `/api/models/config` - Model visibility and aliasing
- `/api/logs/stream` - SSE endpoint for real-time logs
- `/api/stats/history` - Retrieve 30-day request history (sorted chronologically)
- `/api/auth/url` - Generate Google OAuth URL
- `/api/auth/status/:state` - Poll OAuth flow status
- `/account-limits` - Fetch account quotas and subscription data
  - Returns: `{ accounts: [...], models: [...] }`
  - Query params: `?format=table` (ASCII) or `?includeHistory=true` (usage stats)

## Frontend Development

### CSS Build System

**Workflow:**

1. Edit styles in `public/css/src/input.css` (Tailwind source with `@apply` directives)
2. Run `npm run build:css` to compile (or `npm run watch:css` for auto-rebuild)
3. Compiled CSS output: `public/css/style.css` (minified, committed to git)

**Component Styles:**

- Use `@apply` to abstract common Tailwind patterns into reusable classes
- Example: `.btn-action-ghost`, `.status-pill-success`, `.input-search`
- Skeleton loading: `.skeleton`, `.skeleton-stat-card`, `.skeleton-chart`

**When to rebuild:**

- After modifying `public/css/src/input.css`
- After pulling changes that updated CSS source
- Automatically on `npm install` (via `prepare` hook)

### Error Handling Pattern

Use `window.ErrorHandler.withLoading()` for async operations:

```javascript
async myOperation() {
  return await window.ErrorHandler.withLoading(async () => {
    // Your async code here
    const result = await someApiCall();
    if (!result.ok) {
      throw new Error('Operation failed');
    }
    return result;
  }, this, 'loading', { errorMessage: 'Failed to complete operation' });
}
```

- Automatically manages `this.loading` state
- Shows error toast on failure
- Always resets loading state in `finally` block

### Frontend Configuration

**Constants**:
All frontend magic numbers and configuration values are centralized in `public/js/config/constants.js`. Use `window.AppConstants` to access:

- `INTERVALS`: Refresh rates and timeouts
- `LIMITS`: Data quotas and display limits
- `UI`: Animation durations and delay settings

### Account Operations Service Layer

Use `window.AccountActions` for account operations instead of direct API calls:

```javascript
// ✅ Good: Use service layer
const result = await window.AccountActions.refreshAccount(email);
if (result.success) {
  this.$store.global.showToast("Account refreshed", "success");
} else {
  this.$store.global.showToast(result.error, "error");
}

// ❌ Bad: Direct API call in component
const response = await fetch(`/api/accounts/${email}/refresh`);
```

**Available methods:**

- `refreshAccount(email)` - Refresh token and quota
- `toggleAccount(email, enabled)` - Enable/disable account (with optimistic update)
- `deleteAccount(email)` - Delete account
- `getFixAccountUrl(email)` - Get OAuth re-auth URL
- `reloadAccounts()` - Reload from disk
- `canDelete(account)` - Check if account is deletable

All methods return `{success: boolean, data?: object, error?: string}`

### Dashboard Modules

Dashboard is split into three modules for maintainability:

1. **stats.js** - Account statistics calculation

   - `updateStats(component)` - Computes active/limited/total counts
   - Updates subscription tier distribution

2. **charts.js** - Chart.js visualizations

   - `initQuotaChart(component)` - Initialize quota distribution pie chart
   - `initTrendChart(component)` - Initialize usage trend line chart
   - `updateQuotaChart(component)` - Update quota chart data
   - `updateTrendChart(component)` - Update trend chart (with concurrency lock)

3. **filters.js** - Filter state management
   - `getInitialState()` - Default filter values
   - `loadPreferences(component)` - Load from localStorage
   - `savePreferences(component)` - Save to localStorage
   - `autoSelectTopN(component)` - Smart select top 5 active models
   - Filter types: time range (1h/6h/24h/7d/all), display mode, family/model selection

Each module is well-documented with JSDoc comments.

## Maintenance

When making significant changes to the codebase (new modules, refactoring, architectural changes), update this CLAUDE.md and the README.md file to keep documentation in sync.
