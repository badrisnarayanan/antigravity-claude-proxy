/**
 * Electron Main Process
 * Boots the Express backend and displays the Web UI in an Electron window.
 *
 * Usage:
 *   npm run app         # Start Electron app
 *   npm run app:debug   # Start with DevTools open
 */

import { app as electronApp, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_PORT } from './src/constants.js';
import { initTray, setupCloseToTray, setQuitting, destroyTray } from './src/electron/tray.js';

// Start backend server in the same process
// This imports index.js which calls app.listen()
import './src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {BrowserWindow | null} */
let mainWindow = null;

/**
 * Create the main application window.
 */
function createWindow() {
    // Create window icon from SVG (Electron supports SVG natively on some platforms)
    const iconPath = path.join(__dirname, 'public', 'favicon.svg');

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'Antigravity Claude Proxy',
        icon: iconPath,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        // Modern window appearance
        backgroundColor: '#1d232a', // Match DaisyUI dark theme background
        show: false, // Don't show until ready
    });

    // Remove the menu bar completely
    Menu.setApplicationMenu(null);

    const PORT = process.env.PORT || DEFAULT_PORT;

    // Allow server time to boot before loading UI
    // The server is started via import './src/index.js' above
    setTimeout(() => {
        mainWindow.loadURL(`http://localhost:${PORT}`);
    }, 500);

    // Show window when content is ready (prevents white flash)
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();

        // Initialize system tray after window is ready
        initTray(mainWindow);
        setupCloseToTray(mainWindow);
    });

    // Open DevTools if --debug flag is passed
    if (process.argv.includes('--debug')) {
        mainWindow.webContents.openDevTools();
    }

    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Electron app lifecycle
electronApp.whenReady().then(createWindow);

// Quit when all windows are closed (only when explicitly quitting)
electronApp.on('window-all-closed', () => {
    // On macOS, apps typically stay active until Cmd+Q
    // On other platforms, closing all windows means quit only if explicitly requested
    // The tray keeps the app running otherwise
});

// macOS: Re-create window when dock icon is clicked
electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Graceful shutdown handling
electronApp.on('before-quit', () => {
    // Mark as quitting so window close event allows exit
    setQuitting(true);
    // Clean up tray icon
    destroyTray();
});
