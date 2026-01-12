/**
 * Electron Main Process
 *
 * Creates a frameless window with custom titlebar and rounded corners.
 * Boots the Express backend and displays the Web UI.
 *
 * @module main
 */

import { app, BrowserWindow, Menu, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_PORT } from './src/constants.js';
import { initTray, setupCloseToTray, setQuitting, destroyTray } from './src/electron/tray.js';

// Start backend server
import './src/index.js';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const WINDOW_CONFIG = {
    ASPECT_RATIO: 16 / 9,
    SCREEN_SCALE: 0.75, // 75% of screen width
    MIN_WIDTH: 900,
    MIN_HEIGHT: 506,    // Maintains 16:9 at min width
};

// -----------------------------------------------------------------------------
// Window Management
// -----------------------------------------------------------------------------

/** @type {BrowserWindow | null} */
let mainWindow = null;

/**
 * Calculate centered window bounds with 16:9 aspect ratio.
 * @returns {{ width: number, height: number, x: number, y: number }}
 */
function calculateWindowBounds() {
    const { workAreaSize } = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = workAreaSize;

    // Calculate dimensions maintaining 16:9 aspect ratio
    let width = Math.round(screenWidth * WINDOW_CONFIG.SCREEN_SCALE);
    let height = Math.round(width / WINDOW_CONFIG.ASPECT_RATIO);

    // Ensure window fits on screen with some padding
    if (height > screenHeight * 0.9) {
        height = Math.round(screenHeight * 0.9);
        width = Math.round(height * WINDOW_CONFIG.ASPECT_RATIO);
    }

    // Center on screen
    const x = Math.round((screenWidth - width) / 2);
    const y = Math.round((screenHeight - height) / 2);

    return { width, height, x, y };
}

/**
 * Create the main application window.
 */
function createMainWindow() {
    const bounds = calculateWindowBounds();

    mainWindow = new BrowserWindow({
        ...bounds,
        minWidth: WINDOW_CONFIG.MIN_WIDTH,
        minHeight: WINDOW_CONFIG.MIN_HEIGHT,
        title: 'Antigravity Claude Proxy',
        icon: path.join(__dirname, 'assets', 'icon.png'),

        // Frameless window for custom chrome
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',

        // Performance
        show: false,
        autoHideMenuBar: true,

        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'src', 'electron', 'preload.js'),
        },
    });

    Menu.setApplicationMenu(null);

    // Load UI after server starts
    const port = process.env.PORT || DEFAULT_PORT;
    setTimeout(() => mainWindow.loadURL(`http://localhost:${port}`), 500);

    // Show window when ready (prevents flash)
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        initTray(mainWindow);
        setupCloseToTray(mainWindow);
    });

    // Debug mode
    if (process.argv.includes('--debug')) {
        mainWindow.webContents.openDevTools();
    }

    // Window state events
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.on('maximize', () => notifyMaximizeState(true));
    mainWindow.on('unmaximize', () => notifyMaximizeState(false));
}

/**
 * Notify renderer of maximize state change.
 * @param {boolean} isMaximized
 */
function notifyMaximizeState(isMaximized) {
    if (mainWindow?.webContents) {
        mainWindow.webContents.send('window-maximize-change', isMaximized);
    }
}

// -----------------------------------------------------------------------------
// IPC Handlers - Window Controls
// -----------------------------------------------------------------------------

ipcMain.on('window-minimize', () => mainWindow?.minimize());

ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// -----------------------------------------------------------------------------
// App Lifecycle
// -----------------------------------------------------------------------------

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
    // Tray keeps app running; only quit when explicitly requested
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

app.on('before-quit', () => {
    setQuitting(true);
    destroyTray();
});
