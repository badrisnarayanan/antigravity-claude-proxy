/**
 * Web Search MCP Test
 *
 * Tests that the web search MCP server (scripts/web_search_mcp.py) works
 * correctly when invoked through the Antigravity Proxy.
 *
 * Requires the proxy server to be running on port 8080.
 *
 * Verifies:
 * 1. Google Search grounding returns live results via google_search tool
 * 2. Minimal thinking budget works with grounding
 * 3. Response format matches Anthropic Messages API
 * 4. Grounding tool doesn't leak into functionDeclarations (no regression)
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

    // ===== TEST 1: Google Search grounding returns live results =====
    console.log('TEST 1: Google Search grounding returns live text content');
    console.log('-'.repeat(40));

    try {
        const result = await makeRequest({
            model: 'gemini-3-flash',
            max_tokens: 512,
            stream: false,
            system: 'You are a concise search assistant. Return ONLY factual results in 2-3 sentences with source URLs. No code, no filler.',
            thinking: { budget_tokens: 1 },
            tools: [{ name: 'google_search', input_schema: { type: 'object' } }],
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
        results.push({ name: 'Google Search grounding', passed });
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log('  Result: FAIL ✗');
        allPassed = false;
        results.push({ name: 'Google Search grounding', passed: false });
    }
    console.log('');

    // ===== TEST 2: Grounding with minimal thinking budget =====
    console.log('TEST 2: Grounding with minimal thinking budget (budget_tokens: 1)');
    console.log('-'.repeat(40));

    try {
        const start = Date.now();
        const result = await makeRequest({
            model: 'gemini-3-flash',
            max_tokens: 256,
            stream: false,
            thinking: { budget_tokens: 1 },
            tools: [{ name: 'google_search', input_schema: { type: 'object' } }],
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
        results.push({ name: 'Minimal thinking + grounding', passed });
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log('  Result: FAIL ✗');
        allPassed = false;
        results.push({ name: 'Minimal thinking + grounding', passed: false });
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

    // ===== TEST 4: google_search tool is not treated as a function declaration =====
    console.log('TEST 4: google_search tool is separated from function declarations');
    console.log('-'.repeat(40));

    try {
        // Send only google_search tool - should NOT return a tool_use call for "google_search"
        // because it should be converted to native grounding, not a function declaration
        const result = await makeRequest({
            model: 'gemini-3-flash',
            max_tokens: 512,
            stream: false,
            thinking: { budget_tokens: 1 },
            tools: [{ name: 'google_search', input_schema: { type: 'object' } }],
            messages: [
                { role: 'user', content: 'What is the latest news today?' }
            ]
        });

        // Should return text content (grounding result), not a tool_use block
        const hasText = result.content?.some(b => b.type === 'text' && b.text?.length > 10);
        const hasToolUse = result.content?.some(b => b.type === 'tool_use' && b.name === 'google_search');
        const passed = result.statusCode === 200 && hasText && !hasToolUse;

        const textBlock = result.content?.find(b => b.type === 'text');
        console.log(`  Status: ${result.statusCode}`);
        console.log(`  Has text content: ${hasText ? '✓' : '✗'}`);
        console.log(`  No google_search tool_use: ${!hasToolUse ? '✓' : '✗ (leaked as function call)'}`);
        console.log(`  Text preview: ${textBlock?.text?.substring(0, 120)}...`);
        console.log(`  Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`);

        if (!passed) allPassed = false;
        results.push({ name: 'Grounding not leaked as function call', passed });
    } catch (error) {
        console.log(`  Error: ${error.message}`);
        console.log('  Result: FAIL ✗');
        allPassed = false;
        results.push({ name: 'Grounding not leaked as function call', passed: false });
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
