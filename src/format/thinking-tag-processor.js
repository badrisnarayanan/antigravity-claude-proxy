import crypto from 'crypto';

const THINKING_OPEN = '<thinking>';
const THINKING_CLOSE = '</thinking>';

export function processThinkingTagsNonStreaming(response, mode) {
    if (!mode || mode === 'passthrough') return response;
    if (!response || !Array.isArray(response.content)) return response;

    const newContent = [];

    for (const block of response.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') {
            newContent.push(block);
            continue;
        }

        const parsed = extractThinkingSegments(block.text);

        if (!parsed.hasThinking) {
            newContent.push(block);
            continue;
        }

        if (mode === 'strip') {
            const remaining = parsed.segments
                .filter(s => s.type === 'text')
                .map(s => s.content)
                .join('');
            if (remaining.trim()) {
                newContent.push({ type: 'text', text: remaining });
            }
        } else if (mode === 'native') {
            for (const segment of parsed.segments) {
                if (segment.type === 'thinking' && segment.content.trim()) {
                    newContent.push({
                        type: 'thinking',
                        thinking: segment.content,
                        signature: `erp_${crypto.randomBytes(32).toString('base64')}`
                    });
                } else if (segment.type === 'text' && segment.content.trim()) {
                    newContent.push({ type: 'text', text: segment.content });
                }
            }
        }
    }

    if (newContent.length === 0) {
        newContent.push({ type: 'text', text: '' });
    }

    return { ...response, content: newContent };
}

function extractThinkingSegments(text) {
    const segments = [];
    let hasThinking = false;
    let cursor = 0;

    while (cursor < text.length) {
        const openIdx = text.indexOf(THINKING_OPEN, cursor);
        if (openIdx === -1) {
            segments.push({ type: 'text', content: text.slice(cursor) });
            break;
        }

        if (openIdx > cursor) {
            segments.push({ type: 'text', content: text.slice(cursor, openIdx) });
        }

        const closeIdx = text.indexOf(THINKING_CLOSE, openIdx + THINKING_OPEN.length);
        if (closeIdx === -1) {
            segments.push({ type: 'text', content: text.slice(openIdx) });
            break;
        }

        hasThinking = true;
        const thinkingContent = text.slice(openIdx + THINKING_OPEN.length, closeIdx);
        segments.push({ type: 'thinking', content: thinkingContent });
        cursor = closeIdx + THINKING_CLOSE.length;
    }

    return { segments, hasThinking };
}

const STATE_TEXT = 0;
const STATE_THINKING = 1;
const STATE_MAYBE_OPEN = 2;
const STATE_MAYBE_CLOSE = 3;

export class StreamingThinkingTagProcessor {
    constructor(mode) {
        this.mode = mode;
        this.state = STATE_TEXT;
        this.tagBuffer = '';
        this.originalBlockIndex = -1;
        this.currentBlockIndex = -1;
        this.indexOffset = 0;
        this.tracking = false;
        this.insideThinkingBlock = false;
        this.hasOpenTextBlock = false;
    }

    shouldProcess() {
        return this.mode && this.mode !== 'passthrough';
    }

