export class StandingManager {
    constructor() {
        this.activeStandings = new Map();   // characterId -> jQuery element
        this.maxStandings = 4;              // (현 버전 값 유지)
        this.characterData = {};
        this.lastUsedCharacters = new Set();

        // 활성 토글/도크 관리
        this.activeToggles = new Map();     // characterId -> toggle element (inline)

        // 소켓 채널(실시간 동기화)
        this.SOCKET = 'module.visual-novel-chat';
        game.socket?.on?.(this.SOCKET, (data) => this._onSocket(data));

        this.loadCharacterData();
        this.initQuickDock();
    }

    // ===== 동기화 유틸 =====
    _debug(message, ...args) {
        if (game.settings.get('visual-novel-chat', 'debugMode')) {
            console.log('[StandingManager]', message, ...args);
        }
    }
    _syncEnabled() {
        return !!game.settings.get('visual-novel-chat', 'syncRealtimeStanding');
    }
    _authorityAllowsSend() {
        const mode = game.settings.get('visual-novel-chat', 'syncAuthority') || 'everyone';
        if (mode === 'gm-only') return game.user.isGM;
        return true;
    }
    _emit(payload) {
        if (!this._syncEnabled()) return;
        if (!this._authorityAllowsSend()) return;
        game.socket?.emit?.(this.SOCKET, {
            ...payload,
            _sender: game.user.id,
            _senderIsGM: game.user.isGM,
            _ts: Date.now()
        });
    }
    _onSocket(data) {
        if (!this._syncEnabled()) return;
        if (data?._sender === game.user.id) return; // 루프 방지
        const mode = game.settings.get('visual-novel-chat', 'syncAuthority') || 'everyone';
        if (mode === 'gm-only' && !data?._senderIsGM) return;

        switch (data?.type) {
            case 'show':
                this.showStanding(data.actorId, data.emotion, data.position ?? null, { broadcast: false, fromSocket: true });
                break;
            case 'emotionUpdate':
                this.showStanding(data.actorId, data.emotion, null, { broadcast: false, fromSocket: true, forceUpdate: true });
                break;
            case 'hide':
                this.hideStanding(data.actorId, { broadcast: false });
                break;
            case 'hideAll':
                this.hideStanding(null, { broadcast: false });
                break;
        }
    }

    // ===== 데이터 =====
    loadCharacterData() {
        this.characterData = game.settings.get('visual-novel-chat', 'characterData') || {};
        this.syncWithPCs();
    }

    syncWithPCs() {
        const actors = game.actors.filter(actor =>
            actor.hasPlayerOwner ||
            actor.type === 'character' ||
            (actor.ownership && Object.values(actor.ownership).some(level => level >= 2))
        );
        let updated = false;
        for (const actor of actors) {
            const id = actor.id, nm = actor.name;
            if (!this.characterData[id]) { this.characterData[id] = { name: nm }; updated = true; }
            else if (this.characterData[id].name !== nm) { this.characterData[id].name = nm; updated = true; }
        }
        if (updated) game.settings.set('visual-novel-chat', 'characterData', this.characterData);
    }

    async addCustomEmotion(characterId, emotionName, imagePath) {
        if (!this.characterData[characterId]) return false;
        const clean = emotionName.toLowerCase().replace(/\s+/g, '');
        this.characterData[characterId][clean] = imagePath;
        await game.settings.set('visual-novel-chat', 'characterData', this.characterData);
        return true;
    }

    async deleteEmotion(characterId, emotionName) {
        if (!this.characterData[characterId]) return false;
        const clean = emotionName.toLowerCase().replace(/\s+/g, '');
        if (this.characterData[characterId][clean]) {
            delete this.characterData[characterId][clean];
            await game.settings.set('visual-novel-chat', 'characterData', this.characterData);
            return true;
        }
        return false;
    }

    getAvailableEmotions(characterId) {
        if (!this.characterData[characterId]) return [];
        return Object.keys(this.characterData[characterId]).filter(k => k !== 'name');
    }

