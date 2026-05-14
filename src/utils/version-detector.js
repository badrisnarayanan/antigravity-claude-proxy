import { execSync } from 'child_process';
import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Intelligent Version Detection for Antigravity
 * Attempts to find the local installation and extract its version.
 * Falls back to hard-coded stable versions if detection fails.
 */

// Fallback constant
const FALLBACK_ANTIGRAVITY_VERSION = '1.20.3';

// Cache for the generated User-Agent string
let cachedUserAgent = null;

/**
 * Compares two semver-ish version strings (X.Y.Z).
 * @param {string} v1 - Version string 1
 * @param {string} v2 - Version string 2
 * @returns {boolean} True if v1 > v2
 */
function isVersionHigher(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return true;
        if (p1 < p2) return false;
    }
    return false;
}

/**
 * Gets the version config (version, source)
 * @returns {{ version: string, source: string }}
 */
function getVersionConfig() {
    const os = platform();
    let detectedVersion = null;
    let finalVersion = FALLBACK_ANTIGRAVITY_VERSION;
    let source = 'fallback';

    try {
        if (os === 'darwin') {
            detectedVersion = getVersionMacos();
        } else if (os === 'win32') {
            detectedVersion = getVersionWindows();
        }
    } catch (error) {
        // Silently fail and use fallback
    }

    // Only use detected version if it's higher than the fallback version
    if (detectedVersion && isVersionHigher(detectedVersion, FALLBACK_ANTIGRAVITY_VERSION)) {
        finalVersion = detectedVersion;
        source = 'local';
    }

    return {
        version: finalVersion,
        source
    };
}

/**
 * Generate a simplified User-Agent string used by the Antigravity binary.
 * Format: "antigravity/version os/arch"
 * @returns {string} The User-Agent string
 */
export function generateSmartUserAgent() {
    if (cachedUserAgent) return cachedUserAgent;

    const { version } = getVersionConfig();
    const os = platform();
    const architecture = process.arch;

    // Map Node.js platform names to binary-friendly names
    const osName = os === 'darwin' ? 'darwin' : (os === 'win32' ? 'win32' : 'linux');

    cachedUserAgent = `antigravity/${version} ${osName}/${architecture}`;
    return cachedUserAgent;
}

/**
 * MacOS-specific version detection using plutil
 */
function getVersionMacos() {
    const appPath = '/Applications/Antigravity.app';
    const plistPath = join(appPath, 'Contents/Info.plist');

    if (!existsSync(plistPath)) return null;

    try {
        const version = execSync(`plutil -extract CFBundleShortVersionString raw "${plistPath}"`, { encoding: 'utf8' }).trim();
        if (/^\d+\.\d+\.\d+/.test(version)) {
            return version;
        }
    } catch (e) {
        // plutil failed or file not found
    }
    return null;
}

/**
 * Windows-specific version detection using PowerShell
 */
function getVersionWindows() {
    try {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

        const possiblePaths = [
            join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
            join(programFiles, 'Antigravity', 'Antigravity.exe')
        ];

        for (const exePath of possiblePaths) {
            if (existsSync(exePath)) {
                const cmd = `powershell -Command "(Get-Item '${exePath}').VersionInfo.FileVersion"`;
                const version = execSync(cmd, { encoding: 'utf8' }).trim();
                const match = version.match(/^(\d+\.\d+\.\d+)/);
                if (match) return match[1];
            }
        }
    } catch (e) {
        // PowerShell or path issues
    }
    return null;
}

