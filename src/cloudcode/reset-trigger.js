/**
 * Reset Trigger for Cloud Code
 *
 * Sends minimal API requests to trigger the 5-hour quota reset timer.
 * Uses the smallest possible request to consume minimal quota while
 * ensuring the reset timer starts counting down.
 *
 * Quota Groups:
 * 1. Claude Group: All Claude models (claude-sonnet-4-5-thinking, claude-opus-4-5-thinking,
 *    claude-sonnet-4-5) + GPT-OSS 120B - triggering ANY one resets the whole group
 * 2. Gemini Pro Group: gemini-3-pro-high, gemini-3-pro-low - triggering either resets both
 * 3. Gemini Flash Group: gemini-3-flash - separate from Pro group
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { logger } from '../utils/logger.js';

/**
 * Quota groups - one representative model from each group
 * Triggering any model in a group resets the timer for all models in that group
 *
 * Note: We use non-thinking models where possible to avoid thinking budget constraints
 */
const QUOTA_GROUPS = [
    {
        name: 'Claude',
        model: 'claude-sonnet-4-5',  // Non-thinking model to avoid budget constraints
        description: 'Claude + GPT-OSS models'
    },
    {
        name: 'Gemini Pro',
        model: 'gemini-3-pro-high',
        description: 'Gemini 3 Pro (high & low)'
    },
    {
        name: 'Gemini Flash',
        model: 'gemini-3-flash',
        description: 'Gemini 3 Flash'
    }
];

// Export model names for backwards compatibility
const TRIGGER_MODELS = QUOTA_GROUPS.map(g => g.model);

/**
 * Build a minimal request payload that consumes the least quota possible
 *
 * @param {string} model - Model name
 * @param {string} projectId - Project ID
 * @returns {Object} Minimal request payload
 */
function buildMinimalRequest(model, projectId) {
    // Create a minimal Google AI request
    const googleRequest = {
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Hi' }]
            }
        ],
        generationConfig: {
            maxOutputTokens: 10,  // Small output to minimize quota usage
            temperature: 0
        },
        sessionId: `reset-trigger-${Date.now()}`
    };

    // Add thinking config only for thinking models (Gemini Pro/Flash need it)
    // Claude non-thinking models don't need thinking config
    if (isThinkingModel(model)) {
        const modelFamily = getModelFamily(model);
        if (modelFamily === 'gemini') {
            // Gemini thinking models need thinkingBudget > 0
            googleRequest.generationConfig.thinkingConfig = {
                thinkingBudget: 1
            };
        }
        // For Claude thinking models, we'd need maxOutputTokens > thinkingBudget
        // But we use non-thinking Claude model to avoid this complexity
    }

    return {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: 'reset-trigger-' + crypto.randomUUID()
    };
}

/**
 * Build headers for the API request
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @returns {Object} Headers object
 */
function buildHeaders(token, model) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    const modelFamily = getModelFamily(model);

    // Add interleaved thinking header only for Claude thinking models
    if (modelFamily === 'claude' && isThinkingModel(model)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    return headers;
}

/**
 * Send a minimal request to a single model for an account
 *
 * @param {string} token - OAuth access token
 * @param {string} projectId - Project ID
 * @param {Object} group - Quota group object with name, model, description
 * @returns {Promise<{success: boolean, group: string, model: string, error?: string, note?: string}>}
 */