    // ===== 표시/변경 =====
    async showStanding(characterRef, emotion, position = null, options = {}) {
        const { 
            broadcast = true, 
            fromSocket = false, 
            forceUpdate = false, 
            fromUserAction = false 
        } = options;

        this._debug('showStanding called', { characterRef, emotion, position, options });

        let character = null, characterData = null;

        // Try to find character by ID first
        if (this.characterData[characterRef]) {
            character = characterRef; 
            characterData = this.characterData[characterRef];
        } else {
            // Search by name
            const foundActor = game.actors?.find?.(actor =>
                actor.name?.toLowerCase()?.includes?.(characterRef.toLowerCase()) ||
                characterRef.toLowerCase().includes(actor.name?.toLowerCase() || '')
            );
            if (foundActor && this.characterData[foundActor.id]) {
                character = foundActor.id; 
                characterData = this.characterData[foundActor.id];
            }
        }

        // Synthesize characterData from game.actors when missing for network/sync/user actions
        if (!characterData && (fromSocket || forceUpdate || fromUserAction)) {
            this._debug('Synthesizing characterData for missing character', characterRef);
            
            let actor = null;
            if (typeof characterRef === 'string' && characterRef.length > 10) {
                // Likely an actor ID
                actor = game.actors?.get?.(characterRef);
            }
            
            if (!actor) {
                // Search by name
                actor = game.actors?.find?.(a => 
                    a.name?.toLowerCase()?.includes?.(characterRef.toLowerCase()) ||
                    characterRef.toLowerCase().includes(a.name?.toLowerCase() || '')
                );
            }

            if (actor) {
                character = actor.id;
                characterData = {
                    name: actor.name || characterRef,
                    // Use 'default' as the emotion key for actor fallback
                    default: actor.prototypeToken?.texture?.src || actor.img || null
                };
                
                // Add to characterData cache to prevent repeated synthesis
                this.characterData[character] = characterData;
                this._debug('Synthesized characterData', { character, characterData });
            }
        }

        if (!characterData) {
            this._debug('No characterData found, cannot show standing', characterRef);
            return;
        }

        // Resolve emotion with fallbacks
        let cleanEmotion;
        if (!emotion) {
            const availableEmotions = Object.keys(characterData).filter(k => k !== 'name');
            if (availableEmotions.length === 0) { 
                this.createEmotionToggle(character); 
                this.updateQuickDock(); 
                return; 
            }
            cleanEmotion = availableEmotions[0];
        } else {
            cleanEmotion = emotion.toLowerCase().replace(/\s+/g, '');
        }

        // Resolve emotion image path with fallbacks
        let imagePath = characterData[cleanEmotion];
        if (!imagePath) {
            this._debug('Emotion not found, trying fallbacks', { cleanEmotion, characterData });
            
            // Try 'default' emotion key
            if (characterData.default) {
                imagePath = characterData.default;
                cleanEmotion = 'default';
            } else {
                // Try any available emotion key
                const availableEmotions = Object.keys(characterData).filter(k => k !== 'name');
                if (availableEmotions.length > 0) {
                    imagePath = characterData[availableEmotions[0]];
                    cleanEmotion = availableEmotions[0];
                } else {
                    // Final fallback to actor image
                    const actor = game.actors?.get?.(character);
                    imagePath = actor?.prototypeToken?.texture?.src || actor?.img;
                    if (imagePath) {
                        cleanEmotion = 'default';
                        // Cache this fallback
                        characterData.default = imagePath;
                    } else {
                        this._debug('No image found for character', character);
                        this.createEmotionToggle(character); 
                        this.updateQuickDock(); 
                        return;
                    }
                }
            }
        }

        // VN 창/스탠딩 레이어가 없다면 자동으로 띄움(도크만으로도 구동)
        if (!$('#vn-standing-layer').length) {
            game.visualNovelChat?.show?.();
            await new Promise(r => setTimeout(r, 50));
        }

        const standingContainer = game.visualNovelChat?.getStandingContainer?.();
        if (!standingContainer || !standingContainer.length) {
            this._debug('No standing container found');
            return;
        }

        // Check if standing already exists
        const standingExists = this.activeStandings.has(character);
        const currentEmotion = standingExists ? this.activeStandings.get(character)?.attr?.('data-emotion') : null;
        const shouldUpdate = forceUpdate || !standingExists || currentEmotion !== cleanEmotion;

        if (standingExists && shouldUpdate) {
            // Update existing standing
            const existing = this.activeStandings.get(character);
            const img = existing?.find?.('img');
            
            if (img?.length) {
                const escapedName = (typeof Handlebars !== 'undefined' && Handlebars.Utils?.escapeExpression) 
                    ? Handlebars.Utils.escapeExpression(characterData.name || character)
                    : (characterData.name || character);
                const escapedEmotion = (typeof Handlebars !== 'undefined' && Handlebars.Utils?.escapeExpression)
                    ? Handlebars.Utils.escapeExpression(cleanEmotion)
                    : cleanEmotion;

                img.attr('src', imagePath);
                img.attr('alt', `${escapedName} ${escapedEmotion}`);
                existing.attr('data-emotion', cleanEmotion);
                img[0].src = imagePath;

                this.lastUsedCharacters.delete(character);
                this.lastUsedCharacters.add(character);
                this.updateEmotionToggle(character, cleanEmotion);
                this.updateQuickDock();

                this._debug('Updated existing standing', { character, cleanEmotion });

                // Emit based on conditions
                if (broadcast && !fromSocket && this._authorityAllowsSend()) {
                    if (fromUserAction) {
                        // Immediate emit for user actions
                        this._emit({ type: 'emotionUpdate', actorId: character, emotion: cleanEmotion });
                    } else {
                        // Queue for typing/fromChat as existing behavior
                        this._emit({ type: 'show', actorId: character, emotion: cleanEmotion });
                    }
                }
                return;
            }
        } else if (standingExists && !shouldUpdate) {
            // Standing exists with same emotion, but force broadcast if user action
            if (fromUserAction && broadcast && !fromSocket && this._authorityAllowsSend()) {
                this._debug('Forcing emotion update broadcast for re-selection', { character, cleanEmotion });
                this._emit({ type: 'emotionUpdate', actorId: character, emotion: cleanEmotion });
            }
            return;
        }

        // Create new standing
        if (this.activeStandings.size >= this.maxStandings) {
            const firstCharacter = this.activeStandings.keys().next().value;
            this.hideStanding(firstCharacter, { broadcast });
        }

        if (position === null) position = this.activeStandings.size;

        // Use escaping for DOM creation
        const escapedCharacter = (typeof Handlebars !== 'undefined' && Handlebars.Utils?.escapeExpression)
            ? Handlebars.Utils.escapeExpression(character)
            : character;
        const escapedEmotion = (typeof Handlebars !== 'undefined' && Handlebars.Utils?.escapeExpression)
            ? Handlebars.Utils.escapeExpression(cleanEmotion)
            : cleanEmotion;
        const escapedName = (typeof Handlebars !== 'undefined' && Handlebars.Utils?.escapeExpression)
            ? Handlebars.Utils.escapeExpression(characterData.name || character)
            : (characterData.name || character);
        const escapedImagePath = (typeof Handlebars !== 'undefined' && Handlebars.Utils?.escapeExpression)
            ? Handlebars.Utils.escapeExpression(imagePath)
            : imagePath;

        const standingEl = $(`
            <div class="vn-standing-image" data-character="${escapedCharacter}" data-emotion="${escapedEmotion}" data-position="${position}">
                <img src="${escapedImagePath}" alt="${escapedName} ${escapedEmotion}">
            </div>
        `);

        standingContainer.append(standingEl);
        this.activeStandings.set(character, standingEl);

        this.lastUsedCharacters.delete(character);
        this.lastUsedCharacters.add(character);

        this.repositionStandings();
        standingEl.hide().fadeIn(300);
        this.createEmotionToggle(character);
        this.updateQuickDock();

        this._debug('Created new standing', { character, cleanEmotion, position });

        if (broadcast && !fromSocket && this._authorityAllowsSend()) {
            this._emit({ type: 'show', actorId: character, emotion: cleanEmotion, position });
        }
    }

