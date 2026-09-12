/**
 * Environment Variables Loader
 * 
 * Loads environment variables from .env file into process.env.
 * Should be imported at the very beginning of application entry points
 * before other modules read process.env.
 */

import fs from 'fs';
import path from 'path';

/**
 * Load environment variables from .env file
 * @param {string} [envPath] - Path to .env file (defaults to .env in cwd)
 */
export function loadEnv(envPath) {
    const filePath = envPath || path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(filePath)) {
        return;
    }

    // Use native Node.js loader if available (Node 20.12+)
    if (typeof process.loadEnvFile === 'function') {
        try {
            process.loadEnvFile(filePath);
            return;
        } catch (err) {
            if (err.code === 'ENOENT') return;
            // Fall back to manual parsing if loadEnvFile failed on format
        }
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;
            const key = trimmed.slice(0, eqIndex).trim();
            let value = trimmed.slice(eqIndex + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    } catch {
        // Ignore read errors
    }
}

// Auto-load on import
loadEnv();
