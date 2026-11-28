const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORT_LEVELS.join('|')})$`);

/** Resolve effort using only Gemini tiers the account catalog says are available. */
export function resolveGeminiEffort(model, effort, isAvailable) {
    if (typeof model !== 'string' || !model.startsWith('gemini-')) return model;

    const id = model.replace(/\[[^\]]*\]$/, '');
    // Claude Code can send a default effort even on a fixed-tier model.
    if (EFFORT_SUFFIX.test(id)) return model;
    const family = id.replace(/-tiered$/, '');
    const tiered = `${family}-tiered`;

    if (effort == null) {
        if (isAvailable(id)) return id;
        if (id === family) {
            if (isAvailable(tiered)) return tiered;
            if (isAvailable(`${family}-medium`)) return `${family}-medium`;
            if (isAvailable(`${tiered}-medium`)) return `${tiered}-medium`;
        }
        return model;
    }

    const availableTiers = EFFORT_LEVELS.filter(level =>
        isAvailable(`${family}-${level}`) || isAvailable(`${tiered}-${level}`));
    if (availableTiers.length === 0) return model;
    if (!availableTiers.includes(effort)) {
        throw new Error(`invalid_request_error: Unsupported effort for ${family}. Available levels: ${availableTiers.join(', ')}.`);
    }

    const requested = `${id}-${effort}`;
    if (isAvailable(requested)) return requested;
    return id === tiered ? `${family}-${effort}` : `${tiered}-${effort}`;
}

/** Advertise stable Gemini IDs without changing the account's fixed-tier rows. */
export function addGeminiEffortAliases(catalog) {
    const listed = new Set(catalog.data.map(model => model.id));
    const aliases = [];
    for (const model of catalog.data) {
        if (!model.id.startsWith('gemini-') || !model.id.endsWith('-medium')) continue;
        const id = model.id.replace(/(?:-tiered)?-medium$/, '');
        if (listed.has(id)) continue;
        const alias = {
            ...model,
            id,
            description: model.description?.replace(/\s*\(medium\)$/i, '') || id
        };
        delete alias.thinking_level;
        aliases.push(alias);
        listed.add(id);
    }
    return { ...catalog, data: [...catalog.data, ...aliases] };
}
