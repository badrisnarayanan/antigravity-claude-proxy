import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'monitor.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Prepare statements cache
let insertStmt;
let getLogsStmt;
let getLogStmt;
let cleanupStmt;

// Initialize schema
function init() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS request_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            method TEXT NOT NULL,
            url TEXT NOT NULL,
            status INTEGER,
            duration INTEGER,
            request_body TEXT,
            response_body TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            model TEXT,
            error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp DESC);
    `);

    // Prepare statements
    insertStmt = db.prepare(`
        INSERT INTO request_logs (
            timestamp, method, url, status, duration,
            request_body, response_body, input_tokens, output_tokens, model, error
        ) VALUES (
            datetime('now'), @method, @url, @status, @duration,
            @request_body, @response_body, @input_tokens, @output_tokens, @model, @error
        )
    `);

    getLogsStmt = db.prepare(`
        SELECT * FROM request_logs
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
    `);

    getLogStmt = db.prepare('SELECT * FROM request_logs WHERE id = ?');

    cleanupStmt = db.prepare(`
        DELETE FROM request_logs
        WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    logger.info('[Monitor] Database initialized at ' + dbPath);
}

// Insert a log entry
function logRequest(data) {
    try {
        if (!insertStmt) init(); // Auto-init if not done, but preferably call init() at startup

        insertStmt.run({
            method: data.method,
            url: data.url,
            status: data.status,
            duration: data.duration,
            request_body: typeof data.request_body === 'string' ? data.request_body : JSON.stringify(data.request_body),
            response_body: typeof data.response_body === 'string' ? data.response_body : JSON.stringify(data.response_body),
            input_tokens: data.input_tokens || 0,
            output_tokens: data.output_tokens || 0,
            model: data.model || null,
            error: data.error || null
        });
    } catch (error) {
        logger.error('[Monitor] Failed to log request:', error);
    }
}

// Get logs with pagination and filtering
function getLogs(options = {}) {
    const { limit = 50, offset = 0 } = options;
    if (!getLogsStmt) init();
    return getLogsStmt.all(limit, offset);
}

// Get log by ID
function getLog(id) {
    if (!getLogStmt) init();
    return getLogStmt.get(id);
}

// Clean up old logs (optional, call periodically)
function cleanup(daysToKeep = 7) {
    if (!cleanupStmt) init();
    cleanupStmt.run(daysToKeep);
}

export default {
    init,
    logRequest,
    getLogs,
    getLog,
    cleanup
};
