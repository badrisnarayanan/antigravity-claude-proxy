/**
 * Google OAuth with PKCE for Antigravity
 *
 * Implements the same OAuth flow as opencode-antigravity-auth
 * to obtain refresh tokens for multiple Google accounts.
 * Uses a local callback server to automatically capture the auth code.
 */

import crypto from 'crypto';
import http from 'http';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    LOAD_CODE_ASSIST_HEADERS,
    OAUTH_CONFIG,
    OAUTH_REDIRECT_URI
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { onboardUser, getDefaultTierId } from '../account-manager/onboarding.js';

/**
 * Parse refresh token parts (aligned with opencode-antigravity-auth)
 * Format: refreshToken|projectId|managedProjectId
 *
 * @param {string} refresh - Composite refresh token string
 * @returns {{refreshToken: string, projectId: string|undefined, managedProjectId: string|undefined}}
 */
export function parseRefreshParts(refresh) {
    const [refreshToken = '', projectId = '', managedProjectId = ''] = (refresh ?? '').split('|');
    return {
        refreshToken,
        projectId: projectId || undefined,
        managedProjectId: managedProjectId || undefined,
    };
}

/**
 * Format refresh token parts back into composite string
 *
 * @param {{refreshToken: string, projectId?: string|undefined, managedProjectId?: string|undefined}} parts
 * @returns {string} Composite refresh token
 */
export function formatRefreshParts(parts) {
    const projectSegment = parts.projectId ?? '';
    const base = `${parts.refreshToken}|${projectSegment}`;
    return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

/**
 * Generate authorization URL for Google OAuth
 * Returns the URL and the PKCE verifier (needed for token exchange)
 *
 * @param {string} [customRedirectUri] - Optional custom redirect URI (e.g. for WebUI)
 * @returns {{url: string, verifier: string, state: string}} Auth URL and PKCE data
 */
export function getAuthorizationUrl(customRedirectUri = null) {
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: customRedirectUri || OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: OAUTH_CONFIG.scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state
    });

    return {
        url: `${OAUTH_CONFIG.authUrl}?${params.toString()}`,
        verifier,
        state
    };
}

/**
 * Extract authorization code and state from user input.
 * User can paste either:
 * - Full callback URL: http://localhost:51121/oauth-callback?code=xxx&state=xxx
 * - Just the code parameter: 4/0xxx...
 *
 * @param {string} input - User input (URL or code)
 * @returns {{code: string, state: string|null}} Extracted code and optional state
 */
export function extractCodeFromInput(input) {
    if (!input || typeof input !== 'string') {
        throw new Error('No input provided');
    }

    const trimmed = input.trim();

    // Check if it looks like a URL
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            const url = new URL(trimmed);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                throw new Error(`OAuth error: ${error}`);
            }

            if (!code) {
                throw new Error('No authorization code found in URL');
            }

            return { code, state };
        } catch (e) {
            if (e.message.includes('OAuth error') || e.message.includes('No authorization code')) {
                throw e;
            }
            throw new Error('Invalid URL format');
        }
    }

    // Assume it's a raw code
    // Google auth codes typically start with "4/" and are long
    if (trimmed.length < 10) {
        throw new Error('Input is too short to be a valid authorization code');
    }

    return { code: trimmed, state: null };
}

/**
 * Attempt to bind server to a specific port
 * @param {http.Server} server - HTTP server instance
 * @param {number} port - Port to bind to
 * @returns {Promise<number>} Resolves with port on success, rejects on error
 */
function tryBindPort(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener('listening', onSuccess);
            reject(err);
        };
        const onSuccess = () => {
            server.removeListener('error', onError);
            resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onSuccess);
        server.listen(port);
    });
}

/**
 * Start a local server to receive the OAuth callback
 * Implements automatic port fallback for Windows compatibility (issue #176)
 * Returns an object with a promise and an abort function
 *
 * @param {string} expectedState - Expected state parameter for CSRF protection
 * @param {number} timeoutMs - Timeout in milliseconds (default 120000)
 * @returns {{promise: Promise<string>, abort: Function, getPort: Function}} Object with promise, abort, and getPort functions
 */
