#!/usr/bin/env node
/**
 * Test Runner
 *
 * Runs all tests in sequence and reports results.
 * Usage: node tests/run-all.cjs
 */
const { spawn } = require('child_process');
const path = require('path');

const tests = [
    { name: 'Thinking Signatures', file: 'test-thinking-signatures.cjs' },
    { name: 'Multi-turn Tools (Non-Streaming)', file: 'test-multiturn-thinking-tools.cjs' },
    { name: 'Multi-turn Tools (Streaming)', file: 'test-multiturn-thinking-tools-streaming.cjs' },
    { name: 'Interleaved Thinking', file: 'test-interleaved-thinking.cjs' },
    { name: 'Image Support', file: 'test-images.cjs' },
    { name: 'Prompt Caching', file: 'test-caching-streaming.cjs' }
];

async function runTest(test) {
    return new Promise((resolve) => {
        const testPath = path.join(__dirname, test.file);
        const child = spawn('node', [testPath], {
            stdio: 'inherit'
        });

        child.on('close', (code) => {
            resolve({ ...test, passed: code === 0 });
        });

        child.on('error', (err) => {
            console.error(`Error running ${test.name}:`, err);
            resolve({ ...test, passed: false });
        });
    });
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              ANTIGRAVITY PROXY TEST SUITE                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    const port = process.env.PORT || 8080;
    console.log(`Make sure the server is running on port ${port} before running tests.`);
    console.log('');

    // Check if running specific test
    const specificTest = process.argv[2];
    let testsToRun = tests;

    if (specificTest) {
        testsToRun = tests.filter(t =>
            t.file.includes(specificTest) || t.name.toLowerCase().includes(specificTest.toLowerCase())
        );
        if (testsToRun.length === 0) {
            console.log(`No test found matching: ${specificTest}`);
            console.log('\nAvailable tests:');
            tests.forEach(t => console.log(`  - ${t.name} (${t.file})`));
            process.exit(1);
        }
    }

    const results = [];

    for (const test of testsToRun) {
        console.log('\n');
        console.log('╔' + '═'.repeat(60) + '╗');
        console.log('║ Running: ' + test.name.padEnd(50) + '║');
        console.log('╚' + '═'.repeat(60) + '╝');
        console.log('');

        const result = await runTest(test);
        results.push(result);

        console.log('\n');
    }

    // Summary
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                      FINAL RESULTS                           ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');

    let allPassed = true;
    for (const result of results) {
        const status = result.passed ? '✓ PASS' : '✗ FAIL';
        const statusColor = result.passed ? '' : '';
        console.log(`║ ${status.padEnd(8)} ${result.name.padEnd(50)} ║`);
        if (!result.passed) allPassed = false;
    }

    console.log('╠══════════════════════════════════════════════════════════════╣');
    const overallStatus = allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED';
    console.log(`║ ${overallStatus.padEnd(60)} ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
