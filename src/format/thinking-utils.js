/**
 * Thinking Block Utilities
 * Handles thinking block processing, validation, and filtering
 */

import { MIN_SIGNATURE_LENGTH } from '../constants.js';
import { getCachedSignatureFamily } from './signature-cache.js';
import { logger } from '../utils/logger.js';

/**
 * Check if a part is a thinking block
 * @param {Object} part - Content part to check
 * @returns {boolean} True if the part is a thinking block
 */
function isThinkingPart(part) {
    return part.type === 'thinking' ||
        part.type === 'redacted_thinking' ||
        part.thinking !== undefined ||
        part.thought === true;
}

/**
 * Check if a thinking part has a valid signature (>= MIN_SIGNATURE_LENGTH chars)
 */
function hasValidSignature(part) {
    const signature = part.thought === true ? part.thoughtSignature : part.signature;
    return typeof signature === 'string' && signature.length >= MIN_SIGNATURE_LENGTH;
}

/**
 * Check if conversation history contains Gemini-style messages.
 * Gemini puts thoughtSignature on tool_use blocks, Claude puts signature on thinking blocks.
 * @param {Array<Object>} messages - Array of messages
 * @returns {boolean} True if any tool_use has thoughtSignature (Gemini pattern)
 */
export function hasGeminiHistory(messages) {
    return messages.some(msg =>
        Array.isArray(msg.content) &&
        msg.content.some(block =>
            block.type === 'tool_use' && block.thoughtSignature !== undefined
        )
    );
}

/**
 * Check if conversation has unsigned thinking blocks that will be dropped.
 * These cause "Expected thinking but found text" errors.
 * @param {Array<Object>} messages - Array of messages
 * @returns {boolean} True if any assistant message has unsigned thinking blocks
 */
export function hasUnsignedThinkingBlocks(messages) {
    return messages.some(msg => {
        if (msg.role !== 'assistant' && msg.role !== 'model') return false;
        if (!Array.isArray(msg.content)) return false;
        return msg.content.some(block =>
            isThinkingPart(block) && !hasValidSignature(block)
        );
    });
}

/**
 * Sanitize a thinking part by keeping only allowed fields
 */
function sanitizeThinkingPart(part) {
    // Gemini-style thought blocks: { thought: true, text, thoughtSignature }
    if (part.thought === true) {
        const sanitized = { thought: true };
        if (part.text !== undefined) sanitized.text = part.text;
        if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
        return sanitized;
    }

    // Anthropic-style thinking blocks: { type: "thinking", thinking, signature }
    if (part.type === 'thinking' || part.thinking !== undefined) {
        const sanitized = { type: 'thinking' };
        if (part.thinking !== undefined) sanitized.thinking = part.thinking;
        if (part.signature !== undefined) sanitized.signature = part.signature;
        return sanitized;
    }

    return part;
}

/**
 * Sanitize a thinking block by removing extra fields like cache_control.
 * Only keeps: type, thinking, signature (for thinking) or type, data (for redacted_thinking)
 */
function sanitizeAnthropicThinkingBlock(block) {
    if (!block) return block;

    if (block.type === 'thinking') {
        const sanitized = { type: 'thinking' };
        if (block.thinking !== undefined) sanitized.thinking = block.thinking;
        if (block.signature !== undefined) sanitized.signature = block.signature;
        return sanitized;
    }

    if (block.type === 'redacted_thinking') {
        const sanitized = { type: 'redacted_thinking' };
        if (block.data !== undefined) sanitized.data = block.data;
        return sanitized;
    }

    return block;
}

/**
 * Filter content array, keeping only thinking blocks with valid signatures.
 */
function filterContentArray(contentArray) {
    const filtered = [];

    for (const item of contentArray) {
        if (!item || typeof item !== 'object') {
            filtered.push(item);
            continue;
        }

        if (!isThinkingPart(item)) {
            filtered.push(item);
            continue;
        }

        // Keep items with valid signatures
        if (hasValidSignature(item)) {
            filtered.push(sanitizeThinkingPart(item));
            continue;
        }

        // Drop unsigned thinking blocks
        logger.debug('[ThinkingUtils] Dropping unsigned thinking block');
    }

    return filtered;
}

