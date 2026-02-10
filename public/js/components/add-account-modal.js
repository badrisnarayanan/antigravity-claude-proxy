/**
 * Add Account Modal Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    manualMode: false,
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,

    /**
     * Reset all state to initial values
     */
    resetState() {
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        // Close any open details elements
        const details = document.querySelectorAll('#add_account_modal details[open]');
        details.forEach(d => d.removeAttribute('open'));
    },

    async copyLink() {
        if (!this.authUrl) return;

        const store = Alpine.store('global');

        // 简化逻辑：优先尝试 Clipboard API；无论成功与否，都选中输入框，保证至少可以手动 Ctrl+C
        try {
            // 先选中可见的输入框，方便浏览器策略不允许自动复制时，用户可以直接 Ctrl+C
            const modal = document.getElementById('add_account_modal');
            const inputEl = modal ? modal.querySelector('input[readonly]') : null;
            if (inputEl) {
                inputEl.focus();
                inputEl.select();
            }

            let copied = false;

            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(this.authUrl);
                copied = true;
            }

            if (copied) {
                store.showToast(store.t('linkCopied'), 'success');
            } else {
                // 在不支持 Clipboard API 或被策略拦截的环境下，提示用户手动复制（此时输入框已被选中）
                store.showToast(store.t('authLinkLabel') + ' ' + store.t('linkCopied'), 'info');
            }
        } catch (e) {
            console.error('Failed to copy auth URL:', e);
            // 失败时给出可读提示，但不阻塞用户手动复制
            store.showToast(store.t('authLinkLabel') + ' ' + this.authUrl, 'error');
        }
    },

    async initManualAuth(event) {
        if (event.target.open && !this.authUrl) {
            try {
                const password = Alpine.store('global').webuiPassword;
                const {
                    response,
                    newPassword
                } = await window.utils.request('/api/auth/url', {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                const data = await response.json();
                if (data.status === 'ok') {
                    this.authUrl = data.url;
                    this.authState = data.state;
                }
            } catch (e) {
                Alpine.store('global').showToast(e.message, 'error');
            }
        }
    },

    async completeManualAuth() {
        if (!this.callbackInput || !this.authState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const {
                response,
                newPassword
            } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    callbackInput: this.callbackInput,
                    state: this.authState
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            
            // Check HTTP status code
            if (!response.ok) {
                // Try to parse error response
                let errorMessage = store.t('authFailed');
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    // If JSON parsing fails, use status text
                    errorMessage = `${store.t('authFailed')}: ${response.statusText || response.status}`;
                }
                store.showToast(errorMessage, 'error');
                return;
            }
            
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess'), 'success');
                // Wait for data refresh to complete before closing modal
                await Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || store.t('authFailed'), 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message || store.t('authFailed'), 'error');
        } finally {
            this.submitting = false;
        }
    }
});
