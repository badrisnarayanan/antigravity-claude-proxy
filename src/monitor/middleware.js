import db from './db.js';
import { logger } from '../utils/logger.js';

const MAX_BODY_LENGTH = 100 * 1024; // 100KB

export function monitorMiddleware(req, res, next) {
    const start = Date.now();

    // Store original send/json methods to intercept response
    const originalJson = res.json;
    const originalSend = res.send;

    let responseBody = null;
    let inputTokens = 0;
    let outputTokens = 0;

    // Attempt to extract model from body (usually in POST /v1/messages)
    let model = req.body && req.body.model ? req.body.model : null;

    // Attach a storage object for streaming endpoints to report data
    res.monitorData = {
        streamedContent: [],
        usage: { input_tokens: 0, output_tokens: 0 }
    };

    // Helper to extract tokens from standard response body
    const extractTokens = (body) => {
        if (body && body.usage) {
            inputTokens = body.usage.input_tokens || 0;
            outputTokens = body.usage.output_tokens || 0;
        }
    };

    res.json = function(body) {
        responseBody = body;
        extractTokens(body);
        return originalJson.apply(this, arguments);
    };

    res.send = function(body) {
        if (typeof body === 'string') {
             try {
                 // Try parsing as JSON to extract tokens if possible
                 const parsed = JSON.parse(body);
                 responseBody = parsed;
                 extractTokens(parsed);
             } catch (e) {
                 responseBody = body;
             }
        } else {
            responseBody = body;
        }
        return originalSend.apply(this, arguments);
    };

    res.on('finish', () => {
        const duration = Date.now() - start;

        // If streaming data was collected
        if (res.monitorData.usage.input_tokens > 0 || res.monitorData.usage.output_tokens > 0) {
            inputTokens = res.monitorData.usage.input_tokens;
            outputTokens = res.monitorData.usage.output_tokens;
        }

        // If we have accumulated streamed content, use that as response body
        if (res.monitorData.streamedContent.length > 0) {
             responseBody = res.monitorData.streamedContent.join('');
        }

        // Determine if we should log this request
        // Skip health checks, internal API calls, static files unless meaningful
        if (req.path === '/health' || req.path === '/metrics') {
            return;
        }

        // Use req.originalUrl to see the full path including mount point if any
        const url = req.originalUrl || req.url;

        let error = null;
        if (res.statusCode >= 400) {
            error = typeof responseBody === 'object' ? JSON.stringify(responseBody) : String(responseBody);
        }

        // Truncate large bodies
        let loggedReqBody = req.body;
        if (loggedReqBody && typeof loggedReqBody !== 'string') {
             // If JSON object, we stringify just for size check (db logger stringifies anyway)
             // Ideally we pass object to db logger and let it handle/truncate
        }

        let loggedResBody = responseBody;
        if (typeof loggedResBody === 'string' && loggedResBody.length > MAX_BODY_LENGTH) {
            loggedResBody = loggedResBody.substring(0, MAX_BODY_LENGTH) + '...[TRUNCATED]';
        }

        // For request body, we might not want to truncate the whole JSON as it breaks structure,
        // but for now, we leave it to the DB module to handle stringification.
        // If we strictly want to limit size:
        let reqBodyStr = typeof loggedReqBody === 'string' ? loggedReqBody : JSON.stringify(loggedReqBody);
        if (reqBodyStr && reqBodyStr.length > MAX_BODY_LENGTH) {
            reqBodyStr = reqBodyStr.substring(0, MAX_BODY_LENGTH) + '...[TRUNCATED]';
            // Note: This makes it invalid JSON, but it's for logging.
            loggedReqBody = reqBodyStr;
        }

        db.logRequest({
            method: req.method,
            url: url,
            status: res.statusCode,
            duration: duration,
            request_body: loggedReqBody,
            response_body: loggedResBody,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            model: model,
            error: error
        });
    });

    next();
}

export default monitorMiddleware;
