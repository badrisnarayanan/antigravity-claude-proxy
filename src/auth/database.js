/**
 * SQLite Database Access Module
 * Provides cross-platform database operations for Antigravity state.
 *
 * Uses better-sqlite3 for:
 * - Windows compatibility (no CLI dependency)
 * - Native performance
 * - Synchronous API (simple error handling)
 *
 * Includes auto-rebuild capability for handling Node.js version updates
 * that cause native module incompatibility.
 */

import { createRequire } from 'module';
import { ANTIGRAVITY_DB_PATH } from '../constants.js';
import { isModuleVersionError, attemptAutoRebuild, clearRequireCache } from '../utils/native-module-helper.js';
import { logger } from '../utils/logger.js';
import { NativeModuleError } from '../errors.js';

const require = createRequire(import.meta.url);

// Lazy-loaded Database constructor
let Database = null;
let moduleLoadError = null;

// Connection cache
const dbCache = new Map();

/**
 * Load the better-sqlite3 module with auto-rebuild on version mismatch
 * Uses synchronous require to maintain API compatibility
 * @returns {Function} The Database constructor
 * @throws {Error} If module cannot be loaded even after rebuild
 */
let loadDatabaseModule = function() {
    // Return cached module if already loaded
    if (Database) return Database;

    // Re-throw cached error if previous load failed permanently
    if (moduleLoadError) throw moduleLoadError;

    try {
        Database = require('better-sqlite3');
        // Optimize: replace this function with one that simply returns the module
        loadDatabaseModule = () => Database;
        return Database;
    } catch (error) {
        if (isModuleVersionError(error)) {
            logger.warn('[Database] Native module version mismatch detected');

            if (attemptAutoRebuild(error)) {
                // Clear require cache and retry
                try {
                    const resolvedPath = require.resolve('better-sqlite3');
                    // Clear the module and all its dependencies from cache
                    clearRequireCache(resolvedPath, require.cache);

                    Database = require('better-sqlite3');
                    logger.success('[Database] Module reloaded successfully after rebuild');
                    // Optimize here as well
                    loadDatabaseModule = () => Database;
                    return Database;
                } catch (retryError) {
                    // Rebuild succeeded but reload failed - user needs to restart
                    moduleLoadError = new NativeModuleError(
                        'Native module rebuild completed. Please restart the server to apply the fix.',
                        true,  // rebuildSucceeded
                        true   // restartRequired
                    );
                    logger.info('[Database] Rebuild succeeded - server restart required');
                    throw moduleLoadError;
                }
            } else {
                moduleLoadError = new NativeModuleError(
                    'Failed to auto-rebuild native module. Please run manually:\n' +
                    '  npm rebuild better-sqlite3\n' +
                    'Or if using npx, find the package location in the error and run:\n' +
                    '  cd /path/to/better-sqlite3 && npm rebuild',
                    false,  // rebuildSucceeded
                    false   // restartRequired
                );
                throw moduleLoadError;
            }
        }

        // Non-version-mismatch error, just throw it
        throw error;
    }
};

/**
 * Get a cached database connection or create a new one
 * @param {string} dbPath - Path to the database file
 * @returns {Object} Database connection instance
 */
function getDatabaseConnection(dbPath) {
    const Db = loadDatabaseModule();

    // Check if we have a cached connection
    if (dbCache.has(dbPath)) {
        const cachedDb = dbCache.get(dbPath);
        if (cachedDb.open) {
            return cachedDb;
        }
        // Remove closed connection from cache
        dbCache.delete(dbPath);
    }

    // Create new connection
    const db = new Db(dbPath, {
        readonly: true,
        fileMustExist: true
    });

    // Cache the new connection
    dbCache.set(dbPath, db);
    return db;
}

/**
 * Query Antigravity database for authentication status
 * @param {string} [dbPath] - Optional custom database path
 * @returns {Object} Parsed auth data with apiKey, email, name, etc.
 * @throws {Error} If database doesn't exist, query fails, or no auth status found
 */
export function getAuthStatus(dbPath = ANTIGRAVITY_DB_PATH) {
    try {
        // Get cached or new database connection
        const db = getDatabaseConnection(dbPath);

        // Prepare and execute query (using cached statement if available)
        if (!db._cachedAuthStmt) {
            db._cachedAuthStmt = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"
            );
        }
        const row = db._cachedAuthStmt.get();

        if (!row || !row.value) {
            throw new Error('No auth status found in database');
        }

        // Parse JSON value
        const authData = JSON.parse(row.value);

        if (!authData.apiKey) {
            throw new Error('Auth data missing apiKey field');
        }

        return authData;
    } catch (error) {
        // Enhance error messages for common issues
        if (error.code === 'SQLITE_CANTOPEN') {
            throw new Error(
                `Database not found at ${dbPath}. ` +
                'Make sure Antigravity is installed and you are logged in.'
            );
        }
        // Re-throw with context if not already our error
        if (error.message.includes('No auth status') || error.message.includes('missing apiKey')) {
            throw error;
        }
        // Re-throw native module errors from loadDatabaseModule without wrapping
        if (error instanceof NativeModuleError) {
            throw error;
        }
        throw new Error(`Failed to read Antigravity database: ${error.message}`);
    }
    // No finally block needed as we keep connections open
}

/**
 * Check if database exists and is accessible
 * @param {string} [dbPath] - Optional custom database path
 * @returns {boolean} True if database exists and can be opened
 */
export function isDatabaseAccessible(dbPath = ANTIGRAVITY_DB_PATH) {
    try {
        getDatabaseConnection(dbPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Close all cached database connections
 * Useful for cleanup or testing
 */
export function closeAllConnections() {
    for (const [path, db] of dbCache.entries()) {
        try {
            if (db.open) {
                db.close();
            }
        } catch (e) {
            console.error(`Error closing database ${path}:`, e);
        }
    }
    dbCache.clear();
}

export default {
    getAuthStatus,
    isDatabaseAccessible,
    closeAllConnections
};
