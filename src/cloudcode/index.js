/**
 * Cloud Code Client for Antigravity
 *
 * Communicates with Google's Cloud Code internal API using the
 * v1internal:streamGenerateContent endpoint with proper request wrapping.
 *
 * Supports multi-account load balancing with automatic failover.
 *
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

// Re-export public API
export { sendMessage } from './message-handler.js';
export { sendMessageStream } from './streaming-handler.js';
export { listModels, fetchAvailableModels, getModelQuotas, getUserQuotaSummary, getSubscriptionTier, isValidModel } from './model-api.js';

// Default export for backwards compatibility
import { sendMessage } from './message-handler.js';
import { sendMessageStream } from './streaming-handler.js';
import { listModels, fetchAvailableModels, getModelQuotas, getUserQuotaSummary, getSubscriptionTier, isValidModel } from './model-api.js';

export default {
    sendMessage,
    sendMessageStream,
    listModels,
    fetchAvailableModels,
    getModelQuotas,
    getUserQuotaSummary,
    getSubscriptionTier,
    isValidModel
};
