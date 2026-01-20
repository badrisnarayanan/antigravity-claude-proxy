
const fs = require('fs');
const path = require('path');
// better-sqlite3 can be required in CJS
const Database = require('better-sqlite3');

const TEST_DB_PATH = './test-database.vscdb';

function setupDb() {
    if (fs.existsSync(TEST_DB_PATH)) {
        try {
            fs.unlinkSync(TEST_DB_PATH);
        } catch (e) {
            // Ignore if busy
        }
    }

    const db = new Database(TEST_DB_PATH);
    db.exec(`
        CREATE TABLE ItemTable (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    const authData = {
        apiKey: 'test-api-key',
        email: 'test@example.com',
        name: 'Test User'
    };

    const stmt = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    stmt.run('antigravityAuthStatus', JSON.stringify(authData));

    db.close();
    return authData;
}

function cleanupDb(closeAllConnections) {
    if (closeAllConnections) {
        closeAllConnections();
    }
    if (fs.existsSync(TEST_DB_PATH)) {
        try {
            fs.unlinkSync(TEST_DB_PATH);
        } catch (e) {
            console.error('Failed to cleanup test DB:', e);
        }
    }
}

async function runTests() {
    console.log('Running Database Module Tests...');

    // Dynamic import for ESM module
    const { getAuthStatus, isDatabaseAccessible, closeAllConnections } = await import('../src/auth/database.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.error(e);
            failed++;
        }
    }

    try {
        const expectedAuthData = setupDb();

        test('isDatabaseAccessible returns true for valid DB', () => {
            if (!isDatabaseAccessible(TEST_DB_PATH)) {
                throw new Error('Expected isDatabaseAccessible to return true');
            }
        });

        test('getAuthStatus returns correct data', () => {
            const data = getAuthStatus(TEST_DB_PATH);
            if (data.apiKey !== expectedAuthData.apiKey) throw new Error('ApiKey mismatch');
            if (data.email !== expectedAuthData.email) throw new Error('Email mismatch');
        });

        test('getAuthStatus uses cached connection (multiple calls)', () => {
            for (let i = 0; i < 10; i++) {
                const data = getAuthStatus(TEST_DB_PATH);
                if (data.apiKey !== expectedAuthData.apiKey) throw new Error(`Mismatch at iter ${i}`);
            }
        });

        test('isDatabaseAccessible returns false for non-existent DB', () => {
            if (isDatabaseAccessible('./non-existent.db')) {
                throw new Error('Expected isDatabaseAccessible to return false');
            }
        });

        test('getAuthStatus throws for non-existent DB', () => {
            try {
                getAuthStatus('./non-existent.db');
                throw new Error('Should have thrown');
            } catch (e) {
                if (!e.message.includes('Database not found')) {
                    throw new Error(`Unexpected error message: ${e.message}`);
                }
            }
        });

        // Clean up connections before deleting file
        cleanupDb(closeAllConnections);

    } catch (e) {
        console.error('Test suite error:', e);
        failed++;
        // Try cleanup anyway
        try {
             const { closeAllConnections } = await import('../src/auth/database.js');
             cleanupDb(closeAllConnections);
        } catch(err) {}
    }

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests();
