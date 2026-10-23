/**
 * 预设与世界书智能切换管家 (Preset & WorldInfo Switcher)
 * 完整版：含多方案管理、预设Prompt条目控制、世界书条目UID精细开关
 */
(function () {
    const MODULE_NAME = 'st_preset_world_switcher';

    function getST() {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
    }

    function getSettings() {
        const ctx = getST();
        if (!ctx) return { enabled: true, profiles: [] };
        if (!ctx.extensionSettings[MODULE_NAME]) {
            ctx.extensionSettings[MODULE_NAME] = {
                enabled: true,
                defaultProfileId: '',
                profiles: [
                    {
                        id: 'prof_' + Date.now(),
                        name: '默认方案',
                        presetName: '',
                        applyPromptToggles: false,
                        promptStates: {},
                        globalWorlds: [],
                        chatWorld: '',
                        entryStates: {},
                        bindings: { chats: [], characters: [] }
                    }
                ]
            };
        }
        return ctx.extensionSettings[MODULE_NAME];
    }

    function getCurrentTarget() {
        const ctx = getST();
        if (!ctx) return { chatId: '', charKey: '' };
        const chatId = String(ctx.chatId || '').trim();
        const charKey = ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]
            ? (ctx.characters[ctx.characterId].avatar || ctx.characters[ctx.characterId].name || '')
            : (ctx.groupId ? `group:${ctx.groupId}` : '');
        return { chatId, charKey };
    }

    // 匹配并应用方案
    async function onChatChanged() {
        const ctx = getST();
        if (!ctx) return;
        const s = getSettings();
        if (!s.enabled) return;

        const { chatId, charKey } = getCurrentTarget();
        let matched = null;
        let reason = '';

        if (chatId) {
            matched = s.profiles.find(p => p.bindings?.chats?.includes(chatId));
            if (matched) reason = `聊天绑定 (${chatId})`;
        }
        if (!matched && charKey) {
            matched = s.profiles.find(p => p.bindings?.characters?.includes(charKey));
            if (matched) reason = `角色卡绑定 (${charKey})`;
        }
        if (!matched && s.defaultProfileId) {
            matched = s.profiles.find(p => p.id === s.defaultProfileId);
            if (matched) reason = '全局默认方案';
        }

        if (matched) {
            await applyProfile(matched, reason);
        }
    }

    // 执行应用方案
    async function applyProfile(p, reason) {
        const ctx = getST();
        if (!ctx) return;

        // 1. 切换预设
        if (p.presetName && ctx.getPresetManager) {
            const pm = ctx.getPresetManager();
            if (pm && typeof pm.selectPreset === 'function') {
                try { await pm.selectPreset(p.presetName); } catch (e) { console.warn(e); }
            }
        }

        // 2. 预设内部条目开关
        if (p.applyPromptToggles && p.promptStates && Object.keys(p.promptStates).length > 0) {
            const states = p.promptStates;
            if (ctx.oai_settings?.prompt_order) {
                for (const b of ctx.oai_settings.prompt_order) {
                    if (Array.isArray(b?.order)) {
                        for (const it of b.order) {
                            if (it && Object.prototype.hasOwnProperty.call(states, it.identifier)) {
                                it.enabled = Boolean(states[it.identifier]);
                            }
                        }
                    }
                }
            }
            if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
        }

        // 3. 切换世界书
        if (p.chatWorld && ctx.chatMetadata) {
            ctx.chatMetadata['world_info'] = p.chatWorld;
            if (ctx.saveMetadata) await ctx.saveMetadata();
        }

        // 4. 世界书条目UID精细开关
        if (p.entryStates && typeof p.entryStates === 'object' && ctx.loadWorldInfo && ctx.saveWorldInfo) {
            for (const [bName, uids] of Object.entries(p.entryStates)) {
                try {
                    const book = await ctx.loadWorldInfo(bName);
                    if (book?.entries) {
                        let mod = false;
                        for (const [uid, enable] of Object.entries(uids)) {
                            const entry = book.entries[uid];
                            if (entry && Boolean(entry.disable) === Boolean(enable)) {
                                entry.disable = !enable;
                                mod = true;
                            }
                        }
                        if (mod) await ctx.saveWorldInfo(bName, book, true);
                    }
                } catch (err) {
                    console.error('[PWS] 世界书条目切换异常:', err);
                }
            }
        }

        if (typeof toastr !== 'undefined') {
            toastr.success(`已切换方案：${p.name} (${reason || '手动'})`);
        }
    }

    // 打开双栏管理大弹窗
    function openManagerModal() {
        $('#pws-modal-box').remove();
        const s = getSettings();
        let cur = s.profiles[0];
        const { chatId, charKey } = getCurrentTarget();

        function renderList() {
            let h = '';
            for (const p of s.profiles) {
                const active = cur.id === p.id ? 'background:rgba(82,139,255,0.25);' : '';
                h += `<div class="pws-pitem" data-id="${p.id}" style="padding:8px; border-radius:6px; cursor:pointer; margin-bottom:4px; ${active}">
                    <b>${p.name}</b><br/>
                    <small style="opacity:0.7;">聊天: ${p.bindings?.chats?.length||0} | 角色: ${p.bindings?.characters?.length||0}</small>
                </div>`;
            }
            return h;
        }

        const modalHtml = `
        <div id="pws-modal-box" style="position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.75); display:flex; align-items:center; justify-content:center; padding:10px;">
            <div style="width:100%; max-width:880px; height:85vh; background:var(--SmartThemeBlurTintColor,#1c1d24); color:#eee; border-radius:10px; display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(255,255,255,0.2);">
                <div style="padding:12px; background:rgba(0,0,0,0.3); display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1);">
                    <b style="font-size:1.1em;">⚙ 预设与世界书切换管家</b>
                    <button id="pws-close-m" class="menu_button">关闭</button>
                </div>
                <div style="display:flex; flex:1; min-height:0;">
                    <!-- 左侧列表 -->
                    <div style="width:230px; border-right:1px solid rgba(255,255,255,0.1); padding:10px; display:flex; flex-direction:column;">
                        <button id="pws-add-p" class="menu_button" style="margin-bottom:8px;">+ 新建方案</button>
                        <div id="pws-plist" style="flex:1; overflow-y:auto;">${renderList()}</div>
                    </div>
                    <!-- 右侧编辑 -->
                    <div id="pws-pdetail" style="flex:1; padding:14px; overflow-y:auto; display:flex; flex-direction:column; gap:12px;">
                    </div>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);

        function updateDetail() {
            const ctx = getST();
            const pm = ctx?.getPresetManager ? ctx.getPresetManager() : null;
            const pName = pm?.getSelectedPresetName ? pm.getSelectedPresetName() : '';
            const wiName = ctx?.chatMetadata ? ctx.chatMetadata['world_info'] : '';

            // 预设列表
            let pOpts = `<option value="">-- 保持当前预设不变 --</option>`;
            const pList = pm?.getPresetList ? pm.getPresetList() : [];
            const pArr = Array.isArray(pList) ? pList : Object.keys(pList || {});
            for (const n of pArr) {
                pOpts += `<option value="${n}" ${cur.presetName===n?'selected':''}>${n}</option>`;
            }

            // 当前聊天与角色绑定状态
            const isChatBound = chatId && cur.bindings?.chats?.includes(chatId);
            const isCharBound = charKey && cur.bindings?.characters?.includes(charKey);

            $('#pws-pdetail').html(`
                <div style="display:flex; gap:8px; align-items:center;">
                    <span style="white-space:nowrap;">方案名称:</span>
                    <input type="text" id="pws-name-in" value="${cur.name}" class="text_pole" style="flex:1;" />
                    <button id="pws-del-p" class="menu_button" style="color:#ff6b6b;">删除</button>
                    <button id="pws-apply-p" class="menu_button" style="border-color:#4caf50;">立即应用</button>
                </div>

                <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                    <b>1. 绑定规则 (切换时自动匹配此方案)</b><br/>
                    <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
                        <button id="pws-bind-c" class="menu_button">${isChatBound ? '解绑当前聊天' : '绑定当前聊天 ('+(chatId||'未打开')+')'}</button>
                        <button id="pws-bind-k" class="menu_button">${isCharBound ? '解绑当前角色' : '绑定当前角色 ('+(charKey||'无')+')'}</button>
                    </div>
                    <small style="opacity:0.75; display:block; margin-top:4px;">
                        已绑聊天数: ${cur.bindings?.chats?.length||0} | 已绑角色数: ${cur.bindings?.characters?.length||0}
                    </small>
                </div>

                <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                    <b>2. 预设配置</b><br/>
                    <div style="margin-top:6px; display:flex; gap:8px; align-items:center;">
                        <span>目标预设:</span>
                        <select id="pws-preset-sel" class="text_pole" style="flex:1;">${pOpts}</select>
                    </div>
                    <label style="display:flex; align-items:center; gap:6px; margin-top:8px;">
                        <input type="checkbox" id="pws-prompt-tog" ${cur.applyPromptToggles?'checked':''} />
                        <span>同步切换预设内的条目开关 (已录入 ${Object.keys(cur.promptStates||{}).length} 项)</span>
                    </label>
                    <button id="pws-snap-prompt" class="menu_button" style="margin-top:6px;">录入当前预设所有条目的开关状态</button>
                </div>

                <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                    <b>3. 世界书配置</b><br/>
                    <div style="margin-top:6px; display:flex; gap:8px; align-items:center;">
                        <span>聊天世界书:</span>
                        <input type="text" id="pws-wi-in" value="${cur.chatWorld||''}" class="text_pole" style="flex:1;" placeholder="填入世界书名称..." />
                        <button id="pws-use-cur-wi" class="menu_button">填入当前书</button>
                    </div>
                    <button id="pws-snap-wi-entries" class="menu_button" style="margin-top:6px;">录入当前世界书内所有条目的开关状态</button>
                    <small style="opacity:0.75; display:block; margin-top:4px;">已录入条目规则数: ${Object.keys(cur.entryStates||{}).length} 本世界书</small>
                </div>
            `);

            // 详情内事件
            $('#pws-name-in').on('input', function () {
                cur.name = $(this).val();
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
                $('#pws-plist').html(renderList());
            });

            $('#pws-del-p').on('click', () => {
                if (s.profiles.length <= 1) return;
                s.profiles = s.profiles.filter(x => x.id !== cur.id);
                cur = s.profiles[0];
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
                $('#pws-plist').html(renderList());
                updateDetail();
            });

            $('#pws-apply-p').on('click', () => applyProfile(cur, '手动'));

            $('#pws-bind-c').on('click', () => {
                if (!chatId) return;
                if (!cur.bindings.chats) cur.bindings.chats = [];
                if (cur.bindings.chats.includes(chatId)) {
                    cur.bindings.chats = cur.bindings.chats.filter(c => c !== chatId);
                } else {
                    cur.bindings.chats.push(chatId);
                }
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
                updateDetail();
            });

            $('#pws-bind-k').on('click', () => {
                if (!charKey) return;
                if (!cur.bindings.characters) cur.bindings.characters = [];
                if (cur.bindings.characters.includes(charKey)) {
                    cur.bindings.characters = cur.bindings.characters.filter(k => k !== charKey);
                } else {
                    cur.bindings.characters.push(charKey);
                }
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
                updateDetail();
            });

            $('#pws-preset-sel').on('change', function () {
                cur.presetName = $(this).val();
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
            });

            $('#pws-prompt-tog').on('change', function () {
                cur.applyPromptToggles = $(this).is(':checked');
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
            });

            $('#pws-snap-prompt').on('click', () => {
                const order = ctx?.oai_settings?.prompt_order?.[0]?.order || [];
                cur.promptStates = {};
                for (const it of order) {
                    if (it?.identifier) cur.promptStates[it.identifier] = Boolean(it.enabled);
                }
                cur.applyPromptToggles = true;
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
                if (typeof toastr !== 'undefined') toastr.success(`已记录 ${Object.keys(cur.promptStates).length} 项提示词条目开关！`);
                updateDetail();
            });

            $('#pws-wi-in').on('input', function () {
                cur.chatWorld = $(this).val();
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
            });

            $('#pws-use-cur-wi').on('click', () => {
                $('#pws-wi-in').val(wiName || '').trigger('input');
            });

            $('#pws-snap-wi-entries').on('click', async () => {
                const bookName = cur.chatWorld || wiName;
                if (!bookName || !ctx?.loadWorldInfo) {
                    if (typeof toastr !== 'undefined') toastr.warning('未指定世界书！');
                    return;
                }
                const bData = await ctx.loadWorldInfo(bookName);
                if (!bData?.entries) return;
                if (!cur.entryStates) cur.entryStates = {};
                cur.entryStates[bookName] = {};
                for (const e of Object.values(bData.entries)) {
                    cur.entryStates[bookName][e.uid] = !e.disable;
                }
                if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
                if (typeof toastr !== 'undefined') toastr.success(`已记录「${bookName}」所有条目的启用/禁用状态！`);
                updateDetail();
            });
        }

        $('#pws-close-m').on('click', () => $('#pws-modal-box').remove());
        $('#pws-add-p').on('click', () => {
            const newP = {
                id: 'prof_' + Date.now(),
                name: `方案 ${s.profiles.length + 1}`,
                presetName: '',
                applyPromptToggles: false,
                promptStates: {},
                globalWorlds: [],
                chatWorld: '',
                entryStates: {},
                bindings: { chats: [], characters: [] }
            };
            s.profiles.push(newP);
            cur = newP;
            const ctx = getST();
            if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
            $('#pws-plist').html(renderList());
            updateDetail();
        });

        $(document).on('click', '.pws-pitem', function () {
            const id = $(this).data('id');
            cur = s.profiles.find(x => x.id === id) || cur;
            $('#pws-plist').html(renderList());
            updateDetail();
        });

        updateDetail();
    }

    // 在右侧扩展面板注入抽屉
    function initDrawer() {
        if ($('#pws-main-drawer').length) return;
        const s = getSettings();

        const drawerHtml = `
        <div id="pws-main-drawer" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚡ 预设与世界书智能切换管家</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding:10px;">
                <label class="checkbox_label" style="display:flex; align-items:center; gap:8px;">
                    <input type="checkbox" id="pws-glob-enable" ${s.enabled?'checked':''} />
                    <span>启用切卡/切聊天自动切换</span>
                </label>
                <button id="pws-open-dialog-btn" class="menu_button" style="margin-top:10px; width:100%;">
                    ⚙ 打开方案管理中心
                </button>
            </div>
        </div>`;

        const $c = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        if ($c.length) $c.append(drawerHtml);
        else $('#extensions').append(drawerHtml);

        $('#pws-glob-enable').on('change', function () {
            s.enabled = $(this).is(':checked');
            const ctx = getST();
            if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
        });

        $('#pws-open-dialog-btn').on('click', openManagerModal);
    }

    // 初始化入口
    jQuery(function () {
        const ctx = getST();
        if (ctx && ctx.eventSource && ctx.eventTypes?.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged);
        }
        setTimeout(initDrawer, 1200);
    });
})();
