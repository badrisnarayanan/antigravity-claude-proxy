/**
 * Request Guard - protects the WebUI and admin endpoints from other web pages
 * and from other machines.
 *
 * Three checks run on the WebUI API and admin endpoints (see isAdminPath).
 * The Anthropic-compatible API (/v1) that Claude Code calls is left alone,
 * so a proxy URL pasted into a client config keeps working from anywhere.
 *
 * 1. Host header: only loopback names, IP literals and hosts listed in
 *    config.allowedHosts / ALLOWED_HOSTS are accepted. This blocks DNS
 *    rebinding, where an attacker's domain is pointed at 127.0.0.1 so that
 *    their page becomes "same origin" with the proxy.
 * 2. Origin header: a browser request whose Origin is not the proxy itself
 *    (or listed in config.corsOrigins / CORS_ORIGINS) is refused. Browsers
 *    send Origin on every cross-origin request and on every non-GET request,
 *    so this stops a page on another site from calling the API. Clients such
 *    as Claude Code and curl send no Origin and are not affected.
 * 3. Remote clients: when no WebUI password is set, the WebUI API and admin
 *    endpoints only answer requests from this machine (loopback).
 */

import crypto from 'crypto';
import net from 'net';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Paths that read or change proxy state, accounts or Claude Code settings.
 * The Anthropic-compatible /v1 API is not included (it has its own API key).
 */
export function isAdminPath(reqPath) {
    return reqPath.startsWith('/api/') ||
        reqPath === '/account-limits' ||
        reqPath === '/refresh-token' ||
        reqPath === '/health' ||
        reqPath.startsWith('/test/');
}

/**
 * Split a Host header value into hostname (lowercase, no brackets) and port.
 * @param {string} hostHeader
 * @returns {{hostname: string, port: string}|null}
 */
export function parseHostHeader(hostHeader) {
    if (!hostHeader || typeof hostHeader !== 'string') return null;
    const value = hostHeader.trim().toLowerCase();
    if (!value) return null;
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        if (end === -1) return null;
        const hostname = value.slice(1, end);
        const rest = value.slice(end + 1);
        if (rest && !/^:\d+$/.test(rest)) return null;
        return { hostname, port: rest ? rest.slice(1) : '' };
    }
    const parts = value.split(':');
    if (parts.length > 2) return null; // bare IPv6 without brackets is not a valid Host
    if (parts.length === 2 && !/^\d+$/.test(parts[1])) return null;
    return { hostname: parts[0], port: parts[1] || '' };
}

/**
 * True when the hostname is a loopback name, any IP literal, or listed.
 * IP literals cannot be used for DNS rebinding, so LAN access by IP keeps working.
 */
export function isAllowedHostname(hostname, allowedHosts = []) {
    if (!hostname) return false;
    if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
    if (hostname.endsWith('.localhost')) return true;
    if (net.isIP(hostname)) return true;
    return allowedHosts.map(h => String(h).trim().toLowerCase()).filter(Boolean).includes(hostname);
}

/**
 * True when the request's Origin is the proxy itself or explicitly allowed.
 * Requests without an Origin header (non-browser clients) are allowed.
 */
export function isAllowedOrigin(originHeader, hostHeader, allowedOrigins = []) {
    if (originHeader === undefined) return true;
    if (!originHeader || originHeader === 'null') return false;
    let origin;
    try {
        origin = new URL(originHeader);
    } catch {
        return false;
    }
    const normalized = `${origin.protocol}//${origin.host}`.toLowerCase();
    if (allowedOrigins.map(o => String(o).trim().replace(/\/+$/, '').toLowerCase()).includes(normalized)) {
        return true;
    }
    // Same origin: the page was served by this proxy under the same Host
    return typeof hostHeader === 'string' && origin.host.toLowerCase() === hostHeader.trim().toLowerCase();
}

/**
 * True when the socket address is loopback (127.0.0.0/8, ::1, ::ffff:127.x).
 */
export function isLoopbackAddress(address) {
    if (!address) return false;
    const addr = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (addr === '::1') return true;
    return net.isIPv4(addr) && addr.startsWith('127.');
}

/**
 * Constant-time string comparison for secrets.
 */
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Parse a comma-separated env var or array config value into a list.
 */
export function toList(value) {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

/**
 * Express middleware enforcing the three checks above.
 * @param {Object} options
 * @param {() => Object} options.getConfig - returns the live config object
 * @param {Object} [options.logger]
 * @param {(reqPath: string) => boolean} [options.isProtected] - which paths to guard (default: isAdminPath)
 */
export function createRequestGuard({ getConfig, logger, isProtected = isAdminPath } = {}) {
    return (req, res, next) => {
        if (!isProtected(req.path)) return next();

        const cfg = getConfig ? getConfig() : {};
        const allowedHosts = [...toList(cfg.allowedHosts), ...toList(process.env.ALLOWED_HOSTS)];
        const allowedOrigins = [...toList(cfg.corsOrigins), ...toList(process.env.CORS_ORIGINS)];
        const hostHeader = req.headers.host;

        const parsedHost = parseHostHeader(hostHeader);
        if (!parsedHost || !isAllowedHostname(parsedHost.hostname, allowedHosts)) {
            logger?.warn?.(`[Security] Blocked request with untrusted Host header: ${String(hostHeader).slice(0, 100)}`);
            return res.status(403).json({
                status: 'error',
                error: 'Forbidden: untrusted Host header. Add the hostname to ALLOWED_HOSTS to allow it.'
            });
        }

        if (!isAllowedOrigin(req.headers.origin, hostHeader, allowedOrigins)) {
            logger?.warn?.(`[Security] Blocked cross-origin ${req.method} ${req.path} from ${String(req.headers.origin).slice(0, 100)}`);
            return res.status(403).json({
                status: 'error',
                error: 'Forbidden: cross-origin request. Add the origin to CORS_ORIGINS to allow it.'
            });
        }

        if (!cfg.webuiPassword && !isLoopbackAddress(req.socket?.remoteAddress)) {
            logger?.warn?.(`[Security] Blocked remote ${req.method} ${req.path} from ${req.socket?.remoteAddress}: no WebUI password set`);
            return res.status(403).json({
                status: 'error',
                error: 'Forbidden: set a WebUI password (WEBUI_PASSWORD) to use the WebUI from another machine.'
            });
        }

        next();
    };
}
