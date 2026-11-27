/**
 * Cloud Code accepts the older Gemini responseSchema, not responseJsonSchema.
 * Only translate the subset observed to work; never flatten JSON Schema unions
 * or silently drop constraints. Unsupported formats are negotiated with clients
 * via an explicit invalid_request_error.
 */
import { getModelFamily } from '../constants.js';
import { logger } from '../utils/logger.js';

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const KEYS = new Set(['type', 'description', 'title', 'properties', 'required', 'items', 'enum', 'additionalProperties']);

function unsupported(reason) {
    throw new Error(`invalid_request_error: output_config is unsupported for this Gemini request on Cloud Code (${reason}); use a schema-in-prompt or native JSON Schema-capable provider`);
}

function translate(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 40) unsupported('invalid or too deep schema');
    if (Object.keys(schema).some(key => !KEYS.has(key))) unsupported('unsupported JSON Schema keyword');
    if (!TYPES.has(schema.type)) unsupported('unsupported JSON Schema type');
    const out = { type: schema.type.toUpperCase() };
    if (typeof schema.description === 'string') out.description = schema.description;
    if (schema.enum !== undefined) {
        if (schema.type !== 'string' || !Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(v => typeof v !== 'string')) unsupported('unsupported enum');
        out.enum = schema.enum;
    }
    if (schema.type === 'object') {
        if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || !Object.keys(schema.properties).length) unsupported('object requires declared properties');
        if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) unsupported('unsupported additionalProperties');
        out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k,v]) => [k, translate(v, depth + 1)]));
        if (schema.required !== undefined) {
            if (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties,k))) unsupported('invalid required properties');
            out.required = schema.required;
        }
        // Cloud Code does not reliably enforce additionalProperties. Validate it
        // against the original schema before returning a successful response.
        if (schema.items !== undefined) unsupported('object has items');
    } else if (schema.type === 'array') {
        out.items = translate(schema.items, depth + 1);
        if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) unsupported('array has object constraints');
    } else if (['properties','required','items','additionalProperties'].some(k => schema[k] !== undefined)) unsupported('incompatible schema constraints');
    return out;
}

const warnedStreamReasons = new Set();

function strictOutputSchema(request, format) {
    if (format.type !== 'json_schema') unsupported('unknown format');
    if (request.tools?.length) unsupported('native tools with structured output not verified');
    return translate(format.schema);
}

export function geminiOutputSchema(request) {
    const format = request.output_config?.format;
    if (getModelFamily(request.model || '') !== 'gemini' || format == null) return undefined;
    if (!request.stream) return strictOutputSchema(request, format);
    // Streaming: Claude Code sends output_config.format on streamed side queries
    // (prompt hooks, classifiers) to the small/fast model, which many users map
    // to Gemini. Apply the schema when it translates; otherwise keep the previous
    // behaviour (drop the format) instead of failing those requests with a 400.
    try {
        return strictOutputSchema(request, format);
    } catch (error) {
        if (!warnedStreamReasons.has(error.message)) {
            warnedStreamReasons.add(error.message);
            logger.warn(`[StructuredOutput] Ignoring output_config.format on streaming Gemini request: ${error.message}`);
        }
        return undefined;
    }
}

function matches(value, schema) {
    if (schema.enum && !schema.enum.includes(value)) return false;
    switch (schema.type) {
        case 'object':
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            if ((schema.required || []).some(k => !Object.hasOwn(value,k))) return false;
            return Object.entries(value).every(([k,v]) => Object.hasOwn(schema.properties,k) ? matches(v,schema.properties[k]) : schema.additionalProperties !== false);
        case 'array': return Array.isArray(value) && value.every(v => matches(v,schema.items));
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        case 'integer': return Number.isInteger(value);
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        default: return false;
    }
}

export function assertGeminiStructuredResponse(request, response) {
    if (!geminiOutputSchema(request) || response.stop_reason === 'max_tokens') return;
    // After a fallback to a non-Gemini model the schema was never sent (it only
    // applies to Gemini), so the reply can't be held to it.
    if (response.model && getModelFamily(response.model) !== 'gemini') return;
    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('');
    let valid = false;
    try { valid = matches(JSON.parse(text), request.output_config.format.schema); } catch {}
    // Do not return HTTP 200 for an empty or schema-invalid completed response.
    if (!valid) throw new Error('Gemini returned an empty or invalid structured response');
}
