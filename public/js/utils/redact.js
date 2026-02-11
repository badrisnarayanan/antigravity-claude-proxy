/**
 * Anonymize Mode Utility
 * Replaces sensitive account data with NATO phonetic alphabet labels.
 */
window.Redact = {
    // NATO phonetic alphabet for elegant anonymization
    NATO_ALPHABET: [
        'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
        'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
        'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey',
        'X-ray', 'Yankee', 'Zulu'
    ],

    getCallsign(idx) {
        if (idx < this.NATO_ALPHABET.length) {
            return this.NATO_ALPHABET[idx];
        }
        // For accounts beyond 26, use NATO name + number (e.g., "Alpha-2")
        const cycle = Math.floor(idx / this.NATO_ALPHABET.length) + 1;
        const nameIdx = idx % this.NATO_ALPHABET.length;
        return `${this.NATO_ALPHABET[nameIdx]}-${cycle}`;
    },

    email(email) {
        if (!Alpine.store('settings').redactMode) return email;
        if (!email) return email;
        const accounts = Alpine.store('data')?.accounts || [];
        // Match full email or username-only (split('@')[0]) form
        const idx = accounts.findIndex(a => a.email === email || (a.email && a.email.split('@')[0] === email));
        return idx >= 0 ? this.getCallsign(idx) : 'Unknown';
    },

    logMessage(message) {
        if (!Alpine.store('settings').redactMode) return message;
        const accounts = Alpine.store('data')?.accounts || [];
        let result = message;
        accounts.forEach((acc, idx) => {
            if (!acc.email) return;
            const callsign = this.getCallsign(idx);
            const escaped = acc.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escaped, 'g'), callsign);
            const user = acc.email.split('@')[0];
            if (user) {
                const escapedUser = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(`\\b${escapedUser}\\b`, 'g'), callsign);
            }
        });
        return result;
    }
};
