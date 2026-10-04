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
