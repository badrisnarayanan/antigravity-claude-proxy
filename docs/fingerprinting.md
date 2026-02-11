# Device Fingerprinting

To prevent Google from detecting automated API usage and to reduce the risk of rate limits or bans, Antigravity Claude Proxy implements a robust **Device Fingerprinting** system.

Each connected Google account is assigned a unique, persistent device identity that mimics a real developer workstation.

## How It Works

When you add a Google account, the proxy generates a unique fingerprint containing:

*   **Device ID**: A persistent UUID (`X-Client-Device-Id`)
*   **User Agent**: A randomized but valid user agent string (e.g., `antigravity/1.2.0 darwin/arm64`)
*   **API Client**: A randomized Google Cloud SDK client identifier (`X-Goog-Api-Client`)
*   **Quota User**: A unique ID for Google's quota tracking (`X-Goog-QuotaUser`)
*   **Client Metadata**: OS version, architecture, and IDE details

These headers are sent with every API request made by that account, ensuring consistency. This prevents the "suspicious activity" flags that often occur when multiple requests come from different "devices" (random headers) in a short period.

## Viewing Fingerprints

You can inspect the assigned fingerprint for any account in the Web Dashboard:

1.  Go to the **Accounts** tab.
2.  Click the **Fingerprint** icon (fingerprint symbol) next to an account.
3.  A modal will appear showing the **Device ID**, **User Agent**, and **Platform**.
4.  Expand the **Advanced Details** section to see the Session Token, API Client, and technical metadata.

## Regenerating Fingerprints

If you suspect an account has been flagged, rate-limited, or shadow-banned, you can generate a fresh identity:

1.  Open the **Fingerprint Modal** for the affected account.
2.  Click the **Regenerate Fingerprint** button.
3.  A new device identity will be created immediately.

> [!NOTE]
> The previous fingerprint is saved to a local history (last 5 entries) and can be restored if needed.

## Persistence

Fingerprints are saved to `~/.config/antigravity-proxy/accounts.json` and persist across server restarts. This ensures that your "device" remains stable over time, which is generally safer for account longevity than rotating identities on every request.
