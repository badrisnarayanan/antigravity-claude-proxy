/**
 * OpenAI Chat Completions compatibility layer.
 *
 * Converts OpenAI-style /v1/chat/completions requests into the internal
 * Anthropic Messages request shape used by this proxy, and converts the
 * resulting Anthropic responses/events back to OpenAI-compatible responses.
 */

import crypto from 'crypto';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return String(value);
}

function parseDataUrl(url) {
    const trimmed = (url || '').trim();
    if (!trimmed.startsWith('data:')) return null;

    const comma = trimmed.indexOf(',');
    if (comma === -1) return null;

    const meta = trimmed.slice('data:'.length, comma);
    const data = trimmed.slice(comma + 1);

    // We only support base64-encoded data URLs for image inputs.
    const isBase64 = meta.includes(';base64');
    if (!isBase64) return null;

    const mime = meta.split(';')[0] || 'application/octet-stream';
    return { mime, data };
}

function safeJsonParse(text) {
    const raw = (text || '').trim();
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        // OpenAI tool args must be an object for our downstream.
        return isObject(parsed) ? parsed : { __raw: raw };
    } catch {
        return { __raw: raw };
    }
}

function openAiContentPartsToAnthropicBlocks(parts) {
    const blocks = [];

    for (const part of parts) {
        if (!isObject(part)) continue;
        const type = part.type;

        if (type === 'text') {
            blocks.push({ type: 'text', text: asString(part.text) });
            continue;
        }

        if (type === 'image_url') {
            const url = part.image_url?.url;
            if (typeof url !== 'string' || url.trim() === '') continue;

            const parsed = parseDataUrl(url);
            if (parsed) {
                blocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: parsed.mime,
                        data: parsed.data
                    }
                });
            } else {
                blocks.push({
                    type: 'image',
                    source: {
                        type: 'url',
                        media_type: part.image_url?.media_type,
                        url: url
                    }
                });
            }
            continue;
        }
    }

    return blocks;
}

function openAiMessageToAnthropicMessage(msg) {
    const role = msg.role;

    // system/developer handled separately by request conversion
    if (role === 'system' || role === 'developer') return null;

    if (role === 'tool') {
        const toolCallId = msg.tool_call_id || msg.toolCallId;
        if (!toolCallId) {
            throw new Error('invalid_request_error: tool message is missing tool_call_id');
        }
        const toolContent = msg.content;
        const contentText = Array.isArray(toolContent)
            ? openAiContentPartsToAnthropicBlocks(toolContent)
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n')
            : asString(toolContent);

        return {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: toolCallId,
                    content: contentText
                }
            ]
        };
    }

    // Legacy OpenAI function role: treat like tool output.
    if (role === 'function') {
        const toolUseId = msg.name || 'function';
        return {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: asString(msg.content)
                }
            ]
        };
    }

    if (role !== 'user' && role !== 'assistant') {
        // Best-effort: coerce unknown roles to user.
        // This keeps many OpenAI-compatible clients working (e.g., "human").
    }

    const targetRole = role === 'assistant' ? 'assistant' : 'user';

    // Content: string | array(parts) | null
    let content = msg.content;

    // OpenAI can send content as an array of structured parts.
    if (Array.isArray(content)) {
        content = openAiContentPartsToAnthropicBlocks(content);
    } else if (content === null || content === undefined) {
        content = '';
    } else if (typeof content !== 'string') {
        content = asString(content);
    }

    // Tools: OpenAI assistant messages can include tool calls.
    if (targetRole === 'assistant') {
        const blocks = [];

        if (Array.isArray(content)) {
            blocks.push(...content);
        } else if (typeof content === 'string' && content !== '') {
            blocks.push({ type: 'text', text: content });
        }

        // tool_calls (new)
        if (Array.isArray(msg.tool_calls)) {
            for (const call of msg.tool_calls) {
                if (!isObject(call)) continue;
                if (call.type && call.type !== 'function') continue;
                const id = call.id || `call_${crypto.randomBytes(12).toString('hex')}`;
                const name = call.function?.name || 'function';
                const args = call.function?.arguments;

                blocks.push({
                    type: 'tool_use',
                    id,
                    name,
                    input: safeJsonParse(args)
                });
            }
        }

        // function_call (legacy)
        if (!Array.isArray(msg.tool_calls) && isObject(msg.function_call)) {
            const id = msg.function_call?.name || `call_${crypto.randomBytes(12).toString('hex')}`;
            blocks.push({
                type: 'tool_use',
                id,
                name: msg.function_call?.name || 'function',
                input: safeJsonParse(msg.function_call?.arguments)
            });
        }

        // If we added any tool/text blocks, use block array; otherwise keep string.
        if (blocks.length > 0) {
            return { role: 'assistant', content: blocks };
        }

        return { role: 'assistant', content: typeof content === 'string' ? content : '' };
    }

    // user messages
    return { role: 'user', content };
}

