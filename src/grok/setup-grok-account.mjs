#!/usr/bin/env node
/** Register an isolated Grok CLI account for the proxy. */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const [alias, email] = process.argv.slice(2);
if (!alias || !email) {
    console.error('Usage: node setup-grok-account.mjs <alias> <email>');
    process.exit(1);
}

const accountHome = join(homedir(), `.grok-${alias}`);
const configPath = join(homedir(), '.antigravity-grok-accounts.json');
const grokExecutable = join(homedir(), '.grok', 'bin', 'grok.exe');
await mkdir(accountHome, { recursive: true });

const authCandidates = [
    join(accountHome, '.grok', 'auth.json'),
    join(accountHome, 'auth.json')
];
if (!authCandidates.some(candidate => existsSync(candidate))) {
    const result = spawnSync(grokExecutable, ['login'], {
        env: { ...process.env, HOME: accountHome, USERPROFILE: accountHome },
        stdio: 'inherit',
        shell: false,
        windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

let config = { strategy: 'round-robin', accounts: [] };
if (existsSync(configPath)) {
    let raw = readFileSync(configPath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    config = JSON.parse(raw);
}
config.accounts ||= [];
if (!config.accounts.some(account => account.alias === alias)) {
    config.accounts.push({ alias, email, dir: `.grok-${alias}`, enabled: true, lastUsed: null });
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
console.log(`Grok account '${alias}' is configured.`);
