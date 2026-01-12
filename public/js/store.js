/**
 * Global Store for Antigravity Console
 * Handles Translations, Toasts, and Shared Config
 */

document.addEventListener("alpine:init", () => {
  Alpine.store("global", {
    init() {
      // Hash-based routing
      const validTabs = ["dashboard", "models", "accounts", "logs", "settings"];
      const getHash = () => window.location.hash.substring(1);

      // 1. Initial load from hash
      const initialHash = getHash();
      if (validTabs.includes(initialHash)) {
        this.activeTab = initialHash;
      }
      // Restore password from session storage (more secure than local storage)
      // This ensures password persists across reloads but clears on browser close
      this.webuiPassword = sessionStorage.getItem("webuiPassword") || "";

      // Sync state to URL hash
      Alpine.effect(() => {
        const params = new URLSearchParams(window.location.hash.slice(1));
        if (this.activeTab !== "dashboard") {
          params.set("tab", this.activeTab);
        } else {
          params.delete("tab");
        }
        const newHash = params.toString();
        if (
          window.location.hash.slice(1) !== newHash &&
          (newHash || window.location.hash)
        ) {
          window.location.hash = newHash;
        }
      });

      // 3. Sync URL -> State (Back/Forward buttons)
      window.addEventListener("hashchange", () => {
        const hash = getHash();
        if (validTabs.includes(hash) && this.activeTab !== hash) {
          this.activeTab = hash;
        }
      });
    },

    // App State
    version: "1.0.0",
    activeTab: "dashboard",
    webuiPassword: localStorage.getItem("antigravity_webui_password") || "",

    // i18n
    lang: localStorage.getItem("app_lang") || "en",
    translations: {
      en: {
        dashboard: "Dashboard",
        models: "Models",
        accounts: "Accounts",
        logs: "Logs",
        settings: "Settings",
        online: "ONLINE",
        offline: "OFFLINE",
        totalAccounts: "TOTAL ACCOUNTS",
        active: "ACTIVE",
        operational: "Operational",
        rateLimited: "RATE LIMITED",
        quotasDepleted: "{count}/{total} Quotas Depleted",
        quotasDepletedTitle: "QUOTAS DEPLETED",
        outOfTracked: "Out of {total} Tracked",
        cooldown: "Cooldown",
        searchPlaceholder: "Search models...",
        allAccounts: "All Accounts",
        stat: "STAT",
        modelIdentity: "MODEL IDENTITY",
        globalQuota: "GLOBAL QUOTA",
        nextReset: "NEXT RESET",
        distribution: "ACCOUNT DISTRIBUTION",
        systemConfig: "System Configuration",
        language: "Language",
        pollingInterval: "Polling Interval",
        maxDisplayLogs: "Max Displayed Logs",
        showExhausted: "Show Exhausted Models",
        showExhaustedDesc:
          "Display models even if they have 0% remaining quota.",
        compactMode: "Compact Mode",
        compactModeDesc:
          "Reduce padding in tables for higher information density.",
        saveChanges: "Save Changes",
        autoScroll: "Auto-scroll",
        clearLogs: "Clear Logs",
        accountManagement: "Account Management",
        manageTokens: "Manage Google Account tokens and authorization states",
        addAccount: "Add Account",
        status: "STATUS",
        enabled: "ENABLED",
        health: "STATUS",
        accountEmail: "ACCOUNT (EMAIL)",
        source: "SOURCE",
        projectId: "PROJECT ID",
        sessionState: "SESSION STATE",
        operations: "OPERATIONS",
        delete: "Delete",
        confirmDelete: "Are you sure you want to remove this account?",
        cannotDeleteDatabase:
          "Cannot delete: This account is from Antigravity database (read-only)",
        connectGoogle: "Connect Google Account",
        reauthenticated: "re-authenticated",
        added: "added",
        successfully: "successfully",
        accountAddedSuccess: "Account added successfully",
        accountReauthSuccess: "Account re-authenticated successfully",
        failedToGetAuthUrl: "Failed to get auth URL",
        failedToStartOAuth: "Failed to start OAuth flow",
        oauthInProgress:
          "OAuth in progress. Please complete authentication in the popup window...",
        family: "Family",
        model: "Model",
        activeSuffix: "Active",
        // Tabs
        tabInterface: "Interface",
        tabClaude: "Claude CLI",
        tabModels: "Models",
        tabServer: "Server Settings",
        // Dashboard
        linkedAccounts: "Linked Accounts",
        noSignal: "NO SIGNAL DETECTED",
        establishingUplink: "ESTABLISHING UPLINK...",
        goToAccounts: "Go to Accounts",
        // Settings - Models
        modelsDesc: "Configure model visibility, pinning, and request routing.",
        modelsPageDesc: "Real-time quota and status for all available models.",
        showHidden: "Show Hidden Models",
        modelId: "Model ID",
        actions: "Actions",
        pinToTop: "Pin to top",
        toggleVisibility: "Toggle Visibility",
        noModels: "NO MODELS DETECTED",
        modelMappingHint:
          "Server-side model routing. Claude Code users: see 'Claude CLI' tab for client-side setup.",
        modelMapping: "Mapping (Target Model ID)",
        // Settings - Claude
        proxyConnection: "Proxy Connection",
        modelSelection: "Model Selection",
        defaultModelAliases: "DEFAULT MODEL ALIASES",
        opusAlias: "Opus Alias",
        sonnetAlias: "Sonnet Alias",
        haikuAlias: "Haiku Alias",
        claudeSettingsAlertPrefix: "Settings below directly modify",
        claudeSettingsAlertSuffix: "Restart Claude CLI to apply.",
        applyToClaude: "Apply to Claude CLI",
        // Settings - Server
        port: "Port",
        uiVersion: "UI Version",
        debugMode: "Debug Mode",
        environment: "Environment",
        serverReadOnly:
          "Settings managed via config.json. Restart server to apply changes.",
        advancedSettings: "Advanced Settings",
        reloadConfigTitle: "Reload Account Config",
        reloadConfigDesc: "Force reload accounts.json from disk",
        reload: "Reload",
        // Config Specific
        primaryModel: "Primary Model",
        subAgentModel: "Sub-agent Model",
        advancedOverrides: "Default Model Overrides",
        opusModel: "Opus Model",
        sonnetModel: "Sonnet Model",
        haikuModel: "Haiku Model",
        authToken: "Auth Token",
        saveConfig: "Save to Claude CLI settings",
        envVar: "Env",
        // New Keys
        systemName: "ANTIGRAVITY",
        systemDesc: "CLAUDE PROXY SYSTEM",
        connectGoogleDesc:
          "Connect a Google Workspace account to increase your API quota limit. The account will be used to proxy Claude requests via Antigravity.",
        useCliCommand: "Use CLI Command",
        close: "Close",
        requestVolume: "Request Volume",
        filter: "Filter",
        all: "All",
        none: "None",
        noDataTracked: "No data tracked yet",
        selectFamilies: "Select families to display",
        selectModels: "Select models to display",
        noLogsMatch: "No logs match filter",
        connecting: "CONNECTING",
        main: "Main",
        system: "System",
        refreshData: "Refresh Data",
        connectionLost: "Connection Lost",
        lastUpdated: "Last Updated",
        grepLogs: "grep logs...",
        noMatchingModels: "No matching models",
        typeToSearch: "Type to search or select...",
        or: "OR",
        refreshingAccount: "Refreshing {email}...",
        refreshedAccount: "Refreshed {email}",
        refreshFailed: "Refresh failed",
        accountToggled: "Account {email} {status}",
        toggleFailed: "Toggle failed",
        reauthenticating: "Re-authenticating {email}...",
        authUrlFailed: "Failed to get auth URL",
        deletedAccount: "Deleted {email}",
        deleteFailed: "Delete failed",
        accountsReloaded: "Accounts reloaded",
        reloadFailed: "Reload failed",
        claudeConfigSaved: "Claude configuration saved",
        claudeConfigRestored: "Claude CLI restored to defaults",
        saveConfigFailed: "Failed to save configuration",
        restoreConfigFailed: "Failed to restore configuration",
        restoreDefault: "Restore Default",
        confirmRestoreTitle: "Confirm Restore",
        confirmRestoreMessage:
          "Are you sure you want to restore Claude CLI to default settings? This will remove proxy configuration.",
        confirmRestore: "Confirm Restore",
        claudeActive: "Claude Active",
        claudeEmpty: "Claude Empty",
        geminiActive: "Gemini Active",
        geminiEmpty: "Gemini Empty",
        synced: "SYNCED",
        syncing: "SYNCING...",
        // Time range labels
        last1Hour: "Last 1H",
        last6Hours: "Last 6H",
        last24Hours: "Last 24H",
        last7Days: "Last 7D",
        allTime: "All Time",
        groupBy: "Group By",
        // Additional
        reloading: "Reloading...",
        reloaded: "Reloaded",
        lines: "lines",
        enabledSeeLogs: "Enabled (See Logs)",
        production: "Production",
        configSaved: "Configuration Saved",
        enterPassword: "Enter Web UI Password:",
        ready: "READY",
        depleted: "Depleted",
        timeH: "H",
        timeM: "M",
        familyClaude: "Claude",
        familyGemini: "Gemini",
        familyOther: "Other",
        enabledStatus: "enabled",
        disabledStatus: "disabled",
        logLevelInfo: "INFO",
        logLevelSuccess: "SUCCESS",
        logLevelWarn: "WARN",
        logLevelError: "ERR",
        totalColon: "Total:",
        todayColon: "Today:",
        hour1Colon: "1H:",
        frequentModels: "Frequent",
        smartTitle: "Auto-select top 5 most used models (24h)",
        activeCount: "{count} Active",
        allCaps: "ALL",
        claudeCaps: "CLAUDE",
        geminiCaps: "GEMINI",
        systemInfo: "System Information",
        refresh: "Refresh",
        runtimeConfig: "Runtime Configuration",
        debugDesc: "Enable detailed logging (See Logs tab)",
        networkRetry: "Network Retry Settings",
        maxRetries: "Max Retries",
        retryBaseDelay: "Retry Base Delay (ms)",
        retryMaxDelay: "Retry Max Delay (ms)",
        persistentSessions: "Persistent Sessions",
        persistTokenDesc: "Save OAuth sessions to disk for faster restarts",
        rateLimiting: "Account Rate Limiting & Timeouts",
        defaultCooldown: "Default Cooldown Time",
        maxWaitThreshold: "Max Wait Threshold (Sticky)",
        maxWaitDesc:
          "Maximum time to wait for a sticky account to reset before switching.",
        saveConfigServer: "Save Configuration",
        serverRestartAlert:
          "Changes saved to {path}. Restart server to apply some settings.",
        changePassword: "Change WebUI Password",
        changePasswordDesc: "Update the password for accessing this dashboard",
        currentPassword: "Current Password",
        newPassword: "New Password",
        confirmNewPassword: "Confirm New Password",
        passwordEmptyDesc: "Leave empty if no password set",
        passwordLengthDesc: "At least 6 characters",
        passwordConfirmDesc: "Re-enter new password",
        cancel: "Cancel",
        passwordsNotMatch: "Passwords do not match",
        passwordTooShort: "Password must be at least 6 characters",
        // Dashboard drill-down
        clickToViewAllAccounts: "Click to view all accounts",
        clickToViewModels: "Click to view Models page",
        clickToViewLimitedAccounts: "Click to view rate-limited accounts",
        clickToFilterClaude: "Click to filter Claude models",
        clickToFilterGemini: "Click to filter Gemini models",
        // Accounts page
        searchAccounts: "Search accounts...",
        noAccountsYet: "No Accounts Yet",
        noAccountsDesc:
          "Get started by adding a Google account via OAuth, or use the CLI command to import credentials.",
        addFirstAccount: "Add Your First Account",
        noSearchResults: "No accounts match your search",
        clearSearch: "Clear Search",
        disabledAccountsNote:
          "<strong>Disabled accounts</strong> will not be used for request routing but remain in the configuration. Dashboard statistics only include enabled accounts.",
        dangerousOperation: "⚠️ Dangerous Operation",
        confirmDeletePrompt: "Are you sure you want to delete account",
        deleteWarning:
          "⚠️ This action cannot be undone. All configuration and historical records will be permanently deleted.",
        // OAuth progress
        oauthWaiting: "Waiting for OAuth authorization...",
        oauthWaitingDesc:
          "Please complete the authentication in the popup window. This may take up to 2 minutes.",
        oauthCancelled: "OAuth authorization cancelled",
        oauthTimeout: "⏱️ OAuth authorization timed out. Please try again.",
        oauthWindowClosed:
          "OAuth window was closed. Authorization may be incomplete.",
        cancelOAuth: "Cancel",
        // MCP CLI & Gemini 1M
        mcpCliExperimental: "Experimental MCP CLI",
        mcpCliDesc:
          "Enables experimental MCP integration for reliable tool usage with reduced context consumption.",
        gemini1mMode: "Gemini 1M Context Mode",
        gemini1mDesc:
          "Appends [1m] suffix to Gemini models for 1M context window support.",
        gemini1mWarning: "⚠ Large context may reduce Gemini-3-Pro performance.",
        clickToSet: "Click to configure...",
      },
      zh: {
        dashboard: "仪表盘",
        models: "模型列表",
        accounts: "账号管理",
        logs: "运行日志",
        settings: "系统设置",
        online: "在线",
        offline: "离线",
        totalAccounts: "账号总数",
        active: "活跃状态",
        operational: "运行中",
        rateLimited: "受限状态",
        quotasDepleted: "{count}/{total} 配额耗尽",
        quotasDepletedTitle: "配额耗尽数",
        outOfTracked: "共追踪 {total} 个",
        cooldown: "冷却中",
        searchPlaceholder: "搜索模型...",
        allAccounts: "所有账号",
        stat: "状态",
        modelIdentity: "模型标识",
        globalQuota: "全局配额",
        nextReset: "重置时间",
        distribution: "账号分布",
        systemConfig: "系统配置",
        language: "语言设置",
        pollingInterval: "数据轮询间隔",
        maxDisplayLogs: "最大日志显示行数",
        showExhausted: "显示耗尽模型",
        showExhaustedDesc: "即使配额为 0% 也显示模型。",
        compactMode: "紧凑模式",
        compactModeDesc: "减少表格间距以显示更多信息。",
        saveChanges: "保存更改",
        autoScroll: "自动滚动",
        clearLogs: "清除日志",
        accountManagement: "账号管理",
        manageTokens: "管理已授权的 Google 账号及其状态",
        addAccount: "添加账号",
        status: "状态",
        enabled: "启用",
        health: "状态",
        accountEmail: "账号 (邮箱)",
        source: "来源",
        projectId: "项目 ID",
        sessionState: "会话状态",
        operations: "操作",
        delete: "删除",
        confirmDelete: "确定要移除此账号吗？",
        cannotDeleteDatabase: "无法删除：此账号来自 Antigravity 数据库（只读）",
        connectGoogle: "连接 Google 账号",
        reauthenticated: "已重新认证",
        added: "已添加",
        successfully: "成功",
        accountAddedSuccess: "账号添加成功",
        accountReauthSuccess: "账号重新认证成功",
        failedToGetAuthUrl: "获取认证链接失败",
        failedToStartOAuth: "启动 OAuth 流程失败",
        oauthInProgress: "OAuth 授权进行中，请在弹出窗口中完成认证...",
        family: "系列",
        model: "模型",
        activeSuffix: "活跃",
        manualReload: "重新加载配置",
        // Tabs
        tabInterface: "界面设置",
        tabClaude: "Claude CLI",
        tabModels: "模型管理",
        tabServer: "服务器设置",
        // Dashboard
        linkedAccounts: "已关联账号",
        noSignal: "无信号连接",
        establishingUplink: "正在建立上行链路...",
        goToAccounts: "前往账号管理",
        // Settings - Models
        modelsDesc: "配置模型的可见性、置顶和请求路由。",
        modelsPageDesc: "所有可用模型的实时配额和状态。",
        showHidden: "显示隐藏模型",
        modelId: "模型 ID",
        actions: "操作",
        pinToTop: "置顶",
        toggleVisibility: "切换可见性",
        noModels: "未检测到模型",
        modelMappingHint:
          "服务端模型路由功能。Claude Code 用户请使用 'Claude CLI' 标签页以便捷配置。",
        modelMapping: "映射 (目标模型 ID)",
        // Settings - Claude
        proxyConnection: "代理连接",
        modelSelection: "模型选择",
        defaultModelAliases: "默认模型映射 (别名)",
        opusAlias: "Opus 别名",
        sonnetAlias: "Sonnet 别名",
        haikuAlias: "Haiku 别名",
        claudeSettingsAlertPrefix: "以下设置直接修改",
        claudeSettingsAlertSuffix: "重启 Claude CLI 生效。",
        applyToClaude: "应用到 Claude CLI",
        // Settings - Server
        port: "端口",
        uiVersion: "UI 版本",
        debugMode: "调试模式",
        environment: "运行环境",
        serverReadOnly: "配置由 config.json 管理。重启服务器以应用更改。",
        advancedSettings: "高级设置",
        reloadConfigTitle: "重载账号配置",
        reloadConfigDesc: "强制从磁盘重新读取 accounts.json",
        reload: "重载",
        // Config Specific
        primaryModel: "主模型",
        subAgentModel: "子代理模型",
        advancedOverrides: "默认模型覆盖 (高级)",
        opusModel: "Opus 模型",
        sonnetModel: "Sonnet 模型",
        haikuModel: "Haiku 模型",
        authToken: "认证令牌",
        saveConfig: "保存到 Claude CLI 设置",
        envVar: "环境变量",
        // New Keys
        systemName: "ANTIGRAVITY",
        systemDesc: "CLAUDE 代理系统",
        connectGoogleDesc:
          "连接 Google Workspace 账号以增加 API 配额。该账号将用于通过 Antigravity 代理 Claude 请求。",
        useCliCommand: "使用命令行",
        close: "关闭",
        requestVolume: "请求量",
        filter: "筛选",
        all: "全选",
        none: "清空",
        noDataTracked: "暂无追踪数据",
        selectFamilies: "选择要显示的系列",
        selectModels: "选择要显示的模型",
        noLogsMatch: "没有符合过滤条件的日志",
        connecting: "正在连接",
        main: "主菜单",
        system: "系统",
        refreshData: "刷新数据",
        connectionLost: "连接已断开",
        lastUpdated: "最后更新",
        grepLogs: "过滤日志...",
        noMatchingModels: "没有匹配的模型",
        typeToSearch: "输入以搜索或选择...",
        or: "或",
        refreshingAccount: "正在刷新 {email}...",
        refreshedAccount: "已完成刷新 {email}",
        refreshFailed: "刷新失败",
        accountToggled: "账号 {email} 已{status}",
        toggleFailed: "切换失败",
        reauthenticating: "正在重新认证 {email}...",
        authUrlFailed: "获取认证链接失败",
        deletedAccount: "已删除 {email}",
        deleteFailed: "删除失败",
        accountsReloaded: "账号配置已重载",
        reloadFailed: "重载失败",
        claudeConfigSaved: "Claude 配置已保存",
        claudeConfigRestored: "Claude CLI 已恢复默认设置",
        saveConfigFailed: "保存配置失败",
        restoreConfigFailed: "恢复配置失败",
        restoreDefault: "恢复默认",
        confirmRestoreTitle: "确认恢复",
        confirmRestoreMessage:
          "确定要将 Claude CLI 恢复为默认设置吗？这将移除代理配置。",
        confirmRestore: "确认恢复",
        claudeActive: "Claude 活跃",
        claudeEmpty: "Claude 耗尽",
        geminiActive: "Gemini 活跃",
        geminiEmpty: "Gemini 耗尽",
        synced: "已同步",
        syncing: "正在同步...",
        // 时间范围标签
        last1Hour: "最近 1 小时",
        last6Hours: "最近 6 小时",
        last24Hours: "最近 24 小时",
        last7Days: "最近 7 天",
        allTime: "最后全部",
        groupBy: "分组方式",
        // Additional
        reloading: "正在重载...",
        reloaded: "已重载",
        lines: "行",
        enabledSeeLogs: "已启用 (见日志)",
        production: "生产环境",
        configSaved: "配置已保存",
        enterPassword: "请输入 Web UI 密码：",
        ready: "就绪",
        depleted: "已耗尽",
        timeH: "时",
        timeM: "分",
        familyClaude: "Claude 系列",
        familyGemini: "Gemini 系列",
        familyOther: "其他系列",
        enabledStatus: "已启用",
        disabledStatus: "已禁用",
        logLevelInfo: "信息",
        logLevelSuccess: "成功",
        logLevelWarn: "警告",
        logLevelError: "错误",
        totalColon: "总计:",
        todayColon: "今日:",
        hour1Colon: "1小时:",
        frequentModels: "常用推荐",
        smartTitle: "自动选出过去 24 小时最常用的 5 个模型",
        activeCount: "{count} 活跃",
        allCaps: "全部",
        claudeCaps: "CLAUDE",
        geminiCaps: "GEMINI",
        modelMapping: "映射 (目标模型 ID)",
        systemInfo: "系统信息",
        refresh: "刷新",
        runtimeConfig: "运行时配置",
        debugDesc: "启用详细日志记录 (见运行日志)",
        networkRetry: "网络重试设置",
        maxRetries: "最大重试次数",
        retryBaseDelay: "重试基础延迟 (毫秒)",
        retryMaxDelay: "重试最大延迟 (毫秒)",
        persistentSessions: "持久化登录会话",
        persistTokenDesc: "将登录会话保存到磁盘以实现快速重启",
        rateLimiting: "账号限流与超时",
        defaultCooldown: "默认冷却时间",
        maxWaitThreshold: "最大等待阈值 (粘性会话)",
        maxWaitDesc: "粘性账号在失败或切换前等待重置的最长时间。",
        saveConfigServer: "保存配置",
        serverRestartAlert: "配置已保存至 {path}。部分更改可能需要重启服务器。",
        changePassword: "修改 WebUI 密码",
        changePasswordDesc: "更新访问此仪表盘的密码",
        currentPassword: "当前密码",
        newPassword: "新密码",
        confirmNewPassword: "确认新密码",
        passwordEmptyDesc: "如果未设置密码请留空",
        passwordLengthDesc: "至少 6 个字符",
        passwordConfirmDesc: "请再次输入新密码",
        cancel: "取消",
        passwordsNotMatch: "密码不匹配",
        passwordTooShort: "密码至少需要 6 个字符",
        // Dashboard drill-down
        clickToViewAllAccounts: "点击查看所有账号",
        clickToViewModels: "点击查看模型页面",
        clickToViewLimitedAccounts: "点击查看受限账号",
        clickToFilterClaude: "点击筛选 Claude 模型",
        clickToFilterGemini: "点击筛选 Gemini 模型",
        // 账号页面
        searchAccounts: "搜索账号...",
        noAccountsYet: "还没有添加任何账号",
        noAccountsDesc:
          '点击上方的 "添加账号" 按钮通过 OAuth 添加 Google 账号，或者使用 CLI 命令导入凭证。',
        addFirstAccount: "添加第一个账号",
        noSearchResults: "没有找到匹配的账号",
        clearSearch: "清除搜索",
        disabledAccountsNote:
          "<strong>已禁用的账号</strong>不会用于请求路由，但仍保留在配置中。仪表盘统计数据仅包含已启用的账号。",
        dangerousOperation: "⚠️ 危险操作",
        confirmDeletePrompt: "确定要删除账号",
        deleteWarning:
          "⚠️ 此操作不可撤销，账号的所有配置和历史记录将永久删除。",
        // OAuth 进度
        oauthWaiting: "等待 OAuth 授权中...",
        oauthWaitingDesc: "请在弹出窗口中完成认证。此过程最长可能需要 2 分钟。",
        oauthCancelled: "已取消 OAuth 授权",
        oauthTimeout: "⏱️ OAuth 授权超时，请重试。",
        oauthWindowClosed: "OAuth 窗口已关闭，授权可能未完成。",
        cancelOAuth: "取消",
        // MCP CLI & Gemini 1M
        mcpCliExperimental: "实验性 MCP CLI",
        mcpCliDesc: "启用实验性 MCP 集成，减少上下文消耗，提高工具调用可靠性。",
        gemini1mMode: "Gemini 1M 上下文模式",
        gemini1mDesc: "为 Gemini 模型添加 [1m] 后缀以支持 1M 上下文窗口。",
        gemini1mWarning: "⚠ 大上下文可能降低 Gemini-3-Pro 性能。",
        clickToSet: "点击进行配置...",
      },
    },

    // Toast Messages
    toast: null,
    _toastTimer: null, // Track timer for cleanup

    // OAuth Progress
    oauthProgress: {
      active: false,
      current: 0,
      max: 60,
      cancel: null,
    },

    t(key, params = {}) {
      let str = this.translations[this.lang][key] || key;
      if (typeof str === "string") {
        Object.keys(params).forEach((p) => {
          str = str.replace(`{${p}}`, params[p]);
        });
      }
      return str;
    },

    setLang(l) {
      this.lang = l;
      localStorage.setItem("app_lang", l);
    },

    showToast(message, type = "info") {
      // Clear any existing timer to prevent race conditions
      if (this._toastTimer) {
        clearTimeout(this._toastTimer);
        this._toastTimer = null;
      }

      const id = Date.now();
      this.toast = { message, type, id };
      this._toastTimer = setTimeout(() => {
        if (this.toast && this.toast.id === id) {
          this.toast = null;
        }
        this._toastTimer = null;
      }, 3000);
    },
  });
});
