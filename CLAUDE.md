# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude models (`claude-sonnet-4-5-thinking`, `claude-opus-4-5-thinking`) and Gemini models (`gemini-3-flash`, `gemini-3-pro-low`, `gemini-3-pro-high`) with Claude Code CLI.

The proxy translates requests from Anthropic Messages API format → Google Generative AI format → Antigravity Cloud Code API, then converts responses back to Anthropic format with full thinking/streaming support.

## Commands

```bash
# Install dependencies (automatically builds CSS via prepare hook)
npm install

# Start server (runs on port 8080)
npm start

# Start with specific account selection strategy
npm start -- --strategy=sticky      # Cache-optimized (stays on same account)
npm start -- --strategy=round-robin # Load-balanced (rotates every request)
npm start -- --strategy=hybrid      # Smart distribution (default)

# Start with model fallback enabled (falls back to alternate model when quota exhausted)
npm start -- --fallback

# Start with developer mode (debug logging + dev tools)
npm start -- --dev-mode

# Start with debug logging (legacy alias, also enables dev mode)
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
npm run test:cache-control # Cache control field stripping

# Run strategy unit tests (no server required)
node tests/test-strategies.cjs
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
│   ├── rate-limits.js          # Rate limit tracking and state
│   ├── credentials.js          # OAuth token and project handling
│   └── strategies/             # Account selection strategies
│       ├── index.js            # Strategy factory (createStrategy)
│       ├── base-strategy.js    # Abstract base class
│       ├── sticky-strategy.js  # Cache-optimized sticky selection
│       ├── round-robin-strategy.js  # Load-balanced rotation
│       ├── hybrid-strategy.js  # Smart multi-signal distribution
│       └── trackers/           # State trackers for hybrid strategy
│           ├── index.js        # Re-exports trackers
│           ├── health-tracker.js    # Account health scores
│           ├── token-bucket-tracker.js  # Client-side rate limiting
│           └── quota-tracker.js     # Quota-aware account selection
│
├── auth/                       # Authentication
│   ├── oauth.js                # Google OAuth with PKCE
│   ├── token-extractor.js      # Legacy token extraction from DB
│   └── database.js             # SQLite database access
│
├── webui/                      # Web Management Interface
│   └── index.js                # Express router and API endpoints
│
├── modules/                    # Feature modules
│   └── usage-stats.js          # Request tracking and history persistence
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
    ├── claude-config.js        # Claude CLI settings file I/O (supports CLAUDE_CONFIG_PATH env var)
    ├── helpers.js              # formatDuration, sleep, isNetworkError
    ├── logger.js               # Structured logging
    └── native-module-helper.js # Auto-rebuild for native modules
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
│   ├── app.js                  # Main application logic (Alpine.js)
│   ├── config/                 # Application configuration
│   │   └── constants.js        # Centralized UI constants and limits
│   ├── store.js                # Global state management
│   ├── data-store.js           # Shared data store (accounts, models, quotas, placeholder data)
│   ├── settings-store.js       # Settings management store (incl. dev mode sub-toggles)
│   ├── components/             # UI Components
│   │   ├── dashboard.js        # Main dashboard orchestrator
│   │   ├── account-manager.js  # Account list, OAuth, & threshold settings
│   │   ├── models.js           # Model list with draggable quota threshold markers
│   │   ├── logs-viewer.js      # Live log streaming
│   │   ├── claude-config.js    # CLI settings editor
│   │   ├── server-config.js    # Server settings UI
│   │   └── dashboard/          # Dashboard sub-modules
│   │       ├── stats.js        # Account statistics calculation
│   │       ├── charts.js       # Chart.js visualizations
│   │       └── filters.js      # Chart filter state management
│   └── utils/                  # Frontend utilities
│       ├── error-handler.js    # Centralized error handling with ErrorHandler.withLoading
│       ├── account-actions.js  # Account operations service layer
│       ├── redact.js           # Screenshot mode email redaction utility
│       ├── validators.js       # Input validation
│       └── model-config.js     # Model configuration helpers
└── views/                      # HTML partials (loaded dynamically)
    ├── dashboard.html
    ├── accounts.html
    ├── models.html
    ├── settings.html
    └── logs.html
```

**Key Modules:**

