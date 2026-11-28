const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORT_LEVELS.join('|')})$`);

function stripContextSuffix(model) {
    return model.replace(/\[[^\]]*\]$/, '');
}

export function isEffortFamily(model) {
    if (typeof model !== 'string') return false;
    const id = stripContextSuffix(model);
    return !EFFORT_SUFFIX.test(id) && (id.startsWith('gemini-') || /^claude-(?:opus|sonnet|haiku|fable)-\d+-\d+$/.test(id));
}

/** Resolve the requested effort against advertised tiers of the same model family. */
export function resolveModelEffort(model, effort, isAvailable) {
    // Claude Code can send a default effort even on a fixed-tier model.
    if (!isEffortFamily(model)) return model;

    const id = stripContextSuffix(model);
    const gemini = id.startsWith('gemini-');
    const family = gemini ? id.replace(/-tiered$/, '') : id;
    const tiered = gemini ? `${family}-tiered` : null;
    const alternate = tiered === id ? family : tiered;
    const modelForTier = level => {
        const direct = `${id}-${level}`;
        if (isAvailable(direct)) return direct;
        const other = alternate && `${alternate}-${level}`;
        return other && isAvailable(other) ? other : null;
    };

    if (effort == null) {
        if (isAvailable(id)) return id;
        if (id === family && tiered && isAvailable(tiered)) return tiered;
        return modelForTier('medium') || model;
    }

    const availableTiers = EFFORT_LEVELS.filter(level => modelForTier(level));
    if (availableTiers.length === 0) return model;
    if (!availableTiers.includes(effort)) {
        throw new Error(`invalid_request_error: Unsupported effort for ${family}. Available levels: ${availableTiers.join(', ')}.`);
    }

    return modelForTier(effort);
}

/** Advertise a family ID when an account offers its Medium tier. */
export function addModelEffortAliases(catalog) {
    const listed = new Set(catalog.data.map(model => model.id));
    const aliases = [];
    for (const model of catalog.data) {
        if (!model.id.endsWith('-medium')) continue;
        const id = model.id.replace(/(?:-tiered)?-medium$/, '');
        if (!isEffortFamily(id) || listed.has(id)) continue;
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
