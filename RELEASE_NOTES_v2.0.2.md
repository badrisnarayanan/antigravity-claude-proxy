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

### Custom Titlebar & Premium Window Design

- **Custom Titlebar** - Sleek minimal titlebar with app logo and name on left, window controls on right
- **Rounded Window Corners** - Premium 8px rounded corners on Windows (automatically removed when maximized)
- **Native Window Controls** - Minimize, maximize/restore, and close buttons with proper hover states
- **Frameless Design** - Modern frameless window with transparent background for clean aesthetics

## Performance Optimizations

Major performance improvements for a lightning-fast, responsive UI:

### Chart.js Optimizations

- **Non-blocking Load** - Chart.js now loads with `defer` attribute, preventing render-blocking
- **In-place Updates** - Charts now use `.update('none')` instead of destroy/recreate pattern
  - Quota distribution chart updates instantly without flickering
  - Trend chart updates in-place when dataset count remains the same
- **Faster Animations** - Reduced animation duration from 300ms to 150ms for snappier feel

### Tab Visibility Throttling

- **Smart Refresh** - Auto-refresh pauses when browser tab is hidden
- **Immediate Resume** - Data refreshes immediately when tab becomes visible again
- **Reduced CPU Usage** - No unnecessary API calls or chart updates when not viewing

### Logs Viewer Optimization

- **Ring Buffer** - O(1) log insertion with `LogRingBuffer` class (no array reallocation)
- **Batch Processing** - Logs are batched and flushed using `requestAnimationFrame`
- **Throttled Scrolling** - Scroll updates are throttled to prevent layout thrashing

### Dashboard Optimization

- **Consolidated Watchers** - Single debounced refresh mechanism replaces multiple watchers
- **Unified Update Path** - All data changes go through `_performRefresh()` in optimal order
- **100ms Debounce** - Prevents redundant updates when multiple data sources change simultaneously
- **View Caching** - Removed cache-busting for faster view navigation

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
