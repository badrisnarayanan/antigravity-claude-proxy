# Antigravity Claude Proxy

[![npm version](https://img.shields.io/npm/v/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![npm downloads](https://img.shields.io/npm/dm/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<a href="https://buymeacoffee.com/badrinarayanans" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50"></a>

A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude and Gemini models with **Claude Code CLI**.

![Antigravity Claude Proxy Banner](images/banner.png)

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  Antigravity Cloud Code    │
│   (Anthropic     │     │  (Anthropic → Google│     │  (daily-cloudcode-pa.      │
│    API format)   │     │   Generative AI)    │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format**
2. Uses OAuth tokens from added Google accounts (or Antigravity's local database)
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API
5. Converts responses back to **Anthropic format** with full thinking/streaming support

## Prerequisites

- **Node.js** 18 or later
- **Antigravity** installed (for single-account mode) OR Google account(s) for multi-account mode

---

## Installation

### Option 1: npm (Recommended)

```bash
# Run directly with npx (no install needed)
npx antigravity-claude-proxy@latest start

# Or install globally
npm install -g antigravity-claude-proxy@latest
antigravity-claude-proxy start
```

### Option 2: Clone Repository

```bash
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install
npm start
```

---

## Quick Start

### 1. Start the Proxy Server

```bash
# If installed via npm
antigravity-claude-proxy start

# If using npx
npx antigravity-claude-proxy@latest start

# If cloned locally
npm start
```

The server runs on `http://localhost:8080` by default.

### 2. Link Account(s)

Choose one of the following methods to authorize the proxy:

#### **Method A: Web Dashboard (Recommended)**

1. With the proxy running, open `http://localhost:8080` in your browser.
2. Navigate to the **Accounts** tab and click **Add Account**.
3. Complete the Google OAuth authorization in the popup window.

#### **Method B: CLI (Desktop or Headless)**

If you prefer the terminal or are on a remote server:

```bash
# Desktop (opens browser)
antigravity-claude-proxy accounts add

# Headless (Docker/SSH)
antigravity-claude-proxy accounts add --no-browser
```

> For full CLI account management options, run `antigravity-claude-proxy accounts --help`.

#### **Method C: Automatic (Antigravity Users)**

If you have the **Antigravity** app installed and logged in, the proxy will automatically detect your local session. No additional setup is required.

To use a custom port:

```bash
PORT=3001 antigravity-claude-proxy start
```

### 3. Verify It's Working

```bash
# Health check
curl http://localhost:8080/health

# Check account status and quota limits
curl "http://localhost:8080/account-limits?format=table"
```

---

## Using with Claude Code CLI

### Configure Claude Code

You can configure these settings in two ways:

#### **Via Web Console (Recommended)**

1. Open the WebUI at `http://localhost:8080`.
2. Go to **Settings** → **Claude CLI**.
3. Select your preferred models and click **Apply to Claude CLI**.

> [!TIP] > **Configuration Precedence**: System environment variables (set in shell profile like `.zshrc`) take precedence over the `settings.json` file. If you use the Web Console to manage settings, ensure you haven't manually exported conflicting variables in your terminal.

#### **Manual Configuration**

Create or edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-2.5-flash-lite[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5-thinking",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

(Please use **gemini-2.5-flash-lite** as the default haiku model, even if others are claude, as claude code makes several calls via the haiku model for background tasks. If you use claude model for it, you may use you claude usage sooner)

Or to use Gemini models:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-flash[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-2.5-flash-lite[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3-flash[1m]",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

### Load Environment Variables

Add the proxy settings to your shell profile:

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:8080'"
Add-Content $PROFILE "`$env:ANTHROPIC_AUTH_TOKEN = 'test'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:8080"
setx ANTHROPIC_AUTH_TOKEN "test"
```

Restart your terminal for changes to take effect.

### Run Claude Code

```bash
# Make sure the proxy is running first
antigravity-claude-proxy start

# In another terminal, run Claude Code
claude
```

> **Note:** If Claude Code asks you to select a login method, add `"hasCompletedOnboarding": true` to `~/.claude.json` (macOS/Linux) or `%USERPROFILE%\.claude.json` (Windows), then restart your terminal and try again.

### Multiple Claude Code Instances (Optional)

To run both the official Claude Code and Antigravity version simultaneously, add this alias:

**macOS / Linux:**

```bash
# Add to ~/.zshrc or ~/.bashrc
alias claude-antigravity='CLAUDE_CONFIG_DIR=~/.claude-account-antigravity ANTHROPIC_BASE_URL="http://localhost:8080" ANTHROPIC_AUTH_TOKEN="test" command claude'
```

**Windows (PowerShell):**

```powershell
# Add to $PROFILE
function claude-antigravity {
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account-antigravity"
    $env:ANTHROPIC_BASE_URL = "http://localhost:8080"
    $env:ANTHROPIC_AUTH_TOKEN = "test"
    claude
}
```

Then run `claude` for official API or `claude-antigravity` for this proxy.

---

## Available Models

### Claude Models

| Model ID                     | Description                              |
| ---------------------------- | ---------------------------------------- |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking |
| `claude-opus-4-5-thinking`   | Claude Opus 4.5 with extended thinking   |
| `claude-sonnet-4-5`          | Claude Sonnet 4.5 without thinking       |

### Gemini Models

| Model ID            | Description                     |
| ------------------- | ------------------------------- |
| `gemini-3-flash`    | Gemini 3 Flash with thinking    |
| `gemini-3-pro-low`  | Gemini 3 Pro Low with thinking  |
| `gemini-3-pro-high` | Gemini 3 Pro High with thinking |

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

---

## Multi-Account Load Balancing

When you add multiple accounts, the proxy intelligently distributes requests across them using configurable selection strategies.

### Account Selection Strategies

Choose a strategy based on your needs:

| Strategy | Best For | Description |
| --- | --- | --- |
| **Hybrid** (Default) | Most users | Smart selection combining health score, token bucket rate limiting, and LRU freshness |
| **Sticky** | Prompt caching | Stays on the same account to maximize cache hits, switches only when rate-limited |
| **Round-Robin** | Even distribution | Cycles through accounts sequentially for balanced load |

**Configure via CLI:**

```bash
antigravity-claude-proxy start --strategy=hybrid    # Default: smart distribution
antigravity-claude-proxy start --strategy=sticky    # Cache-optimized
antigravity-claude-proxy start --strategy=round-robin  # Load-balanced
```

**Or via WebUI:** Settings → Server → Account Selection Strategy

### How It Works

- **Health Score Tracking**: Accounts earn points for successful requests and lose points for failures/rate-limits
- **Token Bucket Rate Limiting**: Client-side throttling with regenerating tokens (50 max, 6/minute)
- **Automatic Cooldown**: Rate-limited accounts recover automatically after reset time expires
- **Invalid Account Detection**: Accounts needing re-authentication are marked and skipped
- **Prompt Caching Support**: Session IDs derived from conversation enable cache hits across turns

### Monitoring

Check account status, subscription tiers, and quota anytime:

```bash
# Web UI: http://localhost:8080/ (Accounts tab - shows tier badges and quota progress)
# CLI Table:
curl "http://localhost:8080/account-limits?format=table"
```

#### CLI Management Reference

If you prefer using the terminal for management:

```bash
# List all accounts
antigravity-claude-proxy accounts list

# Verify account health
antigravity-claude-proxy accounts verify

# Interactive CLI menu
antigravity-claude-proxy accounts
```

---

## Web Management Console

The proxy includes a built-in, modern web interface for real-time monitoring and configuration. Access the console at: `http://localhost:8080` (default port).

![Antigravity Console](images/webui-dashboard.png)

### Key Features

- **Real-time Dashboard**: Monitor request volume, active accounts, model health, and subscription tier distribution.
- **Visual Model Quota**: Track per-model usage and next reset times with color-coded progress indicators.
- **Account Management**: Add/remove Google accounts via OAuth, view subscription tiers (Free/Pro/Ultra) and quota status at a glance.
- **Claude CLI Configuration**: Edit your `~/.claude/settings.json` directly from the browser.
- **Persistent History**: Tracks request volume by model family for 30 days, persisting across server restarts.
- **Time Range Filtering**: Analyze usage trends over 1H, 6H, 24H, 7D, or All Time periods.
- **Smart Analysis**: Auto-select top 5 most used models or toggle between Family/Model views.
- **Live Logs**: Stream server logs with level-based filtering and search.
- **Advanced Tuning**: Configure retries, timeouts, and debug mode on the fly.
- **Bilingual Interface**: Full support for English and Chinese (switch via Settings).

---

## Advanced Configuration

While most users can use the default settings, you can tune the proxy behavior via the **Settings → Server** tab in the WebUI or by creating a `config.json` file.

### Configurable Options

- **API Key Authentication**: Protect `/v1/*` API endpoints with `API_KEY` env var or `apiKey` in config.
- **WebUI Password**: Secure your dashboard with `WEBUI_PASSWORD` env var or in config.
- **Custom Port**: Change the default `8080` port.
- **Retry Logic**: Configure `maxRetries`, `retryBaseMs`, and `retryMaxMs`.
- **Load Balancing**: Adjust `defaultCooldownMs` and `maxWaitBeforeErrorMs`.
- **Persistence**: Enable `persistTokenCache` to save OAuth sessions across restarts.
- **Max Accounts**: Set `maxAccounts` (1-100) to limit the number of Google accounts. Default: 10.

Refer to `config.example.json` for a complete list of fields and documentation.

---

## macOS Menu Bar App

For macOS users who prefer a native experience, there's a companion menu bar app that provides quick access to server controls without touching the terminal. Get it from: [antigravity-claude-proxy-bar](https://github.com/IrvanFza/antigravity-claude-proxy-bar)

> **Note:** This is a GUI wrapper only. You still need to install and setup the proxy server first using one of the [installation methods](#installation) above.

![AntiGravity Claude Proxy Bar](https://github.com/IrvanFza/antigravity-claude-proxy-bar/blob/main/images/application.png?raw=true)

### Key Features

- **Server Control**: Start/stop the proxy server with a single click or ⌘S shortcut.
- **Status Indicator**: Menu bar icon shows server running state at a glance.
- **WebUI Access**: Open the web management console directly from the menu.
- **Port Configuration**: Customize the proxy server port (default: 8080).
- **Auto-Start Options**: Launch server on app start and launch app at login.
- **Native Experience**: Clean, native SwiftUI interface designed for macOS.

---

## API Endpoints

| Endpoint          | Method | Description                                                           |
| ----------------- | ------ | --------------------------------------------------------------------- |
| `/health`         | GET    | Health check                                                          |
| `/account-limits` | GET    | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages`    | POST   | Anthropic Messages API                                                |
| `/v1/models`      | GET    | List available models                                                 |
| `/refresh-token`  | POST   | Force token refresh                                                   |

---

## Testing

Run the test suite (requires server running):

```bash
# Start server in one terminal
npm start

# Run tests in another terminal
npm test
```

Individual tests:

```bash
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
npm run test:strategies    # Account selection strategies
```

---

## Troubleshooting

### "Could not extract token from Antigravity"

If using single-account mode with Antigravity:

1. Make sure Antigravity app is installed and running
2. Ensure you're logged in to Antigravity

Or add accounts via OAuth instead: `antigravity-claude-proxy accounts add`

### 401 Authentication Errors

The token might have expired. Try:

```bash
curl -X POST http://localhost:8080/refresh-token
```

Or re-authenticate the account:

```bash
antigravity-claude-proxy accounts
```

### Rate Limiting (429)

With multiple accounts, the proxy automatically switches to the next available account. With a single account, you'll need to wait for the rate limit to reset.

### Account Shows as "Invalid"

Re-authenticate the account:

```bash
antigravity-claude-proxy accounts
# Choose "Re-authenticate" for the invalid account
```

---

## Safety, Usage, and Risk Notices

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Not Suitable For

- Production application traffic
- High-volume automated extraction
- Any use that violates Acceptable Use Policies

### Warning (Assumption of Risk)

By using this software, you acknowledge and accept the following:

- **Terms of Service risk**: This approach may violate the Terms of Service of AI model providers (Anthropic, Google, etc.). You are solely responsible for ensuring compliance with all applicable terms and policies.

- **Account risk**: Providers may detect this usage pattern and take punitive action, including suspension, permanent ban, or loss of access to paid subscriptions.

- **No guarantees**: Providers may change APIs, authentication, or policies at any time, which can break this method without notice.

- **Assumption of risk**: You assume all legal, financial, and technical risks. The authors and contributors of this project bear no responsibility for any consequences arising from your use.

**Use at your own risk. Proceed only if you understand and accept these risks.**

---

## Legal

- **Not affiliated with Google or Anthropic.** This is an independent open-source project and is not endorsed by, sponsored by, or affiliated with Google LLC or Anthropic PBC.

- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.

- "Claude" and "Anthropic" are trademarks of Anthropic PBC.

- Software is provided "as is", without warranty. You are responsible for complying with all applicable Terms of Service and Acceptable Use Policies.

---

## Development

### For Developers & Contributors

This project uses a local Tailwind CSS build system. CSS is pre-compiled and included in the repository, so you can run the project immediately after cloning.

#### Quick Start

```bash
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install  # Automatically builds CSS via prepare hook
npm start    # Start server (no rebuild needed)
```

#### Frontend Development

If you need to modify styles in `public/css/src/input.css`:

```bash
# Option 1: Build once
npm run build:css

# Option 2: Watch for changes (auto-rebuild)
npm run watch:css

# Option 3: Watch both CSS and server (recommended)
npm run dev:full
```

**File Structure:**
- `public/css/src/input.css` - Source CSS with Tailwind `@apply` directives (edit this)
- `public/css/style.css` - Compiled & minified CSS (auto-generated, don't edit)
- `tailwind.config.js` - Tailwind configuration
- `postcss.config.js` - PostCSS configuration

#### Backend-Only Development

If you're only working on backend code and don't need frontend dev tools:

```bash
npm install --production  # Skip devDependencies (saves ~20MB)
npm start
```

**Note:** Pre-compiled CSS is committed to the repository, so you don't need to rebuild unless modifying styles.

#### Project Structure

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation, including:
- Request flow and module organization
- Frontend architecture (Alpine.js + Tailwind)
- Service layer patterns (`ErrorHandler.withLoading`, `AccountActions`)
- Dashboard module documentation

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left&cache-control=no-cache)](https://www.star-history.com/#badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left)
