/**
 * SSE Streamer for Cloud Code
 *
 * Streams SSE events in real-time, converting Google format to Anthropic format.
 * Handles thinking blocks, text blocks, and tool use blocks.
 */

import crypto from 'crypto';
import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { EmptyResponseError } from '../errors.js';
import { cacheSignature, cacheThinkingSignature } from '../format/signature-cache.js';
import { logger } from '../utils/logger.js';

/**
 * Stream SSE response and yield Anthropic-format events
 *
 * @param {Response} response - The HTTP response with SSE body
 * @param {string} originalModel - The original model name
 * @yields {Object} Anthropic-format SSE events
 */
export async function* streamSSEResponse(response, originalModel) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let stopReason = 'end_turn';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;

            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                // Extract usage metadata (including cache tokens)
                const usage = innerResponse.usageMetadata;
                if (usage) {
                    inputTokens = usage.promptTokenCount || inputTokens;
                    outputTokens = usage.candidatesTokenCount || outputTokens;
                    cacheReadTokens = usage.cachedContentTokenCount || cacheReadTokens;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const content = firstCandidate.content || {};
                const parts = content.parts || [];

                // Emit message_start on first data
                // Note: input_tokens = promptTokenCount - cachedContentTokenCount (Antigravity includes cached in total)
                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;
                    yield {
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: originalModel,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: {
                                input_tokens: inputTokens - cacheReadTokens,
                                output_tokens: 0,
                                cache_read_input_tokens: cacheReadTokens,
                                cache_creation_input_tokens: 0
                            }
                        }
                    };
                }

                // Process each part
                for (const part of parts) {
                    if (part.thought === true) {
                        // Handle thinking block
                        const text = part.text || '';
                        const signature = part.thoughtSignature || '';

                        if (currentBlockType !== 'thinking') {
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'thinking';
                            currentThinkingSignature = '';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'thinking', thinking: '' }
                            };
                        }

                        if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                            currentThinkingSignature = signature;
                            // Cache thinking signature with model family for cross-model compatibility
                            const modelFamily = getModelFamily(originalModel);
                            cacheThinkingSignature(signature, modelFamily);
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'thinking_delta', thinking: text }
                        };

                    } else if (part.text !== undefined) {
                        // Skip empty text parts
                        if (!part.text || part.text.trim().length === 0) {
                            continue;
                        }

                        // Handle regular text
                        if (currentBlockType !== 'text') {
                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                yield {
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                };
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'text';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'text', text: '' }
                            };
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text: part.text }
                        };

                    } else if (part.functionCall) {
                        // Handle tool use
                        // For Gemini 3+, capture thoughtSignature from the functionCall part
                        // The signature is a sibling to functionCall, not inside it
                        const functionCallSignature = part.thoughtSignature || '';

                        if (currentBlockType === 'thinking' && currentThinkingSignature) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'signature_delta', signature: currentThinkingSignature }
                            };
                            currentThinkingSignature = '';
                        }
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'tool_use';
                        stopReason = 'tool_use';

                        const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;

                        // For Gemini, include the thoughtSignature in the tool_use block
                        // so it can be sent back in subsequent requests
                        const toolUseBlock = {
                            type: 'tool_use',
                            id: toolId,
                            name: part.functionCall.name,
                            input: {}
                        };

                        // Store the signature in the tool_use block for later retrieval
                        if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
                            toolUseBlock.thoughtSignature = functionCallSignature;
                            // Cache for future requests (Claude Code may strip this field)
                            cacheSignature(toolId, functionCallSignature);
                        }

                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: toolUseBlock
                        };

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: JSON.stringify(part.functionCall.args || {})
                            }
                        };
                    }
                }

                // Check finish reason
                if (firstCandidate.finishReason && !stopReason) {
                    if (firstCandidate.finishReason === 'MAX_TOKENS') {
                        stopReason = 'max_tokens';
                    } else if (firstCandidate.finishReason === 'STOP') {
                        stopReason = 'end_turn';
                    }
                }

            } catch (parseError) {
                logger.warn('[CloudCode] SSE parse error:', parseError.message);
            }
        }
    }

    // Handle no content received - throw error to trigger retry in streaming-handler
    if (!hasEmittedStart) {
        logger.warn('[CloudCode] No content parts received, throwing for retry');
        throw new EmptyResponseError('No content parts received from API');
    } else {
        // Close any open block
        if (currentBlockType !== null) {
            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                };
            }
            yield { type: 'content_block_stop', index: blockIndex };
        }
    }

    // Emit message_delta and message_stop
    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 0
        }
    };

    yield { type: 'message_stop' };
}
