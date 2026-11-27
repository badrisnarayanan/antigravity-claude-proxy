/**
 * Web Search Routing
 *
 * Anthropic's server-side web_search tool is mapped to Google Search
 * grounding (see request-converter.js). Grounding only works on Gemini
 * models: Claude models through Cloud Code ignore it and answer from memory
 * as if they had searched. So a request that only asks for a web search is
 * sent to a Gemini model when the client picked another model.
 */

import { getModelFamily } from '../constants.js';

/**
 * Whether a tool is Anthropic's server-side web_search tool (web_search_20250305, ...)
 * @param {Object} tool
 * @returns {boolean}
 */
export function isWebSearchTool(tool) {
    return typeof tool?.type === 'string' && tool.type.startsWith('web_search');
}

/**
 * Whether a request will be answered with Google Search grounding: it has a
 * web_search tool and either no client tools or a tool_choice that forces
 * web_search (Cloud Code rejects googleSearch mixed with functionDeclarations).
 * @param {Array<Object>} tools
 * @param {Object|string} [toolChoice]
 * @returns {boolean}
 */
export function usesGoogleSearchGrounding(tools, toolChoice) {
    if (!Array.isArray(tools) || tools.length === 0) return false;
    const webSearchTools = tools.filter(isWebSearchTool);
    if (webSearchTools.length === 0) return false;
    const choiceType = typeof toolChoice === 'string' ? toolChoice : toolChoice?.type;
    // tool_choice none: the client asked for no tool use at all, web search included
    if (choiceType === 'none') return false;
    const clientTools = tools.filter(tool => !isWebSearchTool(tool));
    if (clientTools.length === 0) return true;
    const webSearchNames = new Set(webSearchTools.map(t => t.name || 'web_search'));
    return choiceType === 'tool' && webSearchNames.has(toolChoice?.name);
}

/**
 * Rank a Gemini model id for running a web search: a full Flash model at low
 * effort first (fast, cheap, grounds well), then other Flash models, then any
 * other Gemini model. Lite models come last. Higher versions win ties.
 * @param {string} id
 * @returns {number[]} Sort key, smaller is better
 */
function rankSearchModel(id) {
    const lower = id.toLowerCase();
    const isLite = lower.includes('lite');
    const isFlash = lower.includes('flash');
    const isLow = /-low$/.test(lower);
    const version = parseFloat((lower.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0;
    return [isLite ? 1 : 0, isFlash ? 0 : 1, isLow ? 0 : 1, -version];
}

/**
 * Pick the Gemini model to run a web search on
 * @param {Iterable<string>} availableModels - Model ids the account offers
 * @returns {string|null} A Gemini model id, or null when the account has none
 */
export function pickWebSearchModel(availableModels) {
    const gemini = [...(availableModels || [])].filter(id => getModelFamily(id) === 'gemini');
    if (gemini.length === 0) return null;
    gemini.sort((a, b) => {
        const ra = rankSearchModel(a);
        const rb = rankSearchModel(b);
        for (let i = 0; i < ra.length; i++) {
            if (ra[i] !== rb[i]) return ra[i] - rb[i];
        }
        return a.localeCompare(b);
    });
    return gemini[0];
}

/**
 * The model a request should run on: a Gemini model when the request only
 * asks for a web search and the picked model is not Gemini, else the picked model.
 * @param {string} modelId - The resolved model the client asked for
 * @param {Object} request - { tools, tool_choice }
 * @param {Iterable<string>|null} availableModels - Model ids the account offers
 * @returns {string}
 */
export function routeWebSearchModel(modelId, { tools, tool_choice } = {}, availableModels) {
    if (getModelFamily(modelId) === 'gemini') return modelId;
    if (!usesGoogleSearchGrounding(tools, tool_choice)) return modelId;
    return pickWebSearchModel(availableModels) || modelId;
}
