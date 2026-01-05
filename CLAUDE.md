# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude and Gemini models with Claude Code CLI.

## Commands

```bash
# Install and start
npm install
npm start                              # Port 8080
npm start -- --fallback                # Enable model fallback
npm start -- --debug                   # Debug logging
npm run dev                            # File watching

# Account management
npm run accounts:add                   # OAuth flow
npm run accounts:add -- --no-browser   # Headless (manual code)
npm run accounts:add -- --refresh-token  # Use refresh token directly
npm run accounts:list                  # List accounts
npm run accounts:verify                # Test tokens

# With environment variable
REFRESH_TOKEN=1//xxx npm run accounts:add -- --refresh-token

# Tests (server must be running)
npm test
```

## Refresh Token Authentication

Add accounts using only a refresh token (no OAuth flow needed).

### Where to Find Refresh Tokens

| Source                    | Location                                             |
| ------------------------- | ---------------------------------------------------- |
| Gemini CLI                | `~/.gemini/oauth_creds.json` (`refresh_token` field) |
| opencode-antigravity-auth | `~/.config/opencode/`                                |

### Token Format

- **Refresh tokens**: Start with `1//`, long-lived
- **Access tokens**: Start with `ya29.`, ~1 hour expiry

## Related Projects

### Direct Links (user-provided)

- **opencode-antigravity-auth** - OpenCode plugin for Antigravity auth
  https://github.com/NoeFabris/opencode-antigravity-auth

- **Antigravity-Manager** - Exposes endpoint with fallbacks (stable)
  https://github.com/lbjlaq/Antigravity-Manager

- **CLIProxyAPI** - API and proxy implementation
  https://github.com/router-for-me/CLIProxyAPI

### Gemini CLI OAuth

Token location: `~/.gemini/oauth_creds.json`

Uses standard Gemini CLI OAuth credentials (see Gemini CLI source for values).
Endpoint: `https://cloudcode-pa.googleapis.com`

### Claude Code OAuth (different system)

Token location: `~/.claude/.credentials.json`

- Access tokens: `sk-ant-oat01-*` (8 hour expiry)
- Refresh tokens: `sk-ant-ort01-*`
- Token endpoint: `https://console.anthropic.com/api/oauth/token`
- API endpoint: `https://api.anthropic.com/v1/messages`

### Documentation Links

- https://developers.google.com/identity/protocols/oauth2
- https://ai.google.dev/gemini-api/docs/oauth
- https://deepwiki.com/google-gemini/gemini-cli/2.2-authentication
- https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/sdk-usage.md

## OAuth Error Reference

| Error                | Cause                 | Solution                |
| -------------------- | --------------------- | ----------------------- |
| `invalid_grant`      | Token revoked/expired | Re-authenticate         |
| `invalid_client`     | Wrong OAuth client    | Use correct credentials |
| `RESOURCE_EXHAUSTED` | Rate limit            | Wait or switch accounts |
| `401 Unauthorized`   | Access token expired  | Auto-refreshed          |
