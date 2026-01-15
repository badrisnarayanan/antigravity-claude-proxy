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
 * Validate a port number
 * @param {number} port - Port number to validate
 * @returns {object} { isValid: boolean, value: number, error: string|null }
 */
window.Validators.validatePort = function(port) {
    const { PORT_MIN, PORT_MAX } = window.AppConstants.VALIDATION;
    return window.Validators.validateRange(port, PORT_MIN, PORT_MAX, 'Port');
};

/**
 * Validate a string is not empty
 * @param {string} value - String to validate
 * @param {string} fieldName - Name of the field for error messages
 * @returns {object} { isValid: boolean, value: string, error: string|null }
 */
window.Validators.validateNotEmpty = function(value, fieldName = 'Field') {
    const trimmedValue = String(value || '').trim();
    const t = Alpine.store('global').t;

    if (trimmedValue.length === 0) {
        return {
            isValid: false,
            value: trimmedValue,
            error: t('cannotBeEmpty', { fieldName })
        };
    }

    return {
        isValid: true,
        value: trimmedValue,
        error: null
    };
};

/**
 * Validate a boolean value
 * @param {any} value - Value to validate as boolean
 * @returns {object} { isValid: boolean, value: boolean, error: string|null }
 */
window.Validators.validateBoolean = function(value) {
    if (typeof value === 'boolean') {
        return {
            isValid: true,
            value: value,
            error: null
        };
    }

    // Try to coerce common values
    if (value === 'true' || value === 1 || value === '1') {
        return { isValid: true, value: true, error: null };
    }

    if (value === 'false' || value === 0 || value === '0') {
        return { isValid: true, value: false, error: null };
    }

    return {
        isValid: false,
        value: false,
        error: Alpine.store('global').t('mustBeTrueOrFalse')
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
 * Validate log limit
 * @param {number} value - Log limit value
 * @returns {object} { isValid: boolean, value: number, error: string|null }
 */
window.Validators.validateLogLimit = function(value) {
    const { LOG_LIMIT_MIN, LOG_LIMIT_MAX } = window.AppConstants.VALIDATION;
    return window.Validators.validateRange(value, LOG_LIMIT_MIN, LOG_LIMIT_MAX, 'Log limit');
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

/**
 * Create a validated input handler for Alpine.js
 * @param {Function} validator - Validator function
 * @param {Function} onValid - Callback when validation passes
 * @returns {Function} Handler function
 */
window.Validators.createHandler = function(validator, onValid) {
    return function(value) {
        const result = window.Validators.validate(value, validator, true);

        if (result.isValid && onValid) {
            onValid.call(this, result.value);
        }

        return result.value;
    };
};
