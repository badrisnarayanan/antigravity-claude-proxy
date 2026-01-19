/**
 * Input Validation Utilities
 * Provides validation functions for user inputs
 */
window.Validators = window.Validators || {};

/**
 * Validate a number is within a range
 * @param {number} value - Value to validate
 * @param {number} min - Minimum allowed value (inclusive)
 * @param {number} max - Maximum allowed value (inclusive)
 * @param {string} fieldName - Name of the field for error messages
 * @returns {object} { isValid: boolean, value: number, error: string|null }
 */
window.Validators.validateRange = function(value, min, max, fieldName = 'Value') {
    const numValue = Number(value);
    const t = Alpine.store('global').t;

    if (isNaN(numValue)) {
        return {
            isValid: false,
            value: min,
            error: t('mustBeValidNumber', { fieldName })
        };
    }

    if (numValue < min) {
        return {
            isValid: false,
            value: min,
            error: t('mustBeAtLeast', { fieldName, min })
        };
    }

    if (numValue > max) {
        return {
            isValid: false,
            value: max,
            error: t('mustBeAtMost', { fieldName, max })
        };
    }

    return {
        isValid: true,
        value: numValue,
        error: null
    };
};

/**
 * Validate a timeout/duration value (in milliseconds)
 * @param {number} value - Timeout value in ms
 * @param {number} minMs - Minimum allowed timeout (default: from constants)
 * @param {number} maxMs - Maximum allowed timeout (default: from constants)
 * @returns {object} { isValid: boolean, value: number, error: string|null }
 */
window.Validators.validateTimeout = function(value, minMs = null, maxMs = null) {
    const { TIMEOUT_MIN, TIMEOUT_MAX } = window.AppConstants.VALIDATION;
    return window.Validators.validateRange(value, minMs ?? TIMEOUT_MIN, maxMs ?? TIMEOUT_MAX, 'Timeout');
};

/**
 * Validate and sanitize input with custom validator
 * @param {any} value - Value to validate
 * @param {Function} validator - Validator function
 * @param {boolean} showError - Whether to show error toast (default: true)
 * @returns {object} Validation result
 */
window.Validators.validate = function(value, validator, showError = true) {
    const result = validator(value);

    if (!result.isValid && showError && result.error) {
        window.ErrorHandler.showError(result.error);
    }

    return result;
};
