/**
 * Server Configuration Presets Utility
 *
 * Handles reading and writing server config presets.
 * Location: ~/.config/antigravity-proxy/server-presets.json
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';
import { DEFAULT_SERVER_PRESETS } from '../constants.js';

/**
 * Get the path to the server presets file
 * @returns {string} Absolute path to server-presets.json
 */
export function getServerPresetsPath() {
    return path.join(os.homedir(), '.config', 'antigravity-proxy', 'server-presets.json');
}

/**
 * Read all server config presets.
 * Creates the file with default presets if it doesn't exist.
 * @returns {Promise<Array>} Array of preset objects
 */
export async function readServerPresets() {
    const presetsPath = getServerPresetsPath();
    try {
        const content = await fs.readFile(presetsPath, 'utf8');
        if (!content.trim()) return DEFAULT_SERVER_PRESETS;
        const userPresets = JSON.parse(content);
        // Merge: always include built-in presets (latest version), then user custom presets
        const builtInNames = new Set(DEFAULT_SERVER_PRESETS.map(p => p.name));
        const customPresets = userPresets.filter(p => !builtInNames.has(p.name) && !p.builtIn);
        return [...DEFAULT_SERVER_PRESETS, ...customPresets];
    } catch (error) {
        if (error.code === 'ENOENT') {
            try {
                await fs.mkdir(path.dirname(presetsPath), { recursive: true });
                await fs.writeFile(presetsPath, JSON.stringify(DEFAULT_SERVER_PRESETS, null, 2), 'utf8');
                logger.info(`[ServerPresets] Created presets file with defaults at ${presetsPath}`);
            } catch (writeError) {
                logger.warn(`[ServerPresets] Could not create presets file: ${writeError.message}`);
            }
            return DEFAULT_SERVER_PRESETS;
        }
        if (error instanceof SyntaxError) {
            logger.error(`[ServerPresets] Invalid JSON in presets at ${presetsPath}. Returning defaults.`);
            return DEFAULT_SERVER_PRESETS;
        }
        logger.error(`[ServerPresets] Failed to read presets at ${presetsPath}:`, error.message);
        throw error;
    }
}

/**
 * Save a custom server preset (add or update).
 * Rejects overwriting built-in presets.
 * @param {string} name - Preset name
 * @param {Object} config - Server configuration values
 * @param {string} [description] - Optional user description
 * @returns {Promise<Array>} Updated array of all presets
 */
export async function saveServerPreset(name, config, description) {
    // Reject overwriting built-in presets
    const builtInNames = new Set(DEFAULT_SERVER_PRESETS.map(p => p.name));
    if (builtInNames.has(name)) {
        throw new Error(`Cannot overwrite built-in preset "${name}"`);
    }

    const presetsPath = getServerPresetsPath();
    let allPresets = await readServerPresets();

    // Find or create user custom preset
    const existingIndex = allPresets.findIndex(p => p.name === name && !p.builtIn);
    const newPreset = { name, config: { ...config } };
    if (description && typeof description === 'string' && description.trim()) {
        newPreset.description = description.trim();
    }

    if (existingIndex >= 0) {
        allPresets[existingIndex] = newPreset;
        logger.info(`[ServerPresets] Updated preset: ${name}`);
    } else {
        allPresets.push(newPreset);
        logger.info(`[ServerPresets] Created preset: ${name}`);
    }

    try {
        await fs.mkdir(path.dirname(presetsPath), { recursive: true });
        await fs.writeFile(presetsPath, JSON.stringify(allPresets, null, 2), 'utf8');
    } catch (error) {
        logger.error(`[ServerPresets] Failed to save preset:`, error.message);
        throw error;
    }

    return allPresets;
}

/**
 * Update metadata (name, description) of a custom server preset.
 * Rejects editing built-in presets.
 * @param {string} currentName - Current preset name
 * @param {Object} updates - Fields to update ({ name, description })
 * @returns {Promise<Array>} Updated array of all presets
 */
