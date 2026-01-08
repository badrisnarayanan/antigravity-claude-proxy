/**
 * Request Builder for Cloud Code
 *
 * Builds request payloads and headers for the Cloud Code API.
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_HEADERS,
    ANTIGRAVITY_SYSTEM_INSTRUCTION,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertAnthropicToGoogle } from '../format/index.js';
import { deriveSessionId } from './session-manager.js';

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId) {
    const model = anthropicRequest.model;
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use stable session ID derived from first user message for cache continuity
    googleRequest.sessionId = deriveSessionId(anthropicRequest);

    // Build systemInstruction with role: "user" (CLIProxyAPI v6.6.89 compatibility)
    // Prepend Antigravity identity to any existing system instructions
    let systemInstructionText = ANTIGRAVITY_SYSTEM_INSTRUCTION;
    if (googleRequest.systemInstruction && googleRequest.systemInstruction.parts) {
        const existingText = googleRequest.systemInstruction.parts
            .map(p => p.text || '')
            .filter(t => t)
            .join('\n');
        if (existingText) {
            systemInstructionText = ANTIGRAVITY_SYSTEM_INSTRUCTION + '\n\n' + existingText;
        }
    }

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestType: 'agent',  // CLIProxyAPI v6.6.89 compatibility
        requestId: 'agent-' + crypto.randomUUID()
    };

    // Inject systemInstruction with role: "user" at the top level (CLIProxyAPI v6.6.89 behavior)
    payload.request.systemInstruction = {
        role: 'user',
        parts: [{ text: systemInstructionText }]
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @param {string} accept - Accept header value (default: 'application/json')
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = 'application/json') {
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

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}
