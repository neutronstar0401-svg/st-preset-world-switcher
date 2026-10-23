/**
 * ============================================================================
 * 预设与世界书智能切换管家 (Preset & WorldInfo Switcher)
 * 标准 SillyTavern 第三方扩展插件
 * 放置路径: SillyTavern/public/scripts/extensions/third-party/st-preset-world-switcher/
 * ============================================================================
 */

import {
    extension_settings,
    writeExtensionField,
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
} from '../../../../script.js';

import {
    promptManager,
    oai_settings,
} from '../../../openai.js';

import {
    world_names,
    selected_world_info,
    loadWorldInfo,
    saveWorldInfo,
    METADATA_KEY as WI_METADATA_KEY,
} from '../../../world-info.js';

const MODULE_NAME = 'st_preset_world_switcher';

const DEFAULT_SETTINGS = {
    enabled: true,
    showToastOnSwitch: true,
    defaultProfileId: '',
    profiles: [
        {
            id: 'profile_default_demo',
            name: '示例方案：日常对话配置',
            description: '可自由绑定多个聊天记录与角色卡，切换时自动应用预设条目与世界书配置',
            presetConfig: {
                enabled: false,
                presetName: '',
                applyPromptToggles: false,
                promptStates: {},
            },
            worldInfoConfig: {
                enabled: false,
                globalWorldMode: 'keep',
                globalWorlds: [],
                chatWorldMode: 'keep',
                chatWorld: '',
                charWorldMode: 'keep',
                charPrimaryWorld: '',
                charAuxWorlds: [],
                entryStates: {},
            },
            bindings: {
                chats: [],
                characters: [],
            },
        },
    ],
};

let activeProfileId = null;
let currentSelectedProfileId = null;
let currentActiveTab = 'bindings';
let loadedWorldBookCache = {};
let isApplyingProfile = false;
let currentInspectedWorldBook = '';

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE_NAME];
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (typeof s.showToastOnSwitch !== 'boolean') s.showToastOnSwitch = true;
    if (typeof s.defaultProfileId !== 'string') s.defaultProfileId = '';
    if (!Array.isArray(s.profiles)) s.profiles = [];

    for (const p of s.profiles) {
        p.presetConfig = Object.assign(
            { enabled: false, presetName: '', applyPromptToggles: false, promptStates: {} },
            p.presetConfig || {},
        );
        p.worldInfoConfig = Object.assign(
            {
                enabled: false,
                globalWorldMode: 'keep',
                globalWorlds: [],
                chatWorldMode: 'keep',
                chatWorld: '',
                charWorldMode: 'keep',
                charPrimaryWorld: '',
                charAuxWorlds: [],
                entryStates: {},
            },
            p.worldInfoConfig || {},
        );
        p.bindings = Object.assign({ chats: [], characters: [] }, p.bindings || {});
    }
    return s;
}

function getCurrentTargetContext() {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext
        ? SillyTavern.getContext()
        : {};

    const chatId = ctx.chatId
        || (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]?.chat)
        || '';

    let charKey = '';
    let charDisplayName = '未选择角色';

    if (ctx.groupId) {
        charKey = `group:${ctx.groupId}`;
        const grp = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId));
        charDisplayName = grp ? `[群聊] ${grp.name}` : `[群聊] ${ctx.groupId}`;
    } else if (ctx.characterId !== undefined && ctx.characters && ctx.characters[ctx.characterId]) {
        const ch = ctx.characters[ctx.characterId];
        charKey = ch.avatar || ch.name || '';
        charDisplayName = ch.name || ch.avatar || '当前角色';
    }

    return {
        ctx,
        chatId: String(chatId || '').trim(),
        charKey: String(charKey || '').trim(),
        charDisplayName,
        characterId: ctx.characterId,
    };
}

function resolveMatchingProfile() {
    const settings = getSettings();
    const { chatId, charKey } = getCurrentTargetContext();

    if (chatId) {
        const chatMatched = settings.profiles.find(
            p => Array.isArray(p.bindings?.chats) && p.bindings.chats.includes(chatId),
        );
        if (chatMatched) return { profile: chatMatched, matchReason: `聊天绑定 (${chatId})` };
    }

    if (charKey) {
        const charMatched = settings.profiles.find(
            p => Array.isArray(p.bindings?.characters) && p.bindings.characters.includes(charKey),
        );
        if (charMatched) return { profile: charMatched, matchReason: `角色卡绑定 (${charKey})` };
    }

    if (settings.defaultProfileId) {
        const fallback = settings.profiles.find(p => p.id === settings.defaultProfileId);
        if (fallback) return { profile: fallback, matchReason: '全局默认方案' };
    }

    return { profile: null, matchReason: '' };
}

function getAvailablePresetsInfo() {
    const ctx = SillyTavern.getContext();
    const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
    const presetNames = [];
    let currentPreset = '';

    if (pm) {
        try {
            if (typeof pm.getSelectedPresetName === 'function') currentPreset = pm.getSelectedPresetName() || '';
            if (typeof pm.getPresetList === 'function') {
                const list = pm.getPresetList();
                if (Array.isArray(list)) presetNames.push(...list);
                else if (list && typeof list === 'object') presetNames.push(...Object.keys(list));
            }
        } catch (err) {
            console.warn('[PWS] 读取 PresetManager 列表异常:', err);
        }
    }

    if (presetNames.length === 0) {
        $('#settings_preset_openai option').each(function () {
            const text = $(this).text().trim();
            if (text && !presetNames.includes(text)) presetNames.push(text);
            if ($(this).is(':selected') && !currentPreset) currentPreset = text;
        });
    }

    return { presetNames, currentPreset, pm };
}

function getCurrentPromptEntries() {
    const prompts = Array.isArray(oai_settings?.prompts) ? oai_settings.prompts : [];
    const promptMap = new Map();
    for (const p of prompts) {
        if (p && p.identifier) promptMap.set(p.identifier, p);
    }

    let orderList = [];
    if (promptManager && typeof promptManager.getPromptOrderForCharacter === 'function') {
        try {
            const activeChar = promptManager.activeCharacter || { id: 100001 };
            orderList = promptManager.getPromptOrderForCharacter(activeChar) || [];
        } catch {
            orderList = [];
        }
    }

    if (!Array.isArray(orderList) || orderList.length === 0) {
        const orderBlock = Array.isArray(oai_settings?.prompt_order)
            ? (oai_settings.prompt_order.find(o => Number(o.character_id) === 100001) || oai_settings.prompt_order[0])
            : null;
        orderList = orderBlock?.order || [];
    }

    const result = [];
    const seen = new Set();

    for (const item of orderList) {
        if (!item || !item.identifier) continue;
        seen.add(item.identifier);
        const detail = promptMap.get(item.identifier);
        result.push({
            identifier: item.identifier,
            name: detail?.name || item.identifier,
            role: detail?.role || 'system',
            marker: Boolean(detail?.marker),
            enabled: Boolean(item.enabled),
        });
    }

    for (const p of prompts) {
        if (!p || !p.identifier || seen.has(p.identifier)) continue;
        result.push({
            identifier: p.identifier,
            name: p.name || p.identifier,
            role: p.role || 'system',
            marker: Boolean(p.marker),
            enabled: Boolean(p.enabled),
        });
    }

    return result;
}

