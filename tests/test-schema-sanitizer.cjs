/**
 * Test Schema Sanitizer - Tests for schema transformation for Google API
 * 
 * Verifies that complex nested array schemas are properly converted to 
 * Google's protobuf format (uppercase type names) to fix issue #82:
 * "Proto field is not repeating, cannot start list"
 */

// Import the schema sanitizer functions
const path = require('path');

// Since we're in CommonJS and the module is ESM, we need to use dynamic import
async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           SCHEMA SANITIZER TEST SUITE                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const { sanitizeSchema, cleanSchema } = await import('../src/format/schema-sanitizer.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    function assertIncludes(actual, substring, message = '') {
        if (!JSON.stringify(actual).includes(substring)) {
            throw new Error(`${message}\nExpected to include: ${substring}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    // Test 1: Basic type conversion to uppercase
    test('Basic type conversion to uppercase', () => {
        const schema = { type: 'string', description: 'A test string' };
        const result = cleanSchema(sanitizeSchema(schema));
        assertEqual(result.type, 'STRING', 'Type should be uppercase STRING');
    });

    // Test 2: Object type conversion
    test('Object type conversion', () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                age: { type: 'integer' }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        assertEqual(result.type, 'OBJECT', 'Object type should be uppercase');
        assertEqual(result.properties.name.type, 'STRING', 'Nested string type should be uppercase');
        assertEqual(result.properties.age.type, 'INTEGER', 'Nested integer type should be uppercase');
    });

    // Test 3: Array type conversion (the main bug fix)
    test('Array type conversion with items', () => {
        const schema = {
            type: 'array',
            items: {
                type: 'string'
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        assertEqual(result.type, 'ARRAY', 'Array type should be uppercase ARRAY');
        assertEqual(result.items.type, 'STRING', 'Items type should be uppercase STRING');
    });

    // Test 4: Nested array inside object (the actual bug scenario)
    test('Nested array inside object (Claude Code TodoWrite-style schema)', () => {
        const schema = {
            type: 'object',
            properties: {
                todos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'integer' },
                            title: { type: 'string' },
                            status: { type: 'string' }
                        }
                    }
                }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.type, 'OBJECT', 'Root type should be OBJECT');
        assertEqual(result.properties.todos.type, 'ARRAY', 'Todos type should be ARRAY');
        assertEqual(result.properties.todos.items.type, 'OBJECT', 'Items type should be OBJECT');
        assertEqual(result.properties.todos.items.properties.id.type, 'INTEGER', 'id type should be INTEGER');
        assertEqual(result.properties.todos.items.properties.title.type, 'STRING', 'title type should be STRING');
    });

    // Test 5: Complex nested structure (simulating Claude Code tools)
    test('Complex nested structure with multiple array levels', () => {
        const schema = {
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            subtasks: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        step: { type: 'string' },
                                        completed: { type: 'boolean' }
                                    }
                                }
                            }
                        }
                    }
                },
                count: { type: 'number' }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.tasks.type, 'ARRAY');
        assertEqual(result.properties.tasks.items.type, 'OBJECT');
        assertEqual(result.properties.tasks.items.properties.subtasks.type, 'ARRAY');
        assertEqual(result.properties.tasks.items.properties.subtasks.items.type, 'OBJECT');
        assertEqual(result.properties.tasks.items.properties.subtasks.items.properties.completed.type, 'BOOLEAN');
        assertEqual(result.properties.count.type, 'NUMBER');
    });

    // Test 6: cleanSchema handles anyOf (when not stripped by sanitizeSchema)
    test('cleanSchema handles anyOf and converts types', () => {
        // Test cleanSchema directly with anyOf (bypassing sanitizeSchema)
        const schema = {
            type: 'object',
            properties: {
                value: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'object', properties: { name: { type: 'string' } } }
                    ]
                }
            }
        };
        const result = cleanSchema(schema);
        
        assertEqual(result.type, 'OBJECT');
        // anyOf gets flattened to best option (object type scores highest)
        assertEqual(result.properties.value.type, 'OBJECT');
    });

    // Test 7: Schema with type array (nullable)
    test('Schema with type array (nullable) gets flattened and converted', () => {
        const schema = {
            type: 'object',
            properties: {
                optional: {
                    type: ['string', 'null']
                }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.optional.type, 'STRING');
    });

    // Test 8: All primitive types
    test('All primitive types converted correctly', () => {
        const schema = {
            type: 'object',
            properties: {
                str: { type: 'string' },
                num: { type: 'number' },
                int: { type: 'integer' },
                bool: { type: 'boolean' },
                arr: { type: 'array', items: { type: 'string' } },
                obj: { type: 'object', properties: { x: { type: 'string' } } }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));
        
        assertEqual(result.properties.str.type, 'STRING');
        assertEqual(result.properties.num.type, 'NUMBER');
        assertEqual(result.properties.int.type, 'INTEGER');
        assertEqual(result.properties.bool.type, 'BOOLEAN');
        assertEqual(result.properties.arr.type, 'ARRAY');
        assertEqual(result.properties.obj.type, 'OBJECT');
    });

    // Test 9: Empty schema gets placeholder with correct types
    test('Empty schema gets placeholder with uppercase types', () => {
        const result = cleanSchema(sanitizeSchema(null));
        
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.reason.type, 'STRING');
    });

    // Test 10: Real-world Claude Code tool schema simulation
    test('Real-world Claude Code ManageTodoList-style schema', () => {
        // Simulates the type of schema that caused issue #82
        const schema = {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['write', 'read']
                },
                todoList: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number' },
                            title: { type: 'string' },
                            status: {
                                type: 'string',
                                enum: ['not-started', 'in-progress', 'completed']
                            }
                        },
                        required: ['id', 'title', 'status']
                    }
                }
            },
            required: ['operation']
        };
        
        const result = cleanSchema(sanitizeSchema(schema));
        
        // Verify all types are uppercase
        assertEqual(result.type, 'OBJECT');
        assertEqual(result.properties.operation.type, 'STRING');
        assertEqual(result.properties.todoList.type, 'ARRAY');
        assertEqual(result.properties.todoList.items.type, 'OBJECT');
        assertEqual(result.properties.todoList.items.properties.id.type, 'NUMBER');
        assertEqual(result.properties.todoList.items.properties.title.type, 'STRING');
        assertEqual(result.properties.todoList.items.properties.status.type, 'STRING');
    });

    // Structural invariant: every schema node produced by cleanSchema must be
    // valid for Google's protobuf-based Schema format - specifically, every
    // ARRAY must carry exactly one object `items` schema, every type must be
    // one of Google's uppercase names, and only OBJECT nodes may carry
    // `properties`/`required`. Used by the tests below instead of asserting
    // one invented shape, so it catches any cause that produces the same
    // class of invalid payload (not just the literal repro schema).
    function assertGoogleSchemaValid(node, path = '$') {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ARRAY' && (!node.items || typeof node.items !== 'object' || Array.isArray(node.items))) {
            throw new Error(`${path}: ARRAY without a single object items (got ${JSON.stringify(node.items)})`);
        }
        if (node.type && !['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT'].includes(node.type)) {
            throw new Error(`${path}: non-Google type ${node.type}`);
        }
        if (node.type !== 'OBJECT' && (node.properties || node.required)) {
            throw new Error(`${path}: non-OBJECT node carries properties/required`);
        }
        if (node.items) assertGoogleSchemaValid(node.items, `${path}.items`);
        for (const [k, v] of Object.entries(node.properties || {})) {
            assertGoogleSchemaValid(v, `${path}.properties[${k}]`);
        }
    }

    // Test 11: Array missing `items` gets a fallback (issue #368)
    test('Bare array type without items gets a fallback items schema', () => {
        const schema = { type: 'array' };
        const result = cleanSchema(sanitizeSchema(schema));

        assertEqual(result.type, 'ARRAY', 'Type should be ARRAY');
        assertEqual(result.items, { type: 'STRING' }, 'Missing items should fall back to STRING');
    });

    // Test 12: Nested array-of-array where the innermost items is omitted (issue #368)
    // Reproduces "properties[where].items.items: missing field" from the Google API.
    test('Nested array-of-array with missing innermost items (issue #368)', () => {
        const schema = {
            type: 'object',
            properties: {
                query: {
                    type: 'object',
                    properties: {
                        where: {
                            type: 'array',
                            items: { type: 'array' } // innermost items intentionally omitted
                        }
                    }
                }
            }
        };
        const result = cleanSchema(sanitizeSchema(schema));

        const where = result.properties.query.properties.where;
        assertEqual(where.type, 'ARRAY', 'where should be ARRAY');
        assertEqual(where.items.type, 'ARRAY', 'where.items should be ARRAY');
        assertEqual(where.items.items, { type: 'STRING' }, 'where.items.items should fall back to STRING, not be missing');
        assertGoogleSchemaValid(result);
    });

    // Test 13: `items: true` (boolean/"any" schema) is normalized to an object (issue #368)
    test('Boolean items schema is normalized to an object', () => {
        const schema = { type: 'array', items: true };
        const result = cleanSchema(schema); // bypass sanitizeSchema's allowlist to hit cleanSchema directly
        assertEqual(result.type, 'ARRAY');
        assertEqual(typeof result.items, 'object', 'items should be normalized to an object, not left as boolean');
        assertGoogleSchemaValid(result);
    });

    // Test 14: Tuple-form `items: [...]` is collapsed to a single schema (issue #368)
    test('Tuple-form items array is collapsed to one representative schema', () => {
        const schema = {
            type: 'array',
            items: [{ type: 'string' }, { type: 'object', properties: { x: { type: 'string' } } }]
        };
        const result = cleanSchema(schema);
        assertEqual(result.type, 'ARRAY');
        assertEqual(Array.isArray(result.items), false, 'items should be collapsed to a single schema, not an array');
        assertGoogleSchemaValid(result);
    });

    // Test 15: Full suite of prior schemas still satisfies the structural invariant
    test('All prior real-world schemas satisfy the Google schema invariant', () => {
        const schema = {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['write', 'read'] },
                todoList: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number' },
                            title: { type: 'string' },
                            status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'] }
                        },
                        required: ['id', 'title', 'status']
                    }
                }
            },
            required: ['operation']
        };
        assertGoogleSchemaValid(cleanSchema(sanitizeSchema(schema)));
    });

    // Summary
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
