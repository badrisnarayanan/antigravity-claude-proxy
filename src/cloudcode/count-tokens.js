/**
 * Token Counter Implementation for antigravity-claude-proxy
 *
 * Implements Anthropic's /v1/messages/count_tokens endpoint
 * Uses official tokenizers for each model family:
 * - Claude: @anthropic-ai/tokenizer
 * - Gemini: @lenml/tokenizer-gemini
 *
 * @see https://platform.claude.com/docs/en/api/messages-count-tokens
 */

import { countTokens as claudeCountTokens } from '@anthropic-ai/tokenizer';
import { fromPreTrained as loadGeminiTokenizer } from '@lenml/tokenizer-gemini';
import { logger } from '../utils/logger.js';
import { getModelFamily } from '../constants.js';

// Lazy-loaded Gemini tokenizer (138MB, loaded once on first use)
let geminiTokenizer = null;
let geminiTokenizerLoading = null;

/**
 * Get or initialize the Gemini tokenizer
 * Uses singleton pattern with loading lock to prevent multiple loads
 *
 * @returns {Promise<Object>} Gemini tokenizer instance
 */
async function getGeminiTokenizer() {
    if (geminiTokenizer) {
        return geminiTokenizer;
    }

    // Prevent multiple simultaneous loads
    if (geminiTokenizerLoading) {
        return geminiTokenizerLoading;
    }

    geminiTokenizerLoading = (async () => {
        try {
            logger.debug('[TokenCounter] Loading Gemini tokenizer...');
            geminiTokenizer = await loadGeminiTokenizer();
            logger.debug('[TokenCounter] Gemini tokenizer loaded successfully');
            return geminiTokenizer;
        } catch (error) {
            logger.warn(`[TokenCounter] Failed to load Gemini tokenizer: ${error.message}`);
            throw error;
        } finally {
            geminiTokenizerLoading = null;
        }
    })();

    return geminiTokenizerLoading;
}

/**
 * Count tokens for text using Claude tokenizer
 *
 * @param {string} text - Text to tokenize
 * @returns {number} Token count
 */
function countClaudeTokens(text) {
    if (!text) return 0;
    try {
        return claudeCountTokens(text);
    } catch (error) {
        logger.debug(`[TokenCounter] Claude tokenizer error: ${error.message}`);
        return Math.ceil(text.length / 4);
    }
}

/**
 * Count tokens for text using Gemini tokenizer
 *
 * @param {Object} tokenizer - Gemini tokenizer instance
 * @param {string} text - Text to tokenize
 * @returns {number} Token count
 */
function countGeminiTokens(tokenizer, text) {
    if (!text) return 0;
    try {
        const tokens = tokenizer.encode(text);
        // Remove BOS token if present (token id 2)
        return tokens[0] === 2 ? tokens.length - 1 : tokens.length;
    } catch (error) {
        logger.debug(`[TokenCounter] Gemini tokenizer error: ${error.message}`);
        return Math.ceil(text.length / 4);
    }
}

/**
 * Estimate tokens for text content using appropriate tokenizer
 *
 * @param {string} text - Text to tokenize
 * @param {string} model - Model name to determine tokenizer
 * @param {Object} geminiTok - Gemini tokenizer instance (optional)
 * @returns {number} Token count
 */
function estimateTextTokens(text, model, geminiTok = null) {
    if (!text) return 0;

    const family = getModelFamily(model);

    if (family === 'claude') {
        return countClaudeTokens(text);
    } else if (family === 'gemini' && geminiTok) {
        return countGeminiTokens(geminiTok, text);
    }

    // Fallback for unknown models: rough estimate
    return Math.ceil(text.length / 4);
}

/**
 * Extract text from message content
 *
 * Note: This function only extracts text from 'text' type blocks.
 * Image blocks (type: 'image') and document blocks (type: 'document') are not tokenized
 * and will not contribute to the token count. This is intentional as binary content
 * requires different handling and Anthropic's actual token counting for images uses
 * a fixed estimate (~1600 tokens per image) that depends on image dimensions.
 *
 * @param {string|Array} content - Message content
 * @returns {string} Concatenated text
 */
function extractText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');
    }

    return '';
}

/**
 * Count tokens locally using model-specific tokenizer
 *
 * @param {Object} request - Anthropic format request
 * @param {Object} geminiTok - Gemini tokenizer instance (optional)
 * @returns {number} Token count
 */