/**
 * Filter unsigned thinking blocks from contents (Gemini format)
 *
 * @param {Array<{role: string, parts: Array}>} contents - Array of content objects in Gemini format
 * @returns {Array<{role: string, parts: Array}>} Filtered contents with unsigned thinking blocks removed
 */
export function filterUnsignedThinkingBlocks(contents) {
    return contents.map(content => {
        if (!content || typeof content !== 'object') return content;

        if (Array.isArray(content.parts)) {
            return { ...content, parts: filterContentArray(content.parts) };
        }

        return content;
    });
}

/**
 * Remove trailing unsigned thinking blocks from assistant messages.
 * Claude/Gemini APIs require that assistant messages don't end with unsigned thinking blocks.
 *
 * @param {Array<Object>} content - Array of content blocks
 * @returns {Array<Object>} Content array with trailing unsigned thinking blocks removed
 */
export function removeTrailingThinkingBlocks(content) {
    if (!Array.isArray(content)) return content;
    if (content.length === 0) return content;

    // Work backwards from the end, removing thinking blocks
    let endIndex = content.length;
    for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (!block || typeof block !== 'object') break;

        // Check if it's a thinking block (any format)
        const isThinking = isThinkingPart(block);

        if (isThinking) {
            // Check if it has a valid signature
            if (!hasValidSignature(block)) {
                endIndex = i;
            } else {
                break; // Stop at signed thinking block
            }
        } else {
            break; // Stop at first non-thinking block
        }
    }

    if (endIndex < content.length) {
        logger.debug('[ThinkingUtils] Removed', content.length - endIndex, 'trailing unsigned thinking blocks');
        return content.slice(0, endIndex);
    }

    return content;
}

/**
 * Filter thinking blocks: keep only those with valid signatures.
 * Blocks without signatures are dropped (API requires signatures).
 * Also sanitizes blocks to remove extra fields like cache_control.
 *
 * @param {Array<Object>} content - Array of content blocks
 * @returns {Array<Object>} Filtered content with only valid signed thinking blocks
 */
export function restoreThinkingSignatures(content) {
    if (!Array.isArray(content)) return content;

    const originalLength = content.length;
    const filtered = [];

    for (const block of content) {
        if (!block || block.type !== 'thinking') {
            filtered.push(block);
            continue;
        }

        // Keep blocks with valid signatures (>= MIN_SIGNATURE_LENGTH chars), sanitized
        if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
            filtered.push(sanitizeAnthropicThinkingBlock(block));
        }
        // Unsigned thinking blocks are dropped
    }

    if (filtered.length < originalLength) {
        logger.debug(`[ThinkingUtils] Dropped ${originalLength - filtered.length} unsigned thinking block(s)`);
    }

    return filtered;
}

/**
 * Reorder content so that:
 * 1. Thinking blocks come first (required when thinking is enabled)
 * 2. Text blocks come in the middle (filtering out empty/useless ones)
 * 3. Tool_use blocks come at the end (required before tool_result)
 *
 * @param {Array<Object>} content - Array of content blocks
 * @returns {Array<Object>} Reordered content array
 */
export function reorderAssistantContent(content) {
    if (!Array.isArray(content)) return content;

    // Even for single-element arrays, we need to sanitize thinking blocks
    if (content.length === 1) {
        const block = content[0];
        if (block && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
            return [sanitizeAnthropicThinkingBlock(block)];
        }
        return content;
    }

    const thinkingBlocks = [];
    const textBlocks = [];
    const toolUseBlocks = [];
    let droppedEmptyBlocks = 0;

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // Sanitize thinking blocks to remove cache_control and other extra fields
            thinkingBlocks.push(sanitizeAnthropicThinkingBlock(block));
        } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block);
        } else if (block.type === 'text') {
            // Only keep text blocks with meaningful content
            if (block.text && block.text.trim().length > 0) {
                textBlocks.push(block);
            } else {
                droppedEmptyBlocks++;
            }
        } else {
            // Other block types go in the text position
            textBlocks.push(block);
        }
    }

    if (droppedEmptyBlocks > 0) {
        logger.debug(`[ThinkingUtils] Dropped ${droppedEmptyBlocks} empty text block(s)`);
    }

    const reordered = [...thinkingBlocks, ...textBlocks, ...toolUseBlocks];

    // Log only if actual reordering happened (not just filtering)
    if (reordered.length === content.length) {
        const originalOrder = content.map(b => b?.type || 'unknown').join(',');
        const newOrder = reordered.map(b => b?.type || 'unknown').join(',');
        if (originalOrder !== newOrder) {
            logger.debug('[ThinkingUtils] Reordered assistant content');
        }
    }

    return reordered;
}

