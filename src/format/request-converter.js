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
import { sanitizeSchema, cleanSchemaForGemini } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks
} from './thinking-utils.js';

const SCHEMA_CACHE_MAX = 200;
const schemaCache = new Map();
const schemaRefCache = new WeakMap();
const geminiSchemaRefCache = new WeakMap();

function getSchemaCacheKey(schema, isGemini) {
    try {
        return `${isGemini ? 'gemini' : 'default'}:${JSON.stringify(schema)}`;
    } catch {
        return null;
    }
}

function setSchemaCache(key, value) {
    if (!key) return;
    schemaCache.set(key, value);
    if (schemaCache.size > SCHEMA_CACHE_MAX) {
        const firstKey = schemaCache.keys().next().value;
        if (firstKey) schemaCache.delete(firstKey);
    }
}

function sanitizeSchemaCached(schema, isGeminiModel) {
    if (schema && typeof schema === 'object') {
        const refCache = isGeminiModel ? geminiSchemaRefCache : schemaRefCache;
        const cached = refCache.get(schema);
        if (cached) return cached;
    }

    const key = getSchemaCacheKey(schema, isGeminiModel);
    if (key && schemaCache.has(key)) {
        return schemaCache.get(key);
    }

    let parameters = sanitizeSchema(schema);
    if (isGeminiModel) {
        parameters = cleanSchemaForGemini(parameters);
    }

    if (schema && typeof schema === 'object') {
        const refCache = isGeminiModel ? geminiSchemaRefCache : schemaRefCache;
        refCache.set(schema, parameters);
    }
    setSchemaCache(key, parameters);
    return parameters;
}

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
    const maxTokens = Number.isFinite(max_tokens) ? max_tokens : undefined;

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
            // Filter for text blocks as system prompts are usually text
            // Anthropic supports text blocks in system prompts
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

    // Convert messages to contents, then filter unsigned thinking blocks
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            msgContent = restoreThinkingSignatures(msgContent);
            // Remove trailing unsigned thinking blocks
            msgContent = removeTrailingThinkingBlocks(msgContent);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);
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
            // Claude thinking config
            const thinkingConfig = {
                include_thoughts: true
            };

            // Only set thinking_budget if explicitly provided
            let thinkingBudget = Number.isFinite(thinking?.budget_tokens) ? thinking.budget_tokens : undefined;
            if (thinkingBudget && maxTokens && thinkingBudget >= maxTokens) {
                const adjusted = Math.max(maxTokens - 1, 0);
                if (adjusted > 0) {
                    console.log(`[RequestConverter] Clamping thinking budget from ${thinkingBudget} to ${adjusted} (max_tokens: ${maxTokens})`);
                    thinkingBudget = adjusted;
                } else {
                    console.log('[RequestConverter] Dropping thinking budget; max_tokens too small for thinking');
                    thinkingBudget = undefined;
                }
            }

            if (thinkingBudget) {
                thinkingConfig.thinking_budget = thinkingBudget;
                console.log('[RequestConverter] Claude thinking enabled with budget:', thinkingBudget);
            } else {
                console.log('[RequestConverter] Claude thinking enabled (no budget specified)');
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            // Gemini thinking config (uses camelCase)
            let thinkingBudget = Number.isFinite(thinking?.budget_tokens) ? thinking.budget_tokens : 16000;
            if (thinkingBudget && maxTokens && thinkingBudget >= maxTokens) {
                const adjusted = Math.max(maxTokens - 1, 0);
                if (adjusted > 0) {
                    console.log(`[RequestConverter] Clamping Gemini thinking budget from ${thinkingBudget} to ${adjusted} (max_tokens: ${maxTokens})`);
                    thinkingBudget = adjusted;
                } else {
                    console.log('[RequestConverter] Dropping Gemini thinking budget; max_tokens too small for thinking');
                    thinkingBudget = undefined;
                }
            }

            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinkingBudget
            };
            console.log('[RequestConverter] Gemini thinking enabled with budget:', thinkingConfig.thinkingBudget);

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Convert tools to Google format
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            // Extract name from various possible locations
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

            // Extract description from various possible locations
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema from various possible locations
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            // Sanitize schema for general compatibility
            const parameters = sanitizeSchemaCached(schema, isGeminiModel);

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
        console.log('[RequestConverter] Tools:', JSON.stringify(googleRequest.tools).substring(0, 300));
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        console.log(`[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}