    createEmotionToggle(characterId) {
        const placement = game.settings.get('visual-novel-chat', 'toggleUiPlacement') || 'dock';
        if (placement === 'dock') return; // 도크만 쓰는 경우 인라인 토글 생성 안 함

        const data = this.characterData[characterId];
        if (!data) return;
        const name = data.name || characterId;
        const emotions = Object.keys(data).filter(k => k !== 'name');

        // 기존 토글 제거
        this.removeEmotionToggle(characterId);

        const vnWindow = $('.vn-window');
        if (!vnWindow.length) return;

        let html = `
            <div class="emotion-toggle" data-character="${characterId}" style="
                position: absolute;
                bottom: -40px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0, 0, 0, 0.85);
                border-radius: 15px;
                padding: 4px 10px;
                display: flex; gap: 5px; align-items: center;
                backdrop-filter: blur(10px);
                border: 1px solid rgba(66,153,225,0.5);
                z-index: 1000; min-width: fit-content; white-space: nowrap;">
                <span style="color:#63b3ed;font-size:10px;font-weight:bold;">${name}:</span>
        `;
        if (emotions.length > 0) {
            emotions.forEach(em => {
                const isActive = this.activeStandings.get(characterId)?.attr('data-emotion') === em;
                html += `
                    <button class="emotion-btn" data-character="${characterId}" data-emotion="${em}" style="
                        background:${isActive ? '#4299e1' : 'rgba(255,255,255,0.1)'}; color:#fff;
                        border:none; border-radius:8px; padding:3px 7px; font-size:9px; cursor:pointer;"
                        title="우클릭으로 삭제">${em}</button>`;
            });
        } else {
            html += `<span style="color:#ffd700;font-size:9px;font-style:italic;">감정 없음</span>`;
        }
        html += `
                <button class="emotion-manage-btn" data-character="${characterId}" style="
                    background:rgba(156,39,176,0.8); color:#fff; border:none; border-radius:8px; padding:3px 7px; font-size:9px; cursor:pointer;">⚙</button>
                <button class="emotion-hide-btn" data-character="${characterId}" style="
                    background:rgba(239,68,68,0.8); color:#fff; border:none; border-radius:8px; padding:3px 7px; font-size:9px; cursor:pointer;">✕</button>
            </div>
        `;

        const $toggle = $(html);
        $('.vn-window').append($toggle);
        this.activeToggles.set(characterId, $toggle);
        this.attachEmotionToggleEvents(characterId);
        this.repositionAllToggles();
    }

