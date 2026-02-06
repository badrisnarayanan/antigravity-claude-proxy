#!/bin/sh
# Docker entrypoint script to fix permissions for mounted volumes

set -e

CONFIG_DIR="/home/node/.config/antigravity-proxy"

# Fix permissions for the config directory if running as root
if [ "$(id -u)" = "0" ]; then
    echo "[Entrypoint] Running as root, fixing permissions for $CONFIG_DIR..."
    
    # Ensure the directory exists
    mkdir -p "$CONFIG_DIR" 2>/dev/null || true
    
    # Fix ownership and permissions
    chown -R node:node "$CONFIG_DIR" 2>/dev/null || true
    chmod -R 755 "$CONFIG_DIR" 2>/dev/null || true
    
    # Switch to node user and execute the command
    # Using standard 'su' command (available on all Linux systems)
    echo "[Entrypoint] Switching to node user and starting application..."
    # Combine all arguments into a single command string
    # This handles cases like "npm start" correctly
    if [ $# -eq 0 ]; then
        # No arguments, use default CMD
        exec su -s /bin/sh node -c "cd /usr/src/app && npm start"
    else
        # Execute the provided command
        CMD="$*"
        exec su -s /bin/sh node -c "cd /usr/src/app && $CMD"
    fi
else
    # Already running as node user, just execute the command
    exec "$@"
fi