export async function updateServerPreset(currentName, updates) {
    const builtInNames = new Set(DEFAULT_SERVER_PRESETS.map(p => p.name));
    if (builtInNames.has(currentName)) {
        throw new Error(`Cannot edit built-in preset "${currentName}"`);
    }

    const presetsPath = getServerPresetsPath();
    let allPresets = await readServerPresets();

    const index = allPresets.findIndex(p => p.name === currentName && !p.builtIn);
    if (index < 0) {
        throw new Error(`Preset "${currentName}" not found`);
    }

    // Check new name doesn't collide with a built-in
    if (updates.name && builtInNames.has(updates.name)) {
        throw new Error(`Cannot use built-in preset name "${updates.name}"`);
    }

    // Check new name doesn't collide with another custom preset
    if (updates.name && updates.name !== currentName) {
        const conflict = allPresets.findIndex(p => p.name === updates.name && !p.builtIn);
        if (conflict >= 0) {
            throw new Error(`A preset named "${updates.name}" already exists`);
        }
    }

    if (updates.name) {
        allPresets[index].name = updates.name.trim();
    }
    if (updates.description !== undefined) {
        if (updates.description && updates.description.trim()) {
            allPresets[index].description = updates.description.trim();
        } else {
            delete allPresets[index].description;
        }
    }

    // Merge config updates if provided
    if (updates.config && typeof updates.config === 'object') {
        const allowedKeys = [
            'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs',
            'maxWaitBeforeErrorMs', 'maxAccounts', 'globalQuotaThreshold',
            'rateLimitDedupWindowMs', 'maxConsecutiveFailures', 'extendedCooldownMs',
            'maxCapacityRetries', 'switchAccountDelayMs', 'capacityBackoffTiersMs',
            'accountSelection'
        ];
        const existing = allPresets[index].config || {};
        for (const key of allowedKeys) {
            if (updates.config[key] !== undefined) {
                if (key === 'accountSelection') {
                    const updateAS = updates.config.accountSelection;
                    if (!updateAS || typeof updateAS !== 'object') continue;
                    // Deep merge accountSelection sub-objects to preserve fields not in partial update
                    const existingAS = existing.accountSelection || {};
                    existing.accountSelection = { ...existingAS };
                    if (updateAS.strategy !== undefined) existing.accountSelection.strategy = updateAS.strategy;
                    for (const subKey of ['healthScore', 'tokenBucket', 'quota', 'weights']) {
                        if (updateAS[subKey] && typeof updateAS[subKey] === 'object') {
                            existing.accountSelection[subKey] = { ...existingAS[subKey], ...updateAS[subKey] };
                        }
                    }
                } else {
                    existing[key] = updates.config[key];
                }
            }
        }
        allPresets[index].config = existing;
    }

    const hasConfigChange = updates.config && Object.keys(updates.config).length > 0;
    const hasNameChange = updates.name && updates.name !== currentName;

    try {
        await fs.mkdir(path.dirname(presetsPath), { recursive: true });
        await fs.writeFile(presetsPath, JSON.stringify(allPresets, null, 2), 'utf8');
        logger.info(`[ServerPresets] Updated preset${hasConfigChange ? ' config' : ' metadata'}: ${currentName}${hasNameChange ? ` → ${updates.name}` : ''}`);
    } catch (error) {
        logger.error(`[ServerPresets] Failed to update preset:`, error.message);
        throw error;
    }

    return allPresets;
}

/**
 * Delete a custom server preset by name.
 * Rejects deletion of built-in presets.
 * @param {string} name - Preset name to delete
 * @returns {Promise<Array>} Updated array of all presets
 */
export async function deleteServerPreset(name) {
    // Reject deleting built-in presets
    const builtInNames = new Set(DEFAULT_SERVER_PRESETS.map(p => p.name));
    if (builtInNames.has(name)) {
        throw new Error(`Cannot delete built-in preset "${name}"`);
    }

    const presetsPath = getServerPresetsPath();
    let allPresets = await readServerPresets();

    const originalLength = allPresets.length;
    allPresets = allPresets.filter(p => p.name !== name);

    if (allPresets.length === originalLength) {
        logger.warn(`[ServerPresets] Preset not found: ${name}`);
        return allPresets;
    }

    try {
        await fs.writeFile(presetsPath, JSON.stringify(allPresets, null, 2), 'utf8');
        logger.info(`[ServerPresets] Deleted preset: ${name}`);
    } catch (error) {
        logger.error(`[ServerPresets] Failed to delete preset:`, error.message);
        throw error;
    }

    return allPresets;
}
