/**
 * Shared Response Utilities
 * Provides consistent stop reason mapping and token calculation across handlers
 */

/**
 * Map Google's finishReason to Anthropic's stop_reason
 * @param {string} finishReason - Google's finish reason (e.g., 'STOP', 'MAX_TOKENS', 'TOOL_USE')
 * @param {boolean} hasToolCalls - Whether the response contains tool calls
 * @returns {string} Anthropic's stop_reason (e.g., 'end_turn', 'max_tokens', 'tool_use')
 */
export function mapStopReason(finishReason, hasToolCalls = false) {
    // Tool calls take priority
    if (hasToolCalls) {
        return 'tool_use';
    }

    // Map known finish reasons
    const mapping = {
        'STOP': 'end_turn',
        'MAX_TOKENS': 'max_tokens',
        'SAFETY': 'content_filter',
        'TOOL_USE': 'tool_use',
        'RECITATION': 'content_filter',
        'OTHER': 'end_turn',
        'FINISH_REASON_UNSPECIFIED': 'end_turn'
    };

    return mapping[finishReason] || 'end_turn';
}

/**
 * Calculate token usage from Google's usageMetadata
 * Provides consistent calculation for both streaming and non-streaming responses
 *
 * @param {Object} usageMetadata - Google's usage metadata object
 * @param {number} [usageMetadata.promptTokenCount] - Total prompt tokens
 * @param {number} [usageMetadata.candidatesTokenCount] - Output tokens
 * @param {number} [usageMetadata.cachedContentTokenCount] - Cached tokens (prompt cache hits)
 * @returns {{input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number}}
 */
export function calculateTokenUsage(usageMetadata) {
    const {
        promptTokenCount = 0,
        candidatesTokenCount = 0,
        cachedContentTokenCount = 0
    } = usageMetadata || {};

    // input_tokens should exclude cached tokens (they weren't "processed" as new input)
    const inputTokens = Math.max(0, promptTokenCount - cachedContentTokenCount);

    return {
        input_tokens: inputTokens,
        output_tokens: candidatesTokenCount,
        cache_creation_input_tokens: 0, // Google doesn't report this separately
        cache_read_input_tokens: cachedContentTokenCount
    };
}

/**
 * Create an empty usage object
 * @returns {{input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number}}
 */
export function emptyTokenUsage() {
    return {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    };
}
