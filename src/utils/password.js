/**
 * Password Hashing Utilities
 *
 * Uses bcrypt for secure password hashing and verification.
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';

const SALT_ROUNDS = 12;
const BCRYPT_PREFIX = '$2';

/**
 * Check if a string is a bcrypt hash
 * @param {string} str - String to check
 * @returns {boolean} True if the string appears to be a bcrypt hash
 */
export function isHashed(str) {
    if (!str || typeof str !== 'string') return false;
    return str.startsWith(BCRYPT_PREFIX) && str.length >= 59;
}

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Bcrypt hash
 */
export async function hashPassword(password) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password to verify
 * @param {string} hash - Bcrypt hash to compare against
 * @returns {Promise<boolean>} True if password matches
 */
export async function verifyPassword(password, hash) {
    if (!password || !hash) return false;

    // If hash is not actually a bcrypt hash (legacy plain text),
    // use constant-time comparison for migration to avoid timing attacks
    if (!isHashed(hash)) {
        const bufPassword = Buffer.from(password, 'utf8');
        const bufHash = Buffer.from(hash, 'utf8');

        // Pad shorter buffer to match longer length to avoid early-return timing differences
        const maxLen = Math.max(bufPassword.length, bufHash.length);
        const paddedPassword = Buffer.alloc(maxLen, 0);
        const paddedHash = Buffer.alloc(maxLen, 0);
        bufPassword.copy(paddedPassword);
        bufHash.copy(paddedHash);

        return crypto.timingSafeEqual(paddedPassword, paddedHash);
    }

    return bcrypt.compare(password, hash);
}

/**
 * Hash password synchronously (for use in config loading)
 *
 * WARNING: This function uses bcrypt.hashSync which is BLOCKING and will block
 * the Node.js event loop for the duration of the hash computation (with SALT_ROUNDS=12,
 * this can take ~100-300ms depending on hardware).
 *
 * DO NOT use this function in:
 * - Request handlers
 * - Middleware
 * - Any performance-sensitive or concurrent code paths
 *
 * This function should ONLY be used for one-off tasks like:
 * - Config loading at startup
 * - CLI tools
 * - Scripts
 *
 * For request handlers and async code, use the async alternative:
 *   await hashPassword(password)  // uses bcrypt.hash, non-blocking
 *
 * @param {string} password - Plain text password
 * @returns {string} Bcrypt hash
 */
export function hashPasswordSync(password) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    return bcrypt.hashSync(password, SALT_ROUNDS);
}

export default {
    isHashed,
    hashPassword,
    verifyPassword,
    hashPasswordSync
};
