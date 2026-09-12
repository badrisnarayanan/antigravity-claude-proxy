/**
 * OpenAI Format Converter
 * Converts between OpenAI Chat Completions API format and Anthropic / Cloud Code format
 */

import crypto from 'crypto';

/**
 * Map Anthropic stop reasons to OpenAI finish reasons
 * @param {string} stopReason - Anthropic stop reason
 * @returns {string} OpenAI finish reason
 */
export function mapAnthropicStopReasonToOpenAI(stopReason) {
    switch (stopReason) {
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        case 'tool_use':
            return 'tool_calls';
        case 'max_tokens':
            return 'length';
        default:
            return 'stop';
    }
}

/**
 * Convert OpenAI Chat Completions request to Anthropic Messages format
 *
 * @param {Object} openAIRequest - OpenAI format request body
 * @returns {Object} Anthropic format request body
 */
export function convertOpenAIToAnthropic(openAIRequest) {
    const {
        model,
        messages = [],
        stream = false,
        temperature,
        top_p,
        max_tokens,
        max_completion_tokens,
        tools,
        tool_choice,
        stop
    } = openAIRequest;

    let systemPrompt = '';
    const anthropicMessages = [];

    // Separate system messages and process conversation turns
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;

        if (role === 'system' || role === 'developer') {
            const sysText = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content)
                    ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
                    : '');
            if (systemPrompt) {
                systemPrompt += '\n\n' + sysText;
            } else {
                systemPrompt = sysText;
            }
            continue;
        }

        if (role === 'user') {
            if (typeof msg.content === 'string') {
                anthropicMessages.push({
                    role: 'user',
                    content: msg.content
                });
            } else if (Array.isArray(msg.content)) {
                const parts = [];
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        parts.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                        const url = part.image_url.url;
                        if (url.startsWith('data:')) {
                            const match = url.match(/^data:([^;]+);base64,(.+)$/);
                            if (match) {
                                parts.push({
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: match[1],
                                        data: match[2]
                                    }
                                });
                            }
                        } else {
                            // Remote image URL: Anthropic also accepts image URLs via base64 or pass as text reference
                            parts.push({
                                type: 'text',
                                text: `[Image: ${url}]`
                            });
                        }
                    }
                }
                anthropicMessages.push({
                    role: 'user',
                    content: parts.length > 0 ? parts : (msg.content || '')
                });
            } else {
                anthropicMessages.push({
                    role: 'user',
                    content: String(msg.content || '')
                });
            }
        } else if (role === 'assistant') {
            const contentBlocks = [];

            // Add text content if present
            if (msg.content) {
                if (typeof msg.content === 'string') {
                    contentBlocks.push({ type: 'text', text: msg.content });
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'text') {
                            contentBlocks.push({ type: 'text', text: part.text });
                        }
                    }
                }
            }

            // Convert tool_calls to Anthropic tool_use blocks
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    let parsedInput = {};
                    if (typeof tc.function?.arguments === 'string') {
                        try {
                            parsedInput = JSON.parse(tc.function.arguments);
                        } catch {
                            parsedInput = { raw: tc.function.arguments };
                        }
                    } else if (typeof tc.function?.arguments === 'object' && tc.function?.arguments !== null) {
                        parsedInput = tc.function.arguments;
                    }

                    contentBlocks.push({
                        type: 'tool_use',
                        id: tc.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                        name: tc.function?.name || 'unknown_tool',
                        input: parsedInput
                    });
                }
            }

            anthropicMessages.push({
                role: 'assistant',
                content: contentBlocks.length > 0 ? contentBlocks : (msg.content || '')
            });
        } else if (role === 'tool' || role === 'function') {
            // Anthropic formats tool execution results as a user message with tool_result blocks
            const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id || msg.name || `call_${i}`,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
            };

            // If previous message was also a user message with tool_result, combine them
            const prevMsg = anthropicMessages[anthropicMessages.length - 1];
            if (prevMsg && prevMsg.role === 'user' && Array.isArray(prevMsg.content) && prevMsg.content.some(b => b.type === 'tool_result')) {
                prevMsg.content.push(toolResultBlock);
            } else {
                anthropicMessages.push({
                    role: 'user',
                    content: [toolResultBlock]
                });
            }
        }
    }

    // Convert tools
    let anthropicTools = undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        anthropicTools = tools.map((t, idx) => {
            const fn = t.function || t;
            return {
                name: fn.name || `tool_${idx}`,
                description: fn.description || '',
                input_schema: fn.parameters || { type: 'object', properties: {} }
            };
        });
    }

    // Convert tool_choice
    let anthropicToolChoice = undefined;
    if (tool_choice) {
        if (tool_choice === 'auto') {
            anthropicToolChoice = { type: 'auto' };
        } else if (tool_choice === 'none') {
            anthropicToolChoice = { type: 'none' };
        } else if (tool_choice === 'required') {
            anthropicToolChoice = { type: 'any' };
        } else if (typeof tool_choice === 'object' && tool_choice.type === 'function' && tool_choice.function?.name) {
            anthropicToolChoice = { type: 'tool', name: tool_choice.function.name };
        }
    }

    // Convert stop sequences
    let stopSequences = undefined;
    if (stop) {
        if (typeof stop === 'string') {
            stopSequences = [stop];
        } else if (Array.isArray(stop)) {
            stopSequences = stop;
        }
    }

    return {
        model,
        messages: anthropicMessages,
        system: systemPrompt || undefined,
        stream: !!stream,
        max_tokens: max_completion_tokens || max_tokens || 4096,
        temperature,
        top_p,
        tools: anthropicTools,
        tool_choice: anthropicToolChoice,
        stop_sequences: stopSequences
    };
}

