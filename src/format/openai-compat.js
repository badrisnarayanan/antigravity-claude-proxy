/**
 * OpenAI-compatible format converters
 * Translates between OpenAI Chat Completions API and Anthropic Messages API formats
 */

import crypto from 'crypto';

/**
 * Convert OpenAI Chat Completions request to Anthropic Messages API format
 */
export function convertOpenAIToAnthropic(openaiBody) {
    const {
        model,
        messages = [],
        max_tokens,
        max_completion_tokens,
        temperature,
        top_p,
        stream,
        tools,
        tool_choice,
        stop
    } = openaiBody;

    // Separate system messages from conversation messages
    let systemParts = [];
    const anthropicMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string'
                ? msg.content
                : (msg.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
            if (text) systemParts.push(text);
            continue;
        }

        if (msg.role === 'tool') {
            anthropicMessages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                }]
            });
            continue;
        }

        if (msg.role === 'assistant') {
            const content = convertAssistantContent(msg);
            anthropicMessages.push({ role: 'assistant', content });
            continue;
        }

        // user messages
        const content = convertUserContent(msg.content);
        anthropicMessages.push({ role: 'user', content });
    }

    // Merge consecutive same-role messages (Anthropic requires alternating roles)
    const mergedMessages = mergeConsecutiveRoles(anthropicMessages);

    const result = {
        model: model,
        messages: mergedMessages,
        max_tokens: max_completion_tokens || max_tokens || 4096,
        stream: !!stream,
    };

    if (systemParts.length > 0) {
        result.system = systemParts.join('\n\n');
    }

    if (temperature !== undefined) result.temperature = temperature;
    if (top_p !== undefined) result.top_p = top_p;
    if (stop) result.stop_sequences = Array.isArray(stop) ? stop : [stop];

    // Convert tools
    if (tools && tools.length > 0 && tool_choice !== 'none') {
        result.tools = tools
            .filter(t => t.type === 'function' && t.function)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object', properties: {} }
            }));

        if (tool_choice && tool_choice !== 'auto') {
            if (tool_choice === 'required') {
                result.tool_choice = { type: 'any' };
            } else if (typeof tool_choice === 'object' && tool_choice.function) {
                result.tool_choice = { type: 'tool', name: tool_choice.function.name };
            }
        }
    }

    return result;
}

function convertUserContent(content) {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }
    if (!Array.isArray(content)) {
        return [{ type: 'text', text: String(content ?? '') }];
    }

    return content.map(part => {
        if (part.type === 'text') {
            return { type: 'text', text: part.text };
        }
        if (part.type === 'image_url' && part.image_url) {
            const url = part.image_url.url || '';
            const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
                return {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: base64Match[1],
                        data: base64Match[2]
                    }
                };
            }
            return {
                type: 'image',
                source: { type: 'url', url }
            };
        }
        return { type: 'text', text: JSON.stringify(part) };
    });
}

function convertAssistantContent(msg) {
    const blocks = [];

    if (msg.content) {
        const text = typeof msg.content === 'string' ? msg.content : msg.content;
        if (typeof text === 'string' && text) {
            blocks.push({ type: 'text', text });
        }
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
            let input = {};
            try {
                input = JSON.parse(tc.function.arguments || '{}');
            } catch { /* use empty object */ }

            blocks.push({
                type: 'tool_use',
                id: tc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                name: tc.function.name,
                input
            });
        }
    }

    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function mergeConsecutiveRoles(messages) {
    if (messages.length === 0) return messages;

    const merged = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
        const prev = merged[merged.length - 1];
        const curr = messages[i];
        if (prev.role === curr.role) {
            const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content) }];
            const currContent = Array.isArray(curr.content) ? curr.content : [{ type: 'text', text: String(curr.content) }];
            prev.content = [...prevContent, ...currContent];
        } else {
            merged.push(curr);
        }
    }
    return merged;
}

/**
 * Convert Anthropic Messages API response to OpenAI Chat Completions format (non-streaming)
 */
export function convertAnthropicToOpenAI(anthropicResponse) {
    const textParts = [];
    const toolCalls = [];
    let toolCallIndex = 0;

    for (const block of (anthropicResponse.content || [])) {
        if (block.type === 'text' && block.text) {
            textParts.push(block.text);
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                },
                index: toolCallIndex++
            });
        }
        // skip thinking blocks — no OpenAI equivalent
    }

    const hasToolCalls = toolCalls.length > 0;
    const content = textParts.length > 0 ? textParts.join('') : null;

    const message = { role: 'assistant', content };
    if (hasToolCalls) {
        message.tool_calls = toolCalls;
    }

    const stopReason = anthropicResponse.stop_reason;
    let finishReason = 'stop';
    if (stopReason === 'max_tokens') finishReason = 'length';
    else if (stopReason === 'tool_use') finishReason = 'tool_calls';

    const usage = anthropicResponse.usage || {};

    return {
        id: `chatcmpl-${(anthropicResponse.id || crypto.randomBytes(16).toString('hex')).replace(/^msg_/, '')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResponse.model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason
        }],
        usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
        }
    };
}

/**
 * Convert a single Anthropic SSE event to OpenAI streaming chunk format.
 * Returns the chunk object, or null to signal the caller should write [DONE].
 *
 * @param {Object} event - Anthropic SSE event
 * @param {string} model - Model name
 * @param {Object} state - Mutable state: { id, toolCallIndex, blockType }
 * @returns {Object|null} OpenAI chunk or null for stream end
 */
export function convertAnthropicSSEToOpenAI(event, model, state) {
    const base = {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model
    };

    switch (event.type) {
        case 'message_start': {
            state.id = `chatcmpl-${(event.message?.id || crypto.randomBytes(16).toString('hex')).replace(/^msg_/, '')}`;
            state.created = Math.floor(Date.now() / 1000);
            base.id = state.id;
            base.created = state.created;
            return {
                ...base,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
            };
        }

        case 'content_block_start': {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
                state.blockType = 'tool_use';
                const idx = state.toolCallIndex++;
                return {
                    ...base,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: idx,
                                id: block.id,
                                type: 'function',
                                function: { name: block.name, arguments: '' }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }
            if (block?.type === 'text') {
                state.blockType = 'text';
            } else {
                state.blockType = block?.type || 'unknown';
            }
            return null;
        }

        case 'content_block_delta': {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
                return {
                    ...base,
                    choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }]
                };
            }
            if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
                return {
                    ...base,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: state.toolCallIndex - 1,
                                function: { arguments: delta.partial_json }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }
            // Skip thinking_delta, signature_delta
            return null;
        }

        case 'content_block_stop':
            return null;

        case 'message_delta': {
            const stopReason = event.delta?.stop_reason;
            let finishReason = 'stop';
            if (stopReason === 'max_tokens') finishReason = 'length';
            else if (stopReason === 'tool_use') finishReason = 'tool_calls';

            return {
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            };
        }

        case 'message_stop':
            return null;

        default:
            return null;
    }
}
