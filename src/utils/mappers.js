/**
 * Parameter Mapping Utility
 *
 * Handles compatibility issues between Google Gemini models and Claude tools.
 * Fixes parameter hallucinations, wrong types, and Unix-style flags.
 */

import { logger } from './logger.js';

/**
 * Helper function to coerce values to boolean.
 * Gemini sometimes sends boolean parameters as strings (e.g., "true", "-n", "false").
 *
 * @param {any} value - The value to coerce
 * @returns {boolean|null} The boolean value or null if coercion failed
 */
export function coerceToBool(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (['true', 'yes', '1', '-n'].includes(lower)) {
            return true;
        }
        if (['false', 'no', '0'].includes(lower)) {
            return false;
        }
        return null; // Unknown string, can't coerce
    }

    if (typeof value === 'number') {
        return value !== 0;
    }

    return null;
}

/**
 * Remap function call arguments to fix Gemini hallucinations.
 * Modifies the args object in-place.
 *
 * @param {string} toolName - The name of the tool being called
 * @param {Object} args - The arguments object to modify
 */
export function remapFunctionCallArgs(toolName, args) {
    if (!args || typeof args !== 'object') return;

    const lowerToolName = toolName.toLowerCase();

    if (lowerToolName === 'grep') {
        // [FIX #546] Gemini hallucination: maps parameter description to "description" field
        if (args.description !== undefined) {
            const desc = args.description;
            delete args.description;
            if (args.pattern === undefined) {
                args.pattern = desc;
                logger.debug('[Mappers] Remapped Grep: description → pattern');
            }
        }

        // Gemini uses "query", Claude Code expects "pattern"
        if (args.query !== undefined) {
            const query = args.query;
            delete args.query;
            if (args.pattern === undefined) {
                args.pattern = query;
                logger.debug('[Mappers] Remapped Grep: query → pattern');
            }
        }

        // [FIX] Remap "includes" (array) -> "include" (string)
        if (args.includes !== undefined) {
            const includes = args.includes;
            delete args.includes;
            if (args.include === undefined) {
                let includeStr = '';
                if (Array.isArray(includes)) {
                    // Filter non-strings and join with comma
                    includeStr = includes
                        .filter(v => typeof v === 'string')
                        .join(',');
                } else if (typeof includes === 'string') {
                    includeStr = includes;
                }

                if (includeStr) {
                    args.include = includeStr;
                    logger.debug(`[Mappers] Remapped Grep: includes → include("${includeStr}")`);
                }
            }
        }

        // [FIX] Remap "ignore_case" -> "ignoreCase"
        if (args.ignore_case !== undefined) {
            const ignoreCase = args.ignore_case;
            delete args.ignore_case;
            if (args.ignoreCase === undefined) {
                args.ignoreCase = ignoreCase;
                logger.debug('[Mappers] Remapped Grep: ignore_case → ignoreCase');
            }
        }

        // [FIX #547] Handle "-n" parameter sent as string instead of boolean
        // Gemini sometimes sends Unix-style flags as parameter names
        if (args['-n'] !== undefined) {
            const nVal = args['-n'];
            delete args['-n'];
            const boolVal = coerceToBool(nVal);
            if (boolVal !== null) {
                // "-n" in grep usually means "line numbers" - map to appropriate param
                if (args.lineNumbers === undefined) {
                    args.lineNumbers = boolVal;
                    logger.debug('[Mappers] Remapped Grep: -n → lineNumbers');
                }
            }
        }

        // [FIX #547] Coerce all known boolean parameters from string to bool
        const boolParams = ['ignoreCase', 'lineNumbers', 'caseSensitive', 'regex', 'wholeWord'];
        for (const param of boolParams) {
            if (typeof args[param] === 'string') {
                const boolVal = coerceToBool(args[param]);
                if (boolVal !== null) {
                    args[param] = boolVal;
                    logger.debug(`[Mappers] Coerced Grep param '${param}' from string to bool`);
                }
            }
        }
    } else if (lowerToolName === 'glob') {
        // [FIX #546] Gemini hallucination: maps parameter description to "description" field
        if (args.description !== undefined) {
            const desc = args.description;
            delete args.description;
            if (args.pattern === undefined) {
                args.pattern = desc;
                logger.debug('[Mappers] Remapped Glob: description → pattern');
            }
        }

        // Gemini uses "query", Claude Code expects "pattern"
        if (args.query !== undefined) {
            const query = args.query;
            delete args.query;
            if (args.pattern === undefined) {
                args.pattern = query;
                logger.debug('[Mappers] Remapped Glob: query → pattern');
            }
        }
    }
}
