/**
 * Account Actions Service
 * 纯业务逻辑层 - 处理账号操作的 HTTP 请求、乐观更新和数据刷新
 * 不包含 UI 关注点（Toast、Loading、模态框由组件层处理）
 */
window.AccountActions = window.AccountActions || {};

/**
 * 刷新账号 token 和配额信息
 * @param {string} email - 账号邮箱
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
window.AccountActions.refreshAccount = async function(email) {
    const store = Alpine.store('global');

    try {
        const { response, newPassword } = await window.utils.request(
            `/api/accounts/${encodeURIComponent(email)}/refresh`,
            { method: 'POST' },
            store.webuiPassword
        );

        if (newPassword) {
            store.webuiPassword = newPassword;
        }

        const data = await response.json();
        if (data.status !== 'ok') {
            return { success: false, error: data.error || Alpine.store('global').t('refreshFailed') };
        }

        // 触发数据刷新
        await Alpine.store('data').fetchData();

        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * 切换账号启用/禁用状态（包含乐观更新和错误回滚）
 * @param {string} email - 账号邮箱
 * @param {boolean} enabled - 目标状态（true=启用, false=禁用）
 * @returns {Promise<{success: boolean, rolledBack?: boolean, data?: object, error?: string}>}
 */
window.AccountActions.toggleAccount = async function(email, enabled) {
    const store = Alpine.store('global');
    const dataStore = Alpine.store('data');

    // 乐观更新：立即修改 UI
    const account = dataStore.accounts.find(a => a.email === email);
    const previousState = account ? account.enabled : !enabled;

    if (account) {
        account.enabled = enabled;
    }

    try {
        const { response, newPassword } = await window.utils.request(
            `/api/accounts/${encodeURIComponent(email)}/toggle`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            },
            store.webuiPassword
        );

        if (newPassword) {
            store.webuiPassword = newPassword;
        }

        const data = await response.json();
        if (data.status !== 'ok') {
            throw new Error(data.error || Alpine.store('global').t('toggleFailed'));
        }

        // 确认服务器状态
        await dataStore.fetchData();
        return { success: true, data };

    } catch (error) {
        // 错误回滚：恢复原状态
        if (account) {
            account.enabled = previousState;
        }
        await dataStore.fetchData();
        return { success: false, error: error.message, rolledBack: true };
    }
};

/**
 * 删除账号
 * @param {string} email - 账号邮箱
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
window.AccountActions.deleteAccount = async function(email) {
    const store = Alpine.store('global');

    try {
        const { response, newPassword } = await window.utils.request(
            `/api/accounts/${encodeURIComponent(email)}`,
            { method: 'DELETE' },
            store.webuiPassword
        );

        if (newPassword) {
            store.webuiPassword = newPassword;
        }

        const data = await response.json();
        if (data.status !== 'ok') {
            return { success: false, error: data.error || Alpine.store('global').t('deleteFailed') };
        }

        // 触发数据刷新
        await Alpine.store('data').fetchData();
        return { success: true, data };

    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * 获取账号重新认证的 OAuth URL
 * 注意：此方法仅返回 URL，不打开窗口（由组件层决定如何处理）
 * @param {string} email - 账号邮箱
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
window.AccountActions.getFixAccountUrl = async function(email) {
    const store = Alpine.store('global');

    try {
        const urlPath = `/api/auth/url?email=${encodeURIComponent(email)}`;
        const { response, newPassword } = await window.utils.request(
            urlPath,
            {},
            store.webuiPassword
        );

        if (newPassword) {
            store.webuiPassword = newPassword;
        }

        const data = await response.json();
        if (data.status !== 'ok') {
            return { success: false, error: data.error || Alpine.store('global').t('authUrlFailed') };
        }

        return { success: true, url: data.url };

    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * 从磁盘重新加载所有账号配置
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
window.AccountActions.reloadAccounts = async function() {
    const store = Alpine.store('global');

    try {
        const { response, newPassword } = await window.utils.request(
            '/api/accounts/reload',
            { method: 'POST' },
            store.webuiPassword
        );

        if (newPassword) {
            store.webuiPassword = newPassword;
        }

        const data = await response.json();
        if (data.status !== 'ok') {
            return { success: false, error: data.error || Alpine.store('global').t('reloadFailed') };
        }

        // 触发数据刷新
        await Alpine.store('data').fetchData();
        return { success: true, data };

    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * 检查账号是否可以删除
 * 来自 Antigravity 数据库的账号（source='database'）不可删除
 * @param {object} account - 账号对象
 * @returns {boolean} true 表示可删除
 */
window.AccountActions.canDelete = function(account) {
    return account && account.source !== 'database';
};
