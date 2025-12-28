const assert = require('node:assert/strict');

async function run() {
    const {
        reorderAssistantContent,
        restoreThinkingSignatures,
        filterUnsignedThinkingBlocks
    } = await import('../src/format/thinking-utils.js');

    const shortSignature = 'x'.repeat(10);
    const validSignature = 'y'.repeat(60);

    // reorderAssistantContent drops invalid thinking blocks
    const reordered = reorderAssistantContent([
        { type: 'thinking', thinking: 'secret', signature: shortSignature },
        { type: 'text', text: 'ok' }
    ]);
    assert.equal(reordered.some(block => block.type === 'thinking'), false);
    assert.equal(reordered.some(block => block.type === 'text'), true);

    // restoreThinkingSignatures keeps only valid thinking blocks
    const restored = restoreThinkingSignatures([
        { type: 'thinking', thinking: 'secret', signature: shortSignature },
        { type: 'thinking', thinking: 'secret2', signature: validSignature },
        { type: 'text', text: 'ok' }
    ]);
    assert.equal(restored.some(block => block.type === 'thinking' && block.signature === shortSignature), false);
    assert.equal(restored.some(block => block.type === 'thinking' && block.signature === validSignature), true);

    // filterUnsignedThinkingBlocks drops invalid thought parts
    const filtered = filterUnsignedThinkingBlocks([{
        role: 'model',
        parts: [
            { thought: true, text: 'secret', thoughtSignature: shortSignature },
            { text: 'ok' }
        ]
    }]);
    assert.equal(filtered[0].parts.length, 1);
    assert.equal(filtered[0].parts[0].text, 'ok');

    console.log('Thinking utils tests passed.');
}

run().catch((error) => {
    console.error('Thinking utils test failed:', error);
    process.exit(1);
});
