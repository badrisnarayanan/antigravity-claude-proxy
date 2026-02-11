/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Generates randomized device fingerprints to help distribute API usage
 * across different apparent device identities.
 *
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import crypto from 'crypto';
import { IDE_TYPE, PLATFORM, PLUGIN_TYPE, ANTIGRAVITY_VERSION } from '../constants.js';

const OS_VERSIONS = {
    darwin: ['10.15.7', '11.6.8', '12.6.3', '13.5.2', '14.2.1', '14.5'],
    win32: ['10.0.19041', '10.0.19042', '10.0.19043', '10.0.22000', '10.0.22621', '10.0.22631'],
    linux: ['5.15.0', '5.19.0', '6.1.0', '6.2.0', '6.5.0', '6.6.0']
};

const ARCHITECTURES = ['x64', 'arm64'];

const IDE_TYPES = [
    'IDE_UNSPECIFIED',
    'VSCODE',
    'INTELLIJ',
    'ANDROID_STUDIO',
    'CLOUD_SHELL_EDITOR'
];

const SDK_CLIENTS = [
    'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'google-cloud-sdk vscode/1.86.0',
    'google-cloud-sdk vscode/1.87.0',
    'google-cloud-sdk intellij/2024.1',
    'google-cloud-sdk android-studio/2024.1',
    'gcloud-python/1.2.0 grpc-google-iam-v1/0.12.6'
];

/**
 * Maximum number of fingerprint versions to keep in history
 */
export const MAX_FINGERPRINT_HISTORY = 5;

/**
 * Pick a random item from an array
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generateDeviceId() {
    return crypto.randomUUID();
}

function generateSessionToken() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a randomized device fingerprint.
 * Each fingerprint represents a unique "device" identity.
 * @returns {Object} Fingerprint object
 */
export function generateFingerprint() {
    const platform = randomFrom(['darwin', 'win32', 'linux']);
    const arch = randomFrom(ARCHITECTURES);
    const osVersion = randomFrom(OS_VERSIONS[platform] || OS_VERSIONS.linux);

    let matchingPlatform;
    if (platform === 'darwin') matchingPlatform = PLATFORM.MACOS;
    else if (platform === 'win32') matchingPlatform = PLATFORM.WINDOWS;
    else if (platform === 'linux') matchingPlatform = PLATFORM.LINUX;
    else matchingPlatform = PLATFORM.UNSPECIFIED;

    return {
        deviceId: generateDeviceId(),
        sessionToken: generateSessionToken(),
        userAgent: `antigravity/${ANTIGRAVITY_VERSION} ${platform}/${arch}`,
        apiClient: randomFrom(SDK_CLIENTS),
        clientMetadata: {
            ideType: randomFrom(IDE_TYPES),
            platform: matchingPlatform,
            pluginType: PLUGIN_TYPE.GEMINI,
            osVersion: osVersion,
            arch: arch,
            sqmId: `{${crypto.randomUUID().toUpperCase()}}`
        },
        quotaUser: `device-${crypto.randomBytes(8).toString('hex')}`,
        createdAt: Date.now()
    };
}

/**
 * Build HTTP headers from a fingerprint object.
 * These headers are used to identify the "device" making API requests.
 * @param {Object} fingerprint - The fingerprint object
 * @returns {Object} Headers object
 */
export function buildFingerprintHeaders(fingerprint) {
    if (!fingerprint) {
        return {};
    }

    return {
        'User-Agent': fingerprint.userAgent,
        'X-Goog-Api-Client': fingerprint.apiClient,
        'Client-Metadata': JSON.stringify(fingerprint.clientMetadata),
        'X-Goog-QuotaUser': fingerprint.quotaUser,
        'X-Client-Device-Id': fingerprint.deviceId
    };
}

/**
 * Update fingerprint userAgent to current version if outdated.
 * Extracts platform/arch from existing userAgent and rebuilds with current version.
 * @param {Object} fingerprint
 * @returns {Object} Updated fingerprint
 */
export function updateFingerprintVersion(fingerprint) {
    if (!fingerprint || !fingerprint.userAgent) return fingerprint;

    const match = fingerprint.userAgent.match(/^antigravity\/\S+ (.+)$/);
    if (match) {
        const platformArch = match[1];
        const expectedUserAgent = `antigravity/${ANTIGRAVITY_VERSION} ${platformArch}`;
        if (fingerprint.userAgent !== expectedUserAgent) {
            return { ...fingerprint, userAgent: expectedUserAgent };
        }
    }
    return fingerprint;
}
