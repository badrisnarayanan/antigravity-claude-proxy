/** Short-lived, account/project-scoped metadata cache. Never performs inference. */
import { createHash } from 'node:crypto';

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;
const ERROR_TTL_MS = 10000;
const MAX_ENTRIES = 128;

export function clearMetadataCache() {
    cache.clear();
}

export async function cachedMetadata(kind, token, projectId, load) {
    // Never retain an access token in a cache key or expose it in diagnostics.
    const key = createHash('sha256').update(JSON.stringify([kind, token, projectId || null])).digest('hex');
    const old = cache.get(key);
    if (old?.promise) return old.promise;
    if (old && Date.now() < old.expiresAt) {
        if (old.error) throw old.error;
        return old.value;
    }
    const entry = {};
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    entry.promise = Promise.resolve().then(load).then(value => {
        entry.value = value;
        entry.expiresAt = Date.now() + TTL_MS;
        return value;
    }, error => {
        entry.error = error;
        entry.expiresAt = Date.now() + ERROR_TTL_MS;
        throw error;
    }).finally(() => { entry.promise = null; });
    return entry.promise;
}