async function applyPresetConfiguration(presetConfig) {
    if (!presetConfig || !presetConfig.enabled) return [];
    const logs = [];

    if (presetConfig.presetName) {
        const { currentPreset, pm } = getAvailablePresetsInfo();
        if (currentPreset !== presetConfig.presetName) {
            let switched = false;
            if (pm && typeof pm.selectPreset === 'function') {
                try {
                    const $opt =$('#settings_preset_openai option').filter(function () {
                        return $(this).text().trim() === presetConfig.presetName \vert{}\vert{}$(this).val() === presetConfig.presetName;
                    });
                    const targetVal = $opt.length ? $opt.val() : presetConfig.presetName;
                    await pm.selectPreset(targetVal);
                    switched = true;
                } catch (err) {
                    console.warn('[PWS] pm.selectPreset 切换异常:', err);
                }
            }

            if (!switched) {
                const $select =$('#settings_preset_openai');
                const $opt =$select.find('option').filter(function () {
                    return $(this).text().trim() === presetConfig.presetName \vert{}\vert{}$(this).val() === presetConfig.presetName;
                });
                if ($opt.length) {
                    $select.val($opt.val()).trigger('change');
                    await new Promise(r => setTimeout(r, 150));
                    switched = true;
                }
            }

            if (switched) logs.push(`预设 → ${presetConfig.presetName}`);
        }
    }

    if (presetConfig.applyPromptToggles && presetConfig.promptStates && Object.keys(presetConfig.promptStates).length > 0) {
        const states = presetConfig.promptStates;

        if (promptManager && typeof promptManager.getPromptOrderForCharacter === 'function') {
            try {
                const activeChar = promptManager.activeCharacter || { id: 100001 };
                const orderList = promptManager.getPromptOrderForCharacter(activeChar);
                if (Array.isArray(orderList)) {
                    for (const entry of orderList) {
                        if (entry && Object.prototype.hasOwnProperty.call(states, entry.identifier)) {
                            entry.enabled = Boolean(states[entry.identifier]);
                        }
                    }
                }
            } catch (e) {
                console.warn('[PWS] 更新 Prompt 条目异常:', e);
            }
        }

        if (Array.isArray(oai_settings?.prompt_order)) {
            for (const block of oai_settings.prompt_order) {
                if (!Array.isArray(block?.order)) continue;
                for (const entry of block.order) {
                    if (entry && Object.prototype.hasOwnProperty.call(states, entry.identifier)) {
                        entry.enabled = Boolean(states[entry.identifier]);
                    }
                }
            }
        }

        if (Array.isArray(oai_settings?.prompts)) {
            for (const p of oai_settings.prompts) {
                if (p && Object.prototype.hasOwnProperty.call(states, p.identifier)) {
                    p.enabled = Boolean(states[p.identifier]);
                }
            }
        }

        if (promptManager) {
            if (typeof promptManager.render === 'function') promptManager.render();
            if (typeof promptManager.saveServiceSettings === 'function') promptManager.saveServiceSettings();
        }
        saveSettingsDebounced();
        logs.push(`预设条目已同步 (${Object.keys(states).length} 项)`);
    }

    return logs;
}

async function applyWorldInfoConfiguration(wiConfig) {
    if (!wiConfig || !wiConfig.enabled) return [];
    const logs = [];
    const { ctx, characterId } = getCurrentTargetContext();

    if (wiConfig.globalWorldMode === 'replace' || wiConfig.globalWorldMode === 'append') {
        const targetBooks = Array.isArray(wiConfig.globalWorlds) ? wiConfig.globalWorlds : [];
        if (Array.isArray(selected_world_info)) {
            const nextList = wiConfig.globalWorldMode === 'replace'
                ? [...targetBooks]
                : Array.from(new Set([...selected_world_info, ...targetBooks]));

            selected_world_info.splice(0, selected_world_info.length, ...nextList);

            const $wiSelect =$('#world_info');
            if ($wiSelect.length)$wiSelect.val(selected_world_info).trigger('change');
            saveSettingsDebounced();
            logs.push(`全局世界书: ${nextList.join(', ') || '无'}`);
        }
    }

    if (wiConfig.chatWorldMode === 'set' || wiConfig.chatWorldMode === 'clear') {
        if (ctx.chatMetadata) {
            const metaKey = WI_METADATA_KEY || 'world_info';
            if (wiConfig.chatWorldMode === 'clear' || !wiConfig.chatWorld) {
                delete ctx.chatMetadata[metaKey];
                logs.push('聊天世界书: 已清除');
            } else {
                ctx.chatMetadata[metaKey] = wiConfig.chatWorld;
                logs.push(`聊天世界书 → ${wiConfig.chatWorld}`);
            }
            if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
        }
    }

    if (wiConfig.charWorldMode === 'set' && characterId !== undefined && ctx.characters?.[characterId]) {
        const charObj = ctx.characters[characterId];
        if (wiConfig.charPrimaryWorld !== undefined) {
            try {
                await writeExtensionField(characterId, 'world', wiConfig.charPrimaryWorld);
            } catch {
                if (charObj.data && charObj.data.extensions) charObj.data.extensions.world = wiConfig.charPrimaryWorld;
            }
        }
        logs.push(`角色主世界书 → ${wiConfig.charPrimaryWorld || '未设'}`);
    }

    if (wiConfig.entryStates && typeof wiConfig.entryStates === 'object') {
        for (const [bookName, uidMap] of Object.entries(wiConfig.entryStates)) {
            if (!bookName || !uidMap || Object.keys(uidMap).length === 0) continue;
            try {
                const bookData = await loadWorldInfo(bookName);
                if (!bookData || !bookData.entries) continue;

                let modified = false;
                for (const [uid, shouldEnable] of Object.entries(uidMap)) {
                    const entry = bookData.entries[uid]
                        || Object.values(bookData.entries).find(e => String(e.uid) === String(uid));
                    if (entry) {
                        const targetDisable = !shouldEnable;
                        if (Boolean(entry.disable) !== targetDisable) {
                            entry.disable = targetDisable;
                            modified = true;
                        }
                    }
                }

                if (modified) {
                    await saveWorldInfo(bookName, bookData, true);
                    loadedWorldBookCache[bookName] = bookData;
                }
                logs.push(`世界书[${bookName}]条目开关已生效`);
            } catch (err) {
                console.error(`[PWS] 更新世界书 "${bookName}" 失败:`, err);
            }
        }
    }

    return logs;
}

