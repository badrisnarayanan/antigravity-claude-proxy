/** Bound the complete metadata exchange, including response-body consumption. */
import { throttledFetch } from '../utils/helpers.js';

export async function metadataJSON(url, options, timeoutMs = 2500) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('MODEL_METADATA_TIMEOUT: Metadata lookup exceeded its deadline.'));
        }, timeoutMs);
    });
    const request = (async () => {
        const response = await throttledFetch(url, { ...options, signal: controller.signal });
        return {
            ok: response.ok,
            status: response.status,
            data: response.ok ? await response.json() : await response.text()
        };
    })();
    try {
        return await Promise.race([request, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
