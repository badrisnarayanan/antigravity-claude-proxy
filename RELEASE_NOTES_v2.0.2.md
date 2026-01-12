# Release Notes - Antigravity Claude Proxy v2.0.2

## Desktop Application (New)

This release introduces a native **Electron desktop application** for Windows, macOS, and Linux - making it easier than ever to run Antigravity Claude Proxy.

### Fully Portable Executable

- **Windows Portable EXE** - Single executable file, no installation required
  - Just double-click and the server starts automatically
  - Runs entirely self-contained - perfect for USB drives or restricted environments
  - No admin privileges needed
- **NSIS Installer** - Traditional installer option with:
  - Custom installation directory
  - Desktop and Start Menu shortcuts
- **macOS** - DMG installer + ZIP archive
- **Linux** - AppImage (portable) + DEB package

### System Tray Integration

- **Minimize to Tray** - Closing the window hides the app to the system tray instead of quitting
  - The proxy server continues running in the background
  - Your Claude Code sessions remain uninterrupted
- **Tray Context Menu**
  - "Open" - Restore the main window
  - "Exit" - Fully quit the application
- **Double-Click to Open** - Double-click the tray icon to restore the window (Windows/Linux)
- **Cross-Platform Icons**
  - Native `.ico` support on Windows
  - Template images on macOS for proper dark/light mode handling

### Native Desktop Experience

- Clean, menu-bar-free interface
- Dark theme background matching the WebUI (`#1d232a`)
- Smooth startup with splash-free loading
- Debug mode available via `--debug` flag for DevTools access

## How to Use

### Run from Source

```bash
npm run app           # Start desktop app
npm run app:debug     # Start with DevTools
```

### Build Executables

```bash
npm run build:win     # Windows (NSIS + Portable)
npm run build:mac     # macOS (DMG + ZIP)
npm run build:linux   # Linux (AppImage + DEB)
```

### Output Files (Windows)

- `dist/Antigravity Claude Proxy Setup 2.0.2.exe` - Installer
- `dist/Antigravity Claude Proxy 2.0.2.exe` - Portable executable

---

**Full Changelog**: v2.0.1...v2.0.2