function countTokensLocally(request, geminiTok = null) {
    const { messages = [], system, tools, model } = request;
    let totalTokens = 0;

    // Count system prompt tokens
    if (system) {
        if (typeof system === 'string') {
            totalTokens += estimateTextTokens(system, model, geminiTok);
        } else if (Array.isArray(system)) {
            for (const block of system) {
                if (block.type === 'text') {
                    totalTokens += estimateTextTokens(block.text, model, geminiTok);
                }
            }
        }
    }

    // Count message tokens
    for (const message of messages) {
        // Add overhead for role and structure (~4 tokens per message)
        totalTokens += 4;
        totalTokens += estimateTextTokens(extractText(message.content), model, geminiTok);

        // Handle tool_use and tool_result blocks
        if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === 'tool_use') {
                    totalTokens += estimateTextTokens(block.name, model, geminiTok);
                    totalTokens += estimateTextTokens(JSON.stringify(block.input), model, geminiTok);
                } else if (block.type === 'tool_result') {
                    if (typeof block.content === 'string') {
                        totalTokens += estimateTextTokens(block.content, model, geminiTok);
                    } else if (Array.isArray(block.content)) {
                        totalTokens += estimateTextTokens(extractText(block.content), model, geminiTok);
                    }
                } else if (block.type === 'thinking') {
                    totalTokens += estimateTextTokens(block.thinking, model, geminiTok);
                }
            }
        }
    }

    // Count tool definitions
    if (tools && tools.length > 0) {
        for (const tool of tools) {
            totalTokens += estimateTextTokens(tool.name, model, geminiTok);
            totalTokens += estimateTextTokens(tool.description || '', model, geminiTok);
            totalTokens += estimateTextTokens(JSON.stringify(tool.input_schema || {}), model, geminiTok);
        }
    }

    return totalTokens;
}

/**
 * Count tokens in a message request
 * Implements Anthropic's /v1/messages/count_tokens endpoint
 * Uses local tokenization for all content types
 *
 * @param {Object} anthropicRequest - Anthropic format request with messages, model, system, tools
 * @param {Object} accountManager - Account manager instance (unused, kept for API compatibility)
 * @param {Object} options - Options (unused, kept for API compatibility)
 * @returns {Promise<Object>} Response with input_tokens count
 */
export async function countTokens(anthropicRequest, accountManager = null, options = {}) {
    try {
        const family = getModelFamily(anthropicRequest.model);
        let geminiTok = null;

        // Load Gemini tokenizer if needed
        if (family === 'gemini') {
            try {
                geminiTok = await getGeminiTokenizer();
            } catch (error) {
                logger.warn(`[TokenCounter] Gemini tokenizer unavailable, using fallback`);
            }
        }

        const inputTokens = countTokensLocally(anthropicRequest, geminiTok);
        logger.debug(`[TokenCounter] Local count (${family}): ${inputTokens} tokens`);

        return {
            input_tokens: inputTokens
        };

    } catch (error) {
        logger.warn(`[TokenCounter] Error: ${error.message}, using character-based fallback`);

        // Ultimate fallback: character-based estimation
        const { messages = [], system } = anthropicRequest;
        let charCount = 0;

        if (system) {
            charCount += typeof system === 'string' ? system.length : JSON.stringify(system).length;
        }

        for (const message of messages) {
            charCount += JSON.stringify(message.content).length;
        }

        return {
            input_tokens: Math.ceil(charCount / 4)
        };
    }
}

/**
 * Express route handler for /v1/messages/count_tokens
 *
 * @param {Object} accountManager - Account manager instance
 * @returns {Function} Express middleware
 */
export function createCountTokensHandler(accountManager) {
    return async (req, res) => {
        try {
            const { messages, model, system, tools, tool_choice, thinking } = req.body;

            // Validate required fields
            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required and must be an array'
                    }
                });
            }

            if (!model) {
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'model is required'
                    }
                });
            }

            const result = await countTokens(
                { messages, model, system, tools, tool_choice, thinking },
                accountManager
            );

            res.json(result);

        } catch (error) {
            logger.error(`[TokenCounter] Handler error: ${error.message}`);
            res.status(500).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: error.message
                }
            });
        }
    };
}
