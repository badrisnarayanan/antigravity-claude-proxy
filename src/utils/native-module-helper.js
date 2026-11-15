/**
 * Native Module Helper
 * Detects and auto-rebuilds native Node.js modules when they become
 * incompatible after a Node.js version update.
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { logger } from './logger.js';

/**
 * Check if an error is a NODE_MODULE_VERSION mismatch error
 * @param {Error} error - The error to check
 * @returns {boolean} True if it's a version mismatch error
 */
export function isModuleVersionError(error) {
    const message = error?.message || '';
    return message.includes('NODE_MODULE_VERSION') &&
           message.includes('was compiled against a different Node.js version');
}

/**
 * Extract the module path from a NODE_MODULE_VERSION error message
 * @param {Error} error - The error containing the module path
 * @returns {string|null} The path to the .node file, or null if not found
 */
export function extractModulePath(error) {
    const message = error?.message || '';
    // Match pattern like: "The module '/path/to/module.node'"
    const match = message.match(/The module '([^']+\.node)'/);
    return match ? match[1] : null;
}

/**
 * Find the package root directory from a .node file path
 * @param {string} nodeFilePath - Path to the .node file
 * @returns {string|null} Path to the package root, or null if not found
 */
export function findPackageRoot(nodeFilePath) {
    // Walk up from the .node file to find package.json
    let dir = dirname(nodeFilePath);
    while (dir) {
        const packageJsonPath = join(dir, 'package.json');
        if (existsSync(packageJsonPath)) {
            return dir;
        }
        const parentDir = dirname(dir);
        // Stop when we've reached the filesystem root (dirname returns same path)
        if (parentDir === dir) {
            break;
        }
        dir = parentDir;
    }
    return null;
}

/**
 * Attempt to rebuild a native module
 * @param {string} packagePath - Path to the package root directory
 * @returns {boolean} True if rebuild succeeded, false otherwise
 */
export function rebuildModule(packagePath) {
    try {
        logger.info(`[NativeModule] Rebuilding native module at: ${packagePath}`);

        const output = execSync('npm rebuild', {
            cwd: packagePath,
            stdio: 'pipe', // Capture output instead of printing
            timeout: 120000 // 2 minute timeout
        });

        const outputStr = output?.toString().trim();
        if (outputStr) {
            logger.debug(`[NativeModule] Rebuild output:\n${outputStr}`);
        }

        logger.success('[NativeModule] Rebuild completed successfully');
        return true;
    } catch (error) {
        // Include stdout/stderr from the failed command for troubleshooting
        const stdout = error.stdout?.toString().trim();
        const stderr = error.stderr?.toString().trim();
        let errorDetails = `[NativeModule] Rebuild failed: ${error.message}`;
        if (stdout) {
            errorDetails += `\n[NativeModule] stdout: ${stdout}`;
        }
        if (stderr) {
            errorDetails += `\n[NativeModule] stderr: ${stderr}`;
        }
        logger.error(errorDetails);
        return false;
    }
}

/**
 * Attempt to auto-rebuild a native module from an error
 * @param {Error} error - The NODE_MODULE_VERSION error
 * @returns {boolean} True if rebuild succeeded, false otherwise
 */
export function attemptAutoRebuild(error) {
    const nodePath = extractModulePath(error);
    if (!nodePath) {
        logger.error('[NativeModule] Could not extract module path from error');
        return false;
    }

    const packagePath = findPackageRoot(nodePath);
    if (!packagePath) {
        logger.error('[NativeModule] Could not find package root');
        return false;
    }

    logger.warn('[NativeModule] Native module version mismatch detected');
    logger.info('[NativeModule] Attempting automatic rebuild...');

    return rebuildModule(packagePath);
}

/**
 * Recursively clear a module and its dependencies from the require cache
 * This is needed after rebuilding a native module to force re-import
 * @param {string} modulePath - Resolved path to the module
 * @param {object} cache - The require.cache object
 * @param {Set} [visited] - Set of already-visited paths to prevent cycles
 */
export function clearRequireCache(modulePath, cache, visited = new Set()) {
    if (visited.has(modulePath)) return;
    visited.add(modulePath);

    const mod = cache[modulePath];
    if (!mod) return;

    // Recursively clear children first
    if (mod.children) {
        for (const child of mod.children) {
            clearRequireCache(child.id, cache, visited);
        }
    }

    if (mod.parent && mod.parent.children) {
        const idx = mod.parent.children.indexOf(mod);
        if (idx !== -1) {
            mod.parent.children.splice(idx, 1);
        }
    }

    delete cache[modulePath];
}

export default {
    isModuleVersionError,
    extractModulePath,
    findPackageRoot,
    rebuildModule,
    attemptAutoRebuild,
    clearRequireCache
};
