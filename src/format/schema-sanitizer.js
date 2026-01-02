/**
 * Schema Sanitizer
 * Sanitizes and flattens Anthropic JSON Schema into a proto-safe format.
 * Removes or transforms invalid/unsafe constructs, recursively builds descriptive text.
 */

function normalizeSchema(schema, depth = 0, maxDepth = 10) {
    if (depth > maxDepth) return { description: '[schema too deep]' };

    if (!schema) return { description: 'any' };

    const descParts = [];

    // Type handling
    if (schema.type) {
        descParts.push(schema.type);
    } else if (schema.enum) {
        descParts.push(`enum (${schema.enum.join('|')})`);
    } else if (schema.oneOf || schema.anyOf) {
        const union = (schema.oneOf || schema.anyOf).map(s => normalizeSchema(s, depth + 1).description);
        descParts.push(`union (${union.join(' | ')})`);
    }

    // Array/items
    if (schema.items) {
        const itemDesc = normalizeSchema(schema.items, depth + 1).description;
        descParts[0] = `array<${itemDesc}>`;  // Override base type
    }

    // Object/properties
    if (schema.properties) {
        const propDescs = Object.entries(schema.properties).map(([key, prop]) => {
            const pDesc = normalizeSchema(prop, depth + 1).description;
            const required = schema.required?.includes(key) ? ' (required)' : '';
            return `${key}: ${pDesc}${required}`;
        });
        descParts.push(`object { ${propDescs.join('; ')} }`);
    }

    // Append user description
    if (schema.description) descParts.push(`— ${schema.description}`);

    // Cap length
    let fullDesc = descParts.join(' ');
    if (fullDesc.length > 200) fullDesc = fullDesc.slice(0, 197) + '...';

    return { description: fullDesc };
}

function normalizeParameters(parameters) {
    if (!parameters?.properties) return { properties: {} };

    const flatProps = {};
    for (const [key, prop] of Object.entries(parameters.properties)) {
        flatProps[key] = normalizeSchema(prop);
    }

    return {
        type: 'object',  // Flat object only
        properties: flatProps,
        required: parameters.required || []
    };
}

export { normalizeParameters };
