/**
 * Issue Banner Component
 * Displays active system issues at the top of the logs view
 */
window.Components = window.Components || {};

window.Components.issueBanner = () => ({
    issues: [],
    loading: false,
    expanded: true, // Default to expanded
    pollInterval: null,

    init() {
        this.loadIssues();

        // Watch issues to notify other components
        this.$watch('issues', (val) => {
            this.notifyUpdate(val.length);
        });

        // Subscribe to global issue events if available, otherwise poll
        // For now we'll use polling to keep it simple and robust
        this.pollInterval = setInterval(() => {
            if (!document.hidden) {
                this.loadIssues(true); // Silent reload
            }
        }, 5000);
    },

    notifyUpdate(count) {
        window.dispatchEvent(new CustomEvent('issues-updated', {
            detail: { count }
        }));
    },

    destroy() {
        // Called when component is removed
        if (this.pollInterval) clearInterval(this.pollInterval);
    },

    async loadIssues(silent = false) {
        if (!silent) this.loading = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/issues/active', {}, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;

            if (response.ok) {
                const data = await response.json();
                this.issues = data.issues || [];

                // Immediate notification on first load
                if (!silent) this.notifyUpdate(this.issues.length);
            }
        } catch (error) {
            if (!silent) console.error('Failed to load issues:', error);
        } finally {
            if (!silent) this.loading = false;
        }
    },

    async resolveIssue(issueId) {
        if (!confirm('Mark this issue as resolved?')) return;

        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(`/api/issues/${issueId}/resolve`, {
                method: 'POST'
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;

            if (response.ok) {
                // Remove locally immediately for better UX
                this.issues = this.issues.filter(i => i.id !== issueId);
                store.showToast('Issue resolved', 'success');

                // Trigger global stats update if needed
                if (window.AccountActions) window.AccountActions.reloadAccounts();
            } else {
                const err = await response.json();
                store.showToast(err.error || 'Failed to resolve issue', 'error');
            }
        } catch (error) {
            Alpine.store('global').showToast('Network error', 'error');
        }
    },

    getIcon(type) {
        switch (type) {
            case 'rate_limit_streak': return `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
            case 'auth_failure': return `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>`;
            case 'model_exhausted': return `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>`;
            case 'health_degraded': return `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" /></svg>`;
            default: return `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
        }
    },

    getColorClass(severity) {
        switch (severity) {
            case 'high': return 'alert-error bg-red-900/20 border-red-500/50 text-red-200';
            case 'medium': return 'alert-warning bg-yellow-900/20 border-yellow-500/50 text-yellow-200';
            default: return 'alert-info bg-blue-900/20 border-blue-500/50 text-blue-200';
        }
    }
});
