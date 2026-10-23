import { execSync } from 'child_process';
import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Intelligent Version Detection for Antigravity
 *
 * Detects versions from the local Antigravity installation's product.json.
 * Two version values are tracked:
 *   - "version" field      → X-Client-Version header (API version gate)
 *   - "ideVersion" field   → User-Agent version string
 *
 * Detection priority (for each):
 *   1. Environment variable override
 *   2. product.json from local Antigravity app
 *   3. OS-specific detection (macOS plist / Windows exe)
 *   4. Hardcoded fallback
 */

// Fallback for User-Agent version (ideVersion in product.json)
const FALLBACK_USER_AGENT_VERSION = process.env.FALLBACK_ANTIGRAVITY_VERSION || '2.0.3';

// Fallback for X-Client-Version (top-level "version" in product.json)
// Can be overridden via ANTIGRAVITY_CLIENT_VERSION_FALLBACK env var
const FALLBACK_CLIENT_VERSION = process.env.ANTIGRAVITY_CLIENT_VERSION_FALLBACK || '1.110.0';

let cachedUserAgent = null;
let cachedClientVersion = null;
let cachedProductJson = undefined; // undefined = not yet attempted
let loggedVersionInfo = false;

/**
 * Compares two semver-ish version strings (X.Y.Z).
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
 * Returns platform-specific search paths for product.json.
 */
function getProductJsonPaths() {
    const os = platform();
    const paths = [];

    if (os === 'darwin') {
        paths.push('/Applications/Antigravity.app/Contents/Resources/app/product.json');
        paths.push(join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'product.json'));
    } else if (os === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        if (localAppData) {
            paths.push(join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'product.json'));
        }
        paths.push(join(programFiles, 'Antigravity', 'resources', 'app', 'product.json'));
    } else {
        paths.push('/usr/share/antigravity/resources/app/product.json');
        paths.push('/opt/antigravity/resources/app/product.json');
        paths.push('/opt/Antigravity/resources/app/product.json');
        paths.push(join(homedir(), '.local', 'share', 'antigravity', 'resources', 'app', 'product.json'));
        paths.push('/snap/antigravity/current/resources/app/product.json');
    }

    return paths;
}

/**
 * Find and parse product.json from the local Antigravity installation.
 * Caches the result after first attempt.
 * @returns {Object|null} Parsed product.json or null
 */
function getProductJson() {
    if (cachedProductJson !== undefined) return cachedProductJson;

    for (const p of getProductJsonPaths()) {
        try {
            if (existsSync(p)) {
                const content = JSON.parse(readFileSync(p, 'utf8'));
                if (content && (content.version || content.ideVersion)) {
                    cachedProductJson = content;
                    return content;
                }
            }
        } catch (e) {
            // Continue to next path
        }
    }

    cachedProductJson = null;
    return null;
}

/**
 * Log version detection results once at startup (lazy import to avoid circular deps).
 */
function logVersionInfo(version, source) {
    if (loggedVersionInfo) return;
    loggedVersionInfo = true;

    import('./logger.js').then(({ logger }) => {
        if (source === 'fallback') {
            logger.warn(`X-Client-Version: using hardcoded fallback ${version} — product.json not found. Set ANTIGRAVITY_CLIENT_VERSION (exact version) or ANTIGRAVITY_CLIENT_VERSION_FALLBACK (fallback value) env var to override.`);
        } else {
            logger.debug(`X-Client-Version: ${version} (source: ${source})`);
        }
    }).catch(() => {});
}

/**
 * Get the X-Client-Version value for API requests.
 * Priority: ANTIGRAVITY_CLIENT_VERSION env var > product.json "version" > hardcoded fallback
 * @returns {string} Version string (e.g. "1.110.0")
 */
export function getClientVersion() {
    if (cachedClientVersion) return cachedClientVersion;

    if (process.env.ANTIGRAVITY_CLIENT_VERSION) {
        cachedClientVersion = process.env.ANTIGRAVITY_CLIENT_VERSION;
        logVersionInfo(cachedClientVersion, 'env');
        return cachedClientVersion;
    }

    const product = getProductJson();
    if (product?.version) {
        cachedClientVersion = product.version;
        logVersionInfo(cachedClientVersion, 'product.json');
        return cachedClientVersion;
    }

    cachedClientVersion = FALLBACK_CLIENT_VERSION;
    logVersionInfo(cachedClientVersion, 'fallback');
    return cachedClientVersion;
}

/**
 * Get the User-Agent version string.
 * Priority: FALLBACK_ANTIGRAVITY_VERSION env var > product.json "ideVersion" > OS detection > fallback
 * @returns {{ version: string, source: string }}
 */
function getUserAgentVersionConfig() {
    if (process.env.FALLBACK_ANTIGRAVITY_VERSION) {
        return { version: process.env.FALLBACK_ANTIGRAVITY_VERSION, source: 'env' };
    }

    const product = getProductJson();
    if (product?.ideVersion && isVersionHigher(product.ideVersion, FALLBACK_USER_AGENT_VERSION)) {
        return { version: product.ideVersion, source: 'product.json' };
    }

    // OS-specific detection (legacy — reads app binary metadata directly)
    const os = platform();
    let detectedVersion = null;
    try {
        if (os === 'darwin') {
            detectedVersion = getVersionMacos();
        } else if (os === 'win32') {
            detectedVersion = getVersionWindows();
        }
    } catch (error) {
        // Silently fail and use fallback
    }

    if (detectedVersion && isVersionHigher(detectedVersion, FALLBACK_USER_AGENT_VERSION)) {
        return { version: detectedVersion, source: 'local' };
    }

    return { version: FALLBACK_USER_AGENT_VERSION, source: 'fallback' };
}

/**
 * Generate a simplified User-Agent string used by the Antigravity binary.
 * Format: "antigravity/version os/arch"
 * @returns {string} The User-Agent string
 */
export function generateSmartUserAgent() {
    if (cachedUserAgent) return cachedUserAgent;

    const { version } = getUserAgentVersionConfig();
    const os = platform();
    const architecture = process.arch;

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