    updateEmotionToggle(characterId, currentEmotion) {
        const $t = $(`.emotion-toggle[data-character="${characterId}"]`);
        if (!$t.length) return;
        $t.find('.emotion-btn').css('background', 'rgba(255, 255, 255, 0.1)');
        $t.find(`.emotion-btn[data-emotion="${currentEmotion}"]`).css('background', '#4299e1');
    }

    attachEmotionToggleEvents(characterId) {
        $(`.emotion-btn[data-character="${characterId}"]`).off('click contextmenu').on({
            click: (e) => this.showStanding(characterId, $(e.target).data('emotion'), null, { broadcast: true, fromUserAction: true }),
            contextmenu: (e) => { e.preventDefault(); this.confirmDeleteEmotion(characterId, $(e.target).data('emotion')); }
        });
        $(`.emotion-manage-btn[data-character="${characterId}"]`).off('click').on('click', () => this.openEmotionManager(characterId));
        $(`.emotion-hide-btn[data-character="${characterId}"]`).off('click').on('click', () => {
            this.hideStanding(characterId, { broadcast: true });
            $(`.emotion-toggle[data-character="${characterId}"]`).remove();
        });
    }

    async confirmDeleteEmotion(characterId, emotion) {
        const ok = await Dialog.confirm({
            title: "감정 삭제",
            content: `"${emotion}" 감정을 삭제하시겠습니까?`,
            yes: () => true, no: () => false
        });
        if (!ok) return;

        await this.deleteEmotion(characterId, emotion);
        if (this.activeStandings.has(characterId)) {
            const cur = this.activeStandings.get(characterId).attr('data-emotion');
            if (cur === emotion.toLowerCase().replace(/\s+/g, '')) {
                const left = this.getAvailableEmotions(characterId);
                if (left.length > 0) this.showStanding(characterId, left[0], null, { broadcast: true, fromUserAction: true });
                else {
                    this.hideStanding(characterId, { broadcast: true });
                    setTimeout(() => this.createEmotionToggle(characterId), 80);
                }
            }
        } else this.createEmotionToggle(characterId);
        this.updateQuickDock();
    }