/**
 * Convert Anthropic Messages non-streaming response to OpenAI ChatCompletion format
 *
 * @param {Object} anthropicResponse - Anthropic API response object
 * @param {string} requestedModel - The model requested by the client
 * @returns {Object} OpenAI ChatCompletion response object
 */
export function convertAnthropicToOpenAI(anthropicResponse, requestedModel) {
    const id = `chatcmpl-${(anthropicResponse.id || crypto.randomBytes(12).toString('hex')).replace(/^msg_/, '')}`;
    const created = Math.floor(Date.now() / 1000);

    let textContent = '';
    const toolCalls = [];

    const contentBlocks = anthropicResponse.content || [];
    for (const block of contentBlocks) {
        if (block.type === 'text') {
            textContent += block.text || '';
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            });
        }
    }

    const message = {
        role: 'assistant',
        content: toolCalls.length > 0 && !textContent ? null : textContent
    };

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    const finishReason = mapAnthropicStopReasonToOpenAI(anthropicResponse.stop_reason);

    const inputTokens = anthropicResponse.usage?.input_tokens || 0;
    const outputTokens = anthropicResponse.usage?.output_tokens || 0;

    return {
        id,
        object: 'chat.completion',
        created,
        model: requestedModel || anthropicResponse.model,
        choices: [
            {
                index: 0,
                message,
                finish_reason: finishReason
            }
        ],
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens
        }
    };
}

/**
 * Stream Anthropic Messages SSE events converted to OpenAI ChatCompletion chunk format
 *
 * @param {AsyncGenerator} anthropicStream - Stream of Anthropic events
 * @param {string} requestedModel - The model requested by the client
 * @param {string} [completionId] - Unique ID for the completion
 * @returns {AsyncGenerator<string>} Yields serialized SSE data lines (e.g. "data: {...}\n\n")
 */
export async function* streamAnthropicToOpenAI(anthropicStream, requestedModel, completionId = null) {
    const id = completionId || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);

    let toolCallIndex = -1;
    let finishReason = null;
    let usage = null;
    let sentRole = false;

    for await (const event of anthropicStream) {
        if (event.type === 'message_start') {
            // First chunk: announce assistant role
            sentRole = true;
            const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel || event.message?.model || 'antigravity-model',
                choices: [
                    {
                        index: 0,
                        delta: {
                            role: 'assistant',
                            content: ''
                        },
                        finish_reason: null
                    }
                ]
            };
            yield `data: ${JSON.stringify(chunk)}\n\n`;

            if (event.message?.usage) {
                usage = {
                    prompt_tokens: event.message.usage.input_tokens || 0,
                    completion_tokens: 0,
                    total_tokens: event.message.usage.input_tokens || 0
                };
            }
        } else if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'tool_use') {
                toolCallIndex++;
                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: requestedModel,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: toolCallIndex,
                                        id: event.content_block.id,
                                        type: 'function',
                                        function: {
                                            name: event.content_block.name,
                                            arguments: ''
                                        }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                };
                yield `data: ${JSON.stringify(chunk)}\n\n`;
            }
        } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: requestedModel,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                content: event.delta.text
                            },
                            finish_reason: null
                        }
                    ]
                };
                yield `data: ${JSON.stringify(chunk)}\n\n`;
            } else if (event.delta?.type === 'input_json_delta') {
                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: requestedModel,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: Math.max(0, toolCallIndex),
                                        function: {
                                            arguments: event.delta.partial_json
                                        }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                };
                yield `data: ${JSON.stringify(chunk)}\n\n`;
            } else if (event.delta?.type === 'thinking_delta') {
                // OpenAI-compatible reasoning_content delta
                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: requestedModel,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                reasoning_content: event.delta.thinking
                            },
                            finish_reason: null
                        }
                    ]
                };
                yield `data: ${JSON.stringify(chunk)}\n\n`;
            }
        } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) {
                finishReason = mapAnthropicStopReasonToOpenAI(event.delta.stop_reason);
            }
            if (event.usage) {
                const output = event.usage.output_tokens || 0;
                const prompt = usage?.prompt_tokens || 0;
                usage = {
                    prompt_tokens: prompt,
                    completion_tokens: output,
                    total_tokens: prompt + output
                };
            }
        }
    }

    // Final chunk with finish_reason and usage
    const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: finishReason || 'stop'
            }
        ]
    };

    if (usage) {
        finalChunk.usage = usage;
    }

    yield `data: ${JSON.stringify(finalChunk)}\n\n`;
    yield 'data: [DONE]\n\n';
}

export default {
    mapAnthropicStopReasonToOpenAI,
    convertOpenAIToAnthropic,
    convertAnthropicToOpenAI,
    streamAnthropicToOpenAI
};
