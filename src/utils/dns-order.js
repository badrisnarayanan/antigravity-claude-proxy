// Prefer IPv4 when a host has both IPv4 and IPv6 addresses (#384).
//
// On networks where IPv6 is advertised but doesn't actually route to Google, Node can
// try the IPv6 address first and the request hangs until it times out. Preferring
// IPv4 avoids that, and costs nothing on networks where both work.
//
// The user can still choose: an explicit --dns-result-order (in NODE_OPTIONS or on the
// node command line) is left alone, and DNS_RESULT_ORDER=ipv4first|ipv6first|verbatim
// sets the order directly.
import dns from 'dns';
import { logger } from './logger.js';

const VALID_ORDERS = ['ipv4first', 'ipv6first', 'verbatim'];

/**
 * Work out which DNS result order to apply, if any
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to read
 * @param {string[]} [options.execArgv=process.execArgv] - Node command-line flags
 * @returns {{order: string|null, source: string}} order to set (null = leave Node's choice), and why
 */
export function resolveDnsResultOrder({ env = process.env, execArgv = process.execArgv } = {}) {
    const fromEnv = (env.DNS_RESULT_ORDER || '').trim().toLowerCase();
    if (fromEnv) {
        if (VALID_ORDERS.includes(fromEnv)) {
            return { order: fromEnv, source: 'DNS_RESULT_ORDER' };
        }
        logger.warn(`[DNS] Ignoring DNS_RESULT_ORDER="${env.DNS_RESULT_ORDER}". Use one of: ${VALID_ORDERS.join(', ')}.`);
    }

    const nodeFlags = [...execArgv, env.NODE_OPTIONS || ''].join(' ');
    if (nodeFlags.includes('--dns-result-order')) {
        return { order: null, source: '--dns-result-order' };
    }

    return { order: 'ipv4first', source: 'default' };
}

/**
 * Apply the DNS result order for outbound requests. Call once at startup.
 * @param {Object} [options] - Same as resolveDnsResultOrder
 * @returns {string|null} The order that was set, or null if Node's own setting was kept
 */
export function initDnsResultOrder(options) {
    const { order, source } = resolveDnsResultOrder(options);
    if (!order) {
        logger.debug(`[DNS] Keeping the DNS order set by ${source}`);
        return null;
    }
    try {
        dns.setDefaultResultOrder(order);
        if (source !== 'default') {
            logger.info(`[DNS] Using DNS result order ${order} (from ${source})`);
        }
        return order;
    } catch (error) {
        logger.warn(`[DNS] Could not set DNS result order ${order}: ${error.message}`);
        return null;
    }
}

// Auto-initialize on import
initDnsResultOrder();
