# ⚠️ DO NOT USE THIS ANYMORE – GOOGLE IS ISSUING TOS VIOLATION BANS FOR THE ACCOUNTS CONNECTED

# Antigravity Claude Proxy

[![npm version](https://img.shields.io/npm/v/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![npm downloads](https://img.shields.io/npm/dm/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude and Gemini models with **Claude Code CLI** and **OpenClaw / ClawdBot**.

![Antigravity Claude Proxy Banner](images/banner.png)

<details>
<summary><strong>⚠️ Terms of Service Warning — Read Before Installing</strong></summary>

> [!CAUTION]
> Using this proxy may violate Google's Terms of Service. A small number of users have reported their Google accounts being **banned** or **shadow-banned** (restricted access without explicit notification).
>
> **High-risk scenarios:**
> - 🚨 **Fresh Google accounts** have a very high chance of getting banned
> - 🚨 **New accounts with Pro/Ultra subscriptions** are frequently flagged and banned
>
> **By using this proxy, you acknowledge:**
> - This is an unofficial tool not endorsed by Google
> - Your account may be suspended or permanently banned
> - You assume all risks associated with using this proxy
>
> **Recommendation:** Use an established Google account that you don't rely on for critical services. Avoid creating new accounts specifically for this proxy.

</details>

---

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

## Key Features

- **Anthropic-Compatible API** — Drop-in replacement for the Anthropic Messages API; works with Claude Code CLI, Gemini CLI, and OpenClaw
- **Claude + Gemini Models** — Access Claude Sonnet 4.5, Claude Opus 4.6, Gemini 3 Flash, Gemini 3.1 Pro (all with thinking support)
- **Multi-Account Load Balancing** — Add multiple Google accounts with Hybrid, Sticky, or Round-Robin selection strategies
- **Web Management Console** — Real-time dashboard with quota monitoring, account management, live logs, and multi-language support
- **Per-Account Quota Protection** — Set minimum quota thresholds per account and per model to proactively rotate before exhaustion
- **Full Thinking/Streaming Support** — Extended thinking with `thoughtSignature` handling for multi-turn conversations
- **Security Options** — Protect API endpoints with `API_KEY` and the dashboard with `WEBUI_PASSWORD`
- **HTTP/HTTPS Proxy Support** — Route outbound requests through corporate firewalls and VPNs
- **Developer Mode** — Granular debug toggles, log export, health inspector, and screenshot mode
- **macOS Menu Bar App** — Native companion app for one-click server control ([antigravity-claude-proxy-bar](https://github.com/IrvanFza/antigravity-claude-proxy-bar))

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
git clone https://github.com/badrisnarayanan/antigravity-claude-proxy.git
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

> **Headless/Remote Servers**: If running on a server without a browser, the WebUI supports a "Manual Authorization" mode. After clicking "Add Account", you can copy the OAuth URL, complete authorization on your local machine, and paste the authorization code back.

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
3. Use the **Connection Mode** toggle to switch between:
   - **Proxy Mode**: Uses the local proxy server (Antigravity Cloud Code). Configure models, base URL, and presets here.
   - **Paid Mode**: Uses the official Anthropic Credits directly (requires your own subscription). This hides proxy settings to prevent accidental misconfiguration.
4. Click **Apply to Claude CLI** to save your changes.

> [!TIP]
> **Configuration Precedence**: System environment variables (set in shell profile like `.zshrc`) take precedence over the `settings.json` file. If you use the Web Console to manage settings, ensure you haven't manually exported conflicting variables in your terminal.

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
    "ANTHROPIC_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5-thinking",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

Or to use Gemini models:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "gemini-3.1-pro-high[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3.1-pro-high[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-flash[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3-flash[1m]",
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

### Proxy Mode vs. Paid Mode

Toggle in **Settings** → **Claude CLI**:

| Feature | 🔌 Proxy Mode | 💳 Paid Mode |
| :--- | :--- | :--- |
| **Backend** | Local Server (Antigravity) | Official Anthropic Credits |
| **Cost** | Free (Google Cloud) | Paid (Anthropic Credits) |
| **Models** | Claude + Gemini | Claude Only |

**Paid Mode** automatically clears proxy settings so you can use your official Anthropic account directly.

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

### Running as a System Service (systemd)

When running as a systemd service, the proxy runs under a different user (e.g. `root`), so it can't find your Claude CLI settings at `~/.claude/settings.json`. Set `CLAUDE_CONFIG_PATH` to point to the real user's `.claude` directory:

```ini
# /etc/systemd/system/antigravity-proxy.service
[Service]
Environment=CLAUDE_CONFIG_PATH=/home/youruser/.claude
ExecStart=/usr/bin/node /path/to/antigravity-claude-proxy/src/index.js
```

Without this, the WebUI's Claude CLI tab won't be able to read or write your Claude Code configuration.

---

## Using with Gemini CLI

The proxy also works with [Gemini CLI](https://github.com/google-gemini/gemini-cli). Set the following environment variables:

```bash
export GEMINI_API_KEY="test"
export GEMINI_BASE_URL="http://localhost:8080"
```

Or configure in your shell profile and run `gemini` as usual. The proxy translates requests for Gemini models the same way it does for Claude Code.

---

## Security & Advanced Configuration

The proxy supports several environment variables for security and tuning:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Server port | `8080` |
| `HOST` | Bind address (use `127.0.0.1` on VPS) | `0.0.0.0` |
| `API_KEY` | Protect `/v1/*` API endpoints | — |
| `WEBUI_PASSWORD` | Password-protect the web dashboard | — |
| `HTTP_PROXY` / `HTTPS_PROXY` | Route outbound requests through a proxy | — |
| `DEBUG` | Enable debug logging | `false` |
| `DEV_MODE` | Enable developer mode | `false` |
| `OAUTH_CALLBACK_PORT` | Custom OAuth callback port (Windows fix) | `51121` |

See [Advanced Configuration](docs/configuration.md) for the full list including retry logic, rate limit handling, and load balancing options.

---

## Documentation

- [Available Models](docs/models.md)
- [Multi-Account Load Balancing](docs/load-balancing.md)
- [Web Management Console](docs/web-console.md)
- [Advanced Configuration](docs/configuration.md)
- [macOS Menu Bar App](docs/menubar-app.md)
- [OpenClaw / ClawdBot Integration](docs/openclaw.md)
- [API Endpoints](docs/api-endpoints.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Safety, Usage, and Risk Notices](docs/safety-notices.md)
- [Legal](docs/legal.md)
- [Development](docs/development.md)

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT

---

<a href="https://buymeacoffee.com/badrinarayanans" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50"></a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left&cache-control=no-cache)](https://www.star-history.com/#badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left)