    openEmotionManager(characterId) {
        const data = this.characterData[characterId];
        const name = data?.name || characterId;
        const list = Object.keys(data || {}).filter(k => k !== 'name');

        let content = `<div style="padding:10px;"><h3 style="margin:0 0 15px 0; color:#63b3ed;">"${name}" 감정 관리</h3>`;
        if (list.length > 0) {
            content += `<div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;font-weight:bold;">현재 감정:</label>
                <div style="display:flex;flex-wrap:wrap;gap:5px;">`;
            list.forEach(em => {
                content += `<div style="display:flex;align-items:center;background:rgba(66,153,225,0.1);padding:5px 8px;border-radius:8px;">
                    <span style="color:#e2e8f0;font-size:12px;margin-right:5px;">${em}</span>
                    <button class="delete-emotion-btn" data-emotion="${em}" style="background:rgba(239,68,68,0.8);color:#fff;border:none;border-radius:3px;padding:1px 4px;font-size:10px;cursor:pointer;">✕</button>
                </div>`;
            });
            content += `</div></div>`;
        } else content += `<p style="color:#ffd700;font-style:italic;margin-bottom:15px;">아직 설정된 감정이 없습니다.</p>`;

        content += `
            <div style="border-top:1px solid rgba(66,153,225,0.3);padding-top:15px;">
                <label style="display:block;margin-bottom:5px;font-weight:bold;">새 감정 추가:</label>
                <div style="margin-bottom:10px;">
                    <input type="text" id="emotion-name" placeholder="감정 이름" style="width:100%;padding:5px;margin-bottom:5px;">
                    <div style="display:flex;gap:5px;">
                        <input type="text" id="emotion-path" placeholder="이미지 경로" style="flex:1;padding:5px;">
                        <button id="select-file-btn" style="padding:5px 10px;background:#38a169;color:#fff;border:none;border-radius:4px;">📁 파일 선택</button>
                    </div>
                </div>
                <button id="add-emotion-btn" style="width:100%;padding:8px;background:#4299e1;color:#fff;border:none;border-radius:4px;">감정 추가</button>
            </div>
        </div>`;

        const dialog = new Dialog({
            title: `${name} 감정 관리`,
            content,
            buttons: { close: { label: "닫기" } },
            render: (html) => {
                html.find('.delete-emotion-btn').on('click', async (e) => {
                    const em = $(e.target).data('emotion');
                    const ok = await Dialog.confirm({ title: "감정 삭제", content: `"${em}" 감정을 삭제하시겠습니까?` });
                    if (ok) {
                        await this.deleteEmotion(characterId, em);
                        dialog.close();
                        this.openEmotionManager(characterId);
                        this.createEmotionToggle(characterId);
                        this.updateQuickDock();
                    }
                });
                html.find('#select-file-btn').on('click', async () => {
                    const p = await this.selectImageFile();
                    if (p) html.find('#emotion-path').val(p);
                });
                html.find('#add-emotion-btn').on('click', async () => {
                    const emName = html.find('#emotion-name').val().trim();
                    const path = html.find('#emotion-path').val().trim();
                    if (!emName || !path) return ui.notifications.warn('감정 이름과 이미지 경로를 모두 입력해주세요.');
                    const ok = await this.addCustomEmotion(characterId, emName, path);
                    if (ok) {
                        dialog.close();
                        this.openEmotionManager(characterId);
                        this.showStanding(characterId, emName, null, { broadcast: true, fromUserAction: true });
                        this.createEmotionToggle(characterId);
                        this.updateQuickDock();
                    }
                });
            },
            width: 500
        });
        dialog.render(true);
    }

