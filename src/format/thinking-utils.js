/**
 * Thinking Block Utilities
 * Handles thinking block processing, validation, and filtering
 */

import { MIN_SIGNATURE_LENGTH } from '../constants.js';

/**
 * Check if a part is a thinking block
 * @param {Object} part - Content part to check
 * @returns {boolean} True if the part is a thinking block
 */
export function isThinkingPart(part) {
    return part.type === 'thinking' ||
        part.type === 'redacted_thinking' ||
        part.thinking !== undefined ||
        part.thought === true;
}

/**
 * Check if a thinking part has a valid signature (>= MIN_SIGNATURE_LENGTH chars)
 */
export function hasValidSignature(part) {
    const signature = part.thought === true ? part.thoughtSignature : part.signature;
    return typeof signature === 'string' && signature.length >= MIN_SIGNATURE_LENGTH;
}

/**
 * Sanitize a thinking part by keeping only allowed fields
 */
export function sanitizeThinkingPart(part) {
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
export function sanitizeAnthropicThinkingBlock(block) {
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
        console.log('[ThinkingUtils] Dropping unsigned thinking block');
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
        console.log('[ThinkingUtils] Removed', content.length - endIndex, 'trailing unsigned thinking blocks');
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
        console.log(`[ThinkingUtils] Dropped ${originalLength - filtered.length} unsigned thinking block(s)`);
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
    let droppedInvalidThinkingBlocks = 0;

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'thinking') {
            if (hasValidSignature(block)) {
                // Sanitize thinking blocks to remove cache_control and other extra fields
                thinkingBlocks.push(sanitizeAnthropicThinkingBlock(block));
            } else {
                droppedInvalidThinkingBlocks++;
            }
        } else if (block.type === 'redacted_thinking') {
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
        console.log(`[ThinkingUtils] Dropped ${droppedEmptyBlocks} empty text block(s)`);
    }
    if (droppedInvalidThinkingBlocks > 0) {
        console.log(`[ThinkingUtils] Dropped ${droppedInvalidThinkingBlocks} invalid thinking block(s)`);
    }

    const reordered = [...thinkingBlocks, ...textBlocks, ...toolUseBlocks];

    // Log only if actual reordering happened (not just filtering)
    if (reordered.length === content.length) {
        const originalOrder = content.map(b => b?.type || 'unknown').join(',');
        const newOrder = reordered.map(b => b?.type || 'unknown').join(',');
        if (originalOrder !== newOrder) {
            console.log('[ThinkingUtils] Reordered assistant content');
        }
    }

    return reordered;
}