// ============================================================================
// Thinking Recovery Functions
// ============================================================================

/**
 * Check if a message has any VALID (signed) thinking blocks.
 * Only counts thinking blocks that have valid signatures, not unsigned ones
 * that will be dropped later.
 *
 * @param {Object} message - Message to check
 * @returns {boolean} True if message has valid signed thinking blocks
 */
function messageHasValidThinking(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block => {
        if (!isThinkingPart(block)) return false;
        // Check for valid signature (Anthropic style)
        if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) return true;
        // Check for thoughtSignature (Gemini style on functionCall)
        if (block.thoughtSignature && block.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) return true;
        return false;
    });
}

/**
 * Check if a message has tool_use blocks
 * @param {Object} message - Message to check
 * @returns {boolean} True if message has tool_use blocks
 */
function messageHasToolUse(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block =>
        block.type === 'tool_use' || block.functionCall
    );
}

/**
 * Check if a message has tool_result blocks
 * @param {Object} message - Message to check
 * @returns {boolean} True if message has tool_result blocks
 */
function messageHasToolResult(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block =>
        block.type === 'tool_result' || block.functionResponse
    );
}

/**
 * Check if message is a plain user text message (not tool_result)
 * @param {Object} message - Message to check
 * @returns {boolean} True if message is plain user text
 */
function isPlainUserMessage(message) {
    if (message.role !== 'user') return false;
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return typeof content === 'string';
    // Check if it has tool_result blocks
    return !content.some(block =>
        block.type === 'tool_result' || block.functionResponse
    );
}

/**
 * Analyze conversation state to detect if we're in a corrupted state.
 * This includes:
 * 1. Tool loop: assistant has tool_use followed by tool_results (normal flow)
 * 2. Interrupted tool: assistant has tool_use followed by plain user message (interrupted)
 *
 * @param {Array<Object>} messages - Array of messages
 * @returns {Object} State object with inToolLoop, interruptedTool, turnHasThinking, etc.
 */
function analyzeConversationState(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { inToolLoop: false, interruptedTool: false, turnHasThinking: false, toolResultCount: 0 };
    }

    // Find the last assistant message
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' || messages[i].role === 'model') {
            lastAssistantIdx = i;
            break;
        }
    }

    if (lastAssistantIdx === -1) {
        return { inToolLoop: false, interruptedTool: false, turnHasThinking: false, toolResultCount: 0 };
    }

    const lastAssistant = messages[lastAssistantIdx];
    const hasToolUse = messageHasToolUse(lastAssistant);
    const hasThinking = messageHasValidThinking(lastAssistant);

    // Count trailing tool results after the assistant message
    let toolResultCount = 0;
    let hasPlainUserMessageAfter = false;
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
        if (messageHasToolResult(messages[i])) {
            toolResultCount++;
        }
        if (isPlainUserMessage(messages[i])) {
            hasPlainUserMessageAfter = true;
        }
    }

    // We're in a tool loop if: assistant has tool_use AND there are tool_results after
    const inToolLoop = hasToolUse && toolResultCount > 0;

    // We have an interrupted tool if: assistant has tool_use, NO tool_results,
    // but there IS a plain user message after (user interrupted and sent new message)
    const interruptedTool = hasToolUse && toolResultCount === 0 && hasPlainUserMessageAfter;

    return {
        inToolLoop,
        interruptedTool,
        turnHasThinking: hasThinking,
        toolResultCount,
        lastAssistantIdx
    };
}

/**
 * Check if conversation needs thinking recovery.
 *
 * Recovery is only needed when:
 * 1. We're in a tool loop or have an interrupted tool, AND
 * 2. No valid thinking blocks exist in the current turn
 *
 * Cross-model signature compatibility is handled by stripInvalidThinkingBlocks
 * during recovery (not here).
 *
 * @param {Array<Object>} messages - Array of messages
 * @returns {boolean} True if thinking recovery is needed
 */