async function triggerQuotaGroup(token, projectId, group) {
    const { name, model } = group;
    const payload = buildMinimalRequest(model, projectId);
    const headers = buildHeaders(token, model);

    let lastError = null;

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:generateContent`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const responseText = await response.text();

            if (response.ok) {
                return { success: true, group: name, model };
            }

            // Check for rate limit - that's actually fine, it means the timer is active
            const status = response.status;
            if (status === 429) {
                return {
                    success: true,
                    group: name,
                    model,
                    note: 'Already rate-limited (timer already active)'
                };
            }

            // Parse error for more info
            let errorDetail = `HTTP ${status}`;
            try {
                const errorJson = JSON.parse(responseText);
                // Handle various error structures
                if (typeof errorJson.error === 'object' && errorJson.error?.message) {
                    errorDetail = errorJson.error.message;
                } else if (typeof errorJson.error === 'string') {
                    errorDetail = errorJson.error;
                } else if (errorJson.message) {
                    errorDetail = errorJson.message;
                }
                // Truncate long messages
                if (errorDetail.length > 100) {
                    errorDetail = errorDetail.substring(0, 100) + '...';
                }
            } catch {
                // Not JSON, use status code
            }

            lastError = errorDetail;
            logger.debug(`[ResetTrigger] ${name} (${model}) failed at ${endpoint}: ${errorDetail}`);

        } catch (error) {
            lastError = error.message;
            logger.debug(`[ResetTrigger] ${name} (${model}) error at ${endpoint}: ${error.message}`);
        }
    }

    return {
        success: false,
        group: name,
        model,
        error: lastError || 'All endpoints failed'
    };
}

/**
 * Trigger reset timers for a single account
 * Sends minimal requests to all 3 quota groups (Claude, Gemini Pro, Gemini Flash)
 *
 * @param {Object} account - Account object
 * @param {Function} getToken - Function to get OAuth token for account
 * @param {Function} getProject - Function to get project ID for account
 * @param {Function} updateLastUsed - Function to update account's lastUsed timestamp
 * @returns {Promise<{email: string, results: Array}>}
 */
export async function triggerResetForAccount(account, getToken, getProject, updateLastUsed) {
    const email = account.email;

    try {
        const token = await getToken(account);
        const project = await getProject(account, token);

        // Trigger all quota groups in parallel
        const results = await Promise.all(
            QUOTA_GROUPS.map(group => triggerQuotaGroup(token, project, group))
        );

        // Update lastUsed timestamp if at least one group succeeded
        const anySuccess = results.some(r => r.success);
        if (anySuccess && updateLastUsed) {
            await updateLastUsed(account.email);
        }

        return {
            email,
            status: 'ok',
            results
        };
    } catch (error) {
        return {
            email,
            status: 'error',
            error: error.message,
            results: []
        };
    }
}

/**
 * Trigger reset timers for all accounts
 *
 * @param {AccountManager} accountManager - The account manager instance
 * @returns {Promise<Array<{email: string, status: string, results: Array}>>}
 */
export async function triggerResetForAllAccounts(accountManager) {
    const accounts = accountManager.getAllAccounts();

    if (accounts.length === 0) {
        return [];
    }

    logger.info(`[ResetTrigger] Triggering reset for ${accounts.length} account(s)...`);

    // Process accounts sequentially to avoid rate limiting issues
    // and ensure each account completes before moving to the next
    const results = [];
    const now = new Date().toISOString();

    for (const account of accounts) {
        const result = await triggerResetForAccount(
            account,
            (acc) => accountManager.getTokenForAccount(acc),
            (acc, token) => accountManager.getProjectForAccount(acc, token),
            null  // We'll update lastUsed directly after
        );

        // Update lastUsed timestamp if at least one group succeeded
        if (result.status === 'ok') {
            const anySuccess = result.results.some(r => r.success);
            if (anySuccess) {
                // Update directly on the account object (which is in the accounts array)
                account.lastUsed = now;
                logger.debug(`[ResetTrigger] Updated lastUsed for ${account.email}`);
            }
        }

        results.push(result);
    }

    // Save updated timestamps to disk
    logger.debug('[ResetTrigger] Saving account state to disk...');
    await accountManager.saveToDisk();

    // Log summary
    const successful = results.filter(r => r.status === 'ok').length;
    const failed = results.filter(r => r.status === 'error').length;

    logger.info(`[ResetTrigger] Complete: ${successful} succeeded, ${failed} failed`);

    return results;
}

/**
 * Format trigger results for display
 *
 * @param {Array} results - Results from triggerResetForAllAccounts
 * @returns {string} Formatted output
 */
export function formatTriggerResults(results) {
    if (results.length === 0) {
        return 'No accounts configured.';
    }

    const lines = [];
    lines.push(`\nReset Trigger Results (${new Date().toLocaleString()})`);
    lines.push('─'.repeat(60));

    for (const result of results) {
        const shortEmail = result.email.split('@')[0];

        if (result.status === 'error') {
            lines.push(`✗ ${shortEmail}: ${result.error}`);
        } else {
            lines.push(`✓ ${shortEmail}:`);
            for (const groupResult of result.results) {
                const icon = groupResult.success ? '  ✓' : '  ✗';
                const note = groupResult.note ? ` (${groupResult.note})` : '';
                const error = groupResult.error ? `: ${groupResult.error}` : '';
                lines.push(`${icon} ${groupResult.group}${note}${error}`);
            }
        }
    }

    lines.push('─'.repeat(60));

    // Count successes
    const accountsSuccessful = results.filter(r => r.status === 'ok').length;

    // Count group successes
    let totalGroups = 0;
    let successfulGroups = 0;
    for (const result of results) {
        if (result.results) {
            totalGroups += result.results.length;
            successfulGroups += result.results.filter(r => r.success).length;
        }
    }

    lines.push(`Accounts: ${accountsSuccessful}/${results.length} succeeded`);
    lines.push(`Groups: ${successfulGroups}/${totalGroups} triggered`);

    return lines.join('\n');
}

export { TRIGGER_MODELS, QUOTA_GROUPS };
