/**
 * Discord Bot Module
 *
 * Provides live log streaming, event notifications, model status display,
 * and interactive slash commands via a Discord bot.
 *
 * Follows the same single-file module pattern as usage-stats.js.
 */

import { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { formatDuration, getPackageVersion } from '../utils/helpers.js';

// ── State ──
let client = null;
let isConnected = false;
let logListener = null;
let logBuffer = [];
let logFlushTimer = null;
let modelUpdateTimer = null;
let modelMessageId = null;
let startTime = Date.now();

// ── Level Icons ──
const LEVEL_ICONS = {
    ERROR: '\u2716',
    WARN: '\u26A0',
    INFO: '\u25CF',
    SUCCESS: '\u2714',
    DEBUG: '\u25C6'
};

// ── Notification Embed Colors ──
const EMBED_COLORS = {
    error: 0xEF4444,      // red
    warn: 0xEAB308,       // yellow
    success: 0x22C55E,    // green
    info: 0x3B82F6,       // blue
    system: 0xA855F7      // purple
};

// ── Slash Command Definitions ──
const commands = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show proxy server status'),
    new SlashCommandBuilder()
        .setName('models')
        .setDescription('Show model quotas for all accounts'),
    new SlashCommandBuilder()
        .setName('accounts')
        .setDescription('List accounts with status (ephemeral)'),
    new SlashCommandBuilder()
        .setName('add-account')
        .setDescription('Get OAuth URL to add a new account (ephemeral)')
];

// ── Helpers ──

/**
 * Get a Discord channel by ID with error handling
 */
function getChannel(channelId) {
    if (!client || !isConnected || !channelId) return null;
    try {
        return client.channels.cache.get(channelId) || null;
    } catch {
        return null;
    }
}

/**
 * Send a message to a channel, handling errors silently
 */
async function safeSend(channel, content) {
    if (!channel) return null;
    try {
        return await channel.send(content);
    } catch (err) {
        logger.debug(`[Discord] Failed to send to channel: ${err.message}`);
        return null;
    }
}

/**
 * Build a quota bar string for embeds
 */
function buildQuotaBar(fraction, width = 10) {
    if (fraction === null || fraction === undefined) return '`[??????????]` N/A';
    const pct = Math.round(fraction * 100);
    const filled = Math.round(fraction * width);
    const empty = width - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
    return `\`[${bar}]\` ${pct}%`;
}

/**
 * Format a timestamp for log entries
 */