export function startCallbackServer(expectedState, timeoutMs = 120000) {
    let server = null;
    let timeoutId = null;
    let isAborted = false;
    let actualPort = OAUTH_CONFIG.callbackPort;

    const promise = new Promise(async (resolve, reject) => {
        // Build list of ports to try: primary + fallbacks
        const portsToTry = [OAUTH_CONFIG.callbackPort, ...(OAUTH_CONFIG.callbackFallbackPorts || [])];
        const errors = [];

        server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${actualPort}`);

            if (url.pathname !== '/oauth-callback') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <html>
                    <head><meta charset="UTF-8"><title>Authentication Failed</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                        <p>Error: ${error}</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `);
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <html>
                    <head><meta charset="UTF-8"><title>Authentication Failed</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                        <p>State mismatch - possible CSRF attack.</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `);
                server.close();
                reject(new Error('State mismatch'));
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <html>
                    <head><meta charset="UTF-8"><title>Authentication Failed</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                        <p>No authorization code received.</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `);
                server.close();
                reject(new Error('No authorization code'));
                return;
            }

            // Success!
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <html>
                <head><meta charset="UTF-8"><title>Authentication Successful</title></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h1 style="color: #28a745;">✅ Authentication Successful!</h1>
                    <p>You can close this window and return to the terminal.</p>
                    <script>setTimeout(() => window.close(), 2000);</script>
                </body>
                </html>
            `);

            server.close();
            resolve(code);
        });

        // Try ports with fallback logic (issue #176 - Windows EACCES fix)
        let boundSuccessfully = false;
        for (const port of portsToTry) {
            try {
                await tryBindPort(server, port);
                actualPort = port;
                boundSuccessfully = true;

                if (port !== OAUTH_CONFIG.callbackPort) {
                    logger.warn(`[OAuth] Primary port ${OAUTH_CONFIG.callbackPort} unavailable, using fallback port ${port}`);
                } else {
                    logger.info(`[OAuth] Callback server listening on port ${port}`);
                }
                break;
            } catch (err) {
                const errMsg = err.code === 'EACCES'
                    ? `Permission denied on port ${port}`
                    : err.code === 'EADDRINUSE'
                    ? `Port ${port} already in use`
                    : `Failed to bind port ${port}: ${err.message}`;
                errors.push(errMsg);
                logger.warn(`[OAuth] ${errMsg}`);
            }
        }

        if (!boundSuccessfully) {
            // All ports failed - provide helpful error message
            const isWindows = process.platform === 'win32';
            let errorMsg = `Failed to start OAuth callback server.\nTried ports: ${portsToTry.join(', ')}\n\nErrors:\n${errors.join('\n')}`;

            if (isWindows) {
                errorMsg += `\n
================== WINDOWS TROUBLESHOOTING ==================
The default port range may be reserved by Hyper-V/WSL2/Docker.

Option 1: Use a custom port
  Set OAUTH_CALLBACK_PORT=3456 in your environment or .env file

Option 2: Reset Windows NAT (run as Administrator)
  net stop winnat && net start winnat

Option 3: Check reserved port ranges
  netsh interface ipv4 show excludedportrange protocol=tcp

Option 4: Exclude port from reservation (run as Administrator)
  netsh int ipv4 add excludedportrange protocol=tcp startport=51121 numberofports=1
