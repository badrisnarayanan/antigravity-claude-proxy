/**
 * Dashboard Filters Module
 * 职责：管理图表筛选器的状态和持久化
 *
 * 功能：
 *   1. 时间范围筛选（1h/6h/24h/7d/all）
 *   2. 显示模式切换（按家族/按模型）
 *   3. 模型/家族多选筛选
 *   4. 筛选器状态持久化到 localStorage
 *
 * 调用时机：
 *   - 组件初始化时加载用户偏好
 *   - 筛选器变化时保存并触发图表更新
 *
 * 持久化键：
 *   - localStorage['dashboard_chart_prefs']
 *
 * @module DashboardFilters
 */
window.DashboardFilters = window.DashboardFilters || {};

/**
 * Get initial filter state
 * @returns {object} Initial state for filter properties
 */
window.DashboardFilters.getInitialState = function() {
    return {
        timeRange: '24h',  // '1h', '6h', '24h', '7d', 'all'
        displayMode: 'model',
        selectedFamilies: [],
        selectedModels: {},
        showModelFilter: false,
        showTimeRangeDropdown: false,
        showDisplayModeDropdown: false
    };
};

/**
 * Load filter preferences from localStorage
 * @param {object} component - Dashboard component instance
 */
window.DashboardFilters.loadPreferences = function(component) {
    try {
        const saved = localStorage.getItem('dashboard_chart_prefs');
        if (saved) {
            const prefs = JSON.parse(saved);
            component.timeRange = prefs.timeRange || '24h';
            component.displayMode = prefs.displayMode || 'model';
            component.selectedFamilies = prefs.selectedFamilies || [];
            component.selectedModels = prefs.selectedModels || {};
        }
    } catch (e) {
        if (window.UILogger) window.UILogger.debug('Failed to load dashboard preferences:', e.message);
    }
};

/**
 * Save filter preferences to localStorage
 * @param {object} component - Dashboard component instance
 */
window.DashboardFilters.savePreferences = function(component) {
    try {
        localStorage.setItem('dashboard_chart_prefs', JSON.stringify({
            timeRange: component.timeRange,
            displayMode: component.displayMode,
            selectedFamilies: component.selectedFamilies,
            selectedModels: component.selectedModels
        }));
    } catch (e) {
        if (window.UILogger) window.UILogger.debug('Failed to save dashboard preferences:', e.message);
    }
};

/**
 * Set display mode (family or model)
 * @param {object} component - Dashboard component instance
 * @param {string} mode - 'family' or 'model'
 */
window.DashboardFilters.setDisplayMode = function(component, mode) {
    component.displayMode = mode;
    component.showDisplayModeDropdown = false;
    window.DashboardFilters.savePreferences(component);
    // updateTrendChart uses debounce internally, call directly
    component.updateTrendChart();
};

/**
 * Set time range filter
 * @param {object} component - Dashboard component instance
 * @param {string} range - '1h', '6h', '24h', '7d', 'all'
 */
window.DashboardFilters.setTimeRange = function(component, range) {
    component.timeRange = range;
    component.showTimeRangeDropdown = false;
    window.DashboardFilters.savePreferences(component);
    component.updateTrendChart();
};

/**
 * Get time range cutoff timestamp
 * @param {string} range - Time range code
 * @returns {number|null} Cutoff timestamp or null for 'all'
 */
window.DashboardFilters.getTimeRangeCutoff = function(range) {
    const now = Date.now();
    switch (range) {
        case '1h': return now - 1 * 60 * 60 * 1000;
        case '6h': return now - 6 * 60 * 60 * 1000;
        case '24h': return now - 24 * 60 * 60 * 1000;
        case '7d': return now - 7 * 24 * 60 * 60 * 1000;
        default: return null; // 'all'
    }
};

/**
 * Get filtered history data based on time range
 * @param {object} component - Dashboard component instance
 * @returns {object} Filtered history data
 */
window.DashboardFilters.getFilteredHistoryData = function(component) {
    const history = component.historyData;
    if (!history || Object.keys(history).length === 0) return {};

    const cutoff = window.DashboardFilters.getTimeRangeCutoff(component.timeRange);
    if (!cutoff) return history; // 'all' - return everything

    const filtered = {};
    Object.entries(history).forEach(([iso, data]) => {
        const timestamp = new Date(iso).getTime();
        if (timestamp >= cutoff) {
            filtered[iso] = data;
        }
    });
    return filtered;
};

/**
 * Get time range label for display
 * @param {object} component - Dashboard component instance
 * @returns {string} Translated label
 */
window.DashboardFilters.getTimeRangeLabel = function(component) {
    const store = Alpine.store('global');
    switch (component.timeRange) {
        case '1h': return store.t('last1Hour');
        case '6h': return store.t('last6Hours');
        case '24h': return store.t('last24Hours');
        case '7d': return store.t('last7Days');
        default: return store.t('allTime');
    }
};

/**
 * Toggle family selection
 * @param {object} component - Dashboard component instance
 * @param {string} family - Family name (e.g., 'claude', 'gemini')
 */
window.DashboardFilters.toggleFamily = function(component, family) {
    const index = component.selectedFamilies.indexOf(family);
    if (index > -1) {
        component.selectedFamilies.splice(index, 1);
    } else {
        component.selectedFamilies.push(family);
    }
    window.DashboardFilters.savePreferences(component);
    // updateTrendChart uses debounce internally, call directly
    component.updateTrendChart();
};

/**
 * Toggle model selection within a family
 * @param {object} component - Dashboard component instance
 * @param {string} family - Family name
 * @param {string} model - Model name
 */