function formatLogTime(timestamp) {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── Log Streaming ──

/**
 * Start listening to logger events and batch them
 */
function startLogStreaming() {
    if (logListener) return;

    logListener = (logEntry) => {
        const dc = config.discord;
        if (!dc?.enabled || !dc?.channels?.logs) return;

        logBuffer.push(logEntry);

        // Start flush timer if not already running
        if (!logFlushTimer) {
            const interval = dc.logBatchIntervalMs || 3000;
            logFlushTimer = setTimeout(flushLogs, interval);
        }
    };

    logger.on('log', logListener);
}

/**
 * Flush accumulated log buffer to Discord
 */
async function flushLogs() {
    logFlushTimer = null;

    if (logBuffer.length === 0) return;

    const dc = config.discord;
    const channel = getChannel(dc?.channels?.logs);
    if (!channel) {
        logBuffer = [];
        return;
    }

    // Take current buffer and reset
    const entries = logBuffer.splice(0, logBuffer.length);

    // Format as code block
    const lines = entries.map(entry => {
        const time = formatLogTime(entry.timestamp);
        const icon = LEVEL_ICONS[entry.level] || '\u25CF';
        const level = entry.level.padEnd(7);
        return `${time} ${icon} ${level} ${entry.message}`;
    });

    // Discord message limit is 2000 chars - split if needed
    let current = '';
    for (const line of lines) {
        const candidate = current ? current + '\n' + line : line;
        if (candidate.length + 12 > 1990) { // 12 for ```ansi\n...\n```
            if (current) {
                await safeSend(channel, '```\n' + current + '\n```');
            }
            current = line;
        } else {
            current = candidate;
        }
    }

    if (current) {
        await safeSend(channel, '```\n' + current + '\n```');
    }
}

/**
 * Stop log streaming and clean up
 */
function stopLogStreaming() {
    if (logListener) {
        logger.off('log', logListener);
        logListener = null;
    }
    if (logFlushTimer) {
        clearTimeout(logFlushTimer);
        logFlushTimer = null;
    }
    logBuffer = [];
}

// ── Notifications ──

/**
 * Emit a notification to the Discord notifications channel
 * @param {string} eventType - Notification type key (e.g., 'accountAdded')
 * @param {Object} data - Event data
 */
async function emitNotification(eventType, data = {}) {
    const dc = config.discord;
    if (!dc?.enabled || !isConnected) return;

    // Check if this notification type is enabled
    if (dc.notifications && dc.notifications[eventType] === false) return;

    const channel = getChannel(dc.channels?.notifications);
    if (!channel) return;

    const embed = buildNotificationEmbed(eventType, data);
    if (!embed) return;

    await safeSend(channel, { embeds: [embed] });
}

/**
 * Build an embed for a notification event
 */
function buildNotificationEmbed(eventType, data) {
    const templates = {
        accountRateLimited: {
            title: 'Account Rate Limited',
            color: EMBED_COLORS.warn,
            description: `**${data.email || 'Unknown'}** hit rate limit${data.model ? ` on \`${data.model}\`` : ''}`,
            fields: data.resetTime ? [{ name: 'Reset', value: `<t:${Math.floor(data.resetTime / 1000)}:R>`, inline: true }] : []
        },
        accountQuotaExhausted: {
            title: 'Quota Exhausted',
            color: EMBED_COLORS.error,
            description: `**${data.email || 'Unknown'}** exhausted quota${data.model ? ` for \`${data.model}\`` : ''}`,
            fields: data.resetTime ? [{ name: 'Reset', value: `<t:${Math.floor(data.resetTime / 1000)}:R>`, inline: true }] : []
        },
        accountInvalidated: {
            title: 'Account Invalidated',
            color: EMBED_COLORS.error,
            description: `**${data.email || 'Unknown'}** marked invalid`,
            fields: data.reason ? [{ name: 'Reason', value: data.reason, inline: false }] : []
        },
        accountAdded: {
            title: 'Account Added',
            color: EMBED_COLORS.success,
            description: `**${data.email || 'Unknown'}** added to pool`
        },
        accountRemoved: {
            title: 'Account Removed',
            color: EMBED_COLORS.warn,
            description: `**${data.email || 'Unknown'}** removed from pool`
        },
        serverStarted: {
            title: 'Server Started',
            color: EMBED_COLORS.success,
            description: `Proxy server v${getPackageVersion()} is online`,
            fields: [
                { name: 'Strategy', value: data.strategy || 'hybrid', inline: true }
            ]
        },
        serverStopped: {
            title: 'Server Stopped',
            color: EMBED_COLORS.error,
            description: 'Proxy server is shutting down'
        },
        strategyChanged: {
            title: 'Strategy Changed',
            color: EMBED_COLORS.system,
            description: `Account selection strategy changed to **${data.strategy || 'unknown'}**`
        },
        configChanged: {
            title: 'Configuration Updated',
            color: EMBED_COLORS.system,
            description: data.message || 'Server configuration was modified',
            fields: data.fields ? data.fields.map(f => ({ name: f.name, value: String(f.value), inline: true })) : []
        },
        errorOccurred: {
            title: 'Error Occurred',
            color: EMBED_COLORS.error,
            description: data.message || 'An error occurred',
            fields: data.details ? [{ name: 'Details', value: String(data.details).slice(0, 1024), inline: false }] : []
        }
    };

    const template = templates[eventType];
    if (!template) return null;

    const embed = new EmbedBuilder()
        .setTitle(template.title)
        .setColor(template.color)
        .setDescription(template.description)
        .setTimestamp();

    if (template.fields) {
        for (const field of template.fields) {
            embed.addFields(field);
        }
    }

    return embed;
}

// ── Model Status ──

/**
 * Start periodic model status updates
 */
function startModelUpdates() {
    const dc = config.discord;
    if (!dc?.channels?.models) return;

    const interval = dc.modelUpdateIntervalMs || 300000;
    modelUpdateTimer = setInterval(updateModelStatus, interval);

    // Initial update after a short delay (let accounts load)
    setTimeout(updateModelStatus, 5000);
}

/**
 * Update the pinned model status message
 */
async function updateModelStatus() {
    const dc = config.discord;
    const channel = getChannel(dc?.channels?.models);
    if (!channel) return;

    const accountManager = globalThis.accountManager;
    if (!accountManager) return;

    try {
        const allAccounts = accountManager.getAllAccounts();
        if (!allAccounts || allAccounts.length === 0) return;

        const embed = new EmbedBuilder()
            .setTitle('Model Quota Status')
            .setColor(EMBED_COLORS.info)
            .setTimestamp();

        // Collect quota data from accounts
        let hasData = false;
        for (const account of allAccounts.slice(0, 5)) { // Limit to 5 accounts for embed size
            const quota = account.quota?.models;
            if (!quota || Object.keys(quota).length === 0) continue;

            hasData = true;
            const lines = [];
            for (const [modelId, info] of Object.entries(quota)) {
                const bar = buildQuotaBar(info.remainingFraction);
                lines.push(`\`${modelId}\`: ${bar}`);
            }

            const name = account.email.split('@')[0].slice(0, 20);
            embed.addFields({
                name: name,
                value: lines.join('\n').slice(0, 1024) || 'No data',
                inline: false
            });
        }

        if (!hasData) {
            embed.setDescription('No quota data available. Make a request to refresh quotas.');
        }

        // Try to edit existing message, or send new one
        if (modelMessageId) {
            try {
                const msg = await channel.messages.fetch(modelMessageId);
                await msg.edit({ embeds: [embed] });
                return;
            } catch {
                modelMessageId = null; // Message was deleted, send new
            }
        }

        const sent = await safeSend(channel, { embeds: [embed] });
        if (sent) {
            modelMessageId = sent.id;
        }
    } catch (err) {
        logger.debug(`[Discord] Model status update failed: ${err.message}`);
    }
}

