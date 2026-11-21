/**
 * Test Stop Sequences - Verifies stop_sequences and extraStopSequences handling
 *
 * Tests that convertAnthropicToGoogle merges client stop_sequences with
 * config.extraStopSequences, removes empty strings and duplicates, caps at
 * Gemini's 5-sequence limit (client entries first, logging a warning when
 * entries are dropped), and leaves generationConfig.stopSequences unset when
 * neither is given.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               STOP SEQUENCES TEST SUITE                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    const { buildCloudCodeRequest } = await import('../src/cloudcode/request-builder.js');
    const { config } = await import('../src/config.js');
    const { logger } = await import('../src/utils/logger.js');

    const originalExtraStopSequences = config.extraStopSequences;
    const originalWarn = logger.warn.bind(logger);

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        const warnings = [];
        config.extraStopSequences = [];
        logger.warn = (...args) => {
            warnings.push(args.join(' '));
        };
        try {
            fn(warnings);
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        } finally {
            logger.warn = originalWarn;
            config.extraStopSequences = originalExtraStopSequences;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
                `${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`
            );
        }
    }

    function assert(cond, message) {
        if (!cond) throw new Error(message);
    }

    function convert(overrides = {}) {
        return convertAnthropicToGoogle({
            model: 'gemini-3.8-flash-low',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
            ...overrides
        });
    }

    test('No client stop_sequences and empty extraStopSequences leaves stopSequences unset', (warnings) => {
        const result = convert();
        assert(!('stopSequences' in result.generationConfig), `expected stopSequences to be unset, got ${JSON.stringify(result.generationConfig.stopSequences)}`);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('Client stop_sequences are forwarded to generationConfig.stopSequences', (warnings) => {
        const result = convert({ stop_sequences: ['beta', 'gamma'] });
        assertEqual(result.generationConfig.stopSequences, ['beta', 'gamma']);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('extraStopSequences are used when client sends no stop_sequences', (warnings) => {
        config.extraStopSequences = ['\nuser\n<system-reminder>'];
        const result = convert();
        assertEqual(result.generationConfig.stopSequences, ['\nuser\n<system-reminder>']);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('extraStopSequences are appended after client stop_sequences', (warnings) => {
        config.extraStopSequences = ['\nuser\n<system-reminder>', 'END'];
        const result = convert({ stop_sequences: ['alpha', 'beta'] });
        assertEqual(result.generationConfig.stopSequences, ['alpha', 'beta', '\nuser\n<system-reminder>', 'END']);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('Duplicate stop sequences are removed across and within lists', (warnings) => {
        config.extraStopSequences = ['beta', 'gamma', 'gamma'];
        const result = convert({ stop_sequences: ['alpha', 'alpha', 'beta'] });
        assertEqual(result.generationConfig.stopSequences, ['alpha', 'beta', 'gamma']);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('Empty strings are removed from client and extra stop sequences', (warnings) => {
        config.extraStopSequences = ['', 'extra', ''];
        const result = convert({ stop_sequences: ['', 'client', ''] });
        assertEqual(result.generationConfig.stopSequences, ['client', 'extra']);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('All-empty stop sequences leave generationConfig.stopSequences unset', (warnings) => {
        config.extraStopSequences = ['', ''];
        const result = convert({ stop_sequences: [''] });
        assert(!('stopSequences' in result.generationConfig), `expected stopSequences to be unset, got ${JSON.stringify(result.generationConfig.stopSequences)}`);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    test('Merged list is capped at 5 with client entries first and warns when entries are dropped', (warnings) => {
        config.extraStopSequences = ['e1', 'e2', 'e3'];
        const result = convert({ stop_sequences: ['c1', 'c2', 'c3', 'c4'] });
        assertEqual(result.generationConfig.stopSequences, ['c1', 'c2', 'c3', 'c4', 'e1']);
        assertEqual(warnings.length, 1, 'should warn once when dropping entries');
        assert(warnings[0].includes('e2') && warnings[0].includes('e3'), `warning should mention dropped entries, got: ${warnings[0]}`);
    });

    test('Deduplication runs before the 5-entry cap', (warnings) => {
        config.extraStopSequences = ['c1', 'c2', 'e1'];
        const result = convert({ stop_sequences: ['c1', 'c2', 'c3', 'c4'] });
        assertEqual(result.generationConfig.stopSequences, ['c1', 'c2', 'c3', 'c4', 'e1']);
        assertEqual(warnings.length, 0, 'should not warn when deduplicated count is <= 5');
    });

    test('More than 5 client stop_sequences are capped at 5 with a warning', (warnings) => {
        config.extraStopSequences = ['e1'];
        const result = convert({ stop_sequences: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] });
        assertEqual(result.generationConfig.stopSequences, ['c1', 'c2', 'c3', 'c4', 'c5']);
        assertEqual(warnings.length, 1, 'should warn once when dropping entries');
        assert(warnings[0].includes('c6') && warnings[0].includes('e1'), `warning should mention dropped entries, got: ${warnings[0]}`);
    });

    test('buildCloudCodeRequest preserves merged stopSequences in generationConfig', (warnings) => {
        config.extraStopSequences = ['\nuser\n<system-reminder>'];
        const payload = buildCloudCodeRequest(
            {
                model: 'gemini-3.8-flash-low',
                max_tokens: 64,
                messages: [{ role: 'user', content: 'hi' }],
                stop_sequences: ['beta']
            },
            'project-id',
            'test@example.com'
        );
        assertEqual(payload.request.generationConfig.stopSequences, ['beta', '\nuser\n<system-reminder>']);
        assertEqual(warnings.length, 0, 'should not warn');
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
