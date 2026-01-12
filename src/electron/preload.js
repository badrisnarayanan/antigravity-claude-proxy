/**
 * Electron Preload Script
 *
 * Exposes safe IPC methods to the renderer process for window controls.
 * Uses contextBridge to maintain security with contextIsolation enabled.
 *
 * @module electron/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

// IPC channel names
const CHANNELS = {
    MINIMIZE: 'window-minimize',
    MAXIMIZE: 'window-maximize',
    CLOSE: 'window-close',
    IS_MAXIMIZED: 'window-is-maximized',
    MAXIMIZE_CHANGE: 'window-maximize-change',
};

// Expose window control API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimize: () => ipcRenderer.send(CHANNELS.MINIMIZE),
    maximize: () => ipcRenderer.send(CHANNELS.MAXIMIZE),
    close: () => ipcRenderer.send(CHANNELS.CLOSE),

    // Window state query
    isMaximized: () => ipcRenderer.invoke(CHANNELS.IS_MAXIMIZED),

    // Window state change listener
    onMaximizeChange: (callback) => {
        const handler = (_, isMaximized) => callback(isMaximized);
        ipcRenderer.on(CHANNELS.MAXIMIZE_CHANGE, handler);

        // Return cleanup function
        return () => ipcRenderer.removeListener(CHANNELS.MAXIMIZE_CHANGE, handler);
    },

    // Runtime check
    isElectron: true,
});
