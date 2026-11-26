// Outbound proxy support from the standard env vars (HTTPS_PROXY, HTTP_PROXY, NO_PROXY,
// upper or lower case). Import before any fetch call (see src/index.js).
//
// Requests go out through undici's own fetch with this dispatcher passed explicitly
// (see throttledFetch in helpers.js). Setting only undici's global dispatcher is not
// enough: Node's built-in fetch reads the global dispatcher slot of the undici version
// bundled with Node, which can differ from ours (Node 26 bundles undici 8, while older
// releases of this package shipped undici 7), so requests silently skipped the proxy.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';

let proxyDispatcher = null;

/**
 * Hide any user:password in a proxy URL before logging it
 * @param {string} url - Proxy URL
 * @returns {string} URL safe to log
 */
export function redactProxyUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '';
        }
        return parsed.toString();
    } catch {
        return '<invalid proxy URL>';
    }
}

/**
 * Initialize proxy support from environment variables
 * Call this once at application startup
 * @param {Object} [env=process.env] - Environment to read
 * @returns {import('undici').Dispatcher|null} The proxy dispatcher, or null if no proxy is set
 */
export function initProxy(env = process.env) {
    const httpProxy = env.http_proxy || env.HTTP_PROXY;
    const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
    // '' (not undefined) so undici doesn't fall back to process.env when a custom env is passed
    const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';

    proxyDispatcher = null;
    if (!httpProxy && !httpsProxy) {
        return null;
    }

    try {
        // EnvHttpProxyAgent picks the proxy per request: HTTPS_PROXY for https URLs
        // (falling back to HTTP_PROXY), and no proxy for hosts listed in NO_PROXY.
        const agent = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
        proxyDispatcher = agent;
        // Also set it globally, for any code that uses undici's request APIs directly.
        setGlobalDispatcher(agent);
        logger.info(`[Proxy] Using proxy: ${redactProxyUrl(httpsProxy || httpProxy)}` +
            (noProxy ? ` (NO_PROXY: ${noProxy})` : ''));
    } catch (error) {
        logger.error(`[Proxy] Failed to configure proxy: ${error.message}`);
    }
    return proxyDispatcher;
}

/**
 * The dispatcher outbound requests should use, or null when no proxy is configured
 * @returns {import('undici').Dispatcher|null}
 */
export function getProxyDispatcher() {
    return proxyDispatcher;
}

// Auto-initialize on import
initProxy();
