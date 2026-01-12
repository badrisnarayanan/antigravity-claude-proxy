/**
 * Electron Main Process
 * Boots the Express backend and displays the Web UI in an Electron window.
 *
 * Usage:
 *   npm run app         # Start Electron app
 *   npm run app:debug   # Start with DevTools open
 */

import { app as electronApp, BrowserWindow, Menu, ipcMain } from 'electron';
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
    const preloadPath = path.join(__dirname, 'src', 'electron', 'preload.js');

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'Antigravity Claude Proxy',
        icon: iconPath,
        autoHideMenuBar: true,
        // Frameless window for custom titlebar
        frame: false,
        // Transparent background for rounded corners
        transparent: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: preloadPath,
        },
        // Modern window appearance
        backgroundColor: '#00000000', // Transparent for rounded corners
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

    // Notify renderer when maximize state changes
    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('window-maximize-change', true);
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('window-maximize-change', false);
    });
}

// IPC handlers for window controls
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
});

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