export function needsThinkingRecovery(messages) {
    const state = analyzeConversationState(messages);

    // Recovery is only needed in tool loops or interrupted tools
    if (!state.inToolLoop && !state.interruptedTool) return false;

    // Need recovery if no valid thinking blocks exist
    return !state.turnHasThinking;
}

/**
 * Strip invalid or incompatible thinking blocks from messages.
 * Used before injecting synthetic messages for recovery.
 * Keeps valid thinking blocks to preserve context from previous turns.
 *
 * @param {Array<Object>} messages - Array of messages
 * @param {string} targetFamily - Target model family ('claude' or 'gemini')
 * @returns {Array<Object>} Messages with invalid thinking blocks removed
 */
function stripInvalidThinkingBlocks(messages, targetFamily = null) {
    let strippedCount = 0;

    const result = messages.map(msg => {
        const content = msg.content || msg.parts;
        if (!Array.isArray(content)) return msg;

        const filtered = content.filter(block => {
            // Keep non-thinking blocks
            if (!isThinkingPart(block)) return true;

            // Check generic validity (has signature of sufficient length)
            if (!hasValidSignature(block)) {
                strippedCount++;
                return false;
            }

            // Check family compatibility only for Gemini targets
            // Claude can validate its own signatures, so we don't drop for Claude
            if (targetFamily === 'gemini') {
                const signature = block.thought === true ? block.thoughtSignature : block.signature;
                const signatureFamily = getCachedSignatureFamily(signature);

                // For Gemini: drop unknown or mismatched signatures
                if (!signatureFamily || signatureFamily !== targetFamily) {
                    strippedCount++;
                    return false;
                }
            }

            return true;
        });

        // Use '.' instead of '' because claude models reject empty text parts
        if (msg.content) {
            return { ...msg, content: filtered.length > 0 ? filtered : [{ type: 'text', text: '.' }] };
        } else if (msg.parts) {
            return { ...msg, parts: filtered.length > 0 ? filtered : [{ text: '.' }] };
        }
        return msg;
    });

    if (strippedCount > 0) {
        logger.debug(`[ThinkingUtils] Stripped ${strippedCount} invalid/incompatible thinking block(s)`);
    }

    return result;
}

/**
 * Close tool loop by injecting synthetic messages.
 * This allows the model to start a fresh turn when thinking is corrupted.
 *
 * When thinking blocks are stripped (no valid signatures) and we're in the
 * middle of a tool loop OR have an interrupted tool, the conversation is in
 * a corrupted state. This function injects synthetic messages to close the
 * loop and allow the model to continue.
 *
 * @param {Array<Object>} messages - Array of messages
 * @param {string} targetFamily - Target model family ('claude' or 'gemini')
 * @returns {Array<Object>} Modified messages with synthetic messages injected
 */
export function closeToolLoopForThinking(messages, targetFamily = null) {
    const state = analyzeConversationState(messages);

    // Handle neither tool loop nor interrupted tool
    if (!state.inToolLoop && !state.interruptedTool) return messages;

    // Strip only invalid/incompatible thinking blocks (keep valid ones)
    let modified = stripInvalidThinkingBlocks(messages, targetFamily);

    if (state.interruptedTool) {
        // For interrupted tools: just strip thinking and add a synthetic assistant message
        // to acknowledge the interruption before the user's new message

        // Find where to insert the synthetic message (before the plain user message)
        const insertIdx = state.lastAssistantIdx + 1;

        // Insert synthetic assistant message acknowledging interruption
        modified.splice(insertIdx, 0, {
            role: 'assistant',
            content: [{ type: 'text', text: '[Tool call was interrupted.]' }]
        });

        logger.debug('[ThinkingUtils] Applied thinking recovery for interrupted tool');
    } else if (state.inToolLoop) {
        // For tool loops: add synthetic messages to close the loop
        const syntheticText = state.toolResultCount === 1
            ? '[Tool execution completed.]'
            : `[${state.toolResultCount} tool executions completed.]`;

        // Inject synthetic model message to complete the turn
        modified.push({
            role: 'assistant',
            content: [{ type: 'text', text: syntheticText }]
        });

        // Inject synthetic user message to start fresh
        modified.push({
            role: 'user',
            content: [{ type: 'text', text: '[Continue]' }]
        });

        logger.debug('[ThinkingUtils] Applied thinking recovery for tool loop');
    }

    return modified;
}