    async selectImageFile() {
        return new Promise((resolve) => {
            const $file = $('<input type="file" accept="image/*" style="display:none;">');
            $file.on('change', async (ev) => {
                const file = ev.target.files[0];
                if (!file) return resolve(null);
                if (file.size > 10 * 1024 * 1024) { ui.notifications.error('파일 크기가 10MB를 초과합니다.'); return resolve(null); }
                if (!file.type.startsWith('image/')) { ui.notifications.error('이미지 파일만 선택해주세요.'); return resolve(null); }
                try {
                    ui.notifications.info('파일 업로드 중...');
                    let up; try { up = await FilePicker.upload('data', 'vn-standings/', file, {}); }
                    catch { up = await FilePicker.upload('data', '', file, {}); }
                    if (up?.path) { ui.notifications.info('파일 업로드 완료!'); resolve(up.path); }
                    else { ui.notifications.error('파일 업로드에 실패했습니다.'); resolve(null); }
                } catch (err) { console.error('파일 업로드 오류:', err); ui.notifications.error('파일 업로드 중 오류가 발생했습니다.'); resolve(null); }
            });
            $file.trigger('click');
        });
    }

    hideStanding(characterId = null, options = {}) {
        const { broadcast = true } = options;

        if (characterId) {
            const standing = this.activeStandings.get(characterId);
            if (standing) {
                standing.fadeOut(200, function () { $(this).remove(); });
                this.activeStandings.delete(characterId);
                this.lastUsedCharacters.delete(characterId);
            }
            this.removeEmotionToggle(characterId);
            this.repositionStandings();
            this.repositionAllToggles();
            this.updateQuickDock();

            if (broadcast) this._emit({ type: 'hide', actorId: characterId });
        } else {
            // 전체 숨김은 로컬만 처리(필요 시 hideAll 브로드캐스트 확장 가능)
            this.activeStandings.forEach((standing) => standing.fadeOut(200, function () { $(this).remove(); }));
            this.activeStandings.clear();
            this.lastUsedCharacters.clear();
            this.activeToggles.forEach(($t) => $t.remove());
            this.activeToggles.clear();
            $('.emotion-toggle').remove();
            this.updateQuickDock();
        }
    }

    repositionStandings() {
        let index = 0;
        this.activeStandings.forEach((standing) => {
            standing.attr('data-position', index);
            index++;
        });
    }

    // 인라인 토글 여러 줄 배치
    repositionAllToggles() {
        const placement = game.settings.get('visual-novel-chat', 'toggleUiPlacement') || 'dock';
        if (placement === 'dock') return; // 인라인 토글 미사용
        const $win = $('.vn-window');
        if (!$win.length) return;

        const windowWidth = $win.outerWidth() || 700;
        const ids = Array.from(this.activeToggles.keys());
        const gap = 10;
        const widths = ids.map(id => Math.max(120, (this.activeToggles.get(id)?.outerWidth() || 150)));

        const rows = [];
        let cur = [], curW = 0;
        ids.forEach((id, i) => {
            const w = widths[i];
            const need = cur.length === 0 ? w : curW + gap + w;
            if (need <= windowWidth) { cur.push({ id, w }); curW = need; }
            else { if (cur.length) rows.push(cur); cur = [{ id, w }]; curW = w; }
        });
        if (cur.length) rows.push(cur);

        rows.forEach((row, r) => {
            const rowW = row.reduce((s, it, i) => s + it.w + (i ? gap : 0), 0);
            let left = (windowWidth - rowW) / 2;
            row.forEach((it) => {
                const $t = this.activeToggles.get(it.id);
                if ($t?.length) $t.css({ left: `${left}px`, bottom: `${-40 - r * 45}px`, transform: 'none' });
                left += it.w + gap;
            });
        });
    }

    // 스탠딩 레이어 위치(베이스라인)를 VN 창 위로 고정 + 가로 중앙 정렬
    updateStandingAnchor() {
        const $overlay = $('#vn-chat-overlay');
        const $win = $('.vn-window');
        const $layer = $('#vn-standing-layer');
        if (!$overlay.length || !$win.length || !$layer.length) return;

        const offset = Number(game.settings.get('visual-novel-chat', 'standingOffsetPx') ?? 14);
        const rect = $win[0].getBoundingClientRect();

        const centerX = rect.left + rect.width / 2;
        const bottom = (window.innerHeight - rect.top) + offset;

        $layer.css({ left: `${centerX}px`, transform: 'translateX(-50%)', bottom: `${bottom}px` });
    }

