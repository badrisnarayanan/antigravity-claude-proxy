/**
 * Schema Normalizer – turns complex Anthropic JSON Schema into flat proto-safe format
 * Goal: avoid "Unknown name 'type'" / "cannot start list" protobuf validation errors
 */
export function normalizeParameters(original) {
    if (!original || !original.properties) {
        return { type: 'object', properties: {} };
    }

    const flatProps = {};

    for (const [key, def] of Object.entries(original.properties)) {
        flatProps[key] = flattenSchemaDefinition(def);
    }

    return {
        type: 'object',
        properties: flatProps,
        required: original.required || []
    };
}

function flattenSchemaDefinition(def, depth = 0) {
    if (depth > 12) {
        return { description: '[schema too deep]' };
    }

    let desc = [];

    // Base type
    if (def.type) {
        desc.push(def.type);
    }

    // Enum
    if (def.enum) {
        desc.push(`one of: ${def.enum.map(v => JSON.stringify(v)).join(' | ')}`);
    }

    // Array
    if (def.items) {
        const itemDesc = flattenSchemaDefinition(def.items, depth + 1).description;
        desc[0] = `array<${itemDesc}>`;
    }

    // Object / nested properties
    if (def.properties) {
        const nested = Object.entries(def.properties)
            .map(([k, v]) => {
                const sub = flattenSchemaDefinition(v, depth + 1);
                const req = def.required?.includes(k) ? ' (req)' : '';
                return `${k}: ${sub.description}${req}`;
            })
            .join('; ');
        desc.push(`{ ${nested} }`);
    }

    // Union / oneOf / anyOf
    if (def.oneOf || def.anyOf) {
        const union = (def.oneOf || def.anyOf)
            .map(s => flattenSchemaDefinition(s, depth + 1).description)
            .join(' | ');
        desc.push(`(${union})`);
    }

    // User-provided description
    if (def.description) {
        desc.push(`— ${def.description}`);
    }

    let finalDesc = desc.filter(Boolean).join(' ').trim();
    if (finalDesc.length > 240) {
        finalDesc = finalDesc.slice(0, 237) + '…';
    }

    return { description: finalDesc || 'any' };
}