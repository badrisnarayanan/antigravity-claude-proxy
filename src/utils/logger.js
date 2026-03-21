/**
 * Logger Utility
 *
 * Provides structured logging with colors and debug support.
 * Simple ANSI codes used to avoid dependencies.
 */

import { EventEmitter } from 'events';
import util from 'util';

const COLORS = {
    RESET: '\x1b[0m',
    BRIGHT: '\x1b[1m',
    DIM: '\x1b[2m',

    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    GRAY: '\x1b[90m'
};

// Maximum size for log data to prevent memory bloat (in bytes)
const MAX_LOG_DATA_SIZE = 10 * 1024; // 10KB

/**
 * Sanitize sensitive data from log payloads
 * Only includes full payloads when debug mode is explicitly enabled
 * @param {any} data - The data to sanitize
 * @param {boolean} isDebugMode - Whether debug mode is enabled
 * @returns {any} - Sanitized data
 */
function sanitizeLogData(data, isDebugMode) {
    if (!data || typeof data !== 'object') {
        return data;
    }

    // Deep clone to avoid mutating original data
    const sanitized = Array.isArray(data) ? [] : {};

    for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            continue;
        }

        const value = data[key];

        // Handle nested objects recursively
        if (value && typeof value === 'object') {
            // Special handling for request payloads containing sensitive data
            if (key === 'request' && !isDebugMode) {
                // In non-debug mode, only include metadata, not full payloads
                sanitized[key] = sanitizeRequestMetadata(value);
            } else if (key === 'messages' && !isDebugMode) {
                // Sanitize messages array - only keep count and roles
                sanitized[key] = sanitizeMessages(value);
            } else if (key === 'system' && !isDebugMode) {
                // Sanitize system prompt - only include length
                sanitized[key] = typeof value === 'string' 
                    ? `[system prompt: ${value.length} chars]`
                    : '[system prompt: present]';
            } else if (key === 'tools' && !isDebugMode) {
                // Sanitize tools - only include count and names, not full definitions
                sanitized[key] = sanitizeTools(value);
            } else {
                // Recursively sanitize other nested objects
                sanitized[key] = sanitizeLogData(value, isDebugMode);
            }
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

/**
 * Sanitize request object - keep only metadata in non-debug mode
 * @param {object} request - The request object
 * @returns {object} - Sanitized request metadata
 */
function sanitizeRequestMetadata(request) {
    return {
        model: request.model,
        stream: !!request.stream,
        messageCount: request.messages?.length || 0,
        hasSystem: !!request.system,
        toolCount: request.tools?.length || 0,
        thinking: !!request.thinking
    };
}

/**
 * Sanitize messages array - only keep message count and roles in non-debug mode
 * @param {array} messages - The messages array
 * @returns {array} - Sanitized messages summary
 */
function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) {
        return messages;
    }

    return messages.map((msg, index) => ({
        index,
        role: msg.role,
        contentLength: msg.content 
            ? (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length)
            : 0,
        contentTypes: Array.isArray(msg.content)
            ? msg.content.map(c => c.type || 'text').join(', ')
            : (typeof msg.content === 'string' ? 'text' : 'unknown')
    }));
}

/**
 * Sanitize tools array - only keep tool names in non-debug mode
 * @param {array} tools - The tools array
 * @returns {array} - Sanitized tools summary
 */
function sanitizeTools(tools) {
    if (!Array.isArray(tools)) {
        return tools;
    }

    return tools.map((tool, index) => {
        if (tool && tool.function) {
            return {
                index,
                name: tool.function.name || '[unnamed]',
                description: tool.function.description ? '[present]' : undefined
            };
        }
        return { index, name: '[unknown tool]' };
    });
}

/**
 * Truncate log data if it exceeds maximum size
 * @param {any} data - The data to truncate
 * @returns {any} - Truncated data with size warning if applicable
 */
function truncateLogData(data) {
    const jsonString = JSON.stringify(data);
    
    if (jsonString.length <= MAX_LOG_DATA_SIZE) {
        return data;
    }

    // Data too large, truncate and add warning
    const truncatedData = {
        _truncated: true,
        _originalSize: jsonString.length,
        _maxSize: MAX_LOG_DATA_SIZE,
        _warning: 'Log data truncated due to size limit. Enable debug mode for full payloads.',
        _summary: summarizeData(data)
    };

    return truncatedData;
}

