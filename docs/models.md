# Available Models

## Claude Models

Which Claude models you get depends on your plan, and Google renames them from time to time.
Check `curl http://localhost:8080/v1/models` for your account's exact ids. As of November 2026:

| Plan             | Claude ids                                                        |
| ---------------- | ----------------------------------------------------------------- |
| Google AI Pro / Ultra | `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}` |
| Free             | `claude-opus-4-6-thinking`, `claude-sonnet-4-6` (access ends Nov 30, 2026) |

### Claude Code model names resolve automatically

Claude Code sends its own model names (`claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`,
`claude-fable-5-2`, with or without `[1m]`). These aren't backend ids, so the proxy resolves them
against your account's live model list:

| Requested name     | Resolves to                                 |
| ------------------ | ------------------------------------------- |
| `claude-opus-*`    | newest Opus, `medium` effort                |
| `claude-sonnet-*`  | newest Sonnet, `medium` effort              |
| `claude-sonnet-5`  | newest Sonnet, `low` effort (Auto Mode's safety classifier) |
| `claude-haiku-*`   | newest Sonnet, `low` effort (no Haiku on the backend) |
| `claude-fable-*`   | newest Opus, `high` effort (no Fable on the backend) |

"Newest" means the highest version the account offers. If that effort isn't offered, the closest
one is used (e.g. `claude-opus-4-6-thinking` on free accounts). A backend id your account no longer
offers (e.g. `claude-sonnet-4-6` after an upgrade) resolves the same way, so old configs keep
working. A `modelMapping` entry in `config.json` still takes priority, and an id the account
offers as-is is never rewritten. If the live list can't be fetched, a built-in table is used.

## Gemini Models

```bash
curl http://localhost:8080/v1/models
```

`/v1/models` hides Gemini generations below 3.5 (`2.5-*`, `3-flash`, `3.1-*`) and the
unversioned duplicate aliases `gemini-pro-agent` / `gemini-3-flash-agent`. Hidden ids
still work if configured explicitly (e.g. `ANTHROPIC_MODEL=gemini-3.1-pro-low`).

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

## New / Codename Models (e.g. Gemini 4 "Argon")

The model list comes from Cloud Code's `fetchAvailableModels`, not from a hardcoded list.
A model shows up in `/v1/models` as soon as the backend returns it for your account.

- **Codename ids:** ids without `gemini`/`claude` in the name are classified by the backend's
  `apiProvider` and `supportsThinking` metadata. They are only accepted when the backend lists
  them as agent models (`agentModelSorts` / `tieredModelIds`). Internal models (`tab_*`, `chat_*`)
  and other providers stay hidden.
- **Client version gating:** the backend hides newer models unless the User-Agent uses the
  Antigravity Hub format (`antigravity/hub/<version> <os>/<arch>`) with a recent version. The
  version is detected from the installed Antigravity app; if none is found, the fallback is
  `2.32.0`. To override the detected versions, set them in `config.json`:

  ```json
  { "antigravityClientVersion": "<version>", "antigravityIdeVersion": "<ideVersion>" }
  ```

  The env vars `ANTIGRAVITY_CLIENT_VERSION` / `FALLBACK_ANTIGRAVITY_VERSION` take precedence. Restart after changing.
- **Friendly aliases:** once the real id appears in `/v1/models`, map a name to it with `modelMapping`:

  ```json
  { "modelMapping": { "gemini-4-argon": { "mapping": "<id from /v1/models>" } } }
  ```

  Requests for an id the backend doesn't list fail with `400 invalid_request_error`.

> Gemini 4 Argon: with the Hub User-Agent, Cloud Code lists `gemini-4-argon-low`,
> `gemini-4-argon-medium` and `gemini-4-argon-high` for eligible accounts (e.g. Google AI Ultra).
> The bare id `gemini-4-argon` is the Gemini API name and returns `404 NOT_FOUND` on this backend.
> No id is hardcoded: check `curl http://localhost:8080/v1/models` for what your account gets.
