/**
 * Manages isolated Grok CLI accounts and rotates between healthy accounts.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';

const GROK_CONFIG_PATH = join(homedir(), '.antigravity-grok-accounts.json');
const GROK_RATE_LIMIT_COOLDOWN = 120_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export class GrokAccountManager {
    #accounts = [];
    #strategy = 'round-robin';
    #currentIndex = 0;
    #initialized = false;

    constructor() {
        this.#loadConfigSync();
    }

    async initialize() {
        if (this.#initialized) return;
        this.#loadConfigSync();
        this.#initialized = true;
        logger.info(`[GrokAccountManager] Loaded ${this.#accounts.length} grok account(s)`);
    }

    #loadConfigSync() {
        try {
            if (!existsSync(GROK_CONFIG_PATH)) {
                this.#accounts = [];
                return;
            }
            let raw = readFileSync(GROK_CONFIG_PATH, 'utf-8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            const data = JSON.parse(raw);
            this.#accounts = (data.accounts || []).map(account => ({
                ...account,
                enabled: account.enabled !== false,
                lastUsed: account.lastUsed || null,
                failures: 0,
                isRateLimited: false,
                rateLimitResetAt: null,
                error: null
            }));
            this.#strategy = data.strategy || 'round-robin';
        } catch {
            this.#accounts = [];
        }
    }

    async #saveConfig() {
        const data = {
            strategy: this.#strategy,
            accounts: this.#accounts.map(account => ({
                alias: account.alias,
                email: account.email,
                dir: account.dir,
                enabled: account.enabled,
                lastUsed: account.lastUsed
            }))
        };
        await writeFile(GROK_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
    }

    #hasAuthFile(dir) {
        const base = join(homedir(), dir);
        return existsSync(join(base, '.grok', 'auth.json')) || existsSync(join(base, 'auth.json'));
    }

    getHomeDir(alias) {
        const account = this.#accounts.find(candidate => candidate.alias === alias);
        return account ? join(homedir(), account.dir) : null;
    }

    selectAccount() {
        const available = this.#accounts.filter(account => {
            if (!account.enabled) return false;
            if (account.isRateLimited && account.rateLimitResetAt > Date.now()) return false;
            if (account.failures >= DEFAULT_MAX_CONSECUTIVE_FAILURES) return false;
            return this.#hasAuthFile(account.dir);
        });
        if (available.length === 0) return null;

        if (this.#strategy === 'round-robin') {
            const index = this.#currentIndex % available.length;
            this.#currentIndex = (index + 1) % available.length;
            return { ...available[index], homeDir: join(homedir(), available[index].dir) };
        }

        available.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
        return { ...available[0], homeDir: join(homedir(), available[0].dir) };
    }

    markRateLimited(alias, reason) {
        const account = this.#accounts.find(candidate => candidate.alias === alias);
        if (!account) return;
        account.isRateLimited = true;
        account.rateLimitResetAt = Date.now() + GROK_RATE_LIMIT_COOLDOWN;
        account.failures = (account.failures || 0) + 1;
        account.error = reason;
        account.lastUsed = Date.now();
        logger.warn(`[GrokAccountManager] ${alias} rate-limited: ${reason}`);
    }

    markSuccess(alias) {
        const account = this.#accounts.find(candidate => candidate.alias === alias);
        if (!account) return;
        account.failures = 0;
        account.isRateLimited = false;
        account.rateLimitResetAt = null;
        account.error = null;
        account.lastUsed = Date.now();
    }

    isAllRateLimited() {
        if (this.#accounts.length === 0) return true;
        return this.#accounts.every(account => account.isRateLimited && account.rateLimitResetAt > Date.now());
    }

    async addAccount(alias, email) {
        if (this.#accounts.find(account => account.alias === alias)) {
            throw new Error(`Grok account '${alias}' already exists`);
        }
        const dir = `.grok-${alias}`;
        const homeDir = join(homedir(), dir);
        mkdirSync(homeDir, { recursive: true });
        this.#accounts.push({
            alias,
            email,
            dir,
            enabled: true,
            lastUsed: null,
            failures: 0,
            isRateLimited: false,
            rateLimitResetAt: null,
            error: null
        });
        await this.#saveConfig();
        logger.info(`[GrokAccountManager] Added account ${email} as '${alias}'`);
        return { alias, email, dir, homeDir };
    }

    async removeAccount(alias) {
        const index = this.#accounts.findIndex(account => account.alias === alias);
        if (index === -1) throw new Error(`Grok account '${alias}' not found`);
        this.#accounts.splice(index, 1);
        await this.#saveConfig();
    }

    getAccount(alias) {
        return this.getAccounts().find(account => account.alias === alias) || null;
    }

    getAccounts() {
        return this.#accounts.map(account => ({
            ...account,
            homeDir: join(homedir(), account.dir),
            hasAuth: this.#hasAuthFile(account.dir),
            isCurrentlyRateLimited: account.isRateLimited && account.rateLimitResetAt > Date.now(),
            rateLimitRemainingMs: account.isRateLimited
                ? Math.max(0, account.rateLimitResetAt - Date.now())
                : 0
        }));
    }

    getStatus() {
        const accounts = this.getAccounts();
        return {
            total: accounts.length,
            available: accounts.filter(account => !account.isCurrentlyRateLimited && account.enabled && account.hasAuth).length,
            rateLimited: accounts.filter(account => account.isCurrentlyRateLimited).length,
            invalid: accounts.filter(account => !account.hasAuth).length,
            disabled: accounts.filter(account => !account.enabled).length,
            accounts
        };
    }

    async toggleAccount(alias) {
        const account = this.#accounts.find(candidate => candidate.alias === alias);
        if (!account) throw new Error(`Grok account '${alias}' not found`);
        account.enabled = !account.enabled;
        await this.#saveConfig();
        return account.enabled;
    }
}
