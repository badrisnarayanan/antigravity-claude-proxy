/** Shared metadata-only subscription lookup; also used during project discovery. */
import { LOAD_CODE_ASSIST_ENDPOINTS, LOAD_CODE_ASSIST_HEADERS, CLIENT_METADATA } from '../constants.js';
import { metadataJSON } from './metadata-http.js';
import { cachedMetadata } from './metadata-cache.js';

export function loadCodeAssistMetadata(token, projectId = null) {
    return cachedMetadata('load-code-assist', token, projectId, async () => {
        const metadata = { ...CLIENT_METADATA };
        if (projectId) metadata.duetProject = projectId;
        for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
            try {
                const response = await metadataJSON(`${endpoint}/v1internal:loadCodeAssist`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...LOAD_CODE_ASSIST_HEADERS },
                    body: JSON.stringify({ metadata, mode: 1 })
                });
                if (!response.ok) continue;
                const data = response.data;
                if (data && typeof data === 'object' && !Array.isArray(data)) return data;
            } catch { /* Try the next metadata endpoint, never a generation request. */ }
        }
        throw new Error('Failed to detect subscription metadata');
    });
}
