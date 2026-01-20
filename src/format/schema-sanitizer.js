/**
 * Schema Sanitizer
 * Cleans and transforms JSON schemas for Gemini/Antigravity API compatibility
 *
 * Uses a multi-phase pipeline matching opencode-antigravity-auth approach:
 * - Phase 1: Convert $refs to description hints
 * - Phase 2a: Merge allOf schemas
 * - Phase 2b: Flatten anyOf/oneOf (select best option)
 * - Phase 2c: Flatten type arrays + update required for nullable
 * - Phase 3: Remove unsupported keywords
 * - Phase 4: Final cleanup (required array validation)
 */

/**
 * Append a hint to a schema's description field.
 * Format: "existing (hint)" or just "hint" if no existing description.
 *
 * @param {Object} schema - Schema object to modify
 * @param {string} hint - Hint text to append
 * @returns {Object} Modified schema with appended description
 */
function appendDescriptionHint(schema, hint) {
    if (!schema || typeof schema !== 'object') return schema;
    const result = { ...schema };
    result.description = result.description
        ? `${result.description} (${hint})`
        : hint;
    return result;
}

/**
 * Score a schema option for anyOf/oneOf selection.
 * Higher scores = more preferred schemas.
 *
 * @param {Object} schema - Schema option to score
 * @returns {number} Score (0-3)
 */
function scoreSchemaOption(schema) {
    if (!schema || typeof schema !== 'object') return 0;

    // Score 3: Object types with properties (most informative)
    if (schema.type === 'object' || schema.properties) return 3;

    // Score 2: Array types with items
    if (schema.type === 'array' || schema.items) return 2;

    // Score 1: Any other non-null type
    if (schema.type && schema.type !== 'null') return 1;

    // Score 0: Null or no type
    return 0;
}

/**
 * Convert $ref references to description hints.
 * Replaces { $ref: "#/$defs/Foo" } with { type: "object", description: "See: Foo" }
 *
 * @param {Object} schema - Schema to process
 * @returns {Object} Schema with refs converted to hints
 */
function convertRefsToHints(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(convertRefsToHints);

    const result = { ...schema };

    // Handle $ref at this level
    if (result.$ref && typeof result.$ref === 'string') {
        // Extract definition name from ref path (e.g., "#/$defs/Foo" -> "Foo")
        const parts = result.$ref.split('/');
        const defName = parts[parts.length - 1] || 'unknown';
        const hint = `See: ${defName}`;

        // Merge with existing description if present
        const description = result.description
            ? `${result.description} (${hint})`
            : hint;

        // Replace with object type and hint
        return { type: 'object', description };
    }

    // Recursively process properties
    if (result.properties && typeof result.properties === 'object') {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            result.properties[key] = convertRefsToHints(value);
        }
    }

    // Recursively process items
    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(convertRefsToHints);
        } else if (typeof result.items === 'object') {
            result.items = convertRefsToHints(result.items);
        }
    }

    // Recursively process anyOf/oneOf/allOf
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(result[key])) {
            result[key] = result[key].map(convertRefsToHints);
        }
    }

    return result;
}

/**
 * Merge all schemas in an allOf array into a single schema.
 * Properties and required arrays are merged; other fields use first occurrence.
 *
 * @param {Object} schema - Schema with potential allOf to merge
 * @returns {Object} Schema with allOf merged
 */
function mergeAllOf(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(mergeAllOf);

    let result = { ...schema };

    // Process allOf if present
    if (Array.isArray(result.allOf) && result.allOf.length > 0) {
        const mergedProperties = {};
        const mergedRequired = new Set();
        const otherFields = {};

        for (const subSchema of result.allOf) {
            if (!subSchema || typeof subSchema !== 'object') continue;

            // Merge properties (later overrides earlier)
            if (subSchema.properties) {
                for (const [key, value] of Object.entries(subSchema.properties)) {
                    mergedProperties[key] = value;
                }
            }

            // Union required arrays
            if (Array.isArray(subSchema.required)) {
                for (const req of subSchema.required) {
                    mergedRequired.add(req);
                }
            }

            // Copy other fields (first occurrence wins)
            for (const [key, value] of Object.entries(subSchema)) {
                if (key !== 'properties' && key !== 'required' && !(key in otherFields)) {
                    otherFields[key] = value;
                }
            }
        }

        // Apply merged content
        delete result.allOf;

        // Merge other fields first (parent takes precedence)
        for (const [key, value] of Object.entries(otherFields)) {
            if (!(key in result)) {
                result[key] = value;
            }
        }

        // Merge properties (allOf properties override parent for same keys)
        if (Object.keys(mergedProperties).length > 0) {
            result.properties = { ...mergedProperties, ...(result.properties || {}) };
        }

        // Merge required
        if (mergedRequired.size > 0) {
            const parentRequired = Array.isArray(result.required) ? result.required : [];
            result.required = [...new Set([...mergedRequired, ...parentRequired])];
        }
    }

    // Recursively process properties
    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = mergeAllOf(value);
        }
        result.properties = newProps;
    }

    // Recursively process items
    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(mergeAllOf);
        } else if (typeof result.items === 'object') {
            result.items = mergeAllOf(result.items);
        }
    }

    return result;
}

