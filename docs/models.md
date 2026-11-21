# Available Models

## Claude Models

Cloud Code exposes Claude 5.5 thinking levels as distinct model IDs:

| Model | Model IDs | Thinking levels |
| --- | --- | --- |
| Claude Sonnet 5.5 | `claude-sonnet-5-5-{level}` | `low`, `medium` (default), `high`, `max` |
| Claude Opus 5.5 | `claude-opus-5-5-{level}` | `low`, `medium` (default), `high`, `max` |

Use a complete ID, for example `claude-sonnet-5-5-high`. The built-in aliases
`claude-sonnet-5-5` and `claude-opus-5-5` resolve to their respective `medium`
variants, not to Claude 4.6. Explicit tier IDs are forwarded unchanged, with
Claude thinking, interleaved-thinking headers and tool support enabled.

The suffix selects the backend's effort variant. It is not a fixed token budget:
this proxy retains its existing Claude thinking-budget behavior (32,000 tokens
by default, or the client's explicit `thinking.budget_tokens`). It does not
invent a different budget for each level.

Legacy `claude-sonnet-4-6-thinking`, `claude-opus-4-6-thinking` and
`claude-sonnet-4-6` remain usable when returned by the backend. Model visibility
and entitlement depend on the account; aliases do not grant access or fall back
to a different generation if 5.5 is unavailable.

## Gemini Models

| Model | Model IDs | Thinking levels |
| --- | --- | --- |
| Gemini 4 Neon | `gemini-4-neon-{level}` | `low`, `medium`, `high`, `xhigh` |
| Gemini 4 Carbon | `gemini-4-carbon-{level}` | `low`, `medium`, `high` |
| Gemini 4 Hydrogen | `gemini-4-hydrogen-{level}` | `low`, `medium`, `high`, `xhigh` |
| Gemini 3.8 Flash | `gemini-3.8-flash-{level}` | `low`, `medium`, `high` |

The Antigravity UI calls `xhigh` **Extra**. Claude's `max` and Gemini's `xhigh`
are different suffixes; use only a variant present in your account's model list.
The proxy forwards exact IDs without remapping their levels. Orchestrator is a
planner/executor agent mode and is outside these single-model examples.

These ID/level examples were checked against the official
[model documentation](https://antigravity.google/docs/models),
[enterprise model table](https://antigravity.google/docs/enterprise), and
[`/effort` reference](https://antigravity.google/docs/cli/commands/effort/).
They are not a static allowlist or a guarantee of account access.

```bash
curl http://localhost:8080/v1/models
```

`/v1/models` hides Gemini generations below 3.5 (`2.5-*`, `3-flash`, `3.1-*`) and the
unversioned duplicate aliases `gemini-pro-agent` / `gemini-3-flash-agent`. Hidden ids
still work if configured explicitly (e.g. `ANTHROPIC_MODEL=gemini-3.1-pro-low`).

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

## New / Codename Models

The model list comes from Cloud Code's `fetchAvailableModels`, not from a hardcoded list.
A model shows up in `/v1/models` as soon as the backend returns it for your account. Models that disappear from
the backend list also disappear on the next model-list refresh; older examples
such as Argon are not hardcoded as available or silently redirected to a replacement.

- **Codename ids:** ids without `gemini`/`claude` in the name are classified by the backend's
  `apiProvider` and `supportsThinking` metadata. They are only accepted when the backend lists
  them as agent models (`agentModelSorts` / `tieredModelIds`). Internal models (`tab_*`, `chat_*`)
  and other providers stay hidden.
- **Client version gating:** the backend hides newer models unless the User-Agent uses the
  Antigravity Hub format (`antigravity/hub/<version> <os>/<arch>`) with a recent version. The
  version is detected from the installed Antigravity app; if none is found, the fallback is
  `2.34.0`, matching the [Neon App release](https://antigravity.google/docs/changelog).
  Detected installed versions are still used as-is. If an older local App hides new
  models, update it or explicitly set `antigravityIdeVersion` to your intended Hub
  version. To override the detected versions, set them in `config.json`:

  ```json
  { "antigravityClientVersion": "<version>", "antigravityIdeVersion": "<ideVersion>" }
  ```

  The env vars `ANTIGRAVITY_CLIENT_VERSION` / `FALLBACK_ANTIGRAVITY_VERSION` take precedence. Restart after changing.
- **Friendly aliases:** once the real id appears in `/v1/models`, map a name to it with `modelMapping`:

  ```json
  { "modelMapping": { "my-model": { "mapping": "<id from /v1/models>" } } }
  ```

  Requests for an id the backend doesn't list fail with `400 invalid_request_error`.
