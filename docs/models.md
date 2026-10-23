# Available Models

## Claude Models

| Model ID                     | Description                              |
| ----------------------------- | ---------------------------------------- |
| `claude-sonnet-4-6-thinking`  | Claude Sonnet 4.6 with extended thinking |
| `claude-opus-4-6-thinking`    | Claude Opus 4.6 with extended thinking   |
| `claude-sonnet-4-6`           | Claude Sonnet 4.6 without thinking       |

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
  `2.25.0`. To override the detected versions, set them in `config.json`:

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