/**
 * Flatten anyOf/oneOf by selecting the best option based on scoring.
 * Adds type hints to description when multiple types existed.
 *
 * @param {Object} schema - Schema with potential anyOf/oneOf
 * @returns {Object} Flattened schema
 */
function flattenAnyOfOneOf(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(flattenAnyOfOneOf);

    let result = { ...schema };

    // Handle anyOf or oneOf
    for (const unionKey of ['anyOf', 'oneOf']) {
        if (Array.isArray(result[unionKey]) && result[unionKey].length > 0) {
            const options = result[unionKey];

            // Collect type names for hint
            const typeNames = [];
            let bestOption = null;
            let bestScore = -1;

            for (const option of options) {
                if (!option || typeof option !== 'object') continue;

                // Collect type name
                const typeName = option.type || (option.properties ? 'object' : null);
                if (typeName && typeName !== 'null') {
                    typeNames.push(typeName);
                }

                // Score and track best option
                const score = scoreSchemaOption(option);
                if (score > bestScore) {
                    bestScore = score;
                    bestOption = option;
                }
            }

            // Remove the union key
            delete result[unionKey];

            // Merge best option into result
            if (bestOption) {
                // Preserve parent description
                const parentDescription = result.description;

                // Recursively flatten the best option
                const flattenedOption = flattenAnyOfOneOf(bestOption);

                // Merge fields from selected option
                for (const [key, value] of Object.entries(flattenedOption)) {
                    if (key === 'description') {
                        // Merge descriptions if different
                        if (value && value !== parentDescription) {
                            result.description = parentDescription
                                ? `${parentDescription} (${value})`
                                : value;
                        }
                    } else if (!(key in result) || key === 'type' || key === 'properties' || key === 'items') {
                        result[key] = value;
                    }
                }

                // Add type hint if multiple types existed
                if (typeNames.length > 1) {
                    const uniqueTypes = [...new Set(typeNames)];
                    result = appendDescriptionHint(result, `Accepts: ${uniqueTypes.join(' | ')}`);
                }
            }
        }
    }

    // Recursively process properties
    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = flattenAnyOfOneOf(value);
        }
        result.properties = newProps;
    }

    // Recursively process items
    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(flattenAnyOfOneOf);
        } else if (typeof result.items === 'object') {
            result.items = flattenAnyOfOneOf(result.items);
        }
    }

    return result;
}

// ============================================================================
// Enhanced Schema Hints (for preserving semantic information)
// ============================================================================

/**
 * Add hints for enum values (if ≤10 values).
 * This preserves enum information in the description since Gemini
 * may not fully support enums in all cases.
 *
 * @param {Object} schema - Schema to process
 * @returns {Object} Schema with enum hints added to description
 */
function addEnumHints(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(addEnumHints);

    let result = { ...schema };

    // Add enum hint if present and reasonable size
    if (Array.isArray(result.enum) && result.enum.length > 1 && result.enum.length <= 10) {
        const vals = result.enum.map(v => String(v)).join(', ');
        result = appendDescriptionHint(result, `Allowed: ${vals}`);
    }

    // Recursively process properties
    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = addEnumHints(value);
        }
        result.properties = newProps;
    }

    // Recursively process items
    if (result.items) {
        result.items = Array.isArray(result.items)
            ? result.items.map(addEnumHints)
            : addEnumHints(result.items);
    }

    return result;
}

/**
 * Add hints for additionalProperties: false.
 * This informs the model that extra properties are not allowed.
 *
 * @param {Object} schema - Schema to process
 * @returns {Object} Schema with additionalProperties hints added
 */
