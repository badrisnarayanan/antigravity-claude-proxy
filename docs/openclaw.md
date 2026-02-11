# Using with OpenClaw / ClawdBot

[OpenClaw](https://docs.openclaw.ai/) (formerly ClawdBot/Moltbot) is an AI agent gateway that connects to messaging apps like Telegram, WhatsApp, Discord, Slack, and iMessage. You can configure it to use this proxy for Claude and Gemini models.

## Prerequisites

- OpenClaw installed (`npm install -g openclaw@latest`)
- Antigravity Claude Proxy running on port 8080
- At least one Google account linked to the proxy

## Configure OpenClaw

Edit your OpenClaw config file at:
- **macOS/Linux**: `~/.openclaw/openclaw.json`
- **Windows**: `%USERPROFILE%\.openclaw\openclaw.json`

Add the following configuration:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "antigravity-proxy": {
        "baseUrl": "http://127.0.0.1:8080",
        "apiKey": "test",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "gemini-3-flash",
            "name": "Gemini 3 Flash",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1048576,
            "maxTokens": 65536
          },
          {
            "id": "gemini-3-pro-high",
            "name": "Gemini 3 Pro High",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1048576,
            "maxTokens": 65536
          },
          {
            "id": "claude-sonnet-4-5",
            "name": "Claude Sonnet 4.5",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "claude-sonnet-4-5-thinking",
            "name": "Claude Sonnet 4.5 Thinking",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "claude-opus-4-6-thinking",
            "name": "Claude Opus 4.6 Thinking",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 32000
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity-proxy/gemini-3-flash",
        "fallbacks": ["antigravity-proxy/gemini-3-pro-high"]
      },
      "models": {
        "antigravity-proxy/gemini-3-flash": {}
      }
    }
  }
}
```

> **Important**: Use `127.0.0.1` instead of `localhost` in the `baseUrl`. This ensures the connection stays on the loopback interface. If you're running on a VPS and accidentally start the proxy bound to `0.0.0.0`, using `localhost` in your client config could still work but `127.0.0.1` makes the intent explicit and avoids potential DNS resolution issues.

## Start Both Services

```bash
# Terminal 1: Start the proxy (binds to localhost only by default)
antigravity-claude-proxy start

# Terminal 2: Start OpenClaw gateway
openclaw gateway
```

## Verify Configuration

```bash
# Check available models
openclaw models list

# Check gateway status
openclaw status
```

You should see models prefixed with `antigravity-proxy/` in the list.

## Switch Models

To change the default model:

```bash
openclaw models set antigravity-proxy/claude-opus-4-6-thinking
```

Or edit the `model.primary` field in your config file.

## Troubleshooting

### Connection Refused

Make sure the proxy is running before starting OpenClaw:
```bash
curl http://127.0.0.1:8080/health
```

### Models Not Showing

1. Verify the config file is valid JSON
2. Check that `mode` is set to `"merge"` (not `"replace"` unless you want to override all built-in models)
3. Restart the OpenClaw gateway after config changes

### VPS Security

If running on a VPS, ensure the proxy only binds to localhost:
```bash
# Default binds to 0.0.0.0 (all interfaces) - exposed to network!
antigravity-claude-proxy start

# Explicitly bind to localhost only (recommended for VPS)
HOST=127.0.0.1 antigravity-claude-proxy start
```

By default, the proxy binds to `0.0.0.0` which exposes it to all network interfaces. On a VPS, always use `HOST=127.0.0.1` to restrict access to localhost only, or ensure you have proper authentication (`API_KEY` env var) and firewall rules in place.

## Further Reading

- [OpenClaw Documentation](https://docs.openclaw.ai/)
- [OpenClaw Configuration Reference](https://docs.openclaw.ai/gateway/configuration)
- [Proxy Load Balancing](./load-balancing.md)
- [Proxy Configuration](./configuration.md)
