/**
 * Response Converter
 * Converts Google Generative AI responses to Anthropic Messages API format
 */

import crypto from 'crypto';
import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { cacheSignature, cacheThinkingSignature } from './signature-cache.js';

/**
 * Merge progressive Google Search groundingMetadata chunks from SSE streams
 * so earlier fields (e.g. webSearchQueries) are not wiped by later chunks.
 *
 * @param {Object|null} prev - Accumulated groundingMetadata
 * @param {Object|null} next - Incoming candidate groundingMetadata
 * @returns {Object|null} Merged groundingMetadata
 */
export function mergeGroundingMetadata(prev, next) {
    if (!next) return prev;
    const hasQueries = Array.isArray(next.webSearchQueries) && next.webSearchQueries.length > 0;
    const hasChunks = Array.isArray(next.groundingChunks) && next.groundingChunks.length > 0;
    if (!hasQueries && !hasChunks) return prev;

    const mergedQueries = [];
    const seenQueries = new Set();
    for (const q of [...(prev?.webSearchQueries || []), ...(next.webSearchQueries || [])]) {
        if (typeof q === 'string' && q && !seenQueries.has(q)) {
            seenQueries.add(q);
            mergedQueries.push(q);
        }
    }

    const mergedChunks = [];
    const seenUris = new Set();
    for (const chunk of [...(prev?.groundingChunks || []), ...(next.groundingChunks || [])]) {
        const uri = chunk?.web?.uri;
        if (!uri || seenUris.has(uri)) continue;
        seenUris.add(uri);
        mergedChunks.push(chunk);
    }

    return {
        ...prev,
        ...next,
        webSearchQueries: mergedQueries,
        groundingChunks: mergedChunks
    };
}

/**
 * Resolve Vertex AI grounding redirect URLs to their final destination URLs.
 * Only sends HEAD requests to vertexaisearch.cloud.google.com redirect paths;
 * falls back to the original URI on timeout or error.
 */
export async function resolveGroundingUrl(uri) {
    if (!uri) return uri;
    try {
        const parsed = new URL(uri);
        if (parsed.hostname !== 'vertexaisearch.cloud.google.com' ||
            !parsed.pathname.startsWith('/grounding-api-redirect/')) {
            return uri;
        }
    } catch {
        return uri;
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
            const res = await fetch(uri, {
                method: 'HEAD',
                redirect: 'manual',
                signal: controller.signal
            });
            const loc = res.headers.get('location');
            if (loc && (loc.startsWith('http://') || loc.startsWith('https://'))) {
                return loc;
            }
        } finally {
            clearTimeout(timer);
        }
    } catch {
        // Keep original URI if resolution fails or times out
    }
    return uri;
}

/**
 * Resolve all Vertex AI redirect URLs inside a groundingMetadata object in parallel.
 *
 * @param {Object|null} groundingMetadata
 * @returns {Promise<Object|null>}
 */
export async function resolveGroundingMetadataUrls(groundingMetadata) {
    if (!groundingMetadata || !Array.isArray(groundingMetadata.groundingChunks) || groundingMetadata.groundingChunks.length === 0) {
        return groundingMetadata;
    }
    const resolvedChunks = await Promise.all(
        groundingMetadata.groundingChunks.map(async (chunk) => {
            if (!chunk?.web?.uri) return chunk;
            const resolvedUri = await resolveGroundingUrl(chunk.web.uri);
            return resolvedUri === chunk.web.uri
                ? chunk
                : { ...chunk, web: { ...chunk.web, uri: resolvedUri } };
        })
    );
    return { ...groundingMetadata, groundingChunks: resolvedChunks };
}

/**
 * Build Anthropic server_tool_use + web_search_tool_result blocks from Google groundingMetadata.
 *
 * @param {Object|null} groundingMetadata
 * @returns {Array<Object>} Pair of [server_tool_use, web_search_tool_result] or []
 */
