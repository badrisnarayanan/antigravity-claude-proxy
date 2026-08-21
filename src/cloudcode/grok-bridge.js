/**
 * Anthropic-compatible bridge to the Grok CLI.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, join } from 'path';
import { GrokAccountManager } from '../grok/grok-account-manager.js';
import { logger } from '../utils/logger.js';

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const GROK_BIN_DIR = join(homedir(), '.grok', 'bin');

function findOnPath(fileName, env, existsSyncImpl) {
    for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory.replace(/^"|"$/g, ''), fileName);
        if (existsSyncImpl(candidate)) return candidate;
    }
    return null;
}

export function resolveGrokCommand({
    platform = process.platform,
    homeDir = homedir(),
    env = process.env,
    existsSyncImpl = existsSync
} = {}) {
    const binDir = join(homeDir, '.grok', 'bin');
    if (platform === 'win32') {
        const preferredExe = join(binDir, 'grok.exe');
        if (existsSyncImpl(preferredExe)) return { command: preferredExe, kind: 'executable' };
        const preferredCmd = join(binDir, 'grok.cmd');
        if (existsSyncImpl(preferredCmd)) return { command: preferredCmd, kind: 'cmd' };
        const pathExe = findOnPath('grok.exe', env, existsSyncImpl);
        if (pathExe) return { command: pathExe, kind: 'executable' };
        const pathCmd = findOnPath('grok.cmd', env, existsSyncImpl);
        if (pathCmd) return { command: pathCmd, kind: 'cmd' };
    } else {
        const preferred = join(binDir, 'grok');
        if (existsSyncImpl(preferred)) return { command: preferred, kind: 'executable' };
    }
    return { command: 'grok', kind: 'executable' };
}

function quoteCmdToken(value) {
    const token = String(value);
    if (/\r|\n|\0/.test(token)) throw new Error('Invalid newline in Grok CLI argument');
    return `"${token.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

export function buildGrokLaunch(commandSpec, args, {
    platform = process.platform,
    comSpec = process.env.ComSpec || 'cmd.exe'
} = {}) {
    const options = { shell: false, windowsHide: platform === 'win32' };
    if (platform === 'win32' && commandSpec.kind === 'cmd') {
        const commandLine = [commandSpec.command, ...args].map(quoteCmdToken).join(' ');
        return {
            command: comSpec,
            args: ['/d', '/s', '/c', commandLine],
            options: { ...options, windowsVerbatimArguments: true }
        };
    }
    return { command: commandSpec.command, args, options };
}

function buildEnv(homeDir, baseEnv) {
    const currentPath = baseEnv.PATH || '';
    const fullPath = currentPath.includes(GROK_BIN_DIR)
        ? currentPath
        : `${GROK_BIN_DIR}${delimiter}${currentPath}`;
    return {
        ...baseEnv,
        PATH: fullPath,
        USERPROFILE: homeDir,
        HOME: homeDir,
        GROK_MEMORY: '0',
        GROK_SUBAGENTS: '0'
    };
}

export function spawnGrokProcess(args, {
    homeDir,
    stdio = ['ignore', 'pipe', 'pipe'],
    spawnImpl = nodeSpawn,
    platform = process.platform,
    grokCommand = resolveGrokCommand({ platform }),
    comSpec = process.env.ComSpec || 'cmd.exe',
    baseEnv = process.env
} = {}) {
    const launch = buildGrokLaunch(grokCommand, args, { platform, comSpec });
    return spawnImpl(launch.command, launch.args, {
        ...launch.options,
        stdio,
        env: buildEnv(homeDir, baseEnv)
    });
}

export function terminateGrokProcess(child, {
    platform = process.platform,
    spawnSyncImpl = nodeSpawnSync,
    systemRoot = process.env.SystemRoot || 'C:\\Windows'
} = {}) {
    if (platform === 'win32' && Number.isInteger(child.pid)) {
        const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
        const result = spawnSyncImpl(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            shell: false,
            windowsHide: true
        });
        if (!result.error && result.status === 0) return true;
    }
    try { child.kill(); } catch { /* process already exited */ }
    return false;
}