/**
 * Create a summary of large data objects
 * @param {any} data - The data to summarize
 * @returns {object} - Summary object
 */
function summarizeData(data) {
    if (!data || typeof data !== 'object') {
        return { type: typeof data };
    }

    const summary = {};
    
    if (Array.isArray(data)) {
        summary.type = 'array';
        summary.length = data.length;
        summary.sampleSize = Math.min(3, data.length);
        summary.sample = data.slice(0, 3).map(item => 
            typeof item === 'object' ? summarizeData(item) : String(item).slice(0, 50)
        );
    } else {
        summary.type = 'object';
        summary.keys = Object.keys(data);
        summary.keyCount = summary.keys.length;
    }

    return summary;
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
     * @param {any} data Optional structured data
     * @param {...any} args
     */
    print(level, color, message, data, ...args) {
        let actualData = null;
        let formatArgs = [];

        // Check if data is a withData wrapper
        if (data && typeof data === 'object' && !Array.isArray(data) && data._isExtraData) {
            actualData = data.data;
            formatArgs = args;
        } else {
            // Search for withData wrapper in args (handles cases like logger.error(msg, error, withData(...)))
            const withDataIndex = args.findIndex(arg => arg && typeof arg === 'object' && arg._isExtraData);
            
            if (withDataIndex !== -1) {
                // Found withData wrapper in args
                actualData = args[withDataIndex].data;
                // Remove the withData wrapper from args and combine with data for formatting
                formatArgs = [data, ...args.slice(0, withDataIndex), ...args.slice(withDataIndex + 1)].filter(arg => arg !== undefined);
            } else {
                // No withData wrapper, treat all as format args
                formatArgs = [data, ...args].filter(arg => arg !== undefined);
            }
        }

        // Format: [TIMESTAMP] [LEVEL] Message
        const timestampStr = this.getTimestamp();
        const timestamp = `${COLORS.GRAY}[${timestampStr}]${COLORS.RESET}`;
        const levelTag = `${color}[${level}]${COLORS.RESET}`;

        // Format the message with args similar to console.log
        const formattedMessage = util.format(message, ...formatArgs);

        console.log(`${timestamp} ${levelTag} ${formattedMessage}`);

        // Sanitize and truncate data before storing to prevent sensitive data exposure
        let processedData = actualData;
        if (processedData) {
            // First sanitize based on debug mode
            processedData = sanitizeLogData(processedData, this.isDebugEnabled);
            // Then apply size limit to prevent memory bloat
            processedData = truncateLogData(processedData);
        }

        // Store structured log
        const logEntry = {
            timestamp: timestampStr,
            level,
            message: formattedMessage,
            data: processedData
        };

        this.history.push(logEntry);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        this.emit('log', logEntry);
    }

    /**
     * Helper to wrap extra data for the logger
     */
    withData(data) {
        return { _isExtraData: true, data };
    }

    /**
     * Standard info log
     */
    info(message, ...args) {
        this.print('INFO', COLORS.BLUE, message, ...args);
    }

    /**
     * Success log
     */
    success(message, ...args) {
        this.print('SUCCESS', COLORS.GREEN, message, ...args);
    }

    /**
     * Warning log
     */
    warn(message, ...args) {
        this.print('WARN', COLORS.YELLOW, message, ...args);
    }

    /**
     * Error log
     */
    error(message, ...args) {
        this.print('ERROR', COLORS.RED, message, ...args);
    }

    /**
     * Debug log - only prints if debug mode is enabled
     */
    debug(message, ...args) {
        if (this.isDebugEnabled) {
            this.print('DEBUG', COLORS.MAGENTA, message, ...args);
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
        console.log(`\n${COLORS.BRIGHT}${COLORS.CYAN}=== ${title} ===${COLORS.RESET}\n`);
    }
}

// Export a singleton instance
export const logger = new Logger();

// Export helper functions for testing
export {
    sanitizeLogData,
    sanitizeMessages,
    sanitizeTools,
    sanitizeRequestMetadata,
    truncateLogData,
    summarizeData
};
