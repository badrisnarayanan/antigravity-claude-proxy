#!/usr/bin/env node

/**
 * Tool to trigger Google Config Inspection via the Proxy API.
 *
 * Usage:
 *   node bin/inspect-configs.js [--email=user@example.com]
 *
 * This tool connects to the running proxy server and triggers the /api/debug/inspect-configs endpoint.
 * Results will be saved to the logs/ directory by the server.
 */

import { fetch } from 'undici';

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;

// Parse args
const args = process.argv.slice(2);
let email = null;

for (const arg of args) {
    if (arg.startsWith('--email=')) {
        email = arg.split('=')[1];
    }
}

async function main() {
    console.log(`Connecting to proxy at ${BASE_URL}...`);

    try {
        const url = `${BASE_URL}/api/debug/inspect-configs`;
        const body = email ? { email } : {};

        console.log(`Requesting config inspection${email ? ` for ${email}` : ' for all available accounts'}...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`API Error ${response.status}: ${error}`);
        }

        const data = await response.json();
        console.log('\n✅ Inspection Request Successful');
        console.log(`Processed ${data.count} account(s)`);

        if (data.results && data.results.length > 0) {
            console.log('\nResults:');
            data.results.forEach(res => {
                if (res.error) {
                    console.log(`❌ ${res.email}: Failed - ${res.error}`);
                } else {
                    console.log(`✓ ${res.email}: Success`);
                    console.log(`  Project: ${res.projectId}`);
                    console.log(`  Experiments: ${Array.isArray(res.experiments?.experiments) ? res.experiments.experiments.length : 'Unknown'}`);
                }
            });
            console.log('\nCheck the "logs/" directory for detailed JSON dumps.');
        } else {
            console.log('No accounts processed.');
        }

    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error(`\n❌ Error: Could not connect to server at ${BASE_URL}`);
            console.error('Make sure the proxy server is running: npm start');
        } else {
            console.error('\n❌ Error:', error.message);
        }
        process.exit(1);
    }
}

main();
