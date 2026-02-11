/**
 * Test Traffic Shaper
 */

import { trafficShaper } from '../src/modules/traffic-shaper.js';
import { sleep } from '../src/utils/helpers.js';
import assert from 'assert';

// Adjust shaper for testing (faster)
trafficShaper.minDelayMs = 500;
trafficShaper.jitterMs = 100;

async function runTest() {
    console.log('Starting Traffic Shaper Test...');

    const start = Date.now();
    const results = [];

    // Queue 3 tasks rapidly
    const p1 = trafficShaper.enqueue(async () => {
        console.log('Task 1 executing');
        results.push({ id: 1, time: Date.now() });
        return 1;
    });

    const p2 = trafficShaper.enqueue(async () => {
        console.log('Task 2 executing');
        results.push({ id: 2, time: Date.now() });
        return 2;
    });

    const p3 = trafficShaper.enqueue(async () => {
        console.log('Task 3 executing');
        results.push({ id: 3, time: Date.now() });
        return 3;
    });

    await Promise.all([p1, p2, p3]);

    const end = Date.now();
    const duration = end - start;

    console.log(`Total duration: ${duration}ms`);
    console.log('Results:', results);

    // Check ordering
    assert.strictEqual(results[0].id, 1);
    assert.strictEqual(results[1].id, 2);
    assert.strictEqual(results[2].id, 3);

    // Check timing - should be at least minDelayMs between tasks
    // Task 1 starts immediately (or close to it)
    // Task 2 starts after ~500ms
    // Task 3 starts after ~500ms from Task 2

    const diff1 = results[1].time - results[0].time;
    const diff2 = results[2].time - results[1].time;

    console.log(`Diff 1-2: ${diff1}ms`);
    console.log(`Diff 2-3: ${diff2}ms`);

    assert(diff1 >= 500, 'Task 2 should wait for delay');
    assert(diff2 >= 500, 'Task 3 should wait for delay');

    console.log('Traffic Shaper Test PASSED');
}

runTest().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
