/**
 * Request Converter
 * Converts Anthropic Messages API requests to Google Generative AI format
 */
import {
    GEMINI_MAX_OUTPUT_TOKENS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertContentToParts, convertRole } from './content-converter.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking
} from './thinking-utils.js';
import { normalizeParameters } from './schema-normalizer.js';  // ← NEW IMPORT
import { logger } from '../utils/logger.js';

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 *
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 *
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertAnthropicToGoogle(anthropicRequest) {
    const { messages, system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking } = anthropicRequest;
    const modelName = anthropicRequest.model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isThinking = isThinkingModel(modelName);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            systemParts = [{ text: system }];
        } else if (Array.isArray(system)) {
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: block.text }));
        }
        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    // Add interleaved thinking hint for Claude thinking models with tools
    if (isClaudeModel && isThinking && tools && tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Apply thinking recovery for Gemini thinking models when needed
    let processedMessages = messages;
    if (isGeminiModel && isThinking && needsThinkingRecovery(messages)) {
        logger.debug('[RequestConverter] Applying thinking recovery for Gemini');
        processedMessages = closeToolLoopForThinking(messages);
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            msgContent = restoreThinkingSignatures(msgContent);
            msgContent = removeTrailingThinkingBlocks(msgContent);
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);

        // SAFETY: Google API requires at least one part per content message
        if (parts.length === 0) {
            logger.warn('[RequestConverter] WARNING: Empty parts array after filtering, adding placeholder');
            parts.push({ text: '' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for Claude models
    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    // Generation config
    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    // Enable thinking for thinking models (Claude and Gemini 3+)
    if (isThinking) {
        if (isClaudeModel) {
            const thinkingConfig = {
                include_thoughts: true
            };
            const thinkingBudget = thinking?.budget_tokens;
            if (thinkingBudget) {
                thinkingConfig.thinking_budget = thinkingBudget;
                logger.debug(`[RequestConverter] Claude thinking enabled with budget: ${thinkingBudget}`);
            } else {
                logger.debug('[RequestConverter] Claude thinking enabled (no budget specified)');
            }
            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinking?.budget_tokens || 16000
            };
            logger.debug(`[RequestConverter] Gemini thinking enabled with budget: ${thinkingConfig.thinkingBudget}`);
            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Convert tools to Google format — the critical part
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            // Extract name & description flexibly
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema flexibly
            let schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            // ── THE FIX ──
            // Replace broken sanitizers with proper flattening
            let parameters = normalizeParameters(schema);

            logger.debug(`[RequestConverter] Normalized tool "${name}" parameters: ${JSON.stringify(parameters).substring(0, 200)}...`);

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
        logger.debug(`[RequestConverter] Converted ${functionDeclarations.length} tools`);
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        logger.debug(`[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}