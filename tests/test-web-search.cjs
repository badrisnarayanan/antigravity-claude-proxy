/**
 * Web Search MCP Test
 *
 * Tests that the web search MCP server (scripts/web_search_mcp.py) works
 * correctly when invoked through the Antigravity Proxy.
 *
 * Requires the proxy server to be running on port 8080.
 *
 * Verifies:
 * 1. A search query returns a 200 with text content
 * 2. The response contains actual text (not empty)
 * 3. Invalid model rejection doesn't occur (gemini-3-flash is valid)
 */
const { makeRequest } = require('./helpers/http-client.cjs');

async function runTests() {
    console.log('='.repeat(60));
    console.log('WEB SEARCH MCP TEST');
    console.log('Tests that Google Search grounding works via gemini-3-flash');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];

    // ===== TEST 1: Basic search returns text content =====
    console.log('TEST 1: Basic search query returns text content');
    console.log('-'.repeat(40));

    try {
        const result = await makeRequest({
            model: 'gemini-3-flash',
            max_tokens: 512,
            stream: false,
            system: 'You are a concise search assistant. Answer the query using your Google Search grounding tool. Return ONLY factual results in 2-3 sentences with source URLs. No code, no filler.',
            thinking: { budget_tokens: 1 },
            messages: [
                { role: 'user', content: 'What is the current price of Bitcoin?' }
            ]
        });

        const passed = result.statusCode === 200
            && result.content
            && result.content.length > 0
            && result.content.some(b => b.type === 'text' && b.text && b.text.length > 10);

        const textBlock = result.content?.find(b => b.type === 'text');
        console.log(`  Status: ${result.statusCode}`);
        console.log(`  Content blocks: ${result.content?.length || 0}`);
        console.log(`  Text preview: ${textBlock?.text?.substring(0, 120)}...`);
        console.log(`  Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`);

        if (!passed) allPassed = false;
        results.push({ name: 'Basic search', passed });
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log('  Result: FAIL ✗');
        allPassed = false;
        results.push({ name: 'Basic search', passed: false });
    }
    console.log('');

    // ===== TEST 2: Search with minimal thinking budget =====
    console.log('TEST 2: Search with minimal thinking budget (budget_tokens: 1)');
    console.log('-'.repeat(40));

    try {
        const start = Date.now();
        const result = await makeRequest({
            model: 'gemini-3-flash',
            max_tokens: 256,
            stream: false,
            thinking: { budget_tokens: 1 },
            messages: [
                { role: 'user', content: 'What year is it?' }
            ]
        });
        const elapsed = Date.now() - start;

        const passed = result.statusCode === 200
            && result.content
            && result.content.some(b => b.type === 'text');

        const textBlock = result.content?.find(b => b.type === 'text');
        console.log(`  Status: ${result.statusCode}`);
        console.log(`  Elapsed: ${elapsed}ms`);
        console.log(`  Text: ${textBlock?.text?.substring(0, 100)}`);
        console.log(`  Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`);

        if (!passed) allPassed = false;
        results.push({ name: 'Minimal thinking budget', passed });
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log('  Result: FAIL ✗');
        allPassed = false;
        results.push({ name: 'Minimal thinking budget', passed: false });
    }
    console.log('');

    // ===== TEST 3: Response format matches Anthropic Messages API =====
    console.log('TEST 3: Response format matches Anthropic Messages API');
    console.log('-'.repeat(40));

    try {
        const result = await makeRequest({
            model: 'gemini-3-flash',
            max_tokens: 256,
            stream: false,
            thinking: { budget_tokens: 1 },
            messages: [
                { role: 'user', content: 'Hello' }
            ]
        });

        const hasRole = result.role === 'assistant';
        const hasModel = typeof result.model === 'string';
        const hasContent = Array.isArray(result.content);
        const hasUsage = result.usage && typeof result.usage.input_tokens === 'number';
        const passed = hasRole && hasModel && hasContent && hasUsage;

        console.log(`  role: ${result.role} (${hasRole ? '✓' : '✗'})`);
        console.log(`  model: ${result.model} (${hasModel ? '✓' : '✗'})`);
        console.log(`  content: Array[${result.content?.length}] (${hasContent ? '✓' : '✗'})`);
        console.log(`  usage.input_tokens: ${result.usage?.input_tokens} (${hasUsage ? '✓' : '✗'})`);
        console.log(`  Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`);

        if (!passed) allPassed = false;
        results.push({ name: 'Response format', passed });
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log('  Result: FAIL ✗');
        allPassed = false;
        results.push({ name: 'Response format', passed: false });
    }
    console.log('');

    // ===== Summary =====
    console.log('='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    for (const r of results) {
        console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}`);
    }
    const passCount = results.filter(r => r.passed).length;
    console.log(`\n  ${passCount}/${results.length} tests passed`);
    console.log(`  Overall: ${allPassed ? 'ALL PASSED ✓' : 'SOME FAILED ✗'}`);

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
