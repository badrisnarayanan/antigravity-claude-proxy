/**
 * Antigravity Console - Main Entry
 *
 * This file orchestrates Alpine.js initialization.
 * Components are loaded via separate script files that register themselves
 * to window.Components before this script runs.
 */

document.addEventListener('alpine:init', () => {
    // Register Components (loaded from separate files via window.Components)
    Alpine.data('dashboard', window.Components.dashboard);
    Alpine.data('models', window.Components.models);
    Alpine.data('accountManager', window.Components.accountManager);
    Alpine.data('claudeConfig', window.Components.claudeConfig);
    Alpine.data('logsViewer', window.Components.logsViewer);

    // View Loader Directive (with caching for performance)
    Alpine.directive('load-view', (el, { expression }, { evaluate }) => {
        if (!window.viewCache) window.viewCache = new Map();

        const viewName = evaluate(expression);

        // Use cached view immediately if available
        if (window.viewCache.has(viewName)) {
            el.innerHTML = window.viewCache.get(viewName);
            Alpine.initTree(el);
            return;
        }

        // Fetch without cache-busting for better performance
        fetch(`views/${viewName}.html`)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            })
            .then(html => {
                window.viewCache.set(viewName, html);
                el.innerHTML = html;
                Alpine.initTree(el);
            })
            .catch(err => {
                console.error('Failed to load view:', viewName, err);
                el.innerHTML = `<div class="p-4 border border-red-500/50 bg-red-500/10 rounded-lg text-red-400 font-mono text-sm">
                    Error loading view: ${viewName}<br>
                    <span class="text-xs opacity-75">${err.message}</span>
                </div>`;
            });
    });

    // Main App Controller
    Alpine.data('app', () => ({
        // Electron state
        isElectron: false,
        isMaximized: false,

        // Visibility state for throttling
        _isTabVisible: true,
        _visibilityHandler: null,

        get connectionStatus() {
            return Alpine.store('data')?.connectionStatus || 'connecting';
        },
        get loading() {
            return Alpine.store('data')?.loading || false;
        },

        init() {
            // Theme setup
            document.documentElement.setAttribute('data-theme', 'black');
            document.documentElement.classList.add('dark');

            // Chart Defaults (defer until Chart.js is loaded)
            this._initChartDefaults();

            // Tab visibility handling for performance
            this._setupVisibilityHandler();

            // Start Data Polling
            this.startAutoRefresh();
            document.addEventListener('refresh-interval-changed', () => this.startAutoRefresh());

            // Initial Fetch
            Alpine.store('data').fetchData();
        },

        _initChartDefaults() {
            // Wait for Chart.js to be available (it's deferred)
            if (typeof Chart !== 'undefined') {
                Chart.defaults.color = window.utils?.getThemeColor?.('--color-text-dim') || '#a1a1aa';
                Chart.defaults.borderColor = window.utils?.getThemeColor?.('--color-space-border') || '#27272a';
                Chart.defaults.font.family = '"JetBrains Mono", monospace';
            } else {
                // Retry after a short delay if Chart.js isn't loaded yet
                setTimeout(() => this._initChartDefaults(), 100);
            }
        },

        _setupVisibilityHandler() {
            this._visibilityHandler = () => {
                this._isTabVisible = !document.hidden;
                if (this._isTabVisible) {
                    // Refresh immediately when tab becomes visible
                    Alpine.store('data').fetchData();
                }
            };
            document.addEventListener('visibilitychange', this._visibilityHandler);
        },

        // Initialize Electron-specific features
        initElectron() {
            if (window.electronAPI?.isElectron) {
                this.isElectron = true;

                // Get initial maximize state
                window.electronAPI.isMaximized().then(maximized => {
                    this.isMaximized = maximized;
                });

                // Listen for maximize state changes
                window.electronAPI.onMaximizeChange((maximized) => {
                    this.isMaximized = maximized;
                });
            }
        },

        // Window control methods
        minimizeWindow() {
            window.electronAPI?.minimize();
        },

        maximizeWindow() {
            window.electronAPI?.maximize();
        },

        closeWindow() {
            window.electronAPI?.close();
        },

        refreshTimer: null,

        fetchData() {
            Alpine.store('data').fetchData();
        },

        startAutoRefresh() {
            if (this.refreshTimer) clearInterval(this.refreshTimer);
            const interval = parseInt(Alpine.store('settings')?.refreshInterval || 60);
            if (interval > 0) {
                this.refreshTimer = setInterval(() => {
                    // Skip refresh if tab is not visible (performance optimization)
                    if (this._isTabVisible) {
                        Alpine.store('data').fetchData();
                    }
                }, interval * 1000);
            }
        },

        t(key) {
            return Alpine.store('global')?.t(key) || key;
        },

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
                    Alpine.store('global').showToast(Alpine.store('global').t('oauthInProgress'), 'info');

                    const oauthWindow = window.open(data.url, 'google_oauth', 'width=600,height=700,scrollbars=yes');

                    const initialAccountCount = Alpine.store('data').accounts.length;
                    let pollCount = 0;
                    const maxPolls = 60;
                    let cancelled = false;

                    Alpine.store('global').oauthProgress = {
                        active: true,
                        current: 0,
                        max: maxPolls,
                        cancel: () => {
                            cancelled = true;
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(Alpine.store('global').t('oauthCancelled'), 'info');
                            if (oauthWindow && !oauthWindow.closed) {
                                oauthWindow.close();
                            }
                        }
                    };

                    const pollInterval = setInterval(async () => {
                        if (cancelled) {
                            clearInterval(pollInterval);
                            return;
                        }

                        pollCount++;
                        Alpine.store('global').oauthProgress.current = pollCount;

                        if (oauthWindow && oauthWindow.closed && !cancelled) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(Alpine.store('global').t('oauthWindowClosed'), 'warning');
                            return;
                        }

                        await Alpine.store('data').fetchData();

                        const currentAccountCount = Alpine.store('data').accounts.length;
                        if (currentAccountCount > initialAccountCount) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;

                            const actionKey = reAuthEmail ? 'accountReauthSuccess' : 'accountAddedSuccess';
                            Alpine.store('global').showToast(
                                Alpine.store('global').t(actionKey),
                                'success'
                            );
                            document.getElementById('add_account_modal')?.close();

                            if (oauthWindow && !oauthWindow.closed) {
                                oauthWindow.close();
                            }
                        }

                        if (pollCount >= maxPolls) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(
                                Alpine.store('global').t('oauthTimeout'),
                                'warning'
                            );
                        }
                    }, 2000);
                } else {
                    Alpine.store('global').showToast(data.error || Alpine.store('global').t('failedToGetAuthUrl'), 'error');
                }
            } catch (e) {
                Alpine.store('global').showToast(Alpine.store('global').t('failedToStartOAuth') + ': ' + e.message, 'error');
            }
        }
    }));
});