==============================================================`;
            } else {
                errorMsg += `\n\nTry setting a custom port: OAUTH_CALLBACK_PORT=3456`;
            }

            reject(new Error(errorMsg));
            return;
        }

        // Timeout after specified duration
        timeoutId = setTimeout(() => {
            if (!isAborted) {
                server.close();
                reject(new Error('OAuth callback timeout - no response received'));
            }
        }, timeoutMs);
    });

    // Abort function to clean up server when manual completion happens
    const abort = () => {
        if (isAborted) return;
        isAborted = true;
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        if (server) {
            server.close();
            logger.info('[OAuth] Callback server aborted (manual completion)');
        }
    };

    // Get actual port (useful when fallback is used)
    const getPort = () => actualPort;

    return { promise, abort, getPort };
}

/**
 * Exchange authorization code for tokens
 *
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} verifier - PKCE code verifier
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>} OAuth tokens
 */
export async function exchangeCode(code, verifier) {
    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            client_secret: OAUTH_CONFIG.clientSecret,
            code: code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: OAUTH_REDIRECT_URI
        })
    });

    if (!response.ok) {
        const error = await response.text();
        logger.error(`[OAuth] Token exchange failed: ${response.status} ${error}`);
        throw new Error(`Token exchange failed: ${error}`);
    }

    const tokens = await response.json();

    if (!tokens.access_token) {
        logger.error('[OAuth] No access token in response:', tokens);
        throw new Error('No access token received');
    }

    logger.info(`[OAuth] Token exchange successful, access_token length: ${tokens.access_token?.length}`);

    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in
    };
}

/**
 * Refresh access token using refresh token
 * Handles composite refresh tokens (refreshToken|projectId|managedProjectId)
 *
 * @param {string} compositeRefresh - OAuth refresh token (may be composite)
 * @returns {Promise<{accessToken: string, expiresIn: number}>} New access token
 */
export async function refreshAccessToken(compositeRefresh) {
    // Parse the composite refresh token to extract the actual OAuth token
    const parts = parseRefreshParts(compositeRefresh);

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            client_secret: OAUTH_CONFIG.clientSecret,
            refresh_token: parts.refreshToken,  // Use the actual OAuth token
            grant_type: 'refresh_token'
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
    }

    const tokens = await response.json();
    return {
        accessToken: tokens.access_token,
        expiresIn: tokens.expires_in
    };
}

/**
 * Get user email from access token
 *
 * @param {string} accessToken - OAuth access token
 * @returns {Promise<string>} User's email address
 */
export async function getUserEmail(accessToken) {
    const response = await fetch(OAUTH_CONFIG.userInfoUrl, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[OAuth] getUserEmail failed: ${response.status} ${errorText}`);
        throw new Error(`Failed to get user info: ${response.status}`);
    }

    const userInfo = await response.json();
    return userInfo.email;
}

/**
 * Discover project ID for the authenticated user
 *
 * @param {string} accessToken - OAuth access token
 * @returns {Promise<string|null>} Project ID or null if not found
 */
export async function discoverProjectId(accessToken) {
    let loadCodeAssistData = null;

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    ...LOAD_CODE_ASSIST_HEADERS
                },
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI'
                    }
                })
            });

            if (!response.ok) continue;

            const data = await response.json();
            loadCodeAssistData = data;

            if (typeof data.cloudaicompanionProject === 'string') {
                return data.cloudaicompanionProject;
            }
            if (data.cloudaicompanionProject?.id) {
                return data.cloudaicompanionProject.id;
            }

            // No project found - try to onboard
            logger.info('[OAuth] No project in loadCodeAssist response, attempting onboardUser...');
            break;
        } catch (error) {
            logger.warn(`[OAuth] Project discovery failed at ${endpoint}:`, error.message);
        }
    }

    // Try onboarding if we got a response but no project
    if (loadCodeAssistData) {
        const tierId = getDefaultTierId(loadCodeAssistData.allowedTiers) || 'FREE';
        logger.info(`[OAuth] Onboarding user with tier: ${tierId}`);

        const onboardedProject = await onboardUser(accessToken, tierId);
        if (onboardedProject) {
            logger.success(`[OAuth] Successfully onboarded, project: ${onboardedProject}`);
            return onboardedProject;
        }
    }

    return null;
}

/**
 * Complete OAuth flow: exchange code and get all account info
 *
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} verifier - PKCE code verifier
 * @returns {Promise<{email: string, refreshToken: string, accessToken: string, projectId: string|null}>} Complete account info
 */
export async function completeOAuthFlow(code, verifier) {
    // Exchange code for tokens
    const tokens = await exchangeCode(code, verifier);

    // Get user email
    const email = await getUserEmail(tokens.accessToken);

    // Discover project ID
    const projectId = await discoverProjectId(tokens.accessToken);

    return {
        email,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        projectId
    };
}

export default {
    parseRefreshParts,
    formatRefreshParts,
    getAuthorizationUrl,
    extractCodeFromInput,
    startCallbackServer,
    exchangeCode,
    refreshAccessToken,
    getUserEmail,
    discoverProjectId,
    completeOAuthFlow
};