function buildGrokPrompt(anthropicRequest) {
    const { messages, system } = anthropicRequest;
    let prompt = '';
    if (system) {
        if (typeof system === 'string') prompt += `${system}\n\n`;
        else if (Array.isArray(system)) {
            prompt += `${system.map(block => block.text || '').filter(Boolean).join('\n')}\n\n`;
        }
    }
    for (const message of messages || []) {
        const role = message.role === 'assistant' ? 'Assistant' : 'Human';
        if (typeof message.content === 'string') {
            prompt += `\n\n${role}: ${message.content}`;
        } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === 'text') prompt += `\n\n${role}: ${block.text}`;
                else if (block.type === 'tool_use') prompt += `\n\n${role}: [Using tool ${block.name}]`;
                else if (block.type === 'tool_result') prompt += `\n\n${role}: [Tool result received]`;
            }
        }
    }
    return `${prompt}\n\nAssistant:`;
}

function parseGrokResponse(grokJson, model) {
    let stopReason = 'end_turn';
    if (grokJson.stopReason === 'max_tokens' || grokJson.stopReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    } else if (grokJson.stopReason === 'tool_use' || grokJson.stopReason === 'TOOL_USE') {
        stopReason = 'tool_use';
    }
    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: grokJson.text || '' }],
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: grokJson.usage?.input_tokens || 0,
            output_tokens: grokJson.usage?.output_tokens || 0
        }
    };
}

function isRateLimited(code, stderr, json) {
    if (code === 0) return false;
    const lower = stderr.toLowerCase();
    if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) return true;
    if (code === 1 && json?.stopReason === 'Cancelled') return false;
    return code !== 0 && code !== null;
}

