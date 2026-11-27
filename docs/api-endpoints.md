# API Endpoints

| Endpoint             | Method | Description                                                           |
| -------------------- | ------ | --------------------------------------------------------------------- |
| `/health`            | GET    | Health check                                                          |
| `/account-limits`    | GET    | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages`       | POST   | Anthropic Messages API                                                |
| `/v1/models`         | GET    | List available models                                                 |
| `/v1/account-quotas` | GET    | Each account's 5-hour and weekly quota per model group (see below)    |
| `/refresh-token`     | POST   | Force token refresh                                                   |

## `GET /v1/account-quotas`

Reports each account's quota pools: the 5-hour and the weekly window of each model group, as Google's `retrieveUserQuotaSummary` gives them. Unlike `/account-limits`, it is under `/v1`, so the API key (`Authorization: Bearer <key>` or `x-api-key`) protects it, and it does not need the web UI password.

```bash
curl -H "x-api-key: $API_KEY" http://localhost:8080/v1/account-quotas
```

```json
{
  "fetchedAt": "2026-11-21T12:00:00.000Z",
  "accounts": [
    {
      "email": "a@gmail.com",
      "enabled": true,
      "status": "ok",
      "tier": "ultra",
      "groups": [
        {
          "id": "gemini",
          "name": "Gemini Models",
          "windows": {
            "fiveHour": {
              "remainingFraction": 0.84,
              "resetTime": "2026-11-21T14:22:04Z"
            },
            "weekly": {
              "remainingFraction": 0.96,
              "resetTime": "2026-11-28T09:22:04Z"
            }
          }
        },
        {
          "id": "3p",
          "name": "Claude and GPT models",
          "windows": { "...": "..." }
        }
      ]
    },
    {
      "email": "b@gmail.com",
      "enabled": false,
      "status": "disabled",
      "tier": null,
      "groups": []
    },
    {
      "email": "c@gmail.com",
      "enabled": true,
      "status": "error",
      "tier": "ultra",
      "error": "HTTP 503",
      "groups": []
    }
  ]
}
```

- `status`: `ok`; `disabled` (account turned off, not fetched); `invalid` (the proxy marked the account invalid, not fetched; `error` gives the reason); `error` (the fetch failed; `error` is a short message).
- `tier`: the subscription tier the proxy knows for the account, or `null`.
- `remainingFraction` is 0-1. `resetTime` is an ISO time or `null`. A window that Google does not report is left out.
- Each account's result (also a failed one) is cached for 60 seconds, so frequent polls cost one Google call per account per minute. Accounts are fetched in parallel, and one account's failure does not fail the reply.
