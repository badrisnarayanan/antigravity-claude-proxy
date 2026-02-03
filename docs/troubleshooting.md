# Troubleshooting

## Quick Links

- [Windows: OAuth Port Error (EACCES)](#windows-oauth-port-error-eacces)
- ["Could not extract token from Antigravity"](#could-not-extract-token-from-antigravity)
- [401 Authentication Errors](#401-authentication-errors)
- [Rate Limiting (429)](#rate-limiting-429)
- [Account Shows as "Invalid"](#account-shows-as-invalid)
- [403 Permission Denied](#403-permission-denied)

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

## 403 Permission Denied

If you see:

```
403 permission_error - Permission denied
```

This usually means your Google account requires phone number verification:

1. Download the Antigravity app from https://antigravity.google/download
2. Log in with the affected account(s)
3. Complete phone number verification when prompted (or use QR code on Android)
4. After verification, the account should work properly with the proxy

> **Note:** This verification is required by Google and cannot be bypassed through the proxy.