function extractSystemFromOpenAiMessages(messages) {
    const parts = [];

    for (const msg of messages) {
        if (!isObject(msg)) continue;
        if (msg.role !== 'system' && msg.role !== 'developer') continue;

        const content = msg.content;
        if (typeof content === 'string') {
            if (content.trim()) parts.push(content);
            continue;
        }
        if (Array.isArray(content)) {
            const text = openAiContentPartsToAnthropicBlocks(content)
                .filter(b => b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text)
                .join('\n');
            if (text.trim()) parts.push(text);
            continue;
        }
    }

    const system = parts.join('\n\n').trim();
    return system || null;
}

function normalizeStop(stop) {
    if (!stop) return undefined;
    if (typeof stop === 'string') return [stop];
    if (Array.isArray(stop)) return stop.filter(s => typeof s === 'string' && s.length > 0);
    return undefined;
}

export function convertOpenAIChatCompletionsToAnthropicRequest(openaiBody) {
    if (!isObject(openaiBody)) {
        throw new Error('invalid_request_error: Request body must be a JSON object');
    }

    if (openaiBody.n !== undefined && openaiBody.n !== 1) {
        throw new Error('invalid_request_error: Only n=1 is supported');
    }

    const model = openaiBody.model || '';
    const messages = openaiBody.messages;
    if (!Array.isArray(messages)) {
        throw new Error('invalid_request_error: messages is required and must be an array');
    }

    const system = extractSystemFromOpenAiMessages(messages);

    const anthropicMessages = [];
    for (const msg of messages) {
        if (!isObject(msg)) continue;
        const converted = openAiMessageToAnthropicMessage(msg);
        if (!converted) continue;
        anthropicMessages.push(converted);
    }

    const stop_sequences = normalizeStop(openaiBody.stop);

    // OpenAI legacy: "functions" => "tools" (type=function).
    let tools = Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined;
    if (!tools && Array.isArray(openaiBody.functions)) {
        tools = openaiBody.functions
            .filter(isObject)
            .map(fn => ({
                type: 'function',
                function: {
                    name: fn.name,
                    description: fn.description,
                    parameters: fn.parameters
                }
            }));
    }

    const anthropicRequest = {
        model: model,
        messages: anthropicMessages,
        stream: !!openaiBody.stream,
        system: system || undefined,
        max_tokens: openaiBody.max_tokens ?? openaiBody.max_completion_tokens ?? undefined,
        temperature: openaiBody.temperature,
        top_p: openaiBody.top_p,
        // Pass tools through as-is: the downstream converter understands both Anthropic-style and OpenAI-style shapes.
        tools,
        tool_choice: openaiBody.tool_choice,
        stop_sequences
    };

    const streamOptions = isObject(openaiBody.stream_options) ? openaiBody.stream_options : null;
    const includeUsage = !!streamOptions?.include_usage;

    return { anthropicRequest, includeUsage };
}

function mapAnthropicStopReasonToOpenAiFinishReason(stopReason) {
    if (stopReason === 'tool_use') return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop';
    return 'stop';
}

export function convertAnthropicToOpenAIChatCompletion(anthropicResponse, options = {}) {
    const created = options.created ?? Math.floor(Date.now() / 1000);
    const id = options.id ?? `chatcmpl_${crypto.randomBytes(16).toString('hex')}`;

    const contentBlocks = Array.isArray(anthropicResponse?.content) ? anthropicResponse.content : [];
    const text = contentBlocks
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('');

    const images = contentBlocks
        .filter(b => b && b.type === 'image' && b.source && (b.source.type === 'base64' || b.source.type === 'url'))
        .filter(b => {
            if (b.source.type === 'base64') return typeof b.source.data === 'string' && b.source.data.length > 0;
            if (b.source.type === 'url') return typeof b.source.url === 'string' && b.source.url.length > 0;
            return false;
        });

    const imageMarkdown = images
        .map((b, idx) => {
            if (b.source.type === 'url') {
                // Embed as a normal markdown image URL.
                return `![image_${idx + 1}](${b.source.url})`;
            }

            const mime = b.source.media_type || 'image/png';
            // OpenAI Chat Completions doesn't have a standard structured image output, so we embed a data URL.
            return `![image_${idx + 1}](data:${mime};base64,${b.source.data})`;
        })
        .join('\n');

    const toolCalls = contentBlocks
        .filter(b => b && b.type === 'tool_use')
        .map((b, idx) => ({
            id: b.id || `call_${idx}_${crypto.randomBytes(8).toString('hex')}`,
            type: 'function',
            function: {
                name: b.name || 'function',
                arguments: JSON.stringify(b.input ?? {})
            }
        }));

    const stopReason = anthropicResponse?.stop_reason;
    const finish_reason = mapAnthropicStopReasonToOpenAiFinishReason(stopReason);

    const usage = anthropicResponse?.usage || {};
    const promptTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const completionTokens = usage.output_tokens || 0;

    const combinedContent = [text, imageMarkdown].filter(s => typeof s === 'string' && s.length > 0).join(text && imageMarkdown ? '\n\n' : '');

    const message = {
        role: 'assistant',
        content: combinedContent === '' ? null : combinedContent
    };

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    return {
        id,
        object: 'chat.completion',
        created,
        model: anthropicResponse?.model || options.model,
        choices: [
            {
                index: 0,
                message,
                finish_reason
            }
        ],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        }
    };
}

