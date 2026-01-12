/**
 * Electron Preload Script
 *
 * Exposes safe IPC methods to the renderer process for window controls.
 * This enables the custom titlebar to control minimize, maximize, and close.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose window control API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),

    // Window state
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

    // Listen for maximize state changes
    onMaximizeChange: (callback) => {
        ipcRenderer.on('window-maximize-change', (_, isMaximized) => callback(isMaximized));
    },

    // Check if running in Electron
    isElectron: true
});
