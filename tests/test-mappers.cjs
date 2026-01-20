const { test } = require('node:test');
const assert = require('node:assert');

test('Mappers - coerceToBool', async (t) => {
    const { coerceToBool } = await import('../src/utils/mappers.js');

    await t.test('handles boolean inputs', () => {
        assert.strictEqual(coerceToBool(true), true);
        assert.strictEqual(coerceToBool(false), false);
    });

    await t.test('handles string inputs', () => {
        assert.strictEqual(coerceToBool('true'), true);
        assert.strictEqual(coerceToBool('yes'), true);
        assert.strictEqual(coerceToBool('1'), true);
        assert.strictEqual(coerceToBool('-n'), true);
        assert.strictEqual(coerceToBool('TRUE'), true); // case insensitive

        assert.strictEqual(coerceToBool('false'), false);
        assert.strictEqual(coerceToBool('no'), false);
        assert.strictEqual(coerceToBool('0'), false);
        assert.strictEqual(coerceToBool('FALSE'), false);

        assert.strictEqual(coerceToBool('random'), null);
    });

    await t.test('handles number inputs', () => {
        assert.strictEqual(coerceToBool(1), true);
        assert.strictEqual(coerceToBool(100), true);
        assert.strictEqual(coerceToBool(0), false);
    });
});

test('Mappers - remapFunctionCallArgs', async (t) => {
    const { remapFunctionCallArgs } = await import('../src/utils/mappers.js');

    await t.test('Grep: remapping description to pattern', () => {
        const args = { description: 'test pattern' };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.pattern, 'test pattern');
        assert.strictEqual(args.description, undefined);
    });

    await t.test('Grep: remapping query to pattern', () => {
        const args = { query: 'test pattern' };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.pattern, 'test pattern');
        assert.strictEqual(args.query, undefined);
    });

    await t.test('Grep: remapping includes (array) to include (string)', () => {
        const args = { includes: ['*.js', '*.ts'] };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.include, '*.js,*.ts');
        assert.strictEqual(args.includes, undefined);
    });

    await t.test('Grep: remapping includes (string) to include (string)', () => {
        const args = { includes: '*.js' };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.include, '*.js');
        assert.strictEqual(args.includes, undefined);
    });

    await t.test('Grep: remapping ignore_case to ignoreCase', () => {
        const args = { ignore_case: true };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.ignoreCase, true);
        assert.strictEqual(args.ignore_case, undefined);
    });

    await t.test('Grep: remapping -n to lineNumbers', () => {
        const args = { '-n': 'true' };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.lineNumbers, true);
        assert.strictEqual(args['-n'], undefined);
    });

    await t.test('Grep: coercing boolean params from string', () => {
        const args = {
            ignoreCase: 'true',
            lineNumbers: 'yes',
            caseSensitive: 'false',
            regex: '1',
            wholeWord: 'no'
        };
        remapFunctionCallArgs('grep', args);
        assert.strictEqual(args.ignoreCase, true);
        assert.strictEqual(args.lineNumbers, true);
        assert.strictEqual(args.caseSensitive, false);
        assert.strictEqual(args.regex, true);
        assert.strictEqual(args.wholeWord, false);
    });

    await t.test('Glob: remapping description to pattern', () => {
        const args = { description: '*.js' };
        remapFunctionCallArgs('glob', args);
        assert.strictEqual(args.pattern, '*.js');
        assert.strictEqual(args.description, undefined);
    });

    await t.test('Glob: remapping query to pattern', () => {
        const args = { query: '*.js' };
        remapFunctionCallArgs('glob', args);
        assert.strictEqual(args.pattern, '*.js');
        assert.strictEqual(args.query, undefined);
    });

    await t.test('Ignores unknown tools', () => {
        const args = { description: 'test' };
        remapFunctionCallArgs('unknown_tool', args);
        assert.strictEqual(args.description, 'test');
        assert.strictEqual(args.pattern, undefined);
    });
});