window.DashboardFilters.toggleModel = function(component, family, model) {
    if (!component.selectedModels[family]) {
        component.selectedModels[family] = [];
    }
    const index = component.selectedModels[family].indexOf(model);
    if (index > -1) {
        component.selectedModels[family].splice(index, 1);
    } else {
        component.selectedModels[family].push(model);
    }
    window.DashboardFilters.savePreferences(component);
    // updateTrendChart uses debounce internally, call directly
    component.updateTrendChart();
};

/**
 * Check if family is selected
 * @param {object} component - Dashboard component instance
 * @param {string} family - Family name
 * @returns {boolean}
 */
window.DashboardFilters.isFamilySelected = function(component, family) {
    return component.selectedFamilies.includes(family);
};

/**
 * Check if model is selected
 * @param {object} component - Dashboard component instance
 * @param {string} family - Family name
 * @param {string} model - Model name
 * @returns {boolean}
 */
window.DashboardFilters.isModelSelected = function(component, family, model) {
    return component.selectedModels[family]?.includes(model) || false;
};

/**
 * Select all families and models
 * @param {object} component - Dashboard component instance
 */
window.DashboardFilters.selectAll = function(component) {
    component.selectedFamilies = [...component.families];
    component.families.forEach(family => {
        component.selectedModels[family] = [...(component.modelTree[family] || [])];
    });
    window.DashboardFilters.savePreferences(component);
    // updateTrendChart uses debounce internally, call directly
    component.updateTrendChart();
};

/**
 * Deselect all families and models
 * @param {object} component - Dashboard component instance
 */
window.DashboardFilters.deselectAll = function(component) {
    component.selectedFamilies = [];
    component.selectedModels = {};
    window.DashboardFilters.savePreferences(component);
    // updateTrendChart uses debounce internally, call directly
    component.updateTrendChart();
};

/**
 * Get color for a family
 * @param {string} family - Family name
 * @returns {string} Color value
 */
window.DashboardFilters.getFamilyColor = function(family) {
    const FAMILY_COLORS = window.DashboardConstants?.FAMILY_COLORS || {};
    return FAMILY_COLORS[family] || FAMILY_COLORS.other;
};

/**
 * Get color for a model (with index for variation within family)
 * @param {string} family - Family name
 * @param {number} modelIndex - Index of model within family
 * @returns {string} Color value
 */
window.DashboardFilters.getModelColor = function(family, modelIndex) {
    const MODEL_COLORS = window.DashboardConstants?.MODEL_COLORS || [];
    const baseIndex = family === 'claude' ? 0 : (family === 'gemini' ? 4 : 8);
    return MODEL_COLORS[(baseIndex + modelIndex) % MODEL_COLORS.length];
};

/**
 * Get count of selected items for display
 * @param {object} component - Dashboard component instance
 * @returns {string} Selected count string (e.g., "3/5")
 */
window.DashboardFilters.getSelectedCount = function(component) {
    if (component.displayMode === 'family') {
        return `${component.selectedFamilies.length}/${component.families.length}`;
    }
    let selected = 0, total = 0;
    component.families.forEach(family => {
        const models = component.modelTree[family] || [];
        total += models.length;
        selected += (component.selectedModels[family] || []).length;
    });
    return `${selected}/${total}`;
};

/**
 * Auto-select new families/models that haven't been configured
 * @param {object} component - Dashboard component instance
 */
window.DashboardFilters.autoSelectNew = function(component) {
    // If no preferences saved, select all
    if (component.selectedFamilies.length === 0 && Object.keys(component.selectedModels).length === 0) {
        component.selectedFamilies = [...component.families];
        component.families.forEach(family => {
            component.selectedModels[family] = [...(component.modelTree[family] || [])];
        });
        window.DashboardFilters.savePreferences(component);
        return;
    }

    // Add new families/models that appeared
    component.families.forEach(family => {
        if (!component.selectedFamilies.includes(family)) {
            component.selectedFamilies.push(family);
        }
        if (!component.selectedModels[family]) {
            component.selectedModels[family] = [];
        }
        (component.modelTree[family] || []).forEach(model => {
            if (!component.selectedModels[family].includes(model)) {
                component.selectedModels[family].push(model);
            }
        });
    });
};

/**
 * Auto-select top N models by usage (past 24 hours)
 * @param {object} component - Dashboard component instance
 * @param {number} n - Number of models to select (default: 5)
 */
window.DashboardFilters.autoSelectTopN = function(component, n = 5) {
    // Calculate usage for each model over past 24 hours
    const usage = {};
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    Object.entries(component.historyData).forEach(([iso, hourData]) => {
        const timestamp = new Date(iso).getTime();
        if (timestamp < dayAgo) return;

        Object.entries(hourData).forEach(([family, familyData]) => {
            if (typeof familyData === 'object' && family !== '_total') {
                Object.entries(familyData).forEach(([model, count]) => {
                    if (model !== '_subtotal') {
                        const key = `${family}:${model}`;
                        usage[key] = (usage[key] || 0) + count;
                    }
                });
            }
        });
    });

    // Sort by usage and take top N
    const sorted = Object.entries(usage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);

    // Clear current selection
    component.selectedFamilies = [];
    component.selectedModels = {};

    // Select top models and their families
    sorted.forEach(([key, _]) => {
        const [family, model] = key.split(':');
        if (!component.selectedFamilies.includes(family)) {
            component.selectedFamilies.push(family);
        }
        if (!component.selectedModels[family]) {
            component.selectedModels[family] = [];
        }
        if (!component.selectedModels[family].includes(model)) {
            component.selectedModels[family].push(model);
        }
    });

    window.DashboardFilters.savePreferences(component);
    // updateTrendChart uses debounce internally, call directly
    component.updateTrendChart();
};