export function buildWebSearchBlocks(groundingMetadata) {
    if (!groundingMetadata ||
        !(groundingMetadata.groundingChunks?.length > 0 || groundingMetadata.webSearchQueries?.length > 0)) {
        return [];
    }

    const serverToolId = `srvtoolu_${crypto.randomBytes(12).toString('hex')}`;
    const query = (groundingMetadata.webSearchQueries || [])[0] || '';
    const seen = new Set();
    const searchResults = [];

    for (const chunk of (groundingMetadata.groundingChunks || [])) {
        const url = chunk?.web?.uri;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        searchResults.push({
            type: 'web_search_result',
            title: chunk.web.title || url,
            url,
            encrypted_content: '',
            page_age: null
        });
    }

    return [
        {
            type: 'server_tool_use',
            id: serverToolId,
            name: 'web_search',
            input: { query }
        },
        {
            type: 'web_search_tool_result',
            tool_use_id: serverToolId,
            content: searchResults
        }
    ];
}

/**
 * Convert Google Generative AI response to Anthropic Messages API format
 *
 * @param {Object} googleResponse - Google format response (the inner response object)
 * @param {string} model - The model name used
 * @returns {Object} Anthropic format response
 */
export function convertGoogleToAnthropic(googleResponse, model) {
    const response = googleResponse.response || googleResponse;

    const candidates = response.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];

    // Convert parts to Anthropic content blocks
    const anthropicContent = [];
    let hasToolCalls = false;

    for (const part of parts) {
        if (part.text !== undefined) {
            if (part.thought === true) {
                const signature = part.thoughtSignature || '';

                // Cache thinking signature with model family for cross-model compatibility
                if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                    const modelFamily = getModelFamily(model);
                    cacheThinkingSignature(signature, modelFamily);
                }

                // Include thinking blocks in the response for Claude Code
                anthropicContent.push({
                    type: 'thinking',
                    thinking: part.text,
                    signature: signature
                });
            } else {
                anthropicContent.push({
                    type: 'text',
                    text: part.text
                });
            }
        } else if (part.functionCall) {
            // Convert functionCall to tool_use
            // Use the id from the response if available, otherwise generate one
            const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: part.functionCall.name,
                input: part.functionCall.args || {}
            };

            // For Gemini 3+, include thoughtSignature from the part level
            if (part.thoughtSignature && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = part.thoughtSignature;
                // Cache for future requests (Claude Code may strip this field)
                cacheSignature(toolId, part.thoughtSignature);
            }

            anthropicContent.push(toolUseBlock);
            hasToolCalls = true;
        } else if (part.inlineData) {
            anthropicContent.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: part.inlineData.mimeType,
                    data: part.inlineData.data
                }
            });
        }
    }

    // Insert Anthropic server_tool_use + web_search_tool_result blocks for Google Search grounding
    // Place them after any leading thinking blocks and before synthesized text (canonical order)
    const webSearchBlocks = buildWebSearchBlocks(firstCandidate.groundingMetadata);
    if (webSearchBlocks.length > 0) {
        let insertIdx = 0;
        while (insertIdx < anthropicContent.length && anthropicContent[insertIdx].type === 'thinking') {
            insertIdx++;
        }
        anthropicContent.splice(insertIdx, 0, ...webSearchBlocks);
    }

    // Determine stop reason
    const finishReason = firstCandidate.finishReason;
    let stopReason = 'end_turn';
    if (finishReason === 'STOP') {
        stopReason = 'end_turn';
    } else if (finishReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'TOOL_USE' || hasToolCalls) {
        stopReason = 'tool_use';
    }

    // Extract usage metadata
    // Note: Antigravity's promptTokenCount is the TOTAL (includes cached),
    // but Anthropic's input_tokens excludes cached. We subtract to match.
    const usageMetadata = response.usageMetadata || {};
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const cachedTokens = usageMetadata.cachedContentTokenCount || 0;

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: promptTokens - cachedTokens,
            // Thinking tokens are generated (and billed) output — include them.
            output_tokens: (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0),
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0
        }
    };
}
