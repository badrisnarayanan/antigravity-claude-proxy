/**
 * Content Converter
 * Converts Anthropic message content to Google Generative AI parts format
 */

import { MIN_SIGNATURE_LENGTH, GEMINI_SKIP_SIGNATURE } from '../constants.js';
import { getCachedSignature, getCachedSignatureFamily } from './signature-cache.js';
import { logger } from '../utils/logger.js';

/**
 * Convert Anthropic role to Google role
 * @param {string} role - Anthropic role ('user', 'assistant')
 * @returns {string} Google role ('user', 'model')
 */
export function convertRole(role) {
    if (role === 'assistant') return 'model';
    if (role === 'user') return 'user';
    return 'user'; // Default to user
}

/**
 * Convert Anthropic message content to Google Generative AI parts
 * @param {string|Array} content - Anthropic message content
 * @param {boolean} isClaudeModel - Whether the model is a Claude model
 * @param {boolean} isGeminiModel - Whether the model is a Gemini model
 * @returns {Array} Google Generative AI parts array
 */
export function convertContentToParts(content, isClaudeModel = false, isGeminiModel = false) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ text: String(content) }];
    }

    const parts = [];
    const deferredInlineData = []; // Collect inlineData to add at the end (Issue #91)

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'text') {
            // Skip empty text blocks - they cause API errors
            if (block.text && block.text.trim()) {
                parts.push({ text: block.text });
            }
        } else if (block.type === 'image') {
            // Handle image content
            if (block.source?.type === 'base64') {
                // Base64-encoded image
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                // URL-referenced image
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'image/jpeg',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'document') {
            // Handle document content (e.g. PDF)
            if (block.source?.type === 'base64') {
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'application/pdf',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'tool_use') {
            // Convert tool_use to functionCall (Google format)
            // For Claude models, include the id field
            const functionCall = {
                name: block.name,
                args: block.input || {}
            };

            if (isClaudeModel && block.id) {
                functionCall.id = block.id;
            }

            // Build the part with functionCall
            const part = { functionCall };

            // For Gemini models, include thoughtSignature at the part level
            // This is required by Gemini 3+ for tool calls to work correctly
            if (isGeminiModel) {
                // Priority: block.thoughtSignature > cache > GEMINI_SKIP_SIGNATURE
                let signature = block.thoughtSignature;

                if (!signature && block.id) {
                    signature = getCachedSignature(block.id);
                    if (signature) {
                        logger.debug(`[ContentConverter] Restored signature from cache for: ${block.id}`);
                    }
                }

                part.thoughtSignature = signature || GEMINI_SKIP_SIGNATURE;
            }

            parts.push(part);
        } else if (block.type === 'tool_result') {
            // Convert tool_result to functionResponse (Google format)
            let responseContent = block.content;
            let imageParts = [];

            if (typeof responseContent === 'string') {
                responseContent = { result: responseContent };
            } else if (Array.isArray(responseContent)) {
                // Extract images from tool results first (e.g., from Read tool reading image files)
                for (const item of responseContent) {
                    if (item.type === 'image' && item.source?.type === 'base64') {
                        imageParts.push({
                            inlineData: {
                                mimeType: item.source.media_type,
                                data: item.source.data
                            }
                        });
                    }
                }

                // Extract text content
                const texts = responseContent
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                responseContent = { result: texts || (imageParts.length > 0 ? 'Image attached' : '') };
            }

            const functionResponse = {
                name: block.tool_use_id || 'unknown',
                response: responseContent
            };

            // For Claude models, the id field must match the tool_use_id
            if (isClaudeModel && block.tool_use_id) {
                functionResponse.id = block.tool_use_id;
            }

            parts.push({ functionResponse });

            // Defer images from the tool result to end of parts array (Issue #91)
            // This ensures all functionResponse parts are consecutive
            deferredInlineData.push(...imageParts);
        } else if (block.type === 'thinking') {
            // Handle thinking blocks with signature compatibility check
            if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                const signatureFamily = getCachedSignatureFamily(block.signature);
                const targetFamily = isClaudeModel ? 'claude' : isGeminiModel ? 'gemini' : null;

                // Drop blocks with incompatible signatures for Gemini (cross-model switch)
                if (isGeminiModel && signatureFamily && targetFamily && signatureFamily !== targetFamily) {
                    logger.debug(`[ContentConverter] Dropping incompatible ${signatureFamily} thinking for ${targetFamily} model`);
                    continue;
                }

                // Drop blocks with unknown signature origin for Gemini (cold cache - safe default)
                if (isGeminiModel && !signatureFamily && targetFamily) {
                    logger.debug(`[ContentConverter] Dropping thinking with unknown signature origin`);
                    continue;
                }

                // Compatible - convert to Gemini format with signature
                parts.push({
                    text: block.thinking,
                    thought: true,
                    thoughtSignature: block.signature
                });
            }
            // Unsigned thinking blocks are dropped (existing behavior)
        }
    }

    // Add deferred inlineData at the end (Issue #91)
    // This ensures functionResponse parts are consecutive, which Claude's API requires
    parts.push(...deferredInlineData);

    return parts;
}