    *processEvent(event) {
        if (!this.shouldProcess()) {
            yield event;
            return;
        }

        if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'text') {
                this.originalBlockIndex = event.index;
                this.currentBlockIndex = event.index + this.indexOffset;
                this.tracking = true;
                this.state = STATE_TEXT;
                this.tagBuffer = '';
                this.insideThinkingBlock = false;
                this.hasOpenTextBlock = true;
                yield {
                    ...event,
                    index: this.currentBlockIndex
                };
            } else {
                yield {
                    ...event,
                    index: event.index + this.indexOffset
                };
            }
            return;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && this.tracking) {
            yield* this._processTextDelta(event);
            return;
        }

        if (event.type === 'content_block_stop' && event.index === this.originalBlockIndex && this.tracking) {
            yield* this._flushRemaining();
            yield { type: 'content_block_stop', index: this.currentBlockIndex };
            this.tracking = false;
            this.hasOpenTextBlock = false;
            return;
        }

        if (event.type === 'content_block_delta' || event.type === 'content_block_stop' || event.type === 'content_block_start') {
            yield {
                ...event,
                index: (event.index !== undefined ? event.index + this.indexOffset : event.index)
            };
            return;
        }

        yield event;
    }

    *_processTextDelta(event) {
        const text = event.delta.text;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];

            switch (this.state) {
                case STATE_TEXT:
                    if (ch === '<') {
                        this.state = STATE_MAYBE_OPEN;
                        this.tagBuffer = '<';
                    } else {
                        yield* this._emitText(ch);
                    }
                    break;

                case STATE_MAYBE_OPEN:
                    this.tagBuffer += ch;
                    if (THINKING_OPEN.startsWith(this.tagBuffer)) {
                        if (this.tagBuffer === THINKING_OPEN) {
                            this.state = STATE_THINKING;
                            this.tagBuffer = '';
                            if (this.mode === 'native') {
                                yield* this._startThinkingBlock();
                            }
                        }
                    } else {
                        const buf = this.tagBuffer;
                        this.tagBuffer = '';
                        this.state = STATE_TEXT;
                        yield* this._emitText(buf);
                    }
                    break;

                case STATE_THINKING:
                    if (ch === '<') {
                        this.state = STATE_MAYBE_CLOSE;
                        this.tagBuffer = '<';
                    } else {
                        if (this.mode === 'native') {
                            yield* this._emitThinkingDelta(ch);
                        }
                    }
                    break;

                case STATE_MAYBE_CLOSE:
                    this.tagBuffer += ch;
                    if (THINKING_CLOSE.startsWith(this.tagBuffer)) {
                        if (this.tagBuffer === THINKING_CLOSE) {
                            this.tagBuffer = '';
                            this.state = STATE_TEXT;
                            if (this.mode === 'native') {
                                yield* this._endThinkingBlock();
                            }
                        }
                    } else {
                        const buf = this.tagBuffer;
                        this.tagBuffer = '';
                        this.state = STATE_THINKING;
                        if (this.mode === 'native') {
                            yield* this._emitThinkingDelta(buf);
                        }
                    }
                    break;
            }
        }
    }

    *_emitText(text) {
        yield {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: { type: 'text_delta', text }
        };
    }

    *_startThinkingBlock() {
        yield { type: 'content_block_stop', index: this.currentBlockIndex };
        this.hasOpenTextBlock = false;

        this.indexOffset++;
        this.currentBlockIndex = this.originalBlockIndex + this.indexOffset;
        this.insideThinkingBlock = true;

        yield {
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: { type: 'thinking', thinking: '' }
        };
    }

    *_emitThinkingDelta(text) {
        yield {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: { type: 'thinking_delta', thinking: text }
        };
    }

    *_endThinkingBlock() {
        yield {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
                type: 'signature_delta',
                signature: `erp_${crypto.randomBytes(32).toString('base64')}`
            }
        };
        yield { type: 'content_block_stop', index: this.currentBlockIndex };
        this.insideThinkingBlock = false;

        this.indexOffset++;
        this.currentBlockIndex = this.originalBlockIndex + this.indexOffset;

        yield {
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: { type: 'text', text: '' }
        };
        this.hasOpenTextBlock = true;
    }

    *_flushRemaining() {
        if (this.tagBuffer) {
            if (this.state === STATE_MAYBE_OPEN) {
                yield* this._emitText(this.tagBuffer);
            } else if (this.state === STATE_MAYBE_CLOSE && this.mode === 'native') {
                yield* this._emitThinkingDelta(this.tagBuffer);
            }
            this.tagBuffer = '';
        }

        if (this.insideThinkingBlock && this.mode === 'native') {
            yield {
                type: 'content_block_delta',
                index: this.currentBlockIndex,
                delta: {
                    type: 'signature_delta',
                    signature: `erp_${crypto.randomBytes(32).toString('base64')}`
                }
            };
            yield { type: 'content_block_stop', index: this.currentBlockIndex };
            this.insideThinkingBlock = false;

            this.indexOffset++;
            this.currentBlockIndex = this.originalBlockIndex + this.indexOffset;

            yield {
                type: 'content_block_start',
                index: this.currentBlockIndex,
                content_block: { type: 'text', text: '' }
            };
            this.hasOpenTextBlock = true;
        }
    }
}

export async function* wrapStreamWithThinkingProcessor(generator, mode) {
    if (!mode || mode === 'passthrough') {
        yield* generator;
        return;
    }

    const processor = new StreamingThinkingTagProcessor(mode);

    for await (const event of generator) {
        yield* processor.processEvent(event);
    }
}