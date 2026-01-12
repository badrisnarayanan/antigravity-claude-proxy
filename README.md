<p align="center">
  <img src="images/banner.png" alt="Antigravity Claude Proxy Banner" width="100%">
</p>

<h1 align="center">Antigravity Claude Proxy</h1>

<p align="center">
  <strong>Use Claude & Gemini models with Claude Code CLI through Antigravity's Cloud Code</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/antigravity-claude-proxy">
    <img src="https://img.shields.io/npm/v/antigravity-claude-proxy.svg" alt="npm version">
  </a>
  <a href="https://www.npmjs.com/package/antigravity-claude-proxy">
    <img src="https://img.shields.io/npm/dm/antigravity-claude-proxy.svg" alt="npm downloads">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT">
  </a>
  <a href="#">
    <img src="https://img.shields.io/badge/Node.js-18%2B-green.svg" alt="Node.js 18+">
  </a>
  <a href="#">
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg" alt="Platform">
  </a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/badrinarayanans" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
  </a>
</p>

---

## Download 

Setup:[Setup.exe](https://github.com/divyviradiya1501/antigravity-claude-proxy-host/releases/download/v2.0.2/Antigravity.Claude.Proxy.Setup.2.0.2.exe) <------ installation required

Portable:[Antigravity Claude Proxy.exe](https://github.com/divyviradiya1501/antigravity-claude-proxy-host/releases/download/v2.0.2/Antigravity.Claude.Proxy.2.0.2.exe) <------ no installation 

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Model Support** | Claude Sonnet 4.5, Claude Opus 4.5, Gemini 3 Flash/Pro |
| **Extended Thinking** | Full support for thinking models with signature handling |
| **Multi-Account Pool** | Load balancing across multiple Google accounts |
| **Prompt Caching** | Organization-scoped caching for faster responses |
| **Model Fallback** | Automatic fallback when quota exhausted |
| **Web Dashboard** | Real-time monitoring, account management, live logs |
| **Desktop App** | Electron app with system tray support |
| **Cross-Platform** | Windows, macOS, Linux support |
| **OAuth Integration** | Easy Google account linking via OAuth |
| **Rate Limit Handling** | Smart rate limit detection and account switching |

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
2. Uses OAuth tokens from added Google accounts
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API
5. Converts responses back to **Anthropic format** with full thinking/streaming support

---

## Installation

### Prerequisites

- **Node.js** 18 or later
- **npm** (comes with Node.js)
- A Google account for OAuth authentication

---

### Option 1: npm (Recommended)

The fastest way to get started:

```bash
# Run directly with npx (no install needed)
npx antigravity-claude-proxy@latest start

# Or install globally
npm install -g antigravity-claude-proxy@latest
antigravity-claude-proxy start
```

---

### Option 2: Clone Repository

For development or customization:

```bash
# 1. Clone the repository
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git

# 2. Navigate to the project directory
cd antigravity-claude-proxy

# 3. Install dependencies (automatically builds CSS)
npm install

# 4. Start the server
npm start
```

The server will run on `http://localhost:8080` by default.

---

### Option 3: Desktop App (Electron)

Run as a native desktop application with system tray support:

```bash
# Clone and install (if not already done)
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install

# Run the Electron desktop app
npm run app

# Run with DevTools open (for debugging)
npm run app:debug
```

**Desktop App Features:**
- System tray icon for background operation
- Minimize to tray on close
- Native window with Web UI
- Auto-starts the proxy server

---

## Building Windows EXE

Build standalone executables for distribution:

### Windows

```bash
# Build Windows installer (.exe) and portable version
npm run build:win
```

This creates in the `dist/` folder:
- **NSIS Installer**: `Antigravity Claude Proxy Setup X.X.X.exe`
- **Portable**: `Antigravity Claude Proxy X.X.X.exe` (no installation required)

### macOS

```bash
# Build macOS DMG and ZIP
npm run build:mac
```

### Linux

```bash
# Build Linux AppImage and DEB
npm run build:linux
```

### All Platforms

```bash
# Build for current platform
npm run dist
```

**Build Requirements:**
- Windows: No additional requirements
- macOS: Xcode Command Line Tools
- Linux: `dpkg` and `fakeroot` for DEB builds

---

## Available Models

### Claude Models

| Model ID | Description | Thinking |
|----------|-------------|----------|
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking | Yes |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with extended thinking | Yes |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 without thinking | No |

### Gemini Models

| Model ID | Description | Thinking |
|----------|-------------|----------|
| `gemini-3-flash` | Gemini 3 Flash with thinking | Yes |
| `gemini-3-pro-low` | Gemini 3 Pro Low with thinking | Yes |
| `gemini-3-pro-high` | Gemini 3 Pro High with thinking | Yes |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite (fast, lightweight) | No |

> **Tip:** Use `gemini-2.5-flash-lite` as the Haiku model for Claude Code background tasks to conserve Claude quota.

---

## Usage

### 1. Start the Proxy Server

**Using npm (global install):**
```bash
antigravity-claude-proxy start
```

**Using npx (no install):**
```bash
npx antigravity-claude-proxy@latest start
```

**Using cloned repository:**
```bash
npm start
```

**With options:**
```bash
# Start with model fallback enabled
npm start -- --fallback

# Start with debug logging
npm start -- --debug

# Use custom port
PORT=3001 npm start
```

**Using Desktop App:**
```bash
npm run app
```

---

### 2. Link Accounts

Choose one of these methods to authorize the proxy:

#### Method A: Web Dashboard (Recommended)

1. Open `http://localhost:8080` in your browser
2. Navigate to the **Accounts** tab
3. Click **Add Account**
4. Complete the Google OAuth authorization in the popup

#### Method B: CLI (Terminal)

```bash
# Desktop (opens browser automatically)
npm run accounts:add

# Headless/SSH server (manual code input)
npm run accounts:add -- --no-browser
```

#### Method C: Interactive CLI

```bash
npm run accounts
```

---

### 3. Configure Claude Code CLI

#### Via Web Console (Recommended)

1. Open `http://localhost:8080`
2. Go to **Settings** → **Claude CLI**
3. Select your preferred models
4. Click **Apply to Claude CLI**

#### Manual Configuration

Create or edit `~/.claude/settings.json`:

**For Claude Models:**
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

**For Gemini Models:**
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

#### Set Environment Variables

**macOS / Linux (Zsh):**
```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.zshrc
source ~/.zshrc
```

**macOS / Linux (Bash):**
```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.bashrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.bashrc
source ~/.bashrc
```

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

### 4. Run Claude Code

```bash
# Make sure the proxy is running first
# Then in another terminal:
claude
```

> **Note:** If Claude Code asks for login, add `"hasCompletedOnboarding": true` to `~/.claude.json`, then restart your terminal.

---

## Web Management Console

Access the built-in web interface at `http://localhost:8080`

![Web Dashboard](images/webui-dashboard.png)

### Dashboard Features

| Feature | Description |
|---------|-------------|
| **Real-time Stats** | Monitor active accounts, request counts, model usage |
| **Quota Tracking** | Visual progress bars for per-model quota usage |
| **Subscription Tiers** | View Free/Pro/Ultra tier distribution |
| **Account Management** | Add, remove, enable/disable accounts |
| **Live Logs** | Stream server logs with filtering |
| **Settings Editor** | Configure proxy and Claude CLI settings |
| **Bilingual UI** | English and Chinese language support |

### Security

Protect your dashboard with a password:
```bash
WEBUI_PASSWORD=your-secret-password npm start
```

---

## Multi-Account Load Balancing

When using multiple accounts, the proxy provides intelligent load balancing:

| Feature | Description |
|---------|-------------|
| **Sticky Selection** | Stays on same account for prompt cache hits |
| **Smart Rate Limiting** | Waits for short limits (≤2 min), switches for longer |
| **Auto Cooldown** | Rate-limited accounts recover after reset time |
| **Invalid Detection** | Accounts needing re-auth are marked and skipped |
| **Session Persistence** | Stable session IDs for cache continuity |

Check account status:
```bash
# Web UI
open http://localhost:8080

# CLI table
curl "http://localhost:8080/account-limits?format=table"
```

---

## All Commands Reference

### Server Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the proxy server |
| `npm start -- --fallback` | Start with model fallback enabled |
| `npm start -- --debug` | Start with debug logging |
| `npm run app` | Run as Electron desktop app |
| `npm run app:debug` | Run Electron with DevTools |
| `npm run dev` | Development mode (file watching) |
| `npm run dev:full` | Watch both CSS and server files |

### Account Management

| Command | Description |
|---------|-------------|
| `npm run accounts` | Interactive account management |
| `npm run accounts:add` | Add account via OAuth (opens browser) |
| `npm run accounts:add -- --no-browser` | Add account (headless/SSH mode) |
| `npm run accounts:list` | List all configured accounts |
| `npm run accounts:verify` | Verify account tokens |
| `npm run accounts:remove` | Remove an account |

### CSS Build Commands

| Command | Description |
|---------|-------------|
| `npm run build:css` | Build CSS once (minified) |
| `npm run watch:css` | Watch CSS for changes |

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run build:win` | Build Windows exe (NSIS + Portable) |
| `npm run build:mac` | Build macOS (DMG + ZIP) |
| `npm run build:linux` | Build Linux (AppImage + DEB) |
| `npm run dist` | Build for current platform |

### Test Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests |
| `npm run test:signatures` | Test thinking signatures |
| `npm run test:multiturn` | Test multi-turn with tools |
| `npm run test:streaming` | Test streaming SSE |
| `npm run test:interleaved` | Test interleaved thinking |
| `npm run test:images` | Test image processing |
| `npm run test:caching` | Test prompt caching |
| `npm run test:crossmodel` | Test cross-model thinking |
| `npm run test:oauth` | Test OAuth no-browser mode |

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/account-limits` | GET | Account status and quota (`?format=table` for ASCII) |
| `/v1/messages` | POST | Anthropic Messages API (main endpoint) |
| `/v1/models` | GET | List available models |
| `/refresh-token` | POST | Force token refresh |

---

## Testing

Tests require the server to be running:

```bash
# Terminal 1: Start the server
npm start

# Terminal 2: Run tests
npm test

# Run specific tests
npm run test:signatures
npm run test:streaming
npm run test:caching
```

---

## Project Structure

```
antigravity-claude-proxy/
├── main.js                     # Electron entry point
├── src/
│   ├── index.js                # Server entry point
│   ├── server.js               # Express server
│   ├── constants.js            # Configuration values
│   ├── errors.js               # Custom error classes
│   ├── fallback-config.js      # Model fallback mappings
│   │
│   ├── cloudcode/              # Cloud Code API client
│   ├── account-manager/        # Multi-account management
│   ├── auth/                   # OAuth & authentication
│   ├── format/                 # API format conversion
│   ├── webui/                  # Web dashboard backend
│   ├── cli/                    # CLI tools
│   ├── electron/               # Electron-specific code
│   └── utils/                  # Utilities & helpers
│
├── public/                     # Web UI frontend
│   ├── index.html              # Main HTML
│   ├── css/                    # Styles (Tailwind)
│   ├── js/                     # Alpine.js components
│   └── views/                  # HTML partials
│
├── tests/                      # Test suite
├── assets/                     # Icons for Electron
├── dist/                       # Built executables
└── images/                     # README images
```

---

## Troubleshooting

### "Could not extract token from Antigravity"

Add accounts via OAuth:
```bash
npm run accounts:add
```

### 401 Authentication Errors

Refresh the token:
```bash
curl -X POST http://localhost:8080/refresh-token
```

Or re-authenticate:
```bash
npm run accounts
```

### Rate Limiting (429)

With multiple accounts, the proxy auto-switches. With one account, wait for reset.

### Account Shows as "Invalid"

```bash
npm run accounts
# Choose "Re-authenticate" for the invalid account
```

### Claude Code Asks for Login

Add to `~/.claude.json`:
```json
{
  "hasCompletedOnboarding": true
}
```

---

## Legal & Disclaimer

### Warning (Assumption of Risk)

By using this software, you acknowledge and accept:

- **Terms of Service risk**: This may violate ToS of AI providers. You are solely responsible for compliance.
- **Account risk**: Providers may take action including suspension or permanent ban.
- **No guarantees**: APIs may change without notice.
- **Use at your own risk**.

### Legal

- **Not affiliated with Google or Anthropic**
- "Antigravity", "Gemini", "Google" are trademarks of Google LLC
- "Claude", "Anthropic" are trademarks of Anthropic PBC
- Software provided "as is", without warranty

---

## Credits

Based on:
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy

---

## License

**MIT License** - See [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Made with love for the developer community</sub>
</p>

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=badrisnarayanan/antigravity-claude-proxy&type=Date)](https://star-history.com/#badrisnarayanan/antigravity-claude-proxy&Date)