    // ===== 도크(상시 표시, 도크로만 조작) =====
    initQuickDock() {
        if ($('#vn-quick-dock').length === 0) $('body').append('<div id="vn-quick-dock" class="vn-quick-dock"></div>');
        this.updateQuickDock();
        // 바깥 클릭 시 팝오버 닫기
        $(document).off('mousedown.vn-pop').on('mousedown.vn-pop', (e) => {
            if ($(e.target).closest('.vn-quick-popover, .vn-quick-item').length === 0) {
                $('.vn-quick-popover').remove();
            }
        });
    }

    refreshTogglePlacement() {
        const mode = game.settings.get('visual-novel-chat', 'toggleUiPlacement') || 'dock';
        if (mode === 'dock') {
            // 인라인 토글 제거
            $('.emotion-toggle').remove();
            this.activeToggles.clear();
        }
        this.initQuickDock();
        this.updateQuickDock();
    }

    updateQuickDock() {
        const $dock = $('#vn-quick-dock');
        if (!$dock.length) return;

        const mode = game.settings.get('visual-novel-chat', 'toggleUiPlacement') || 'dock';
        $dock.toggle(mode === 'dock' || mode === 'both'); // 도크 상시

        // 캐릭터 전체를 도크에 항상 표시(활성/비활성 상태만 다름)
        this.syncWithPCs();
        const chars = this.getAvailableCharacters();
        const items = Object.values(chars).sort((a, b) => a.name.localeCompare(b.name));

        let html = '';
        for (const c of items) {
            const active = this.activeStandings.has(c.id);
            const thumb = this._getDockThumb(c.id);
            html += `
                <div class="vn-quick-item ${active ? 'active' : 'inactive'}" data-character="${c.id}" title="${c.name}">
                    <div class="vn-quick-thumb" style="background-image:${thumb ? `url('${thumb}')` : 'none'};"></div>
                </div>
            `;
        }
        $dock.html(html);

        // 좌클릭: 활성/비활성 토글, 우클릭: 표정 팝오버
        $dock.find('.vn-quick-item')
            .off('click contextmenu mousedown')
            .on('click', (e) => {
                const id = $(e.currentTarget).data('character');
                if (this.activeStandings.has(id)) this.hideStanding(id, { broadcast: true });
                else {
                    const last = this.activeStandings.get(id)?.attr('data-emotion') ||
                                 this.getAvailableEmotions(id)[0] || 'default';
                    this.showStanding(id, last || 'default', null, { broadcast: true, fromUserAction: true });
                }
            })
            .on('contextmenu', (e) => {
                e.preventDefault();
                const id = $(e.currentTarget).data('character');
                $('.vn-quick-popover').remove();
                const pop = this.buildQuickPopover(id);
                $('body').append(pop);

                const rect = e.currentTarget.getBoundingClientRect();
                const px = rect.left + rect.width / 2;
                const py = rect.top;
                const $pop = $(pop);
                const w = $pop.outerWidth() || 220;
                const h = $pop.outerHeight() || 40;
                const left = Math.max(8, Math.min(px - w / 2, window.innerWidth - w - 8));
                const top = Math.max(8, py - h - 8);
                $pop.css({ left: `${left}px`, top: `${top}px` });
            })
            .on('mousedown', (e) => {
                if (e.which === 2) {
                    const id = $(e.currentTarget).data('character');
                    this.hideStanding(id, { broadcast: true });
                }
            });
    }

    _getDockThumb(characterId) {
        // 1) 활성 스탠딩 이미지
        if (this.activeStandings.has(characterId)) {
            const el = this.activeStandings.get(characterId);
            return el.find('img').attr('src') || null;
        }
        // 2) characterData의 마지막/기본/첫 감정
        const data = this.characterData[characterId] || {};
        const list = Object.keys(data).filter(k => k !== 'name');
        if (list.includes('default')) return data.default;
        if (list.length) return data[list[0]];
        // 3) 액터 토큰 이미지 폴백
        const actor = game.actors?.get?.(characterId);
        const tok = actor?.prototypeToken;
        const src = tok?.texture?.src || actor?.img;
        return src || null;
    }

