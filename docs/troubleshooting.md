# Troubleshooting

## Quick Links

- [Windows: OAuth Port Error (EACCES)](#windows-oauth-port-error-eacces)
- ["Could not extract token from Antigravity"](#could-not-extract-token-from-antigravity)
- [401 Authentication Errors](#401-authentication-errors)
- [Rate Limiting (429)](#rate-limiting-429)
- [Account Shows as "Invalid"](#account-shows-as-invalid)
- [403 Permission Denied / VALIDATION_REQUIRED](#403-permission-denied--validation_required)

---

## Windows: OAuth Port Error (EACCES)

On Windows, the default OAuth callback port (51121) may be reserved by Hyper-V, WSL2, or Docker. If you see:

```
Error: listen EACCES: permission denied 0.0.0.0:51121
```

The proxy will automatically try fallback ports (51122-51126). If all ports fail, try these solutions:

### Option 1: Use a Custom Port (Recommended)

Set a custom port outside the reserved range:

```bash
# Windows PowerShell
$env:OAUTH_CALLBACK_PORT = "3456"
antigravity-claude-proxy start

# Windows CMD
set OAUTH_CALLBACK_PORT=3456
antigravity-claude-proxy start

# Or add to your .env file
OAUTH_CALLBACK_PORT=3456
```

### Option 2: Reset Windows NAT

Run as Administrator:

```powershell
net stop winnat
net start winnat
```

### Option 3: Check Reserved Ports

See which ports are reserved:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

If 51121 is in a reserved range, use Option 1 with a port outside those ranges.

### Option 4: Permanently Exclude Port (Admin)

Reserve the port before Hyper-V claims it (run as Administrator):

```powershell
netsh int ipv4 add excludedportrange protocol=tcp startport=51121 numberofports=1
```

> **Note:** The server automatically tries fallback ports (51122-51126) if the primary port fails.

---

## "Could not extract token from Antigravity"

If using single-account mode with Antigravity:

1. Make sure Antigravity app is installed and running
2. Ensure you're logged in to Antigravity

Or add accounts via OAuth instead: `antigravity-claude-proxy accounts add`

## 401 Authentication Errors

The token might have expired. Try:

```bash
curl -X POST http://localhost:8080/refresh-token
```

Or re-authenticate the account:

```bash
antigravity-claude-proxy accounts
```

## Rate Limiting (429)

With multiple accounts, the proxy automatically switches to the next available account. With a single account, you'll need to wait for the rate limit to reset.

## Account Shows as "Invalid"

Re-authenticate the account:

```bash
antigravity-claude-proxy accounts
# Choose "Re-authenticate" for the invalid account
```

## 403 Permission Denied / VALIDATION_REQUIRED

If you see:

```
403 VALIDATION_REQUIRED - Account requires verification
```

This means Google requires your account to complete verification (phone number, captcha, or terms acceptance).

**The proxy handles this automatically:**

1. The affected account is marked invalid and the proxy rotates to the next available account
2. If a verification URL is provided by Google, it's stored and shown in the WebUI
3. Other accounts continue working normally while the affected account is paused

**To fix the affected account:**

1. Open the WebUI (http://localhost:8080)
2. Find the account marked with an error badge
3. Click the **FIX** button — this opens the Google verification page directly
4. Complete the verification (phone number, captcha, etc.)
5. Click the **↻ Refresh** button on the account to re-enable it

**If the FIX button opens an OAuth page instead** (no verification URL was provided), re-authenticate the account:

```bash
antigravity-claude-proxy accounts
# Choose "Re-authenticate" for the invalid account
```

**If all accounts are invalid**, the proxy returns an error immediately instead of waiting indefinitely:

```
All accounts are invalid: Account requires verification. Visit the WebUI to fix them.
```

> **Note:** Verification errors persist across server restarts until resolved. Auth errors (token revoked/expired) are reset on restart and require OAuth re-authentication via the FIX button.
