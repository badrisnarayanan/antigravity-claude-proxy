/**
 * Auto-Updater Module
 *
 * Checks GitHub for new releases, pulls updates, installs dependencies,
 * and handles graceful server restarts.
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, saveConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { getPackageVersion } from '../utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const GITHUB_REPO = 'dronzer-tb/antigravity-claude-proxy';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

// ── State ──
let checkTimer = null;
let updateStatus = {
    checking: false,
    installing: false,
    restarting: false,
    lastCheck: null,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    changelog: null,
    releaseUrl: null,
    error: null,
    installProgress: null
};

/**
 * Compare two semver version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareSemver(a, b) {
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

/**
 * Run a shell command in the project root
 */
function runCommand(cmd, timeout = 120000) {
    return execSync(cmd, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout,
        stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
}

/**
 * Check GitHub for the latest release
 */
async function checkForUpdates() {
    if (updateStatus.checking) return updateStatus;

    updateStatus.checking = true;
    updateStatus.error = null;

    try {
        const currentVersion = getPackageVersion();
        updateStatus.currentVersion = currentVersion;

        // Try GitHub releases API first, fall back to tags
        let latestVersion = null;
        let changelog = null;
        let releaseUrl = null;

        try {
            const res = await fetch(`${GITHUB_API}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'antigravity-proxy' }
            });

            if (res.ok) {
                const data = await res.json();
                latestVersion = data.tag_name?.replace(/^v/, '');
                changelog = data.body || null;
                releaseUrl = data.html_url || null;
            }
        } catch {
            // GitHub releases API failed, try git
        }

        // Fallback: use git to check remote tags
        if (!latestVersion) {
            try {
                runCommand('git fetch --tags origin', 30000);
                const tags = runCommand('git tag --sort=-version:refname').split('\n').filter(Boolean);
                if (tags.length > 0) {
                    latestVersion = tags[0].replace(/^v/, '');
                    releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${tags[0]}`;
                }
            } catch {
                // git fetch failed too
            }
        }

        // Last resort: check if remote has new commits
        if (!latestVersion) {
            try {
                runCommand('git fetch origin main', 30000);
                const behind = runCommand('git rev-list HEAD..origin/main --count');
                const behindCount = parseInt(behind);
                if (behindCount > 0) {
                    // There are new commits but no tagged release
                    latestVersion = `${currentVersion}+${behindCount}`;
                    changelog = `${behindCount} new commit(s) available`;
                } else {
                    latestVersion = currentVersion;
                }
            } catch {
                throw new Error('Could not reach remote repository');
            }
        }

        updateStatus.latestVersion = latestVersion;
        updateStatus.changelog = changelog;
        updateStatus.releaseUrl = releaseUrl;
        updateStatus.updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
        updateStatus.lastCheck = new Date().toISOString();

        // Persist last check time
        saveConfig({
            autoUpdate: {
                lastCheckTime: updateStatus.lastCheck,
                pendingVersion: updateStatus.updateAvailable ? latestVersion : null
            }
        });

        if (updateStatus.updateAvailable) {
            logger.info(`[AutoUpdate] Update available: v${currentVersion} → v${latestVersion}`);

            // Notify Discord
            const bot = globalThis.discordBot;
            if (bot) {
                bot.emitNotification('configChanged', {
                    message: `Update available: v${currentVersion} → v${latestVersion}`,
                    fields: [
                        { name: 'Current', value: `v${currentVersion}` },
                        { name: 'Latest', value: `v${latestVersion}` }
                    ]
                });
            }
        } else {
            logger.debug(`[AutoUpdate] Up to date (v${currentVersion})`);
        }
    } catch (err) {
        updateStatus.error = err.message;
        logger.error(`[AutoUpdate] Check failed: ${err.message}`);
    } finally {
        updateStatus.checking = false;
    }

    return updateStatus;
}

/**
 * Install the update (git pull + npm install + build CSS)
 */
