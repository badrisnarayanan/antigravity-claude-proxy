/**
 * System Tray Manager for Electron
 *
 * Handles system tray icon, context menu, and minimize-to-tray behavior.
 * When the user closes the window, the app minimizes to tray instead of quitting.
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {Tray | null} */
let tray = null;

/** @type {boolean} */
let isQuitting = false;

/**
 * Get the appropriate icon path based on platform
 * @returns {string} Path to the tray icon
 */
function getIconPath() {
    const assetsDir = path.join(__dirname, '..', '..', 'assets');

    // Windows uses .ico, others use .png
    if (process.platform === 'win32') {
        return path.join(assetsDir, 'icon.ico');
    }

    return path.join(assetsDir, 'icon.png');
}

/**
 * Create the system tray context menu
 * @param {import('electron').BrowserWindow | null} mainWindow - The main application window
 * @returns {Menu} The context menu for the tray
 */
function createContextMenu(mainWindow) {
    return Menu.buildFromTemplate([
        {
            label: 'Open',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        {
            type: 'separator'
        },
        {
            label: 'Exit',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);
}

/**
 * Initialize the system tray
 * @param {import('electron').BrowserWindow | null} mainWindow - The main application window
 * @returns {Tray} The created tray instance
 */
export function initTray(mainWindow) {
    const iconPath = getIconPath();

    // Create native image for cross-platform compatibility
    const icon = nativeImage.createFromPath(iconPath);

    // Resize icon for tray (16x16 on Windows, 22x22 on Linux, template on macOS)
    const trayIcon = process.platform === 'darwin'
        ? icon.resize({ width: 16, height: 16 })
        : icon.resize({ width: 16, height: 16 });

    // Set as template image on macOS for proper dark/light mode handling
    if (process.platform === 'darwin') {
        trayIcon.setTemplateImage(true);
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Antigravity Claude Proxy');
    tray.setContextMenu(createContextMenu(mainWindow));

    // Double-click on tray icon opens the window (Windows/Linux)
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    return tray;
}

/**
 * Set up window close behavior to minimize to tray
 * @param {import('electron').BrowserWindow} mainWindow - The main application window
 */
export function setupCloseToTray(mainWindow) {
    mainWindow.on('close', (event) => {
        // If not explicitly quitting, minimize to tray instead
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

/**
 * Mark the app as quitting (called before app.quit())
 * This allows the window close event to proceed normally
 */
export function setQuitting(value) {
    isQuitting = value;
}

/**
 * Check if the app is in quitting state
 * @returns {boolean}
 */
export function getIsQuitting() {
    return isQuitting;
}

/**
 * Destroy the tray icon
 * Call this on app quit to clean up
 */
export function destroyTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}

/**
 * Update the tray context menu
 * Useful when main window reference changes
 * @param {import('electron').BrowserWindow | null} mainWindow - The main application window
 */
export function updateTrayMenu(mainWindow) {
    if (tray) {
        tray.setContextMenu(createContextMenu(mainWindow));
    }
}
