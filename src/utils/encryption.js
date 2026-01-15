/**
 * Token Encryption Utilities
 *
 * Encrypts sensitive data at rest using AES-256-GCM.
 * Key is derived from machine-specific information for automatic operation.
 */

import crypto from 'crypto';
import os from 'os';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:v1:';

/**
 * Derive an encryption key from machine-specific data.
 *
 * THREAT MODEL AND LIMITATIONS:
 * -----------------------------
 * This function derives a 32-byte (KEY_LENGTH) encryption key using PBKDF2-SHA256
 * with 100,000 iterations from the following NON-SECRET inputs:
 *   - os.hostname()
 *   - os.homedir()
 *   - os.userInfo().username
 *   - ACCOUNT_CONFIG_PATH (config file location)
 *   - process.env.COMPUTERNAME or HOSTNAME
 *   - A fixed salt: 'antigravity-proxy-v1'
 *
 * SECURITY IMPLICATIONS:
 * - Any local user or process on the same machine can derive the identical key
 *   by reading the same system values. This does NOT protect against local attackers.
 * - Moving the config file to a different machine, changing the hostname, username,
 *   or home directory will cause decryption to fail (tokens become unreadable).
 * - The fixed salt is not secret; security relies on machine-specific entropy.
 *
 * WHAT THIS PROTECTS AGAINST:
 * - Casual file copying: tokens copied to another machine won't decrypt
 * - Accidental exposure: raw tokens not visible in config files
 *
 * WHAT THIS DOES NOT PROTECT AGAINST:
 * - Determined local attackers with access to run code as the same user
 * - Root/admin users on the same machine
 * - Memory inspection of the running process
 *
 * This is an INTENTIONAL TRADE-OFF: automatic encryption without user-managed
 * secrets (no master password required) at the cost of weaker local security.
 * For stronger protection, consider OS keychain integration or user-provided secrets.
 *
 * @returns {Buffer} 32-byte (KEY_LENGTH) encryption key
 */
function deriveKey() {
    const machineInfo = [
        os.hostname(),
        os.homedir(),
        os.userInfo().username,
        ACCOUNT_CONFIG_PATH,
        process.env.COMPUTERNAME || process.env.HOSTNAME || 'node'
    ].join(':');

    const salt = 'antigravity-proxy-v1';
    return crypto.pbkdf2Sync(machineInfo, salt, 100000, KEY_LENGTH, 'sha256');
}

// Cache the derived key
let cachedKey = null;

function getKey() {
    if (!cachedKey) {
        cachedKey = deriveKey();
    }
    return cachedKey;
}

/**
 * Check if a string is encrypted
 * @param {string} str - String to check
 * @returns {boolean} True if the string appears to be encrypted
 */
export function isEncrypted(str) {
    if (!str || typeof str !== 'string') return false;
    return str.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt a string value
 * @param {string} plaintext - Value to encrypt
 * @returns {string} Encrypted value with prefix
 */
export function encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
        return plaintext;
    }

    // Don't double-encrypt
    if (isEncrypted(plaintext)) {
        return plaintext;
    }

    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // Format: prefix + iv (base64) + : + authTag (base64) + : + ciphertext (base64)
    return ENCRYPTED_PREFIX +
        iv.toString('base64') + ':' +
        authTag.toString('base64') + ':' +
        encrypted;
}

/**
 * Decrypt an encrypted string value
 * @param {string} ciphertext - Encrypted value with prefix
 * @returns {string} Decrypted plaintext
 */
export function decrypt(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') {
        return ciphertext;
    }

    // If not encrypted, return as-is (for migration from plain text)
    if (!isEncrypted(ciphertext)) {
        return ciphertext;
    }

    try {
        const key = getKey();

        // Parse the encrypted format
        const withoutPrefix = ciphertext.slice(ENCRYPTED_PREFIX.length);
        const parts = withoutPrefix.split(':');

        if (parts.length !== 3) {
            throw new Error('Invalid encrypted format');
        }

        const iv = Buffer.from(parts[0], 'base64');
        const authTag = Buffer.from(parts[1], 'base64');
        const encrypted = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        // If decryption fails (e.g., key changed), return null
        // This allows detection of invalid tokens
        return null;
    }
}

/**
 * Re-encrypt a value if it's stored in plain text
 * Useful for migration of existing configs
 *
 * @param {string} value - Value that may or may not be encrypted
 * @returns {string} Encrypted value
 */
export function ensureEncrypted(value) {
    if (!value || typeof value !== 'string') {
        return value;
    }

    if (isEncrypted(value)) {
        return value;
    }

    return encrypt(value);
}

export default {
    isEncrypted,
    encrypt,
    decrypt,
    ensureEncrypted
};