export async function applyProfile(profile, reason = '手动触发') {
    if (!profile || isApplyingProfile) return;
    isApplyingProfile = true;

    try {
        const presetLogs = await applyPresetConfiguration(profile.presetConfig);
        const wiLogs = await applyWorldInfoConfiguration(profile.worldInfoConfig);
        activeProfileId = profile.id;

        updateQuickStatusUI(profile, reason);

        const settings = getSettings();
        if (settings.showToastOnSwitch && typeof toastr !== 'undefined') {
            const detailText = [...presetLogs, ...wiLogs].join(' | ') || '无额外变更项';
            toastr.success(`${detailText}`, `已切换方案：${profile.name} (${reason})`, { timeOut: 3200 });
        }
    } catch (err) {
        console.error('[PWS] 应用方案失败:', err);
    } finally {
        isApplyingProfile = false;
    }
}

async function onChatOrCharacterChanged() {
    const settings = getSettings();
    refreshContextBannerInModal();

    if (!settings.enabled) {
        updateQuickStatusUI(null, '自动切换已暂停');
        return;
    }

    const { profile, matchReason } = resolveMatchingProfile();
    if (profile) {
        await applyProfile(profile, matchReason);
    } else {
        activeProfileId = null;
        updateQuickStatusUI(null, '当前聊天/角色未绑定方案');
    }
}

