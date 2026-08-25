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

// cloudcode-pa returns an opaque 429 RESOURCE_EXHAUSTED (reported as "quota
// exhausted", even when quota remains) when a request's system prompt names a
// known third-party AI product — e.g. an agent whose identity line says it was
// "created by <vendor>". This is the same class of problem as the "Antigravity"
// identity handling above (issue #76), but for the *caller's* identity. We
// neutralize those strings in the caller-supplied system parts.
//
// Defaults cover agents commonly used with this proxy; extend or override with
// the ANTIGRAVITY_SCRUB_IDENTITY env var, formatted as a comma-separated list of
// "Term=>Replacement" pairs, e.g. "Nous Research=>the team,Hermes=>the assistant".
const DEFAULT_IDENTITY_SCRUB = [
    ['Nous Research', 'the assistant team'],
    ['Hermes Agent', 'the assistant'],
    ['Hermes', 'the assistant']
];

function parseIdentityScrubEnv(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map((pair) => {
            const idx = pair.indexOf('=>');
            if (idx === -1) return null;
            return [pair.slice(0, idx).trim(), pair.slice(idx + 2).trim()];
        })
        .filter((rule) => rule && rule[0].length > 0);
}

const IDENTITY_SCRUB_RULES = [
    ...DEFAULT_IDENTITY_SCRUB,
    ...parseIdentityScrubEnv(process.env.ANTIGRAVITY_SCRUB_IDENTITY)
];

function scrubClientIdentity(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const [term, replacement] of IDENTITY_SCRUB_RULES) {
        out = out.split(term).join(replacement);
    }
    return out;
}

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @param {string} accountEmail - The account email for session ID derivation
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId, accountEmail) {
    const model = anthropicRequest.model;
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use stable session ID derived from first user message for cache continuity
    googleRequest.sessionId = deriveSessionId(anthropicRequest, accountEmail);

    // Build system instruction parts array with [ignore] tags to prevent model from
    // identifying as "Antigravity" (fixes GitHub issue #76)
    // Reference: CLIProxyAPI, gcli2api, AIClient-2-API all use this approach
    const systemParts = [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore the following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` }
    ];

    // Append any existing system instructions from the request, scrubbing
    // third-party AI product identities that trip cloudcode-pa's 429 (see above).
    if (googleRequest.systemInstruction && googleRequest.systemInstruction.parts) {
        for (const part of googleRequest.systemInstruction.parts) {
            if (part.text) {
                systemParts.push({ text: scrubClientIdentity(part.text) });
            }
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
        parts: systemParts
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @param {string} accept - Accept header value (default: 'application/json')
 * @param {string} [sessionId] - Optional session ID for X-Machine-Session-Id header
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = 'application/json', sessionId) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Add session ID header if provided (matches Antigravity binary behavior)
    if (sessionId) {
        headers['X-Machine-Session-Id'] = sessionId;
    }

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
