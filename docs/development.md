# Development

## For Developers & Contributors

This project uses a local Tailwind CSS build system. CSS is pre-compiled and included in the repository, so you can run the project immediately after cloning.

### Quick Start

```bash
git clone https://github.com/badrisnarayanan/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install  # Automatically builds CSS via prepare hook
npm start    # Start server (no rebuild needed)
```

### Frontend Development

If you need to modify styles in `public/css/src/input.css`:

```bash
# Option 1: Build once
npm run build:css

# Option 2: Watch for changes (auto-rebuild)
npm run watch:css

# Option 3: Watch both CSS and server (recommended)
npm run dev:full
```

**File Structure:**
- `public/css/src/input.css` - Source CSS with Tailwind `@apply` directives (edit this)
- `public/css/style.css` - Compiled & minified CSS (auto-generated, don't edit)
- `tailwind.config.js` - Tailwind configuration
- `postcss.config.js` - PostCSS configuration

### Backend-Only Development

If you're only working on backend code and don't need frontend dev tools:

```bash
npm install --production  # Skip devDependencies (saves ~20MB)
npm start
```

**Note:** Pre-compiled CSS is committed to the repository, so you don't need to rebuild unless modifying styles.

### Project Structure

See [CLAUDE.md](../CLAUDE.md) for detailed architecture documentation, including:
- Request flow and module organization
- Frontend architecture (Alpine.js + Tailwind)
- Service layer patterns (`ErrorHandler.withLoading`, `AccountActions`)
- Dashboard module documentation