/**
 * Stop model status updates
 */
function stopModelUpdates() {
    if (modelUpdateTimer) {
        clearInterval(modelUpdateTimer);
        modelUpdateTimer = null;
    }
    modelMessageId = null;
}

// ── Slash Command Handlers ──

async function handleStatusCommand(interaction) {
    const accountManager = globalThis.accountManager;
    const status = accountManager?.getStatus?.() || {};
    const version = getPackageVersion();
    const uptime = formatDuration(Date.now() - startTime);
    const strategy = config.accountSelection?.strategy || 'hybrid';

    const embed = new EmbedBuilder()
        .setTitle('Antigravity Proxy Status')
        .setColor(EMBED_COLORS.info)
        .addFields(
            { name: 'Version', value: version, inline: true },
            { name: 'Uptime', value: uptime, inline: true },
            { name: 'Strategy', value: strategy, inline: true },
            { name: 'Accounts', value: `${status.available || 0} available / ${status.total || 0} total`, inline: true },
            { name: 'Rate Limited', value: String(status.rateLimited || 0), inline: true },
            { name: 'Invalid', value: String(status.invalid || 0), inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleModelsCommand(interaction) {
    await interaction.deferReply();

    const accountManager = globalThis.accountManager;
    if (!accountManager) {
        await interaction.editReply('Server not fully initialized.');
        return;
    }

    const allAccounts = accountManager.getAllAccounts();
    const embed = new EmbedBuilder()
        .setTitle('Model Quotas')
        .setColor(EMBED_COLORS.info)
        .setTimestamp();

    let hasData = false;
    for (const account of allAccounts.slice(0, 5)) {
        const quota = account.quota?.models;
        if (!quota || Object.keys(quota).length === 0) continue;

        hasData = true;
        const lines = [];
        for (const [modelId, info] of Object.entries(quota)) {
            lines.push(`\`${modelId}\`: ${buildQuotaBar(info.remainingFraction)}`);
        }

        const name = account.email.split('@')[0].slice(0, 20);
        embed.addFields({
            name: name,
            value: lines.join('\n').slice(0, 1024) || 'No data',
            inline: false
        });
    }

    if (!hasData) {
        embed.setDescription('No quota data available. Visit the WebUI to refresh account limits.');
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleAccountsCommand(interaction) {
    const accountManager = globalThis.accountManager;
    const status = accountManager?.getStatus?.() || {};
    const accounts = status.accounts || [];

    const embed = new EmbedBuilder()
        .setTitle('Account Pool')
        .setColor(EMBED_COLORS.info)
        .setDescription(`${accounts.length} accounts configured`)
        .setTimestamp();

    for (const acc of accounts.slice(0, 10)) {
        const statusIcon = acc.isInvalid ? '\u274C' : (acc.enabled === false ? '\u23F8\uFE0F' : '\u2705');
        const tier = acc.subscription?.tier ? ` [${acc.subscription.tier}]` : '';
        embed.addFields({
            name: `${statusIcon} ${acc.email}`,
            value: `Source: ${acc.source || 'unknown'}${tier}`,
            inline: false
        });
    }

    if (accounts.length > 10) {
        embed.setFooter({ text: `Showing 10 of ${accounts.length} accounts` });
    }

    // Ephemeral - only visible to the user who invoked
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAddAccountCommand(interaction) {
    const port = process.env.PORT || 8080;
    const host = process.env.HOST || 'localhost';

    const embed = new EmbedBuilder()
        .setTitle('Add Account')
        .setColor(EMBED_COLORS.system)
        .setDescription([
            'To add a new Google account, use one of these methods:',
            '',
            `**WebUI:** Open http://${host}:${port} and click "Add Account"`,
            '',
            `**CLI:** Run \`npm run accounts:add\``,
            '',
            'The OAuth flow will open in your browser to authenticate with Google.'
        ].join('\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Lifecycle ──

/**
 * Connect the Discord bot
 */
async function connect() {
    const dc = config.discord;
    if (!dc?.enabled || !dc?.botToken) {
        logger.debug('[Discord] Bot not enabled or no token configured');
        return;
    }

    // Clean up any existing connection
    await disconnect();

    try {
        client = new Client({
            intents: [GatewayIntentBits.Guilds]
        });

        // Register slash commands
        client.once('ready', async () => {
            isConnected = true;
            startTime = Date.now();
            logger.success(`[Discord] Bot connected as ${client.user.tag}`);

            // Register commands globally
            try {
                const rest = new REST({ version: '10' }).setToken(dc.botToken);
                await rest.put(
                    Routes.applicationCommands(client.user.id),
                    { body: commands.map(c => c.toJSON()) }
                );
                logger.info(`[Discord] Registered ${commands.length} slash commands`);
            } catch (err) {
                logger.error(`[Discord] Failed to register commands: ${err.message}`);
            }

            // Start log streaming and model updates
            startLogStreaming();
            startModelUpdates();

            // Send server started notification
            emitNotification('serverStarted', {
                strategy: config.accountSelection?.strategy || 'hybrid'
            });
        });

        // Handle slash commands
        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            try {
                switch (interaction.commandName) {
                    case 'status':
                        await handleStatusCommand(interaction);
                        break;
                    case 'models':
                        await handleModelsCommand(interaction);
                        break;
                    case 'accounts':
                        await handleAccountsCommand(interaction);
                        break;
                    case 'add-account':
                        await handleAddAccountCommand(interaction);
                        break;
                    default:
                        await interaction.reply({ content: 'Unknown command', ephemeral: true });
                }
            } catch (err) {
                logger.error(`[Discord] Command error (${interaction.commandName}): ${err.message}`);
                const reply = { content: 'An error occurred while processing the command.', ephemeral: true };
                try {
                    if (interaction.deferred || interaction.replied) {
                        await interaction.editReply(reply);
                    } else {
                        await interaction.reply(reply);
                    }
                } catch { /* ignore */ }
            }
        });

        // Handle errors
        client.on('error', (err) => {
            logger.error(`[Discord] Client error: ${err.message}`);
        });

        // Login
        await client.login(dc.botToken);

    } catch (err) {
        logger.error(`[Discord] Connection failed: ${err.message}`);
        isConnected = false;
        client = null;
        throw err;
    }
}

/**
 * Disconnect the Discord bot
 */
async function disconnect() {
    // Send shutdown notification before disconnecting
    if (isConnected) {
        await emitNotification('serverStopped');
    }

    stopLogStreaming();
    stopModelUpdates();

    if (client) {
        try {
            client.destroy();
        } catch { /* ignore */ }
        client = null;
    }
    isConnected = false;
}

/**
 * Get current bot status
 */
function getStatus() {
    return {
        enabled: !!config.discord?.enabled,
        connected: isConnected,
        botUser: client?.user ? {
            tag: client.user.tag,
            id: client.user.id
        } : null,
        guilds: client?.guilds?.cache?.size || 0
    };
}

// ── Public API ──
export default {
    connect,
    disconnect,
    getStatus,
    emitNotification
};
