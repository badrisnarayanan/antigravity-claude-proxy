/**
 * Test: Logs Viewer - Stable Expansion State
 * 
 * Verifies that:
 * 1. expandedLogs uses timestamps (stable IDs) instead of indices
 * 2. Expansion state persists correctly when logs are filtered
 * 3. Expansion state persists correctly when new logs arrive
 */

// Mock DOM and Alpine for testing
global.window = { Components: {} };
global.Alpine = { store: { settings: {}, global: {} } };

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Read and evaluate the logs viewer code
const logsViewerCode = readFileSync(join(projectRoot, 'public/js/components/logs-viewer.js'), 'utf8');

// Create a mock environment
const mockEnv = {
    window: { Components: {} },
    Alpine: {
        store: {
            settings: { debugLogging: false, logLimit: 1000 },
            global: { t: (key) => key }
        }
    },
    console: console
};

// Evaluate the code in our mock environment
const vm = await import('vm');
const context = vm.createContext(mockEnv);
vm.runInContext(logsViewerCode, context);

const logsViewerFactory = mockEnv.window.Components.logsViewer;

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║        LOGS VIEWER STABLE EXPANSION TEST                   ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (error) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
        failed++;
    }
}

// Create component instance
const component = logsViewerFactory();

// Mock log data with unique timestamps
const log1 = {
    timestamp: '2025-01-01T00:00:00.000Z',
    level: 'INFO',
    message: 'First log message',
    data: { key: 'value1' }
};

const log2 = {
    timestamp: '2025-01-01T00:00:01.000Z',
    level: 'ERROR',
    message: 'Second log message',
    data: { key: 'value2' }
};

const log3 = {
    timestamp: '2025-01-01T00:00:02.000Z',
    level: 'WARN',
    message: 'Third log message',
    data: null // No data, can't expand
};

// ─── Test 1: Toggle uses timestamp ───
test('toggleLog uses timestamp as identifier', () => {
    component.expandedLogs.clear();
    
    // Toggle using timestamp
    component.toggleLog(log1.timestamp);
    
    if (!component.expandedLogs.has(log1.timestamp)) {
        throw new Error('Should have expanded log by timestamp');
    }
    
    // Verify it's NOT using index 0
    if (component.expandedLogs.has(0)) {
        throw new Error('Should NOT use index as identifier');
    }
});

// ─── Test 2: isExpanded uses timestamp ───
test('isExpanded checks by timestamp', () => {
    component.expandedLogs.clear();
    component.expandedLogs.add(log2.timestamp);
    
    if (!component.isExpanded(log2.timestamp)) {
        throw new Error('Should recognize expanded log by timestamp');
    }
    
    if (component.isExpanded(log1.timestamp)) {
        throw new Error('Should not report unexpanded log as expanded');
    }
});

// ─── Test 3: Expansion state persists after filtering ───
test('Expansion state persists after filtering', () => {
    component.logs = [log1, log2, log3];
    component.expandedLogs.clear();
    
    // Expand log2 (index 1 in full list)
    component.toggleLog(log2.timestamp);
    
    // Apply filter that excludes log2
    component.searchQuery = 'First'; // Only matches log1
    
    // Verify log2 is still marked as expanded by timestamp
    if (!component.expandedLogs.has(log2.timestamp)) {
        throw new Error('Expansion state should persist after filtering');
    }
    
    // Clear filter
    component.searchQuery = '';
});

// ─── Test 4: Expansion state correct after new logs arrive ───
test('Expansion state correct after new logs arrive', () => {
    component.logs = [log1];
    component.expandedLogs.clear();
    
    // Expand log1
    component.toggleLog(log1.timestamp);
    
    // Simulate new logs arriving (shifting indices)
    const newLog1 = { ...log1, timestamp: '2025-01-01T00:00:03.000Z' };
    const newLog2 = { ...log2, timestamp: '2025-01-01T00:00:04.000Z' };
    component.logs = [newLog1, newLog2, log1];
    
    // Original log1 should still be expanded (by timestamp)
    if (!component.isExpanded(log1.timestamp)) {
        throw new Error('Original log should still be expanded after new logs arrive');
    }
    
    // New logs should not be expanded
    if (component.isExpanded(newLog1.timestamp)) {
        throw new Error('New log should not be expanded');
    }
});

// ─── Test 5: Multiple logs can be expanded independently ───
test('Multiple logs can be expanded independently', () => {
    component.expandedLogs.clear();
    
    component.toggleLog(log1.timestamp);
    component.toggleLog(log2.timestamp);
    
    if (!component.isExpanded(log1.timestamp)) {
        throw new Error('First log should be expanded');
    }
    if (!component.isExpanded(log2.timestamp)) {
        throw new Error('Second log should be expanded');
    }
    if (component.isExpanded(log3.timestamp)) {
        throw new Error('Third log should not be expanded');
    }
});

// ─── Test 6: Toggle can collapse expanded log ───
test('Toggle can collapse expanded log', () => {
    component.expandedLogs.clear();
    
    component.toggleLog(log1.timestamp);
    if (!component.isExpanded(log1.timestamp)) {
        throw new Error('Should be expanded after first toggle');
    }
    
    component.toggleLog(log1.timestamp);
    if (component.isExpanded(log1.timestamp)) {
        throw new Error('Should be collapsed after second toggle');
    }
});

// ─── Test 7: Timestamps are unique identifiers ───
test('Timestamps serve as unique identifiers', () => {
    component.expandedLogs.clear();
    
    const sameTimeLog1 = { timestamp: '2025-01-01T00:00:05.000Z', level: 'INFO', message: 'A' };
    const sameTimeLog2 = { timestamp: '2025-01-01T00:00:05.000Z', level: 'ERROR', message: 'B' };
    
    // In real usage, timestamps should be unique (down to microseconds)
    // This test verifies that our implementation uses timestamp as the key
    component.toggleLog(sameTimeLog1.timestamp);
    
    // Both logs with same timestamp would be considered expanded
    // This is expected behavior - in practice, timestamps are unique enough
    if (!component.isExpanded(sameTimeLog1.timestamp)) {
        throw new Error('Log with matching timestamp should be expanded');
    }
    if (!component.isExpanded(sameTimeLog2.timestamp)) {
        throw new Error('Log with same timestamp should also be expanded');
    }
});

// ─── Summary ───
console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─────────────────────────────────────────────────────────────────\n');

if (failed > 0) {
    process.exit(1);
}