function addAdditionalPropertiesHints(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(addAdditionalPropertiesHints);

    let result = { ...schema };

    if (result.additionalProperties === false) {
        result = appendDescriptionHint(result, 'No extra properties allowed');
    }

    // Recursively process properties
    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = addAdditionalPropertiesHints(value);
        }
        result.properties = newProps;
    }

    // Recursively process items
    if (result.items) {
        result.items = Array.isArray(result.items)
            ? result.items.map(addAdditionalPropertiesHints)
            : addAdditionalPropertiesHints(result.items);
    }

    return result;
}

/**
 * Move unsupported constraints to description hints.
 * This preserves constraint information that would otherwise be lost
 * when we strip unsupported keywords.
 *
 * @param {Object} schema - Schema to process
 * @returns {Object} Schema with constraint hints added to description
 */
function moveConstraintsToDescription(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(moveConstraintsToDescription);

    const CONSTRAINTS = ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
                         'minItems', 'maxItems', 'format'];

    let result = { ...schema };

    for (const constraint of CONSTRAINTS) {
        if (result[constraint] !== undefined && typeof result[constraint] !== 'object') {
            result = appendDescriptionHint(result, `${constraint}: ${result[constraint]}`);
        }
    }

    // Recursively process properties
    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = moveConstraintsToDescription(value);
        }
        result.properties = newProps;
    }

    // Recursively process items
    if (result.items) {
        result.items = Array.isArray(result.items)
            ? result.items.map(moveConstraintsToDescription)
            : moveConstraintsToDescription(result.items);
    }

    return result;
}

/**
 * Flatten array type fields and track nullable properties.
 * Converts { type: ["string", "null"] } to { type: "string" } with nullable hint.
 *
 * @param {Object} schema - Schema to process
 * @param {Set<string>} nullableProps - Set to collect nullable property names (mutated)
 * @param {string} currentPropName - Current property name (for tracking)
 * @returns {Object} Flattened schema
 */
function flattenTypeArrays(schema, nullableProps = null, currentPropName = null) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => flattenTypeArrays(s, nullableProps));

    let result = { ...schema };

    // Handle array type fields
    if (Array.isArray(result.type)) {
        const types = result.type;
        const hasNull = types.includes('null');
        const nonNullTypes = types.filter(t => t !== 'null' && t);

        // Select first non-null type, or 'string' as fallback
        const firstType = nonNullTypes.length > 0 ? nonNullTypes[0] : 'string';
        result.type = firstType;

        // Add hint for multiple types
        if (nonNullTypes.length > 1) {
            result = appendDescriptionHint(result, `Accepts: ${nonNullTypes.join(' | ')}`);
        }

        // Track nullable and add hint
        if (hasNull) {
            result = appendDescriptionHint(result, 'nullable');
            // Track this property as nullable for required array update
            if (nullableProps && currentPropName) {
                nullableProps.add(currentPropName);
            }
        }
    }

    // Recursively process properties, tracking nullable ones
    if (result.properties && typeof result.properties === 'object') {
        const childNullableProps = new Set();
        const newProps = {};

        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = flattenTypeArrays(value, childNullableProps, key);
        }
        result.properties = newProps;

        // Remove nullable properties from required array
        if (Array.isArray(result.required) && childNullableProps.size > 0) {
            result.required = result.required.filter(prop => !childNullableProps.has(prop));
            if (result.required.length === 0) {
                delete result.required;
            }
        }
    }

    // Recursively process items
    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(item => flattenTypeArrays(item, nullableProps));
        } else if (typeof result.items === 'object') {
            result.items = flattenTypeArrays(result.items, nullableProps);
        }
    }

    return result;
}

/**
 * Sanitize JSON Schema for Antigravity API compatibility.
 * Uses allowlist approach - only permit known-safe JSON Schema features.
 * Converts "const" to equivalent "enum" for compatibility.
 * Generates placeholder schema for empty tool schemas.
 */
