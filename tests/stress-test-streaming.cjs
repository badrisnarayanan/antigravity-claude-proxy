/**
 * Stress Test (Streaming) - Send multiple concurrent streaming requests to test rate limit handling
 *
 * Usage: node tests/stress-test-streaming.cjs [count] [model]
 * Example: node tests/stress-test-streaming.cjs 10 gemini-3-flash
 */

const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://localhost:8080';

const count = parseInt(process.argv[2]) || 8;
const model = process.argv[3] || 'gemini-3-flash';

async function sendStreamingRequest(id) {
    const startTime = Date.now();
    try {
        const response = await fetch(`${BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'test',
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 100,
                stream: true,
                messages: [
                    { role: 'user', content: `Request ${id}: Say "Hello ${id}" and nothing else.` }
                ]
            })
        });

        const elapsed = Date.now() - startTime;

        if (!response.ok) {
            const errorText = await response.text();
            console.log(`[${id}] ❌ ${response.status} after ${elapsed}ms: ${errorText.substring(0, 100)}`);
            return { id, success: false, status: response.status, elapsed };
        }

        // Read the SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let eventCount = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const event = JSON.parse(data);
                        eventCount++;

                        // Extract text from content_block_delta events
                        if (event.type === 'content_block_delta' && event.delta?.text) {
                            fullText += event.delta.text;
                        }
                    } catch (e) {
                        // Ignore parse errors for partial chunks
                    }
                }
            }
        }

        const totalElapsed = Date.now() - startTime;
        const textPreview = fullText.substring(0, 50) || 'No text';
        console.log(`[${id}] ✅ 200 after ${totalElapsed}ms (${eventCount} events): "${textPreview}..."`);
        return { id, success: true, status: 200, elapsed: totalElapsed, eventCount };
    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.log(`[${id}] ❌ Error after ${elapsed}ms: ${error.message}`);
        return { id, success: false, error: error.message, elapsed };
    }
}

async function runStressTest() {
    console.log(`\n🚀 Stress Test (STREAMING): Sending ${count} concurrent requests to ${model}\n`);
    console.log(`Target: ${BASE_URL}/v1/messages (stream=true)\n`);
    console.log('─'.repeat(70));

    const startTime = Date.now();

    // Send all requests concurrently
    const promises = [];
    for (let i = 1; i <= count; i++) {
        promises.push(sendStreamingRequest(i));
    }

    const results = await Promise.all(promises);

    const totalElapsed = Date.now() - startTime;
    console.log('─'.repeat(70));

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const avgElapsed = Math.round(results.reduce((sum, r) => sum + r.elapsed, 0) / results.length);
    const totalEvents = results.filter(r => r.success).reduce((sum, r) => sum + (r.eventCount || 0), 0);

    console.log(`\n📊 Summary:`);
    console.log(`   Total time: ${totalElapsed}ms`);
    console.log(`   Successful: ${successful}/${count}`);
    console.log(`   Failed: ${failed}/${count}`);
    console.log(`   Avg response time: ${avgElapsed}ms`);
    console.log(`   Total SSE events: ${totalEvents}`);

    if (failed > 0) {
        const errors = results.filter(r => !r.success);
        const statusCounts = {};
        errors.forEach(e => {
            const key = e.status || 'network';
            statusCounts[key] = (statusCounts[key] || 0) + 1;
        });
        console.log(`   Error breakdown: ${JSON.stringify(statusCounts)}`);
    }

    console.log('');
}

runStressTest().catch(console.error);
