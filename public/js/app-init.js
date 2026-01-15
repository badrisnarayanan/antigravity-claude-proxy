/**
 * App Initialization (Non-module version)
 * This must load BEFORE Alpine initializes
 */

document.addEventListener('alpine:init', () => {
    // App component registration

    // Main App Controller
    Alpine.data('app', () => ({
        // Re-expose store properties for easier access in navbar
        get connectionStatus() {
            return Alpine.store('data').connectionStatus;
        },
        get loading() {
            return Alpine.store('data').loading;
        },

        init() {
            // App component initialization

            // Theme setup
            document.documentElement.setAttribute('data-theme', 'black');
            document.documentElement.classList.add('dark');

            // Chart Defaults
            if (typeof Chart !== 'undefined') {
                Chart.defaults.color = window.utils.getThemeColor('--color-text-dim');
                Chart.defaults.borderColor = window.utils.getThemeColor('--color-space-border');
                Chart.defaults.font.family = '"JetBrains Mono", monospace';
            }

            // Start Data Polling
            this.startAutoRefresh();
            document.addEventListener('refresh-interval-changed', () => this.startAutoRefresh());

            // Initial Data Fetch (separate from health check)
            Alpine.store('data').fetchData();
        },

        refreshTimer: null,
        isTabVisible: true,

        fetchData() {
            Alpine.store('data').fetchData();
        },

        startAutoRefresh() {
            if (this.refreshTimer) clearInterval(this.refreshTimer);
            const baseInterval = parseInt(Alpine.store('settings').refreshInterval);
            if (baseInterval > 0) {
                // Setup visibility change listener (only once)
                if (!this._visibilitySetup) {
                    this._visibilitySetup = true;
                    document.addEventListener('visibilitychange', () => {
                        this.isTabVisible = !document.hidden;
                        if (this.isTabVisible) {
                            // Tab became visible - fetch immediately and restart timer
                            Alpine.store('data').fetchData();
                            this.startAutoRefresh();
                        }
                    });
                }

                // Schedule next refresh with jitter
                const scheduleNext = () => {
                    // Add ±20% random jitter to prevent synchronized requests
                    const jitter = (Math.random() - 0.5) * 0.4; // -0.2 to +0.2
                    const interval = baseInterval * (1 + jitter);

                    // Slow down when tab is hidden (reduce frequency by 3x)
                    const actualInterval = this.isTabVisible
                        ? interval
                        : interval * 3;

                    this.refreshTimer = setTimeout(() => {
                        Alpine.store('data').fetchData();
                        scheduleNext(); // Reschedule with new jitter
                    }, actualInterval * 1000);
                };

                scheduleNext();
            }
        },

        // Translation helper for modal (not in a component scope)
        t(key) {
            return Alpine.store('global').t(key);
        },

        // Add account handler for modal
        async addAccountWeb(reAuthEmail = null) {
            const password = Alpine.store('global').webuiPassword;
            try {
                const urlPath = reAuthEmail
                    ? `/api/auth/url?email=${encodeURIComponent(reAuthEmail)}`
                    : '/api/auth/url';

                const { response, newPassword } = await window.utils.request(urlPath, {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;

                const data = await response.json();

                if (data.status === 'ok') {
                    const width = 600;
                    const height = 700;
                    const left = (screen.width - width) / 2;
                    const top = (screen.height - height) / 2;

                    window.open(
                        data.url,
                        'google_oauth',
                        `width=${width},height=${height},top=${top},left=${left},scrollbars=yes`
                    );

                    const messageHandler = (event) => {
                        if (event.data?.type === 'oauth-success') {
                            const store = Alpine.store('global');
                            const successMsg = reAuthEmail
                                ? store.t('accountReauthSuccess')
                                : store.t('accountAddedSuccess');
                            store.showToast(successMsg, 'success');
                            Alpine.store('data').fetchData();

                            const modal = document.getElementById('add_account_modal');
                            if (modal) modal.close();
                        }
                    };

                    window.addEventListener('message', messageHandler);
                    setTimeout(() => window.removeEventListener('message', messageHandler), 300000);
                } else {
                    Alpine.store('global').showToast(data.error || Alpine.store('global').t('failedToGetAuthUrl'), 'error');
                }
            } catch (e) {
                Alpine.store('global').showToast(Alpine.store('global').t('failedToStartOAuth') + ': ' + e.message, 'error');
            }
        }
    }));
});
