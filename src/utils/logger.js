/**
 * Logger Utility
 *
 * Provides structured logging with colors and debug support.
 * Simple ANSI codes used to avoid dependencies.
 */

import { EventEmitter } from "events";
import util from "util";

const COLORS = {
  RESET: "\x1b[0m",
  BRIGHT: "\x1b[1m",
  DIM: "\x1b[2m",

  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
  GRAY: "\x1b[90m",
};

// Keys that should be redacted in logs
const SENSITIVE_KEYS = [
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "secret",
  "password",
  "authorization",
  "bearer",
  "credential",
  "key",
];

/**
 * Sanitize an object by redacting sensitive fields
 * @param {any} obj - Object to sanitize
 * @param {number} depth - Current recursion depth
 * @returns {any} Sanitized object
 */
function sanitize(obj, depth = 0) {
  // Limit recursion depth
  if (depth > 5) return "[max depth]";

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    // Redact strings that look like tokens (long alphanumeric strings)
    if (obj.length > 50 && /^[a-zA-Z0-9_-]+$/.test(obj)) {
      return `[REDACTED:${obj.length}chars]`;
    }
    return obj;
  }

  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some((k) => lowerKey.includes(k));

    if (isSensitive) {
      if (typeof value === "string") {
        sanitized[key] = `[REDACTED:${value.length}chars]`;
      } else {
        sanitized[key] = "[REDACTED]";
      }
    } else {
      sanitized[key] = sanitize(value, depth + 1);
    }
  }

  return sanitized;
}

class Logger extends EventEmitter {
  constructor() {
    super();
    this.isDebugEnabled = false;
    this.history = [];
    this.maxHistory = 1000;
  }

  /**
   * Set debug mode
   * @param {boolean} enabled
   */
  setDebug(enabled) {
    this.isDebugEnabled = !!enabled;
  }

  /**
   * Get current timestamp string
   */
  getTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Get log history
   */
  getHistory() {
    return this.history;
  }

  /**
   * Format and print a log message
   * @param {string} level
   * @param {string} color
   * @param {string} message
   * @param  {...any} args
   */
  print(level, color, message, ...args) {
    // Format: [TIMESTAMP] [LEVEL] Message
    const timestampStr = this.getTimestamp();
    const timestamp = `${COLORS.GRAY}[${timestampStr}]${COLORS.RESET}`;
    const levelTag = `${color}[${level}]${COLORS.RESET}`;

    // Format the message with args similar to console.log
    const formattedMessage = util.format(message, ...args);

    console.log(`${timestamp} ${levelTag} ${formattedMessage}`);

    // Store structured log
    const logEntry = {
      timestamp: timestampStr,
      level,
      message: formattedMessage,
    };

    this.history.push(logEntry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    this.emit("log", logEntry);
  }

  /**
   * Standard info log
   */
  info(message, ...args) {
    this.print("INFO", COLORS.BLUE, message, ...args);
  }

  /**
   * Success log
   */
  success(message, ...args) {
    this.print("SUCCESS", COLORS.GREEN, message, ...args);
  }

  /**
   * Warning log
   */
  warn(message, ...args) {
    this.print("WARN", COLORS.YELLOW, message, ...args);
  }

  /**
   * Error log
   */
  error(message, ...args) {
    this.print("ERROR", COLORS.RED, message, ...args);
  }

  /**
   * Debug log - only prints if debug mode is enabled
   */
  debug(message, ...args) {
    if (this.isDebugEnabled) {
      this.print("DEBUG", COLORS.MAGENTA, message, ...args);
    }
  }

  /**
   * Sanitized debug log - redacts sensitive information
   * Use this when logging objects that may contain tokens/secrets
   * @param {string} message - Log message
   * @param {any} obj - Object to log (will be sanitized)
   * @param {number} [maxLength=500] - Maximum JSON string length
   */
  debugSafe(message, obj, maxLength = 500) {
    if (this.isDebugEnabled) {
      try {
        const sanitized = sanitize(obj);
        let json = JSON.stringify(sanitized);
        if (json.length > maxLength) {
          json = json.substring(0, maxLength) + "...";
        }
        this.print("DEBUG", COLORS.MAGENTA, `${message}: ${json}`);
      } catch (err) {
        this.print(
          "DEBUG",
          COLORS.MAGENTA,
          `${message}: [stringify error: ${err.message}]`
        );
      }
    }
  }

  /**
   * Direct log (for raw output usually) - proxied to console.log but can be enhanced
   */
  log(message, ...args) {
    console.log(message, ...args);
  }

  /**
   * Print a section header
   */
  header(title) {
    console.log(
      `\n${COLORS.BRIGHT}${COLORS.CYAN}=== ${title} ===${COLORS.RESET}\n`
    );
  }
}

// Export a singleton instance
export const logger = new Logger();

// Export class if needed for multiple instances
export { Logger };
