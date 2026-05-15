# Using with OpenCode

[OpenCode](https://opencode.ai/) is a terminal-based AI coding assistant similar to Claude Code. You can configure it to use this proxy, which unlocks both Claude and Gemini models in a single interactive session.

## The Problem with Claude Code

The proxy exposes both Claude and Gemini models via `/v1/models`. However, Claude Code's `/model` picker is hardcoded by Anthropic to only show Claude variants. Gemini models are effectively invisible in the UI.

The only workaround within Claude Code is hardcoding a single Gemini model in `settings.json` — no interactive switching, no mid-session changes.

## What OpenCode Solves

OpenCode supports custom providers via a config file. Once pointed at this proxy, all models (Claude and Gemini) appear in one interactive picker and can be switched freely at any time.

| Feature | Claude Code | OpenCode (with this proxy) |
|---|---|---|
| Claude models | yes | yes |
| Gemini models | hardcoded only | interactive picker |
| Switch models mid-session | no | yes |
| Multi-account load balancing | yes (via proxy) | yes (via proxy) |

## Prerequisites

- OpenCode installed (`npm install -g opencode-ai@latest`)
- Antigravity Claude Proxy running on port 8080
- At least one Google account linked to the proxy

## Global Configuration

```bash
mkdir -p ~/.config/opencode

cat > ~/.config/opencode/opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "antigravity": {
      "npm": "@ai-sdk/anthropic",
      "name": "Antigravity Local",
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      },
      "models": {
        "claude-sonnet-4-6": { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
        "claude-opus-4-6-thinking": { "id": "claude-opus-4-6-thinking", "name": "Claude Opus 4.6 Thinking" },
        "gemini-2.5-pro": { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro" },
        "gemini-2.5-flash": { "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash" },
        "gemini-2.5-flash-lite": { "id": "gemini-2.5-flash-lite", "name": "Gemini 2.5 Flash Lite" },
        "gemini-2.5-flash-thinking": { "id": "gemini-2.5-flash-thinking", "name": "Gemini 2.5 Flash Thinking" },
        "gemini-3-flash": { "id": "gemini-3-flash", "name": "Gemini 3 Flash" },
        "gemini-3-flash-agent": { "id": "gemini-3-flash-agent", "name": "Gemini 3 Flash Agent" },
        "gemini-pro-agent": { "id": "gemini-pro-agent", "name": "Gemini 3.1 Pro Agent" },
        "gemini-3.1-pro-low": { "id": "gemini-3.1-pro-low", "name": "Gemini 3.1 Pro Low" },
        "gemini-3.1-flash-lite": { "id": "gemini-3.1-flash-lite", "name": "Gemini 3.1 Flash Lite" },
        "gemini-3.1-flash-image": { "id": "gemini-3.1-flash-image", "name": "Gemini 3.1 Flash Image" }
      }
    }
  },
  "model": "antigravity/claude-sonnet-4-6",
  "small_model": "antigravity/gemini-3-flash"
}
EOF
```

This config is global and applies automatically every time you run `opencode` from any folder.

## Shell Environment

```bash
grep -q 'ANTHROPIC_API_KEY=' ~/.zshrc || echo 'export ANTHROPIC_API_KEY="dummy"' >> ~/.zshrc
grep -q 'ANTHROPIC_BASE_URL=' ~/.zshrc || echo 'export ANTHROPIC_BASE_URL="http://localhost:8080/v1"' >> ~/.zshrc
source ~/.zshrc
```

The `ANTHROPIC_API_KEY` value can be anything — the proxy does not validate it. Authentication is handled via your linked Google accounts.

## Start Both Services

```bash
# Terminal 1: Start the proxy
antigravity-claude-proxy start

# Terminal 2: Open OpenCode from any project folder
opencode
```

## Switching Models

Inside OpenCode, all registered models appear as `antigravity/<model-id>`. The `small_model` field handles background operations — setting it to a Gemini Flash model conserves your Claude quota, the same way `ANTHROPIC_DEFAULT_HAIKU_MODEL` works in Claude Code.

## Available Models

| Model ID | Type | Best For |
|---|---|---|
| `claude-sonnet-4-6` | Claude | Coding, refactoring |
| `claude-opus-4-6-thinking` | Claude | Architecture, deep reasoning |
| `gemini-2.5-pro` | Gemini | Long context, analysis |
| `gemini-2.5-flash` | Gemini | Fast general tasks |
| `gemini-2.5-flash-lite` | Gemini | Background tasks |
| `gemini-2.5-flash-thinking` | Gemini | Reasoning tasks |
| `gemini-3-flash` | Gemini | Fast, lightweight |
| `gemini-3-flash-agent` | Gemini | Agentic workflows |
| `gemini-pro-agent` | Gemini | Agentic workflows |
| `gemini-3.1-pro-low` | Gemini | Strong reasoning |
| `gemini-3.1-flash-lite` | Gemini | Lightweight tasks |
| `gemini-3.1-flash-image` | Gemini | Vision/image tasks |

`gemini-3.1-pro-high` is currently returning `400 INVALID_ARGUMENT` from Google's backend. Use `gemini-3.1-pro-low` instead.

## Verify Configuration

```bash
curl "http://localhost:8080/v1/messages" 
  -H "content-type: application/json" 
  -H "anthropic-version: 2023-06-01" 
  -H "x-api-key: dummy" 
  -d '{"model": "claude-sonnet-4-6", "max_tokens": 100, "messages": [{"role":"user","content":"say hi"}]}'
```

## Troubleshooting

### `Endpoint POST /messages not found`

Your `baseURL` is missing `/v1`. Set it to `http://localhost:8080/v1`, not `http://localhost:8080`.

### Model returns `400 INVALID_ARGUMENT`

The model is rejected by Google's backend. Remove it from your `models` block. Known affected model: `gemini-3.1-pro-high`.

### Models not appearing in picker

1. Check the config is valid JSON: `cat ~/.config/opencode/opencode.json`
2. Check the env var is set: `echo $ANTHROPIC_API_KEY`
3. Open a fresh terminal after config changes

### Connection refused

```bash
acc status
curl http://localhost:8080/health
```

## Further Reading

- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode Providers](https://opencode.ai/docs/providers/)
- [Proxy Load Balancing](load-balancing.md)
- [Proxy Configuration](configuration.md)
- [Available Models](models.md)