export function createOpenAIChatCompletionStreamTransformer(options) {
    const id = options?.id || `chatcmpl_${crypto.randomBytes(16).toString('hex')}`;
    const created = options?.created ?? Math.floor(Date.now() / 1000);
    const model = options?.model || '';
    const includeUsage = !!options?.includeUsage;

    let sentRole = false;
    let nextToolCallIndex = 0;
    const toolIndexByBlockIndex = new Map();
    const toolIdByBlockIndex = new Map();
    const toolNameByBlockIndex = new Map();

    let promptTokens = null;
    let completionTokens = null;

    function makeChunk(delta, finishReason = null, extra = undefined) {
        const base = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
                {
                    index: 0,
                    delta,
                    finish_reason: finishReason
                }
            ]
        };
        return extra ? { ...base, ...extra } : base;
    }

    function maybeCapturePromptUsage(messageStartEvent) {
        const u = messageStartEvent?.message?.usage;
        if (!u) return;
        const inputTokens = u.input_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        promptTokens = inputTokens + cacheRead;
    }

    function captureCompletionUsage(messageDeltaEvent) {
        const u = messageDeltaEvent?.usage;
        if (!u) return;
        completionTokens = u.output_tokens ?? completionTokens ?? 0;
        // Some upstream paths only include cache_read_input_tokens on message_delta.
        if (promptTokens === null) {
            const cacheRead = u.cache_read_input_tokens || 0;
            promptTokens = cacheRead;
        }
    }

    function ensureRoleChunk(out) {
        if (sentRole) return;
        sentRole = true;
        out.push(makeChunk({ role: 'assistant' }));
    }

    return {
        id,
        created,
        model,
        handleAnthropicEvent(event) {
            const out = [];

            if (!event || typeof event !== 'object') return out;

            if (event.type === 'message_start') {
                maybeCapturePromptUsage(event);
                ensureRoleChunk(out);
                return out;
            }

            if (event.type === 'content_block_start') {
                const cb = event.content_block;
                if (cb && cb.type === 'tool_use') {
                    ensureRoleChunk(out);

                    const toolIdx = nextToolCallIndex++;
                    toolIndexByBlockIndex.set(event.index, toolIdx);
                    toolIdByBlockIndex.set(event.index, cb.id);
                    toolNameByBlockIndex.set(event.index, cb.name);

                    out.push(makeChunk({
                        tool_calls: [
                            {
                                index: toolIdx,
                                id: cb.id,
                                type: 'function',
                                function: {
                                    name: cb.name,
                                    arguments: ''
                                }
                            }
                        ]
                    }));
                }
                if (cb && cb.type === 'image' && cb.source && cb.source.type === 'url' && typeof cb.source.url === 'string' && cb.source.url.length > 0) {
                    ensureRoleChunk(out);
                    const markdown = `![image](${cb.source.url})`;
                    out.push(makeChunk({ content: markdown }));
                }
                if (cb && cb.type === 'image' && cb.source && cb.source.type === 'base64' && typeof cb.source.data === 'string' && cb.source.data.length > 0) {
                    ensureRoleChunk(out);
                    const mime = cb.source.media_type || 'image/png';
                    const markdown = `![image](data:${mime};base64,${cb.source.data})`;
                    out.push(makeChunk({ content: markdown }));
                }
                return out;
            }

            if (event.type === 'content_block_delta') {
                const d = event.delta || {};

                if (d.type === 'text_delta') {
                    ensureRoleChunk(out);
                    out.push(makeChunk({ content: asString(d.text) }));
                    return out;
                }

                if (d.type === 'input_json_delta') {
                    const toolIdx = toolIndexByBlockIndex.get(event.index);
                    if (toolIdx === undefined) return out;

                    ensureRoleChunk(out);
                    out.push(makeChunk({
                        tool_calls: [
                            {
                                index: toolIdx,
                                id: toolIdByBlockIndex.get(event.index),
                                type: 'function',
                                function: {
                                    // Only stream arguments here; name was already sent at start.
                                    arguments: asString(d.partial_json)
                                }
                            }
                        ]
                    }));
                    return out;
                }

                // thinking_delta / signature_delta: intentionally not exposed in OpenAI mode.
                return out;
            }

            if (event.type === 'message_delta') {
                captureCompletionUsage(event);
                ensureRoleChunk(out);

                const finishReason = mapAnthropicStopReasonToOpenAiFinishReason(event.delta?.stop_reason);
                out.push(makeChunk({}, finishReason));

                if (includeUsage) {
                    const pt = promptTokens ?? 0;
                    const ct = completionTokens ?? 0;
                    out.push({
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [],
                        usage: {
                            prompt_tokens: pt,
                            completion_tokens: ct,
                            total_tokens: pt + ct
                        }
                    });
                }

                return out;
            }

            return out;
        }
    };
}