export function sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        // Empty/missing schema - generate placeholder with reason property
        return {
            type: 'object',
            properties: {
                reason: {
                    type: 'string',
                    description: 'Reason for calling this tool'
                }
            },
            required: ['reason']
        };
    }

    // Allowlist of permitted JSON Schema fields
    const ALLOWED_FIELDS = new Set([
        'type',
        'description',
        'properties',
        'required',
        'items',
        'enum',
        'title'
    ]);

    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        // Convert "const" to "enum" for compatibility
        if (key === 'const') {
            sanitized.enum = [value];
            continue;
        }

        // Skip fields not in allowlist
        if (!ALLOWED_FIELDS.has(key)) {
            continue;
        }

        if (key === 'properties' && value && typeof value === 'object') {
            sanitized.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                sanitized.properties[propKey] = sanitizeSchema(propValue);
            }
        } else if (key === 'items' && value && typeof value === 'object') {
            if (Array.isArray(value)) {
                sanitized.items = value.map(item => sanitizeSchema(item));
            } else {
                sanitized.items = sanitizeSchema(value);
            }
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            sanitized[key] = sanitizeSchema(value);
        } else {
            sanitized[key] = value;
        }
    }

    // Ensure we have at least a type
    if (!sanitized.type) {
        sanitized.type = 'object';
    }

    // If object type with no properties, add placeholder
    if (sanitized.type === 'object' && (!sanitized.properties || Object.keys(sanitized.properties).length === 0)) {
        sanitized.properties = {
            reason: {
                type: 'string',
                description: 'Reason for calling this tool'
            }
        };
        sanitized.required = ['reason'];
    }

    return sanitized;
}

/**
 * Convert JSON Schema type names to Google's Protobuf-style uppercase type names.
 * Google's Generative AI API expects uppercase types: STRING, OBJECT, ARRAY, etc.
 *
 * @param {string} type - JSON Schema type name (lowercase)
 * @returns {string} Google-format type name (uppercase)
 */
function toGoogleType(type) {
    if (!type || typeof type !== 'string') return type;
    const typeMap = {
        'string': 'STRING',
        'number': 'NUMBER',
        'integer': 'INTEGER',
        'boolean': 'BOOLEAN',
        'array': 'ARRAY',
        'object': 'OBJECT',
        'null': 'STRING'  // Fallback for null type
    };
    return typeMap[type.toLowerCase()] || type.toUpperCase();
}

/**
 * Cleans JSON schema for Gemini API compatibility.
 * Uses a multi-phase pipeline matching opencode-antigravity-auth approach.
 *
 * @param {Object} schema - The JSON schema to clean
 * @returns {Object} Cleaned schema safe for Gemini API
 */
export function cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(cleanSchema);

    // Phase 1: Convert $refs to hints
    let result = convertRefsToHints(schema);

    // Phase 1b: Add enum hints (preserves enum info in description)
    result = addEnumHints(result);

    // Phase 1c: Add additionalProperties hints
    result = addAdditionalPropertiesHints(result);

    // Phase 1d: Move constraints to description (before they get stripped)
    result = moveConstraintsToDescription(result);

    // Phase 2a: Merge allOf schemas
    result = mergeAllOf(result);

    // Phase 2b: Flatten anyOf/oneOf
    result = flattenAnyOfOneOf(result);

    // Phase 2c: Flatten type arrays and update required for nullable
    result = flattenTypeArrays(result);

    // Phase 3: Remove unsupported keywords
    const unsupported = [
        'additionalProperties', 'default', '$schema', '$defs',
        'definitions', '$ref', '$id', '$comment', 'title',
        'minLength', 'maxLength', 'pattern', 'format',
        'minItems', 'maxItems', 'examples', 'allOf', 'anyOf', 'oneOf'
    ];

    for (const key of unsupported) {
        delete result[key];
    }

    // Check for unsupported 'format' in string types
    if (result.type === 'string' && result.format) {
        const allowed = ['enum', 'date-time'];
        if (!allowed.includes(result.format)) {
            delete result.format;
        }
    }

    // Phase 4: Final cleanup - recursively clean nested schemas and validate required
    if (result.properties && typeof result.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = cleanSchema(value);
        }
        result.properties = newProps;
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            result.items = result.items.map(cleanSchema);
        } else if (typeof result.items === 'object') {
            result.items = cleanSchema(result.items);
        }
    }

    // Validate that required array only contains properties that exist
    if (result.required && Array.isArray(result.required) && result.properties) {
        const definedProps = new Set(Object.keys(result.properties));
        result.required = result.required.filter(prop => definedProps.has(prop));
        if (result.required.length === 0) {
            delete result.required;
        }
    }

    // Phase 5: Convert type to Google's uppercase format (STRING, OBJECT, ARRAY, etc.)
    // Only convert at current level - nested types already converted by recursive cleanSchema calls
    if (result.type && typeof result.type === 'string') {
        result.type = toGoogleType(result.type);
    }

    // Phase 6: Remove extension fields (blocklist approach to preserve standard keywords)
    // Only remove fields starting with x- to avoid breaking standard JSON schema features
    for (const key of Object.keys(result)) {
        if (key.startsWith('x-')) {
            delete result[key];
        }
    }

    return result;
}
