# CLAUDE.md

Node.js proxy that exposes an Anthropic-compatible API backed by Google's Cloud Code service, letting Claude Code CLI use Gemini (and Claude) models via Google accounts with multi-account quota management.

Request flow: `Claude Code CLI → Express (server.js) → CloudCode client → Antigravity Cloud Code API`

## Commands

```bash
npm install          # installs deps and builds CSS (prepare hook)
npm start            # port 8080
npm run dev          # watch server files
npm run dev:full     # watch CSS + server files

npm start -- --strategy=sticky       # cache-optimized (default is hybrid)
npm start -- --strategy=round-robin  # load-balanced
npm start -- --fallback              # fall back to alternate model on quota exhaustion
npm start -- --dev-mode              # enables debug logging + dev tools (--debug is a legacy alias)

npm run build:css    # compile Tailwind once
npm run watch:css    # watch CSS

npm run accounts:add                 # add Google account via OAuth
npm run accounts:add -- --no-browser # headless/manual code input
npm run accounts:list
npm run accounts:verify
npm run accounts:import-agy          # import from Antigravity CLI (agy) token

npm start -- --no-webui              # disable WebUI (API-only, saves RAM)

npm test                             # requires server running on port 8080
node tests/run-all.cjs <filter>      # run matching tests only
node tests/test-strategies.cjs       # strategy unit tests (no server needed)
```

## Non-obvious things

**CSS**: Source is `public/css/src/input.css` (Tailwind + `@apply`). Compiled output is `public/css/style.css` — don't edit the compiled file.

**Quota thresholds** are stored as fractions (0–0.99) but displayed as percentages in the UI. Three-tier resolution: per-model > per-account > global.

**`cache_control` stripping**: Claude Code CLI sends `cache_control` on content blocks; Cloud Code API rejects them. Stripped at the start of `convertAnthropicToGoogle()` before any other processing.

**Cross-model thinking signatures**: Claude and Gemini signatures are incompatible. When switching models mid-conversation, mismatched signatures are dropped. Gemini targets: strict (drop unknown). Claude targets: lenient (let Claude validate).

**`CLAUDE_CONFIG_PATH` env var**: Set this when running as a systemd service — `os.homedir()` returns the service user's home, not the real user's.

**`WEBUI_PASSWORD` env var**: Enables password protection on the web UI.

**Native module rebuild**: On Node.js version mismatch, `better-sqlite3` is auto-rebuilt via `npm rebuild`. If reload still fails after rebuild, a server restart is required.

**Dev mode sub-toggles** are client-side only (localStorage in `settings-store.js`): screenshot/redact mode, debug logging, log export, health inspector, placeholder data. No backend involvement.

**`/api/strategy/health`** returns 403 unless dev mode is on.

**`agy` CLI token reuse (`source: 'agy'`)**: The standalone Antigravity CLI (`agy`) stores its Google OAuth token at `~/.gemini/antigravity-cli/antigravity-oauth-token`. `agy` uses the same OAuth client_id/secret as this proxy, so its refresh_token can be refreshed directly. Import with `npm run accounts:import-agy`. No full Antigravity IDE install required. The proxy reads the token file on each request (with caching), and optionally writes back refreshed access tokens when `AGY_TOKEN_WRITEBACK=1`.

**`--no-webui` flag**: Disables the WebUI (static files + account management API routes) for headless servers where only the Anthropic-compatible `/v1/*` API is needed. Saves ~30-50MB RAM. Can also be set via `DISABLE_WEBUI=1` or `NO_WEBUI=1` env vars.