async function installUpdate() {
    if (updateStatus.installing) {
        return { success: false, error: 'Installation already in progress' };
    }
    if (!updateStatus.updateAvailable) {
        return { success: false, error: 'No update available' };
    }

    updateStatus.installing = true;
    updateStatus.error = null;
    updateStatus.installProgress = 'Pulling latest changes...';

    try {
        // Step 1: Stash any local changes
        try {
            const status = runCommand('git status --porcelain');
            if (status) {
                logger.info('[AutoUpdate] Stashing local changes...');
                updateStatus.installProgress = 'Stashing local changes...';
                runCommand('git stash');
            }
        } catch {
            // Ignore stash errors
        }

        // Step 2: Git pull
        logger.info('[AutoUpdate] Pulling latest changes...');
        updateStatus.installProgress = 'Pulling from remote...';
        const pullOutput = runCommand('git pull origin main', 60000);
        logger.info(`[AutoUpdate] git pull: ${pullOutput}`);

        // Step 3: npm install
        logger.info('[AutoUpdate] Installing dependencies...');
        updateStatus.installProgress = 'Installing dependencies...';
        runCommand('npm install --production', 120000);

        // Step 4: Build CSS (runs via prepare hook in npm install, but just in case)
        try {
            logger.info('[AutoUpdate] Building CSS...');
            updateStatus.installProgress = 'Building assets...';
            runCommand('npm run build:css', 30000);
        } catch {
            // CSS build failure is non-fatal
            logger.warn('[AutoUpdate] CSS build failed (non-fatal)');
        }

        // Step 5: Update state
        const newVersion = getPackageVersion();
        updateStatus.installProgress = 'Update installed!';
        updateStatus.currentVersion = newVersion;
        updateStatus.updateAvailable = false;

        saveConfig({
            autoUpdate: {
                pendingVersion: null
            }
        });

        logger.success(`[AutoUpdate] Updated to v${newVersion}. Restart required.`);

        return { success: true, version: newVersion, message: 'Update installed. Restart to apply.' };
    } catch (err) {
        updateStatus.error = err.message;
        updateStatus.installProgress = null;
        logger.error(`[AutoUpdate] Install failed: ${err.message}`);
        return { success: false, error: err.message };
    } finally {
        updateStatus.installing = false;
    }
}

/**
 * Restart the server process
 */
function restartServer() {
    if (updateStatus.restarting) return;
    updateStatus.restarting = true;
    updateStatus.installProgress = 'Restarting server...';

    logger.info('[AutoUpdate] Restarting server...');

    // Spawn a new process then exit the current one
    const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'inherit',
        env: { ...process.env }
    });

    child.unref();

    // Give a moment for the message to be sent, then exit
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

/**
 * Start periodic update checks
 */
function startPeriodicChecks() {
    stopPeriodicChecks();

    const intervalHours = config.autoUpdate?.checkIntervalHours || 6;
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Check if enough time has passed since last check
    const lastCheck = config.autoUpdate?.lastCheckTime;
    if (lastCheck) {
        const elapsed = Date.now() - new Date(lastCheck).getTime();
        if (elapsed < intervalMs) {
            // Schedule next check for remaining time
            const remaining = intervalMs - elapsed;
            logger.debug(`[AutoUpdate] Next check in ${Math.round(remaining / 60000)} minutes`);
            checkTimer = setTimeout(() => {
                checkForUpdates();
                checkTimer = setInterval(checkForUpdates, intervalMs);
            }, remaining);
            return;
        }
    }

    // Check now, then periodically
    setTimeout(() => checkForUpdates(), 10000); // Delay initial check 10s to let server settle
    checkTimer = setInterval(checkForUpdates, intervalMs);
}

/**
 * Stop periodic update checks
 */
function stopPeriodicChecks() {
    if (checkTimer) {
        clearInterval(checkTimer);
        clearTimeout(checkTimer);
        checkTimer = null;
    }
}

/**
 * Get current update status
 */
function getStatus() {
    return { ...updateStatus };
}

export default {
    checkForUpdates,
    installUpdate,
    restartServer,
    startPeriodicChecks,
    stopPeriodicChecks,
    getStatus
};