function updateQuickStatusUI(profile, reasonText = '') {
    const $pill =$('#pws-current-status-pill');
    if (!$pill.length) return;

    if (profile) {
        $pill.addClass('active').html(
            `<i class="fa-solid fa-circle-check"></i> 当前生效：<b>${escapeHtml(profile.name)}</b> <span style="opacity:0.75">(${escapeHtml(reasonText)})</span>`,
        );
    } else {
        $pill.removeClass('active').html(
            `<i class="fa-solid fa-circle-pause"></i> 状态：${escapeHtml(reasonText || '未命中任何绑定方案')}`,
        );
    }
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function createNewProfileObject(name = '新建切换方案') {
    return {
        id: 'pws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name,
        description: '',
        presetConfig: {
            enabled: true,
            presetName: '',
            applyPromptToggles: false,
            promptStates: {},
        },
        worldInfoConfig: {
            enabled: true,
            globalWorldMode: 'keep',
            globalWorlds: [],
            chatWorldMode: 'keep',
            chatWorld: '',
            charWorldMode: 'keep',
            charPrimaryWorld: '',
            charAuxWorlds: [],
            entryStates: {},
        },
        bindings: {
            chats: [],
            characters: [],
        },
    };
}

function ensureSelectedProfile() {
    const settings = getSettings();
    if (settings.profiles.length === 0) {
        settings.profiles.push(createNewProfileObject('默认预设与世界书方案'));
        saveSettingsDebounced();
    }
    if (!currentSelectedProfileId || !settings.profiles.some(p => p.id === currentSelectedProfileId)) {
        currentSelectedProfileId = settings.profiles[0].id;
    }
    return settings.profiles.find(p => p.id === currentSelectedProfileId);
}
function openManagerModal() {
    if ($('#pws-modal-backdrop').length) {
        refreshFullModal();
        $('#pws-modal-backdrop').fadeIn(150);
        return;
    }

    const modalHtml = `
    <div id="pws-modal-backdrop">
        <div id="pws-modal-container">
            <div class="pws-modal-header">
                <div class="pws-modal-title">
                    <i class="fa-solid fa-sliders"></i>
                    <span>预设与世界书智能切换管家</span>
                </div>
                <div class="pws-header-actions">
                    <label class="checkbox_label" style="margin:0; display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="pws-modal-enable-toggle" />
                        <span>启用随聊天/角色自动切换</span>
                    </label>
                    <label class="checkbox_label" style="margin:0; display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="pws-modal-toast-toggle" />
                        <span>切换时弹出提示</span>
                    </label>
                    <button id="pws-modal-close-btn" class="menu_button" title="关闭面板">
                        <i class="fa-solid fa-xmark"></i> 关闭
                    </button>
                </div>
            </div>

            <div class="pws-context-banner" id="pws-context-banner"></div>

            <div class="pws-modal-body">
                <div class="pws-sidebar">
                    <div class="pws-sidebar-header">
                        <div style="display:flex; gap:6px;">
                            <button id="pws-add-profile-btn" class="menu_button" style="flex:1;">
                                <i class="fa-solid fa-plus"></i> 新建方案
                            </button>
                            <button id="pws-dup-profile-btn" class="menu_button" title="复制当前方案">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px; font-size:0.82em;">
                            <span style="white-space:nowrap; opacity:0.8;">全局兜底:</span>
                            <select id="pws-default-profile-select" class="pws-select" style="flex:1; padding:3px 6px;"></select>
                        </div>
                    </div>
                    <div class="pws-profile-list" id="pws-profile-list"></div>
                </div>

                <div class="pws-editor">
                    <div class="pws-editor-top">
                        <div class="pws-profile-name-group">
                            <span style="font-weight:600; white-space:nowrap;">方案名称:</span>
                            <input type="text" id="pws-profile-name-input" class="pws-profile-name-input" placeholder="输入方案名称..." />
                        </div>
                        <div class="pws-row">
                            <button id="pws-apply-now-btn" class="menu_button" style="border-color:#4caf50;">
                                <i class="fa-solid fa-bolt"></i> 立即应用此方案
                            </button>
                            <button id="pws-snapshot-current-btn" class="menu_button" title="抓取当前状态">
                                <i class="fa-solid fa-camera"></i> 抓取当前酒馆状态
                            </button>
                            <button id="pws-delete-profile-btn" class="menu_button" style="color:#ff6b6b;" title="删除此方案">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </div>

                    <div class="pws-tabs">
                        <button class="pws-tab-btn active" data-tab="bindings">
                            <i class="fa-solid fa-link"></i> 1. 绑定规则 (聊天 / 角色卡)
                        </button>
                        <button class="pws-tab-btn" data-tab="presets">
                            <i class="fa-solid fa-sliders"></i> 2. 预设与条目组合
                        </button>
                        <button class="pws-tab-btn" data-tab="worldinfo">
                            <i class="fa-solid fa-book-atlas"></i> 3. 世界书与条目控制
                        </button>
                    </div>

                    <div class="pws-tab-panel active" id="pws-tab-bindings"></div>
                    <div class="pws-tab-panel" id="pws-tab-presets"></div>
                    <div class="pws-tab-panel" id="pws-tab-worldinfo"></div>
                </div>
            </div>
        </div>
    </div>`;

    $('body').append(modalHtml);
    bindModalGlobalEvents();
    refreshFullModal();
}

function bindModalGlobalEvents() {
    const settings = getSettings();

    $('#pws-modal-close-btn').on('click', () => $('#pws-modal-backdrop').fadeOut(150));
    $('#pws-modal-backdrop').on('click', function (e) {
        if (e.target === this) $(this).fadeOut(150);
    });

    $('#pws-modal-enable-toggle').on('change', function () {
        settings.enabled = $(this).is(':checked');$('#pws-drawer-enable-toggle').prop('checked', settings.enabled);
        saveSettingsDebounced();
        onChatOrCharacterChanged();
    });

    $('#pws-modal-toast-toggle').on('change', function () {
        settings.showToastOnSwitch = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#pws-default-profile-select').on('change', function () {
        settings.defaultProfileId = $(this).val() || '';
        saveSettingsDebounced();
        renderSidebarProfiles();
    });

    $('#pws-add-profile-btn').on('click', () => {
        const newProf = createNewProfileObject(`方案 ${settings.profiles.length + 1}`);
        settings.profiles.push(newProf);
        currentSelectedProfileId = newProf.id;
        saveSettingsDebounced();
        refreshFullModal();
    });

    $('#pws-dup-profile-btn').on('click', () => {
        const cur = ensureSelectedProfile();
        if (!cur) return;
        const copy = structuredClone(cur);
        copy.id = 'pws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        copy.name = `${cur.name} (副本)`;
        copy.bindings = { chats: [], characters: [] };
        settings.profiles.push(copy);
        currentSelectedProfileId = copy.id;
        saveSettingsDebounced();
        refreshFullModal();
    });

    $('#pws-delete-profile-btn').on('click', () => {
        if (settings.profiles.length <= 1) {
            if (typeof toastr !== 'undefined') toastr.warning('至少需要保留一个方案');
            return;
        }
        const cur = ensureSelectedProfile();
        if (!confirm(`确定要删除方案「${cur.name}」吗？`)) return;
        settings.profiles = settings.profiles.filter(p => p.id !== cur.id);
        if (settings.defaultProfileId === cur.id) settings.defaultProfileId = '';
        currentSelectedProfileId = settings.profiles[0]?.id || '';
        saveSettingsDebounced();
        refreshFullModal();
    });

    $('#pws-profile-name-input').on('input', function () {
        const cur = ensureSelectedProfile();
        if (!cur) return;
        cur.name = $(this).val().trim() || '未命名方案';
        saveSettingsDebounced();
        renderSidebarProfiles();
    });

    $('#pws-apply-now-btn').on('click', async () => {
        const cur = ensureSelectedProfile();
        if (cur) {
            await applyProfile(cur, '面板手动触发');
            renderSidebarProfiles();
            refreshContextBannerInModal();
        }
    });

    $('#pws-snapshot-current-btn').on('click', () => {
        const cur = ensureSelectedProfile();
        if (!cur) return;

        const { currentPreset } = getAvailablePresetsInfo();
        const promptEntries = getCurrentPromptEntries();

        cur.presetConfig.enabled = true;
        cur.presetConfig.presetName = currentPreset || '';
        cur.presetConfig.applyPromptToggles = true;
        cur.presetConfig.promptStates = {};
        for (const item of promptEntries) {
            cur.presetConfig.promptStates[item.identifier] = Boolean(item.enabled);
        }

        const { ctx } = getCurrentTargetContext();
        const metaKey = WI_METADATA_KEY || 'world_info';
        cur.worldInfoConfig.enabled = true;
        cur.worldInfoConfig.globalWorldMode = 'replace';
        cur.worldInfoConfig.globalWorlds = Array.isArray(selected_world_info) ? [...selected_world_info] : [];

        const currentChatLore = ctx.chatMetadata ? (ctx.chatMetadata[metaKey] || '') : '';
        cur.worldInfoConfig.chatWorldMode = currentChatLore ? 'set' : 'keep';
        cur.worldInfoConfig.chatWorld = currentChatLore;

        saveSettingsDebounced();
        refreshFullModal();
        if (typeof toastr !== 'undefined') toastr.info('已将当前状态录入本方案');
    });

    $('.pws-tab-btn').on('click', function () {
        const tab = $(this).data('tab');
        currentActiveTab = tab;
        $('.pws-tab-btn').removeClass('active');$(this).addClass('active');
        $('.pws-tab-panel').removeClass('active');$(`#pws-tab-${tab}`).addClass('active');
    });
}

function refreshContextBannerInModal() {
    const $banner =$('#pws-context-banner');
    if (!$banner.length) return;

    const { chatId, charKey, charDisplayName } = getCurrentTargetContext();
    const curProfile = ensureSelectedProfile();
    const { profile: matchedProfile, matchReason } = resolveMatchingProfile();

    const isChatBound = chatId && curProfile?.bindings?.chats?.includes(chatId);
    const isCharBound = charKey && curProfile?.bindings?.characters?.includes(charKey);

    $banner.html(`
        <div class="pws-context-info">
            <span><i class="fa-solid fa-user-astronaut"></i> 当前角色: <span class="pws-context-tag">${escapeHtml(charDisplayName)}</span></span>
            <span><i class="fa-solid fa-comments"></i> 当前聊天: <span class="pws-context-tag">${escapeHtml(chatId || '未打开聊天')}</span></span>
            <span><i class="fa-solid fa-wand-magic-sparkles"></i> 命中: <span class="pws-badge ${matchedProfile ? 'success' : 'warn'}">${matchedProfile ? `${escapeHtml(matchedProfile.name)} [${escapeHtml(matchReason)}]` : '无匹配方案'}</span></span>
        </div>
        <div class="pws-quick-bind-btns">
            <button id="pws-quick-bind-chat" class="menu_button" ${!chatId ? 'disabled' : ''}>
                <i class="fa-solid ${isChatBound ? 'fa-link-slash' : 'fa-link'}"></i>
                ${isChatBound ? '解绑聊天' : '将当前聊天绑至本方案'}
            </button>
            <button id="pws-quick-bind-char" class="menu_button" ${!charKey ? 'disabled' : ''}>
                <i class="fa-solid ${isCharBound ? 'fa-user-minus' : 'fa-user-plus'}"></i>
                ${isCharBound ? '解绑角色' : '将当前角色绑至本方案'}
            </button>
        </div>
    `);

    $('#pws-quick-bind-chat').on('click', () => {
        if (!chatId || !curProfile) return;
        toggleChatBinding(curProfile, chatId);
        refreshFullModal();
    });

    $('#pws-quick-bind-char').on('click', () => {
        if (!charKey || !curProfile) return;
        toggleCharacterBinding(curProfile, charKey);
        refreshFullModal();
    });
}

function toggleChatBinding(targetProfile, chatId) {
    const settings = getSettings();
    const alreadyInTarget = targetProfile.bindings.chats.includes(chatId);
    for (const p of settings.profiles) {
        p.bindings.chats = (p.bindings.chats || []).filter(c => c !== chatId);
    }
    if (!alreadyInTarget) targetProfile.bindings.chats.push(chatId);
    saveSettingsDebounced();
}

function toggleCharacterBinding(targetProfile, charKey) {
    const settings = getSettings();
    const alreadyInTarget = targetProfile.bindings.characters.includes(charKey);
    for (const p of settings.profiles) {
        p.bindings.characters = (p.bindings.characters || []).filter(c => c !== charKey);
    }
    if (!alreadyInTarget) targetProfile.bindings.characters.push(charKey);
    saveSettingsDebounced();
}

function renderSidebarProfiles() {
    const settings = getSettings();
    const $list =$('#pws-profile-list');
    const $defSelect =$('#pws-default-profile-select');
    if (!$list.length) return;

    $defSelect.empty().append(`<option value="">(不设全局默认)</option>`);
    for (const p of settings.profiles) {
        const sel = settings.defaultProfileId === p.id ? 'selected' : '';
        $defSelect.append(`<option value="${escapeHtml(p.id)}" ${sel}>${escapeHtml(p.name)}</option>`);
    }

    $list.empty();
    for (const p of settings.profiles) {
        const isSelected = p.id === currentSelectedProfileId;
        const isActive = p.id === activeProfileId;
        const chatCount = p.bindings?.chats?.length || 0;
        const charCount = p.bindings?.characters?.length || 0;

        const $item =$(`
            <div class="pws-profile-item ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(p.id)}">
                <div class="pws-profile-item-top">
                    <span>${escapeHtml(p.name)}</span>
                    ${isActive ? '<span class="pws-badge success">生效中</span>' : ''}
                </div>
                <div class="pws-profile-item-meta">
                    <span>聊天: ${chatCount}</span>
                    <span>角色: ${charCount}</span>
                    ${p.presetConfig?.enabled ? '<span class="pws-badge primary">预设</span>' : ''}
                    ${p.worldInfoConfig?.enabled ? '<span class="pws-badge primary">世界书</span>' : ''}
                </div>
            </div>
        `);

        $item.on('click', () => {
            currentSelectedProfileId = p.id;
            refreshFullModal();
        });

        $list.append($item);
    }
}

function renderBindingsTab(profile) {
    const $panel =$('#pws-tab-bindings');
    if (!$panel.length || !profile) return;

    const { ctx, chatId, charKey } = getCurrentTargetContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const groups = Array.isArray(ctx.groups) ? ctx.groups : [];

    let charOptionsHtml = `<option value="">-- 选择要绑定的角色卡 / 群聊 --</option>`;
    for (const ch of characters) {
        const key = ch.avatar || ch.name;
        if (key) charOptionsHtml += `<option value="${escapeHtml(key)}">${escapeHtml(ch.name)} (${escapeHtml(key)})</option>`;
    }
    for (const g of groups) {
        charOptionsHtml += `<option value="group:${g.id}">[群聊] ${escapeHtml(g.name)}</option>`;
    }

    const chatChipsHtml = (profile.bindings.chats || []).length
        ? profile.bindings.chats.map(c => `
            <span class="pws-chip">
                <i class="fa-regular fa-comments"></i> ${escapeHtml(c)}
                <span class="pws-chip-remove" data-chat="${escapeHtml(c)}">&times;</span>
            </span>`).join('')
        : `<div class="pws-empty-hint">暂未绑定特定聊天记录。</div>`;

    const charChipsHtml = (profile.bindings.characters || []).length
        ? profile.bindings.characters.map(cKey => {
            const foundChar = characters.find(ch => (ch.avatar || ch.name) === cKey);
            const label = foundChar ? `${foundChar.name}` : cKey;
            return `
            <span class="pws-chip">
                <i class="fa-regular fa-id-badge"></i> ${escapeHtml(label)}
                <span class="pws-chip-remove" data-char="${escapeHtml(cKey)}">&times;</span>
            </span>`;
        }).join('')
        : `<div class="pws-empty-hint">暂未绑定角色卡。</div>`;

    $panel.html(`
        <div class="pws-card">
            <div class="pws-card-header"><span>触发规则</span></div>
            <div class="pws-card-desc">仅在切换聊天记录或切换角色卡 (CHAT_CHANGED) 时触发。匹配顺序：聊天记录绑定 &gt; 角色卡绑定 &gt; 全局兜底方案。</div>
        </div>

        <div class="pws-card">
            <div class="pws-card-header">
                <span>绑定的聊天记录 (${profile.bindings.chats.length})</span>
                <button id="pws-bind-cur-chat-btn" class="menu_button" ${!chatId ? 'disabled' : ''}>添加当前聊天</button>
            </div>
            <div class="pws-chip-group">${chatChipsHtml}</div>
            <div class="pws-row" style="margin-top:6px;">
                <input type="text" id="pws-manual-chat-input" class="pws-input" style="flex:1;" placeholder="手动输入聊天记录名称..." />
                <button id="pws-add-manual-chat-btn" class="menu_button">添加</button>
            </div>
        </div>

        <div class="pws-card">
            <div class="pws-card-header">
                <span>绑定的角色卡 / 群聊 (${profile.bindings.characters.length})</span>
                <button id="pws-bind-cur-char-btn" class="menu_button" ${!charKey ? 'disabled' : ''}>添加当前角色卡</button>
            </div>
            <div class="pws-chip-group">${charChipsHtml}</div>
            <div class="pws-row" style="margin-top:6px;">
                <select id="pws-char-picker-select" class="pws-select" style="flex:1;">${charOptionsHtml}</select>
                <button id="pws-add-selected-char-btn" class="menu_button">添加选中角色</button>
            </div>
        </div>
    `);

    $('#pws-bind-cur-chat-btn').on('click', () => { if (chatId) { toggleChatBinding(profile, chatId); refreshFullModal(); } });
    $('#pws-add-manual-chat-btn').on('click', () => {
        const val = $('#pws-manual-chat-input').val().trim();
        if (val) { toggleChatBinding(profile, val); refreshFullModal(); }
    });
    $panel.find('[data-chat]').on('click', function () {
        profile.bindings.chats = profile.bindings.chats.filter(c => c !== $(this).data('chat'));
        saveSettingsDebounced();
        refreshFullModal();
    });

    $('#pws-bind-cur-char-btn').on('click', () => { if (charKey) { toggleCharacterBinding(profile, charKey); refreshFullModal(); } });
    $('#pws-add-selected-char-btn').on('click', () => {
        const val = $('#pws-char-picker-select').val();
        if (val) { toggleCharacterBinding(profile, val); refreshFullModal(); }
    });
    $panel.find('[data-char]').on('click', function () {
        profile.bindings.characters = profile.bindings.characters.filter(c => c !== $(this).data('char'));
        saveSettingsDebounced();
        refreshFullModal();
    });
}

function renderPresetsTab(profile) {
    const $panel =$('#pws-tab-presets');
    if (!$panel.length || !profile) return;

    const pCfg = profile.presetConfig;
    const { presetNames, currentPreset } = getAvailablePresetsInfo();
    const promptEntries = getCurrentPromptEntries();

    let presetOptionsHtml = `<option value="">-- 保持当前预设不变 (仅切换条目组合) --</option>`;
    for (const name of presetNames) {
        const sel = pCfg.presetName === name ? 'selected' : '';
        presetOptionsHtml += `<option value="${escapeHtml(name)}" ${sel}>${escapeHtml(name)}</option>`;
    }

    let promptRowsHtml = '';
    if (promptEntries.length === 0) {
        promptRowsHtml = `<div class="pws-empty-hint">未读取到当前预设条目。</div>`;
    } else {
        for (const item of promptEntries) {
            const hasRule = Object.prototype.hasOwnProperty.call(pCfg.promptStates, item.identifier);
            const isChecked = hasRule ? Boolean(pCfg.promptStates[item.identifier]) : Boolean(item.enabled);
            promptRowsHtml += `
                <div class="pws-list-row" data-identifier="${escapeHtml(item.identifier)}">
                    <div class="pws-list-row-left">
                        <input type="checkbox" class="pws-prompt-item-cb" data-id="${escapeHtml(item.identifier)}" ${isChecked ? 'checked' : ''} />
                        <span style="font-weight:${item.marker ? '400' : '600'};">${escapeHtml(item.name)}</span>
                        <span class="pws-badge">${escapeHtml(item.role)}</span>
                    </div>
                    <div style="font-size:0.8em; opacity:0.75;">${hasRule ? (isChecked ? '开' : '关') : (item.enabled ? '当前:开' : '当前:关')}</div>
                </div>
            `;
                    <div class="pws-card-header">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="pws-preset-enable-cb" ${pCfg.enabled ? 'checked' : ''} />
                    <span>在此方案中启用【预设与条目切换】</span>
                </label>
                <span class="pws-badge">当前酒馆预设: ${escapeHtml(currentPreset || '未知')}</span>
            </div>
            <div class="pws-row" style="margin-top:6px;">
                <span style="font-weight:600; min-width:110px;">目标预设文件:</span>
                <select id="pws-target-preset-select" class="pws-select" style="flex:1;">
                    ${presetOptionsHtml}
                </select>
                <button id="pws-use-cur-preset-btn" class="menu_button">填入当前预设</button>
            </div>
        </div>

        <div class="pws-card">
            <div class="pws-card-header">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="pws-apply-prompts-cb" ${pCfg.applyPromptToggles ? 'checked' : ''} />
                    <span>同步切换预设内的【Prompt 条目组合】 (已记录 ${Object.keys(pCfg.promptStates || {}).length} 项)</span>
                </label>
                <div class="pws-row">
                    <button id="pws-capture-prompts-btn" class="menu_button">
                        <i class="fa-solid fa-floppy-disk"></i> 读取并保存当前条目状态
                    </button>
                    <button id="pws-enable-all-prompts-btn" class="menu_button">全选</button>
                    <button id="pws-disable-all-prompts-btn" class="menu_button">全不选</button>
                    <button id="pws-clear-prompt-rules-btn" class="menu_button">重置</button>
                </div>
            </div>
            <input type="text" id="pws-prompt-search-input" class="pws-input" placeholder="搜索预设条目名称..." />
            <div class="pws-item-list" id="pws-prompt-item-list">
                ${promptRowsHtml}
            </div>
        </div>
    `);

    $('#pws-preset-enable-cb').on('change', function () {
        pCfg.enabled = $(this).is(':checked');
        saveSettingsDebounced();
        renderSidebarProfiles();
    });

    $('#pws-target-preset-select').on('change', function () {
        pCfg.presetName = $(this).val() || '';
        saveSettingsDebounced();
    });

    $('#pws-use-cur-preset-btn').on('click', () => {
        pCfg.presetName = currentPreset || '';
        saveSettingsDebounced();
        renderPresetsTab(profile);
    });

    $('#pws-apply-prompts-cb').on('change', function () {
        pCfg.applyPromptToggles = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#pws-capture-prompts-btn').on('click', () => {
        pCfg.enabled = true;
        pCfg.applyPromptToggles = true;
        pCfg.promptStates = {};
        for (const item of promptEntries) {
            pCfg.promptStates[item.identifier] = Boolean(item.enabled);
        }
        saveSettingsDebounced();
        renderPresetsTab(profile);
        renderSidebarProfiles();
    });

    $('#pws-enable-all-prompts-btn').on('click', () => {
        pCfg.applyPromptToggles = true;
        for (const item of promptEntries) {
            pCfg.promptStates[item.identifier] = true;
        }
        saveSettingsDebounced();
        renderPresetsTab(profile);
    });

    $('#pws-disable-all-prompts-btn').on('click', () => {
        pCfg.applyPromptToggles = true;
        for (const item of promptEntries) {
            pCfg.promptStates[item.identifier] = false;
        }
        saveSettingsDebounced();
        renderPresetsTab(profile);
    });

    $('#pws-clear-prompt-rules-btn').on('click', () => {
        pCfg.promptStates = {};
        saveSettingsDebounced();
        renderPresetsTab(profile);
    });

    $('.pws-prompt-item-cb').on('change', function () {
        const id = $(this).data('id');
        const checked = $(this).is(':checked');
        pCfg.enabled = true;
        pCfg.applyPromptToggles = true;
        pCfg.promptStates[id] = checked;
        saveSettingsDebounced();
        renderPresetsTab(profile);
        renderSidebarProfiles();
    });

    $('#pws-prompt-search-input').on('input', function () {
        const kw = $(this).val().trim().toLowerCase();
        $('#pws-prompt-item-list .pws-list-row').each(function () {
            const text = $(this).text().toLowerCase();
            $(this).toggle(!kw || text.includes(kw));
        });
    });
}

async function renderWorldInfoTab(profile) {
    const $panel = $('#pws-tab-worldinfo');
    if (!$panel.length || !profile) return;

    const wiCfg = profile.worldInfoConfig;
    const allBooks = Array.isArray(world_names) ? world_names : [];

    if (!currentInspectedWorldBook && allBooks.length > 0) {
        currentInspectedWorldBook = wiCfg.chatWorld || wiCfg.globalWorlds?.[0] || allBooks[0];
    }

    let bookOptionsWithEmpty = `<option value="">-- 未选择世界书 --</option>`;
    let bookInspectorOptions = `<option value="">-- 选择要管理内部条目的世界书 --</option>`;
    for (const b of allBooks) {
        bookOptionsWithEmpty += `<option value="${escapeHtml(b)}" ${wiCfg.chatWorld === b ? 'selected' : ''}>${escapeHtml(b)}</option>`;
        bookInspectorOptions += `<option value="${escapeHtml(b)}" ${currentInspectedWorldBook === b ? 'selected' : ''}>${escapeHtml(b)}</option>`;
    }

    const globalBookCheckboxesHtml = allBooks.length
        ? allBooks
            .map(b => {
                const checked = Array.isArray(wiCfg.globalWorlds) && wiCfg.globalWorlds.includes(b);
                return `
                <label class="pws-chip" style="cursor:pointer; background:${checked ? 'rgba(76, 175, 80, 0.2)' : 'rgba(255,255,255,0.05)'}; border-color:${checked ? '#4caf50' : 'rgba(255,255,255,0.15)'};">
                    <input type="checkbox" class="pws-global-book-cb" value="${escapeHtml(b)}" ${checked ? 'checked' : ''} />
                    <span>${escapeHtml(b)}</span>
                </label>`;
            })
            .join('')
        : `<div class="pws-empty-hint">未检测到世界书文件</div>`;

    $panel.html(`
        <div class="pws-card">
            <div class="pws-card-header">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="pws-wi-enable-cb" ${wiCfg.enabled ? 'checked' : ''} />
                    <span>在此方案中启用【世界书挂载与条目切换】</span>
                </label>
            </div>
            <div class="pws-row" style="margin-top:6px;">
                <span style="font-weight:600; min-width:130px;">全局世界书模式:</span>
                <select id="pws-global-wi-mode" class="pws-select">
                    <option value="keep" ${wiCfg.globalWorldMode === 'keep' ? 'selected' : ''}>保持当前全局世界书不变</option>
                    <option value="replace" ${wiCfg.globalWorldMode === 'replace' ? 'selected' : ''}>替换为下方勾选的世界书组合</option>
                    <option value="append" ${wiCfg.globalWorldMode === 'append' ? 'selected' : ''}>在当前基础上追加勾选的世界书</option>
                </select>
            </div>
            <div class="pws-chip-group" id="pws-global-books-container" style="margin-top:6px; ${wiCfg.globalWorldMode === 'keep' ? 'opacity:0.5;' : ''}">
                ${globalBookCheckboxesHtml}
            </div>

            <div class="pws-row" style="margin-top:10px;">
                <span style="font-weight:600; min-width:130px;">当前聊天世界书:</span>
                <select id="pws-chat-wi-mode" class="pws-select">
                    <option value="keep" ${wiCfg.chatWorldMode === 'keep' ? 'selected' : ''}>保持不变</option>
                    <option value="set" ${wiCfg.chatWorldMode === 'set' ? 'selected' : ''}>切换并绑定指定世界书</option>
                    <option value="clear" ${wiCfg.chatWorldMode === 'clear' ? 'selected' : ''}>清除当前聊天绑定的世界书</option>
                </select>
                <select id="pws-chat-wi-select" class="pws-select" style="flex:1;" ${wiCfg.chatWorldMode !== 'set' ? 'disabled' : ''}>
                    ${bookOptionsWithEmpty}
                </select>
            </div>
        </div>

        <div class="pws-card">
            <div class="pws-card-header">
                <span><i class="fa-solid fa-list-check"></i> 世界书内部条目 (Entries) 开关控制</span>
                <div class="pws-row">
                    <button id="pws-wi-capture-entries-btn" class="menu_button">
                        <i class="fa-solid fa-floppy-disk"></i> 录入当前书全部条目状态
                    </button>
                    <button id="pws-wi-enable-all-btn" class="menu_button">全部启用</button>
                    <button id="pws-wi-disable-all-btn" class="menu_button">全部禁用</button>
                    <button id="pws-wi-clear-book-rules-btn" class="menu_button">清除本书规则</button>
                </div>
            </div>
            <div class="pws-row">
                <span style="font-weight:600;">选择世界书:</span>
                <select id="pws-inspector-book-select" class="pws-select" style="flex:1;">
                    ${bookInspectorOptions}
                </select>
                <input type="text" id="pws-wi-entry-search" class="pws-input" style="width:220px;" placeholder="搜索条目注释或关键词..." />
            </div>
            <div class="pws-item-list" id="pws-wi-entries-list">
                <div class="pws-empty-hint"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载世界书条目...</div>
            </div>
        </div>
    `);

    $('#pws-wi-enable-cb').on('change', function () {
        wiCfg.enabled = $(this).is(':checked');
        saveSettingsDebounced();
        renderSidebarProfiles();
    });

    $('#pws-global-wi-mode').on('change', function () {
        wiCfg.globalWorldMode = $(this).val();
        saveSettingsDebounced();
        renderWorldInfoTab(profile);
    });

    $('.pws-global-book-cb').on('change', function () {
        const selected = [];
        $('.pws-global-book-cb:checked').each(function () {
            selected.push($(this).val());
        });
        wiCfg.enabled = true;
        if (wiCfg.globalWorldMode === 'keep') wiCfg.globalWorldMode = 'replace';
        wiCfg.globalWorlds = selected;
        saveSettingsDebounced();
        renderWorldInfoTab(profile);
        renderSidebarProfiles();
    });

    $('#pws-chat-wi-mode').on('change', function () {
        wiCfg.chatWorldMode = $(this).val();
        saveSettingsDebounced();
        renderWorldInfoTab(profile);
    });

    $('#pws-chat-wi-select').on('change', function () {
        wiCfg.chatWorld = $(this).val() || '';
        saveSettingsDebounced();
    });

    $('#pws-inspector-book-select').on('change', function () {
        currentInspectedWorldBook = $(this).val() || '';
        renderWorldBookEntriesList(profile, currentInspectedWorldBook);
    });

    await renderWorldBookEntriesList(profile, currentInspectedWorldBook);
}

async function renderWorldBookEntriesList(profile, bookName) {
    const $list = $('#pws-wi-entries-list');
    if (!$list.length) return;

    if (!bookName) {
        $list.html(`<div class="pws-empty-hint">请先在上方选择一本世界书以配置其内部条目开关。</div>`);
        return;
    }

    let bookData = loadedWorldBookCache[bookName];
    if (!bookData) {
        try {
            bookData = await loadWorldInfo(bookName);
            if (bookData) loadedWorldBookCache[bookName] = bookData;
        } catch (err) {
            console.error('[PWS] 读取世界书失败:', err);
        }
    }

    const entriesObj = bookData?.entries || {};
    const entriesArr = Object.values(entriesObj);

    if (entriesArr.length === 0) {
        $list.html(`<div class="pws-empty-hint">世界书「${escapeHtml(bookName)}」内暂无条目。</div>`);
        return;
    }

    const wiCfg = profile.worldInfoConfig;
    if (!wiCfg.entryStates) wiCfg.entryStates = {};
    const bookRules = wiCfg.entryStates[bookName] || {};

    let rowsHtml = '';
    for (const entry of entriesArr) {
        const uid = String(entry.uid);
        const comment = entry.comment || '(无注释条目)';
        const keysText = Array.isArray(entry.key) ? entry.key.join(', ') : '';
        const currentEnabledInST = !entry.disable;
        const hasRule = Object.prototype.hasOwnProperty.call(bookRules, uid);
        const isChecked = hasRule ? Boolean(bookRules[uid]) : currentEnabledInST;

        rowsHtml += `
            <div class="pws-list-row" data-uid="${escapeHtml(uid)}">
                <div class="pws-list-row-left">
                    <input type="checkbox" class="pws-wi-entry-cb" data-uid="${escapeHtml(uid)}" ${isChecked ? 'checked' : ''} />
                    <span class="pws-badge">#${escapeHtml(uid)}</span>
                    <span style="font-weight:600;">${escapeHtml(comment)}</span>
                    ${keysText ? `<span style="opacity:0.65; font-size:0.82em;">[${escapeHtml(keysText)}]</span>` : ''}
                </div>
                <div style="font-size:0.8em; white-space:nowrap;">
                    ${hasRule ? `<span class="pws-badge primary">${isChecked ? '方案: 启用' : '方案: 禁用'}</span>` : `<span style="opacity:0.65;">当前: ${currentEnabledInST ? '启用' : '禁用'}</span>`}
                </div>
            </div>
        `;
    }

    $list.html(rowsHtml);

    $('.pws-wi-entry-cb').off('change').on('change', function () {
        const uid = String($(this).data('uid'));
        const checked = $(this).is(':checked');
        wiCfg.enabled = true;
        if (!wiCfg.entryStates[bookName]) wiCfg.entryStates[bookName] = {};
        wiCfg.entryStates[bookName][uid] = checked;
        saveSettingsDebounced();
        renderWorldBookEntriesList(profile, bookName);
        renderSidebarProfiles();
    });

    $('#pws-wi-capture-entries-btn').off('click').on('click', () => {
        wiCfg.enabled = true;
        if (!wiCfg.entryStates[bookName]) wiCfg.entryStates[bookName] = {};
        for (const entry of entriesArr) {
            wiCfg.entryStates[bookName][String(entry.uid)] = !entry.disable;
        }
        saveSettingsDebounced();
        renderWorldBookEntriesList(profile, bookName);
        renderSidebarProfiles();
    });

    $('#pws-wi-enable-all-btn').off('click').on('click', () => {
        wiCfg.enabled = true;
        if (!wiCfg.entryStates[bookName]) wiCfg.entryStates[bookName] = {};
        for (const entry of entriesArr) {
            wiCfg.entryStates[bookName][String(entry.uid)] = true;
        }
        saveSettingsDebounced();
        renderWorldBookEntriesList(profile, bookName);
    });

    $('#pws-wi-disable-all-btn').off('click').on('click', () => {
        wiCfg.enabled = true;
        if (!wiCfg.entryStates[bookName]) wiCfg.entryStates[bookName] = {};
        for (const entry of entriesArr) {
            wiCfg.entryStates[bookName][String(entry.uid)] = false;
        }
        saveSettingsDebounced();
        renderWorldBookEntriesList(profile, bookName);
    });

    $('#pws-wi-clear-book-rules-btn').off('click').on('click', () => {
        if (wiCfg.entryStates && wiCfg.entryStates[bookName]) {
            delete wiCfg.entryStates[bookName];
            saveSettingsDebounced();
            renderWorldBookEntriesList(profile, bookName);
        }
    });

    $('#pws-wi-entry-search').off('input').on('input', function () {
        const kw = $(this).val().trim().toLowerCase();
        $('#pws-wi-entries-list .pws-list-row').each(function () {
            const text = $(this).text().toLowerCase();
            $(this).toggle(!kw || text.includes(kw));
        });
    });
}

function refreshFullModal() {
    const settings = getSettings();
    const curProfile = ensureSelectedProfile();

    $('#pws-modal-enable-toggle').prop('checked', settings.enabled);
    $('#pws-modal-toast-toggle').prop('checked', settings.showToastOnSwitch);

    if (curProfile) {
        $('#pws-profile-name-input').val(curProfile.name);
    }

    refreshContextBannerInModal();
    renderSidebarProfiles();

    if (curProfile) {
        renderBindingsTab(curProfile);
        renderPresetsTab(curProfile);
        renderWorldInfoTab(curProfile);
    }
}

function injectExtensionSettingsDrawer() {
    if ($('#pws-settings-drawer').length) return;

    const settings = getSettings();
    const drawerHtml = `
    <div id="pws-settings-drawer" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-sliders"></i> 预设与世界书智能切换管家</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="pws-QuickBar">
                <label class="checkbox_label" style="margin:0; display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" id="pws-drawer-enable-toggle" ${settings.enabled ? 'checked' : ''} />
                    <span>随聊天/角色切换自动生效</span>
                </label>
                <button id="pws-open-manager-btn" class="menu_button">
                    <i class="fa-solid fa-up-right-from-square"></i> 打开方案与绑定管理中心
                </button>
            </div>
            <div style="margin-top:6px;">
                <span id="pws-current-status-pill" class="pws-status-pill">
                    <i class="fa-solid fa-circle-info"></i> 等待聊天加载...
                </span>
            </div>
        </div>
    </div>`;

    const $targetContainer = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');
    $targetContainer.append(drawerHtml);

    $('#pws-drawer-enable-toggle').on('change', function () {
        settings.enabled = $(this).is(':checked');
        saveSettingsDebounced();
        onChatOrCharacterChanged();
    });

    $('#pws-open-manager-btn').on('click', () => {
        openManagerModal();
    });
}

jQuery(async () => {
    getSettings();
    injectExtensionSettingsDrawer();

    if (eventSource && event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            onChatOrCharacterChanged();
        });
    }

    setTimeout(() => {
        onChatOrCharacterChanged();
    }, 800);
});

