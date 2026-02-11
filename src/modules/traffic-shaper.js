/**
 * Traffic Shaper Module
 *
 * Implements a "Human Speed Limit" for request processing.
 * Prevents bursty traffic by queuing concurrent requests and executing them
 * with a minimum delay, simulating a human reading/typing pause.
 */

import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

class TrafficShaper {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.lastRequestTime = 0;
        // Minimum delay between requests (ms) - resembles "thinking/reading" time
        this.minDelayMs = 3000;
        this.jitterMs = 2000;
    }

    /**
     * Enqueue a task to be executed with traffic shaping
     * @param {Function} task - Async function to execute
     * @returns {Promise<any>} Result of the task
     */
    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.processQueue();
        });
    }

    /**
     * Process the queue sequentially with delays
     */
    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const { task, resolve, reject } = this.queue.shift();

            // Calculate wait time based on last request
            const now = Date.now();
            const timeSinceLast = now - this.lastRequestTime;

            // Random delay: 3s to 5s
            const requiredDelay = this.minDelayMs + Math.random() * this.jitterMs;

            const waitTime = Math.max(0, requiredDelay - timeSinceLast);

            if (waitTime > 0) {
                logger.debug(`[TrafficShaper] Enforcing human speed limit: waiting ${Math.round(waitTime)}ms`);
                await sleep(waitTime);
            }

            try {
                // Execute the task
                const result = await task();
                resolve(result);
            } catch (error) {
                reject(error);
            } finally {
                this.lastRequestTime = Date.now();
            }
        }

        this.isProcessing = false;
    }

    /**
     * Get current status for monitoring
     */
    getStatus() {
        return {
            processing: this.isProcessing,
            queued: this.queue.length
        };
    }
}

// Export singleton
export const trafficShaper = new TrafficShaper();