    buildQuickPopover(characterId) {
        const data = this.characterData[characterId] || {};
        const name = data.name || characterId;
        const emotions = Object.keys(data).filter(k => k !== 'name');

        let html = `
            <div class="vn-quick-popover" data-character="${characterId}">
                <div class="vn-qp-header">
                    <span class="vn-qp-name">${name}</span>
                    <div class="vn-qp-actions">
                        <button class="vn-qp-manage" title="감정 관리">⚙</button>
                        <button class="vn-qp-hide" title="숨기기">✕</button>
                    </div>
                </div>
                <div class="vn-qp-body">
        `;
        if (emotions.length === 0) html += `<span class="vn-qp-empty">감정 없음</span>`;
        else emotions.forEach(em => {
            html += `<button class="vn-qp-btn" data-emotion="${em}">${em}</button>`;
        });
        html += `</div></div>`;

        const $pop = $(html);
        // 이벤트 바인딩
        $pop.find('.vn-qp-manage').on('click', () => { this.openEmotionManager(characterId); $('.vn-quick-popover').remove(); });
        $pop.find('.vn-qp-hide').on('click', () => { this.hideStanding(characterId, { broadcast: true }); $('.vn-quick-popover').remove(); });
        $pop.find('.vn-qp-btn').on('click', (e) => {
            const em = $(e.currentTarget).data('emotion');
            this.showStanding(characterId, em, null, { broadcast: true, fromUserAction: true });
            $('.vn-quick-popover').remove();
        });
        return $pop;
    }

    removeEmotionToggle(characterId) {
        const $existing = this.activeToggles.get(characterId);
        if ($existing?.length) $existing.remove();
        this.activeToggles.delete(characterId);
        $(`.emotion-toggle[data-character="${characterId}"]`).remove();
    }

    // 토큰 기반 자동 진입은 유지하되(채팅 훅/토큰 선택), 지금 버전은 도크 중심이라 필요시만 사용
    handleTokenSelection(token) {
        // 이제 토큰 선택 훅을 메인에서 제거했으므로 호출되지 않음
        if (!game.settings.get('visual-novel-chat', 'enableVNMode')) return;
        const actor = token.actor;
        if (!actor) return;
        const isPC =
            actor.hasPlayerOwner ||
            actor.type === 'character' ||
            (actor.ownership && Object.values(actor.ownership).some(level => level >= 2));
        if (!isPC) return;

        const data = this.characterData[actor.id];
        if (data) {
            const list = Object.keys(data).filter(k => k !== 'name');
            if (list.length > 0) this.showStanding(actor.id, list[0], null, { broadcast: false });
            else this.createEmotionToggle(actor.id);
        }
    }

    autoChangeStanding(actorInfo) {
        if (!actorInfo?.id) return;
        const data = this.characterData[actorInfo.id];
        if (data) {
            const list = Object.keys(data).filter(k => k !== 'name');
            if (list.length > 0) this.showStanding(actorInfo.id, list[0], null, { broadcast: false });
            else this.createEmotionToggle(actorInfo.id);
        }
    }

    getAvailableCharacters() {
        const chars = {};
        this.syncWithPCs();
        Object.keys(this.characterData).forEach(id => {
            const data = this.characterData[id];
            const actor = game.actors.get(id);
            chars[id] = {
                id, name: data.name || id, isPC: !!actor,
                emotions: Object.keys(data).filter(k => k !== 'name')
            };
        });
        return chars;
    }

    listAvailableCharacters() {
        const chars = this.getAvailableCharacters();
        const rows = Object.values(chars)
            .map(c => `<li><b>${c.name}</b> (${c.id}) - 감정: ${c.emotions.length ? c.emotions.join(', ') : '없음'}</li>`)
            .join('');
        const html = `<h3>사용 가능한 캐릭터</h3><ul>${rows || '<li>없음</li>'}</ul>`;
        ChatMessage.create({ content: html, whisper: [game.user.id] });
    }
}