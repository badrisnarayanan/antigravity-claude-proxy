/**
 * Google Cloud Code error parsing helpers.
 *
 * The Cloud Code API often returns structured JSON errors. We want to
 * extract actionable info (e.g. VALIDATION_REQUIRED + validation_url)
 * without surfacing the full raw JSON to end users.
 */

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Extract "Verify your account" validation info from an upstream error body.
 *
 * @param {string} errorText - Raw response body text
 * @returns {{message: string, validationUrl: string|null}|null}
 */
export function extractValidationRequiredInfo(errorText) {
    const text = (errorText || '').trim();
    if (!text) return null;

    // Fast path: if neither the reason nor the common message is present, skip JSON parse.
    const upper = text.toUpperCase();
    if (!upper.includes('VALIDATION_REQUIRED') && !upper.includes('VERIFY YOUR ACCOUNT')) {
        return null;
    }

    const data = tryParseJson(text);
    const messageFromTop = data?.error?.message;
    const details = Array.isArray(data?.error?.details) ? data.error.details : [];

    let message = typeof messageFromTop === 'string' && messageFromTop.trim() ? messageFromTop.trim() : null;
    let validationUrl = null;

    for (const d of details) {
        if (!d || typeof d !== 'object') continue;

        const reason = d.reason;
        const md = d.metadata && typeof d.metadata === 'object' ? d.metadata : null;

        if (reason === 'VALIDATION_REQUIRED') {
            if (md?.validation_error_message && typeof md.validation_error_message === 'string') {
                message = md.validation_error_message;
            }
            if (md?.validation_url && typeof md.validation_url === 'string') {
                validationUrl = md.validation_url;
            }
        }

        // Some responses include the URL in Help.links rather than ErrorInfo.metadata.
        if (!validationUrl && Array.isArray(d.links)) {
            const verifyLink = d.links.find(l =>
                l &&
                typeof l === 'object' &&
                typeof l.url === 'string' &&
                typeof l.description === 'string' &&
                l.description.toLowerCase().includes('verify')
            );
            if (verifyLink) {
                validationUrl = verifyLink.url;
            }
        }

        if (validationUrl && message) break;
    }

    // Regex fallback for common account validation URLs embedded in JSON/string.
    if (!validationUrl) {
        const m = text.match(/https:\/\/accounts\.google\.com\/signin\/continue[^"\s]+/);
        if (m) validationUrl = m[0];
    }

    // Only treat as validation-required if we have a strong signal.
    const looksLikeValidation = upper.includes('VALIDATION_REQUIRED') || (typeof message === 'string' && message.toLowerCase().includes('verify your account'));
    if (!looksLikeValidation) return null;

    return {
        message: message || 'Verify your account to continue.',
        validationUrl
    };
}