- **src/server.js**: Express server exposing Anthropic-compatible endpoints (`/v1/messages`, `/v1/models`, `/health`, `/account-limits`) and mounting WebUI
- **src/webui/index.js**: WebUI backend handling API routes (`/api/*`) for config, accounts, and logs
- **src/cloudcode/**: Cloud Code API client with retry/failover logic, streaming and non-streaming support
  - `model-api.js`: Model listing, quota retrieval (`getModelQuotas()`), and subscription tier detection (`getSubscriptionTier()`)
- **src/account-manager/**: Multi-account pool with configurable selection strategies, rate limit handling, and automatic cooldown
  - Strategies: `sticky` (cache-optimized), `round-robin` (load-balanced), `hybrid` (smart distribution)
  - `getStrategyHealthData()`: Exposes per-account health scores, token buckets, and failure counts for the WebUI health inspector
- **src/auth/**: Authentication including Google OAuth, token extraction, database access, and auto-rebuild of native modules
- **src/format/**: Format conversion between Anthropic and Google Generative AI formats
- **src/config.js**: Runtime configuration with defaults (`globalQuotaThreshold`, `maxAccounts`, `accountSelection`, `devMode`, etc.)
- **src/constants.js**: API endpoints, model mappings, fallback config, OAuth config, and all configuration values
- **src/modules/usage-stats.js**: Tracks request volume by model/family, persists 30-day history to JSON, and auto-prunes old data.
- **src/fallback-config.js**: Model fallback mappings (`getFallbackModel()`, `hasFallback()`)
- **src/errors.js**: Custom error classes (`RateLimitError`, `AuthError`, `ApiError`, etc.)

**Multi-Account Load Balancing:**
- Configurable selection strategy via `--strategy` flag or WebUI
- Three strategies available:
  - **Sticky** (`--strategy=sticky`): Best for prompt caching, stays on same account
  - **Round-Robin** (`--strategy=round-robin`): Maximum throughput, rotates every request
  - **Hybrid** (`--strategy=hybrid`, default): Smart selection using health + tokens + LRU
- Model-specific rate limiting via `account.modelRateLimits[modelId]`
- Automatic switch only when rate-limited for > 2 minutes on the current model
- Session ID derived from first user message hash for cache continuity
- Account state persisted to `~/.config/antigravity-proxy/accounts.json`

**Account Selection Strategies:**

1. **Sticky Strategy** (best for caching):
   - Stays on current account until rate-limited or unavailable
   - Waits up to 2 minutes for short rate limits before switching
   - Maintains prompt cache continuity across requests

2. **Round-Robin Strategy** (best for throughput):
   - Rotates to next account on every request
   - Skips rate-limited/disabled accounts
   - Maximizes concurrent request distribution

3. **Hybrid Strategy** (default, smart distribution):
   - Uses health scores, token buckets, quota awareness, and LRU for selection
   - Scoring formula: `score = (Health × 2) + ((Tokens / MaxTokens × 100) × 5) + (Quota × 1) + (LRU × 0.1)`
   - Health scores: Track success/failure patterns with passive recovery
   - Token buckets: Client-side rate limiting (50 tokens, 6 per minute regeneration)
   - Quota awareness: Accounts below configurable quota threshold are deprioritized
   - LRU freshness: Prefer accounts that have rested longer
   - **Emergency/Last Resort Fallback**: When all accounts are exhausted:
     - Emergency fallback: Bypasses health check, adds 250ms throttle delay
     - Last resort fallback: Bypasses both health and token checks, adds 500ms throttle delay
   - Configuration in `src/config.js` under `accountSelection`

**Quota Threshold (Quota Protection):**
- Configurable minimum quota level before the proxy switches to another account
- Three-tier threshold resolution (highest priority first):
  1. **Per-model**: `account.modelQuotaThresholds[modelId]` - override for specific models
  2. **Per-account**: `account.quotaThreshold` - account-level default
  3. **Global**: `config.globalQuotaThreshold` - server-wide default (0 = disabled)
- All thresholds are stored as fractions (0-0.99), displayed as percentages (0-99%) in the UI
- Global threshold configurable via WebUI Settings → Quota Protection
- Per-account and per-model thresholds configurable via Account Settings modal or draggable markers on model quota bars
- Used by `QuotaTracker.isQuotaCritical()` in the hybrid strategy to exclude low-quota accounts

**Account Data Model:**
Each account object in `accounts.json` contains:
- **Basic Info**: `email`, `source` (oauth/manual/database), `enabled`, `lastUsed`
- **Credentials**: `refreshToken` (OAuth) or `apiKey` (manual)
- **Subscription**: `{ tier, projectId, detectedAt }` - automatically detected via `loadCodeAssist` API
  - `tier`: 'free' | 'pro' | 'ultra' (detected from `paidTier` or `currentTier`)
- **Quota**: `{ models: {}, lastChecked }` - model-specific quota cache
  - `models[modelId]`: `{ remainingFraction, resetTime }` from `fetchAvailableModels` API
- **Quota Thresholds**: Per-account quota protection settings
  - `quotaThreshold`: Account-level minimum quota fraction (0-0.99, `undefined` = use global)
  - `modelQuotaThresholds`: `{ [modelId]: fraction }` - per-model overrides (takes priority over account-level)
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

**Cache Control Handling (Issue #189):**
- Claude Code CLI sends `cache_control` fields on content blocks for prompt caching
- Cloud Code API rejects these with "Extra inputs are not permitted"
- `cleanCacheControl(messages)` strips cache_control from ALL block types at pipeline entry
- Called at the START of `convertAnthropicToGoogle()` before any other processing
- Additional sanitizers (`sanitizeTextBlock`, `sanitizeToolUseBlock`) provide defense-in-depth
- Pattern inspired by Antigravity-Manager's `clean_cache_control_from_messages()`

**Claude CLI Config Path (systemd fix):**
- `getClaudeConfigPath()` in `src/utils/claude-config.js` resolves the path to `~/.claude/settings.json`
- When running as a systemd service, `os.homedir()` returns the service user's home (e.g. `/root`), not the real user's
- Set `CLAUDE_CONFIG_PATH` env var to the real user's `.claude` directory (e.g. `/home/user/.claude`)
- The env var is checked first; falls back to `os.homedir()/.claude` if unset

**Native Module Auto-Rebuild:**
- When Node.js is updated, native modules like `better-sqlite3` may become incompatible
- The proxy automatically detects `NODE_MODULE_VERSION` mismatch errors
- On detection, it attempts to rebuild the module using `npm rebuild`
- If rebuild succeeds, the module is reloaded; if reload fails, a server restart is required
- Implementation in `src/utils/native-module-helper.js` and lazy loading in `src/auth/database.js`

**Developer Mode:**
- Broader replacement for the old "Debug Mode" toggle, enabled via `--dev-mode` CLI flag, `DEV_MODE=true` env var, or WebUI Settings toggle
- `--debug` flag is a legacy alias that also enables developer mode
- Backend: `config.devMode` field in `src/config.js`, toggled at runtime via `POST /api/config` with `{ devMode: bool }`
- Frontend: `Alpine.store('data').devMode` synced from server config on health checks
- Gates access to `GET /api/strategy/health` (returns 403 when dev mode is off)
- **Sub-toggles** (client-side, stored in `settings-store.js` via localStorage):
  - **Screenshot Mode** (`redactMode`): Redacts email addresses across all views using `window.Redact` utility (`public/js/utils/redact.js`)
  - **Debug Logging** (`debugLogging`): Controls verbose debug message display
  - **Log Export** (`logExport`): Shows/hides the export button in the logs toolbar
  - **Health Inspector** (`healthInspector`): Shows/hides the strategy health inspector panel in accounts view (hybrid strategy only)
  - **Placeholder Data** (`placeholderMode`): Injects 4 dummy accounts with varied quotas for UI testing
    - **Include Real Accounts** (`placeholderIncludeReal`): Merges real accounts alongside placeholder data
- Placeholder data is purely client-side (generated in `data-store.js`, no backend changes)
- All sub-toggles use unified neon-purple styling

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
  - Account list with tier badges (Ultra/Pro/Free), quota progress bars, and per-account threshold settings
  - Model quota bars with draggable per-account threshold markers (color-coded, with overlap handling)
  - OAuth flow handling via popup window
  - Live log streaming via Server-Sent Events (SSE)
  - Config editor for both Proxy and Claude CLI (`~/.claude/settings.json`)
  - Skeleton loading screens for improved perceived performance
  - Empty state UX with actionable prompts
  - Loading states for all async operations
  - Developer Mode with granular sub-toggles (screenshot mode, debug logging, log export, health inspector, placeholder data)
- **Accessibility**:
  - ARIA labels on search inputs and icon buttons
  - Keyboard navigation support (Escape to clear search)
- **Security**: Optional password protection via `WEBUI_PASSWORD` env var
- **Config Redaction**: Sensitive values (passwords, tokens) are redacted in API responses
- **Smart Refresh**: Client-side polling with ±20% jitter and tab visibility detection (3x slower when hidden)
- **i18n Support**: English, Chinese (中文), Indonesian (Bahasa), Portuguese (PT-BR), Turkish (Türkçe)

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

- `/api/accounts/*` - Account management (list, add, remove, refresh, threshold settings)
  - `PATCH /api/accounts/:email` - Update account quota thresholds (`quotaThreshold`, `modelQuotaThresholds`)
- `/api/config/*` - Server configuration (read/write, includes `globalQuotaThreshold`, `devMode`)
- `/api/strategy/health` - Strategy health data for hybrid strategy (gated behind `devMode`)
- `/api/claude/config` - Claude CLI settings
- `/api/claude/mode` - Switch between Proxy/Paid mode (updates settings.json)
- `/api/logs/stream` - SSE endpoint for real-time logs
- `/api/stats/history` - Retrieve 30-day request history (sorted chronologically)
- `/api/auth/url` - Generate Google OAuth URL
- `/account-limits` - Fetch account quotas and subscription data
  - Returns: `{ accounts: [{ email, subscription, limits, quotaThreshold, modelQuotaThresholds, ... }], models: [...], globalQuotaThreshold }`
  - Query params: `?format=table` (ASCII table) or `?includeHistory=true` (adds usage stats)

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
  this.$store.global.showToast('Account refreshed', 'success');
} else {
  this.$store.global.showToast(result.error, 'error');
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
