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
 * Start a local server to receive the OAuth callback
 * Returns an object with a promise and an abort function
 *
 * @param {string} expectedState - Expected state parameter for CSRF protection
 * @param {number} timeoutMs - Timeout in milliseconds (default 120000)
 * @returns {{promise: Promise<string>, abort: Function}} Object with promise and abort function
 */
export function startCallbackServer(expectedState, timeoutMs = 120000) {
    let server = null;
    let timeoutId = null;
    let isAborted = false;

    const promise = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${OAUTH_CONFIG.callbackPort}`);

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

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${OAUTH_CONFIG.callbackPort} is already in use. Close any other OAuth flows and try again.`));
            } else {
                reject(err);
            }
        });

        server.listen(OAUTH_CONFIG.callbackPort, () => {
            logger.info(`[OAuth] Callback server listening on port ${OAUTH_CONFIG.callbackPort}`);
        });

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

    return { promise, abort };
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
