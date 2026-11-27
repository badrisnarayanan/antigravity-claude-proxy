/**
 * Usage Limits panel (#390)
 * Shows each account's 5-hour and weekly quota windows per model group,
 * from GET /api/account-quotas (the server caches each account for 60 s).
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.quotaWindows = () => ({
    accounts: [],
    loading: true,
    loaded: false,
    error: null,
    fetchedAt: null,
    _timer: null,

    // Window keys in display order, with their translation keys
    windowDefs: [
        { key: 'fiveHour', label: 'limitFiveHour' },
        { key: 'weekly', label: 'limitWeekly' }
    ],

    init() {
        if (this.$store.global.activeTab === 'dashboard') this.start();

        this.$watch('$store.global.activeTab', (val) => {
            if (val === 'dashboard') this.start();
            else this.stop();
        });
    },

    destroy() {
        this.stop();
    },

    start() {
        this.fetchQuotas();
        if (!this._timer) {
            this._timer = setInterval(() => this.fetchQuotas(), window.AppConstants?.INTERVALS?.QUOTA_WINDOWS_REFRESH || 60000);
        }
    },

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    async fetchQuotas() {
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/account-quotas', {}, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.accounts = Array.isArray(data.accounts) ? data.accounts : [];
            this.fetchedAt = data.fetchedAt || null;
            this.error = null;
            this.loaded = true;
        } catch (e) {
            this.error = e.message || 'Request failed';
            if (window.UILogger) window.UILogger.debug('Account quotas fetch failed', this.error);
        } finally {
            this.loading = false;
        }
    },

    /** Accounts that have something to show (groups, or a status worth stating) */
    get visibleAccounts() {
        return this.accounts.filter(a => (a.groups && a.groups.length > 0) || a.status !== 'ok');
    },

    get isEmpty() {
        return this.loaded && this.visibleAccounts.length === 0;
    },

    /** Percent left in a window, 0-100, or null when the window isn't reported */
    pct(win) {
        if (!win || typeof win.remainingFraction !== 'number') return null;
        return Math.round(Math.min(1, Math.max(0, win.remainingFraction)) * 100);
    },

    barClass(win) {
        const f = win?.remainingFraction ?? 0;
        return f > 0.5 ? 'bg-neon-green/80' : (f > 0 ? 'bg-neon-yellow/80' : 'bg-neon-red/60');
    },

    pctClass(win) {
        return (win?.remainingFraction ?? 0) > 0 ? 'text-gray-300' : 'text-red-500/80';
    },

    /** Time until reset ("2H 15M", or "6D 23H" for a weekly window), '' when there's none (window unused) */
    resetLabel(win) {
        if (!win || !win.resetTime) return '';
        const t = new Date(win.resetTime);
        if (Number.isNaN(t.getTime())) return '';
        const hours = Math.floor((t - Date.now()) / 3600000);
        if (hours >= 24) {
            const g = this.$store.global;
            return `${Math.floor(hours / 24)}${g.t('timeD')} ${hours % 24}${g.t('timeH')}`;
        }
        return window.utils.formatTimeUntil(win.resetTime);
    },

    resetTitle(win) {
        if (!win || !win.resetTime) return '';
        const t = new Date(win.resetTime);
        return Number.isNaN(t.getTime()) ? '' : t.toLocaleString();
    },

    tierClass(tier) {
        if (tier === 'ultra') return 'status-pill-ultra';
        if (tier === 'pro') return 'status-pill-pro';
        return 'status-pill-free';
    },

    tierLabel(tier) {
        const t = (key) => this.$store.global.t(key);
        if (!tier) return '';
        const key = { ultra: 'tierUltra', pro: 'tierPro', free: 'tierFree' }[tier];
        const label = key ? t(key) : tier;
        // Some languages lack the tier keys: fall back to the tier name
        return label === key ? tier.charAt(0).toUpperCase() + tier.slice(1) : label;
    },

    statusLabel(account) {
        const t = (key) => this.$store.global.t(key);
        if (account.status === 'disabled') return t('limitAccountDisabled');
        if (account.status === 'invalid') return t('limitAccountInvalid');
        if (account.status === 'error') return t('limitAccountError');
        return '';
    },

    updatedLabel() {
        if (!this.fetchedAt) return '';
        const d = new Date(this.fetchedAt);
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
});