function writePromptFile(prompt) {
    const directory = join(tmpdir(), 'grok-bridge');
    mkdirSync(directory, { recursive: true });
    const filePath = join(directory, `prompt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
    writeFileSync(filePath, prompt, 'utf-8');
    return filePath;
}

function createTimeoutError(timeoutMs) {
    const error = new Error(`Grok CLI request timed out after ${timeoutMs}ms`);
    error.code = 'ETIMEDOUT';
    return error;
}

function createAbortError() {
    const error = new Error('Grok CLI request aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

export function createGrokBridge({
    accountManager = new GrokAccountManager(),
    spawnImpl = nodeSpawn,
    platform = process.platform,
    grokCommand = resolveGrokCommand({ platform }),
    comSpec = process.env.ComSpec || 'cmd.exe',
    baseEnv = process.env,
    terminateProcess = child => terminateGrokProcess(child, { platform }),
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
} = {}) {
    function runGrok(args, account, { signal, timeoutMs, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
        if (signal?.aborted) return Promise.reject(createAbortError());
        const child = spawnGrokProcess(args, {
            homeDir: account.homeDir,
            stdio,
            spawnImpl,
            platform,
            grokCommand,
            comSpec,
            baseEnv
        });

        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            let terminationError = null;
            let terminationGraceTimer = null;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(terminationGraceTimer);
                signal?.removeEventListener('abort', onAbort);
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.unref?.();
                callback(value);
            };
            const terminate = error => {
                terminationError = error;
                const treeTerminated = terminateProcess(child);
                if (treeTerminated) {
                    finish(reject, error);
                    return;
                }
                terminationGraceTimer = setTimeout(() => finish(reject, error), 2_000);
            };
            const onAbort = () => terminate(createAbortError());
            const timer = setTimeout(() => terminate(createTimeoutError(timeoutMs)), timeoutMs);

            child.stdout?.on('data', data => { stdout += data.toString(); });
            child.stderr?.on('data', data => { stderr += data.toString(); });
            child.on('error', error => finish(reject, new Error(`Grok CLI unavailable: ${error.message}`)));
            child.on('close', (code, childSignal) => {
                if (terminationError) {
                    finish(reject, terminationError);
                    return;
                }
                finish(resolve, { code, signal: childSignal, stdout, stderr });
            });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async function checkGrokAvailable({ signal } = {}) {
        await accountManager.initialize();
        const account = accountManager.selectAccount();
        if (!account) return false;
        try {
            const result = await runGrok(['--version'], account, {
                signal,
                timeoutMs: healthTimeoutMs,
                stdio: ['ignore', 'ignore', 'ignore']
            });
            return result.code === 0;
        } catch {
            return false;
        }
    }

    async function runRequest(account, prompt, model, { signal } = {}) {
        const promptFile = writePromptFile(prompt);
        try {
            const result = await runGrok(
                ['--prompt-file', promptFile, '--output-format', 'json', '--max-turns', '1'],
                account,
                { signal, timeoutMs: requestTimeoutMs }
            );
            const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
            let parsed = null;
            if (jsonMatch) {
                try { parsed = JSON.parse(jsonMatch[0]); } catch { /* invalid JSON handled below */ }
            }
            if (isRateLimited(result.code, result.stderr, parsed)) {
                throw Object.assign(new Error('Rate limited'), { rateLimited: true });
            }
            if (!parsed) {
                const output = result.stdout.substring(0, 200) || result.stderr.substring(0, 200);
                throw new Error(`Grok CLI returned no valid JSON. Output: ${output}`);
            }
            return parseGrokResponse(parsed, model);
        } finally {
            try { unlinkSync(promptFile); } catch { /* already removed */ }
        }
    }

    async function sendGrokMessage(anthropicRequest, options = {}) {
        const model = anthropicRequest.model || 'grok-4.5';
        const prompt = buildGrokPrompt(anthropicRequest);
        await accountManager.initialize();
        const maxAttempts = Math.max(1, accountManager.getAccounts().length || 1);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const account = accountManager.selectAccount();
            if (!account) throw new Error('All Grok accounts are rate-limited or unavailable');
            logger.debug(`[GrokBridge] Try ${attempt + 1}/${maxAttempts} account=${account.alias}`);
            try {
                const response = await runRequest(account, prompt, model, options);
                accountManager.markSuccess(account.alias);
                return response;
            } catch (error) {
                if (error.name === 'AbortError' || error.code === 'ETIMEDOUT') throw error;
                if (error.rateLimited) {
                    accountManager.markRateLimited(account.alias, 'Rate limited');
                    logger.warn(`[GrokBridge] Account ${account.alias} rate-limited, trying next`);
                    continue;
                }
                accountManager.markRateLimited(account.alias, error.message);
                throw error;
            }
        }
        throw new Error(`All Grok accounts are rate-limited after ${maxAttempts} attempts`);
    }

    async function* sendGrokMessageStream(anthropicRequest, options = {}) {
        const model = anthropicRequest.model || 'grok-4.5';
        const response = await sendGrokMessage(anthropicRequest, options);
        const text = response.content[0]?.text || '';
        yield {
            type: 'message_start',
            message: {
                id: response.id,
                type: 'message',
                role: 'assistant',
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 }
            }
        };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        if (text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        yield { type: 'content_block_stop', index: 0 };
        yield {
            type: 'message_delta',
            delta: { stop_reason: response.stop_reason || 'end_turn', stop_sequence: null },
            usage: { output_tokens: response.usage.output_tokens }
        };
        yield { type: 'message_stop' };
    }

    return { checkGrokAvailable, sendGrokMessage, sendGrokMessageStream };
}

export const accountManager = new GrokAccountManager();
const defaultBridge = createGrokBridge({ accountManager });
export const checkGrokAvailable = defaultBridge.checkGrokAvailable;
export const sendGrokMessage = defaultBridge.sendGrokMessage;
export const sendGrokMessageStream = defaultBridge.sendGrokMessageStream;
