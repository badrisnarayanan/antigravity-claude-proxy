/**
 * Redact Mode Utility
 * Replaces sensitive account data with anonymous labels for screenshots.
 */
window.Redact = {
    email(email) {
        if (!Alpine.store('settings').redactMode) return email;
        if (!email) return email;
        const accounts = Alpine.store('data')?.accounts || [];
        // Match full email or username-only (split('@')[0]) form
        const idx = accounts.findIndex(a => a.email === email || a.email.split('@')[0] === email);
        return idx >= 0 ? `Account ${idx + 1}` : 'Account';
    },

    logMessage(message) {
        if (!Alpine.store('settings').redactMode) return message;
        const accounts = Alpine.store('data')?.accounts || [];
        let result = message;
        accounts.forEach((acc, idx) => {
            if (!acc.email) return;
            const escaped = acc.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escaped, 'g'), `Account ${idx + 1}`);
            const user = acc.email.split('@')[0];
            if (user) {
                const escapedUser = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escapedUser, 'g'), `Account ${idx + 1}`);
            }
        });
        return result;
    }
};
