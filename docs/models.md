# Available Models

## Account access, without generation probes

`/v1/models` is the union of the enabled, healthy accounts' actual Cloud Code
catalogs. A request is eligible only for an account whose own metadata offers
that exact model ID. A restricted Pro account cannot borrow an Ultra account's
cached permissions. Selection strategies are unchanged; eligibility is checked
before selection and again for the selected account/project before generation.

Subscription labels come from active `paidTier` / `currentTier` metadata.
`allowedTiers` describes onboarding/upgrade choices, not purchased access.
Unknown metadata stays unknown. In particular, `paidTier: g1-pro-tier` does not
prove whether Pro is paid, a trial, a device offer, or a family entitlement: the
response has no reliable payment/trial field. `paymentStatus` and `trialStatus`
therefore remain `unknown`; model availability is determined by the account
catalog instead of guessing permissions from the word Pro.

Metadata lookups use `loadCodeAssist` and `fetchAvailableModels`, never a test
prompt. Subscription display and project discovery share their metadata lookup;
model listing, validation and quotas also share one lookup per token/project.
The in-memory cache lasts five minutes, deduplicates concurrent requests and is
bounded. Failures are cached for ten seconds to avoid retry storms. Empty model
lists are authoritative; failed/malformed lookups do not grant access.

## Thinking levels are specific to the account and model

Use complete IDs returned by `/v1/models`; no missing variants are synthesized.
When Cloud Code supplies `groupedModels.supportedThinkingLevels`, the listing
can include `thinking_level: { id, display_name }` for matching exact model IDs.
Suffixes and display labels are kept as returned. `xhigh`, `max`, and the UI
label Extra must not be universally substituted for one another.

For reference only, current official documentation gives these examples:

| Surface/model | Example ID pattern | Documented levels |
| --- | --- | --- |
| Gemini Neon / Hydrogen | `gemini-4-{name}-{level}` | `low`, `medium`, `high`, `xhigh` (UI Extra) |
| Gemini Carbon / 3.8 Flash | `gemini-4-carbon-{level}` / `gemini-3.8-flash-{level}` | `low`, `medium`, `high` |
| **Enterprise** Claude Sonnet / Opus 5.5 | `claude-{name}-5-5-{level}` | `low`, `medium` (default), `high`, `max` |

The Enterprise Claude table is not a guarantee that consumer Pro, trial Pro,
or even another backend exposes the same variants. Only that account's
returned, enabled agent models are selectable. Orchestrator is a planner/executor
agent mode and is outside these single-model examples.

The built-in aliases `claude-sonnet-5-5` and `claude-opus-5-5` resolve to their
own `medium` variants, not to 4.6. If that variant is unavailable, the request is
rejected instead of silently changing generation. Supported explicit tier IDs
pass through unchanged with Claude thinking/tool handling. Suffix selection is
separate from the existing thinking-token budget (32,000 by default or the
client's explicit `thinking.budget_tokens`); this change does not invent budget
values or translate effort levels between models.

Sources: [consumer models](https://antigravity.google/docs/models),
[Enterprise model IDs/levels](https://antigravity.google/docs/enterprise),
[`/effort`](https://antigravity.google/docs/cli/commands/effort/), and the
[public loadCodeAssist response types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts).

## Disabled and retired models

`models[id].disabled`, disabled placeholders, and `deprecatedModelIds` are
excluded from listings, quota rows and request validation. The proxy does not
follow `newModelId` to another model automatically. If an old Argon entry remains
in `models` but is marked deprecated/disabled, it cannot be selected or invoked.
Models absent after the cache refresh are likewise rejected, including requests
from clients that saved an old ID.

If `agentModelSorts` / `tieredModelIds` are supplied, only their exact agent IDs
are eligible. This also prevents tiers that exist in a broader metadata map but
are not offered to this account from appearing as choices. Older responses
without those roster fields retain name/provider-based classification.

The model list comes from Cloud Code, not from the reference table above.
Codename IDs without `gemini`/`claude` are recognized only through backend
provider metadata and the agent roster; internal/tab-completion models stay
excluded. Gemini generations below 3.5 are hidden from the menu, but can still
be requested explicitly if the account actually lists them as selectable.

```bash
curl http://localhost:8080/v1/models
```

## Client version and custom aliases

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
