# Available Models

Models are discovered per account. `/v1/models` lists the union of models available
on enabled, valid accounts. When discovery succeeds, requests are routed only to
accounts whose catalog includes the requested model. New model rollouts may appear
on only some accounts.

## Claude Models

| Model ID                     | Description                              |
| ----------------------------- | ---------------------------------------- |
| `claude-opus-4-6-thinking`    | Claude Opus 4.6 with extended thinking   |
| `claude-sonnet-4-6`           | Claude Sonnet 4.6                       |
| `claude-opus-5-5-high`        | Claude Opus 5.5, high reasoning effort   |
| `claude-opus-5-5-medium`      | Claude Opus 5.5, medium reasoning effort |
| `claude-opus-5-5-low`         | Claude Opus 5.5, low reasoning effort    |
| `claude-sonnet-5-5-high`      | Claude Sonnet 5.5, high reasoning effort |
| `claude-sonnet-5-5-medium`    | Claude Sonnet 5.5, medium reasoning effort |
| `claude-sonnet-5-5-low`       | Claude Sonnet 5.5, low reasoning effort  |

Use the exact IDs returned by `/v1/models`; the examples above are not guaranteed
to be available on every account. Claude effort variants support thinking output.

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
A model shows up in `/v1/models` as soon as the backend returns it for an enabled account.

- Codename IDs without `gemini`/`claude` in the name are classified by the backend's
  `apiProvider` and `supportsThinking` metadata. They are only accepted when listed
  as agent models (`agentModelSorts` / `tieredModelIds`). Internal and other-provider
  models stay hidden, as do unusable `-disabled` placeholders.
- Newer models require the Antigravity Hub User-Agent format
  (`antigravity/hub/<version> <os>/<arch>`). Versions are detected from the installed
  app, with `2.25.0` as the fallback. Override them in `config.json`:

```json
{ "antigravityClientVersion": "<version>", "antigravityIdeVersion": "<ideVersion>" }
```

The environment variables `ANTIGRAVITY_CLIENT_VERSION` / `FALLBACK_ANTIGRAVITY_VERSION`
take precedence. Restart after changing versions.

Once a real ID appears in `/v1/models`, a friendly name can be configured:

```json
{ "modelMapping": { "gemini-4-argon": { "mapping": "<id from /v1/models>" } } }
```

Eligible accounts may expose `gemini-4-argon-low`, `gemini-4-argon-medium` and
`gemini-4-argon-high`. The bare `gemini-4-argon` ID is not a Cloud Code model ID.
Use the exact IDs returned by `/v1/models`; requests for unlisted IDs are rejected
when account discovery succeeds.

## OpenAI-Compatible Usage

`/v1/chat/completions` reports cache hits in `usage.prompt_tokens_details.cached_tokens`
for both streaming and non-streaming responses. `prompt_tokens` includes cached and
uncached input; `total_tokens` adds completion tokens. Streaming usage is reported
in the final completion chunk using the upstream's final token counts.

Antigravity manages prompt caching implicitly. Explicit `cache_control` is not
forwarded because the upstream API rejects it. Reuse the same conversation prefix
and account for cache continuity; the sticky account strategy is cache-optimized.
Cache hits depend on the upstream service. If it omits cached-token metadata, the
proxy reports zero rather than estimating or fabricating a cache hit.
