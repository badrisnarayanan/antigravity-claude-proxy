/**
 * Global Store for Antigravity Console
 * Handles Translations, Toasts, and Shared Config
 */

document.addEventListener('alpine:init', () => {
    Alpine.store('global', {
        init() {
            // Hash-based routing
            const validTabs = ['dashboard', 'models', 'accounts', 'logs', 'settings'];
            const getHash = () => window.location.hash.substring(1);

            // 1. Initial load from hash
            const initialHash = getHash();
            if (validTabs.includes(initialHash)) {
                this.activeTab = initialHash;
            }

            // 2. Sync State -> URL
            Alpine.effect(() => {
                if (validTabs.includes(this.activeTab) && getHash() !== this.activeTab) {
                    window.location.hash = this.activeTab;
                }
            });

            // 3. Sync URL -> State (Back/Forward buttons)
            window.addEventListener('hashchange', () => {
                const hash = getHash();
                if (validTabs.includes(hash) && this.activeTab !== hash) {
                    this.activeTab = hash;
                }
            });
        },

        // App State
        version: '1.0.0',
        activeTab: 'dashboard',
        webuiPassword: localStorage.getItem('antigravity_webui_password') || '',

        // i18n
        lang: localStorage.getItem('app_lang') || 'en',
        translations: window.translations || {},

        // Toast Messages
        toast: null,

        // OAuth Progress
        oauthProgress: {
            active: false,
            current: 0,
            max: 60,
            cancel: null
        },

        t(key, params = {}) {
            let str = this.translations[this.lang][key] || key;
            if (typeof str === 'string') {
                Object.keys(params).forEach(p => {
                    str = str.replace(`{${p}}`, params[p]);
                });
            }
            return str;
        },

        setLang(l) {
            this.lang = l;
            localStorage.setItem('app_lang', l);
        },

        showToast(message, type = 'info') {
            const id = Date.now();
            this.toast = { message, type, id };
            setTimeout(() => {
                if (this.toast && this.toast.id === id) this.toast = null;
            }, 3000);
        }
    });
});
