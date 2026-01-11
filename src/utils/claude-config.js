/**
 * Claude CLI Configuration Utility
 *
 * Handles reading and writing to the global Claude CLI settings file.
 * Location: ~/.claude/settings.json (Windows: %USERPROFILE%\.claude\settings.json)
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

/**
 * Get the path to the global Claude CLI settings file
 * @returns {string} Absolute path to settings.json
 */
export function getClaudeConfigPath() {
    return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Read the global Claude CLI configuration
 * @returns {Promise<Object>} The configuration object or empty object if file missing
 */
export async function readClaudeConfig() {
    const configPath = getClaudeConfigPath();
    try {
        const content = await fs.readFile(configPath, 'utf8');
        if (!content.trim()) return { env: {} };
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(`[ClaudeConfig] Config file not found at ${configPath}, returning empty default`);
            return { env: {} };
        }
        if (error instanceof SyntaxError) {
            logger.error(`[ClaudeConfig] Invalid JSON in config at ${configPath}. Returning safe default.`);
            return { env: {} };
        }
        logger.error(`[ClaudeConfig] Failed to read config at ${configPath}:`, error.message);
        throw error;
    }
}

/**
 * Update the global Claude CLI configuration
 * Performs a deep merge with existing configuration to avoid losing other settings.
 *
 * @param {Object} updates - The partial configuration to merge in
 * @returns {Promise<Object>} The updated full configuration
 */
export async function updateClaudeConfig(updates) {
    const configPath = getClaudeConfigPath();
    let currentConfig = {};

    // 1. Read existing config
    try {
        currentConfig = await readClaudeConfig();
    } catch (error) {
        // Ignore ENOENT, otherwise rethrow
        if (error.code !== 'ENOENT') throw error;
    }

    // 2. Deep merge updates
    const newConfig = deepMerge(currentConfig, updates);

    // 3. Ensure .claude directory exists
    const configDir = path.dirname(configPath);
    try {
        await fs.mkdir(configDir, { recursive: true });
    } catch (error) {
        // Ignore if exists
    }

    // 4. Write back to file
    try {
        await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
        logger.info(`[ClaudeConfig] Updated config at ${configPath}`);
        return newConfig;
    } catch (error) {
        logger.error(`[ClaudeConfig] Failed to write config:`, error.message);
        throw error;
    }
}

/**
 * Replace the global Claude CLI configuration entirely
 * Unlike updateClaudeConfig, this replaces the config instead of merging.
 *
 * @param {Object} config - The new configuration to write
 * @returns {Promise<Object>} The written configuration
 */
export async function replaceClaudeConfig(config) {
    const configPath = getClaudeConfigPath();

    // 1. Ensure .claude directory exists
    const configDir = path.dirname(configPath);
    try {
        await fs.mkdir(configDir, { recursive: true });
    } catch (error) {
        // Ignore if exists
    }

    // 2. Write config directly (no merge)
    try {
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        logger.info(`[ClaudeConfig] Replaced config at ${configPath}`);
        return config;
    } catch (error) {
        logger.error(`[ClaudeConfig] Failed to write config:`, error.message);
        throw error;
    }
}

/**
 * Simple deep merge for objects
 */
function deepMerge(target, source) {
    const output = { ...target };

    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }

    return output;
}

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}
