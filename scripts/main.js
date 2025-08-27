import { VisualNovelChat } from './chat-window.js';
import { StandingManager } from './standing-manager.js';

Hooks.once('init', () => {
    console.log('Visual Novel Chat | 초기화 시작');

    // 채팅창 표시 설정 (개인)
    game.settings.register('visual-novel-chat', 'enableVNMode', {
        name: 'VN 채팅창 활성화',
        hint: '비주얼노벨 스타일 채팅창을 표시합니다',
        scope: 'client',
        config: true,
        type: Boolean,
        default: false,
        onChange: value => {
            if (!game.visualNovelChat) return;
            if (value) game.visualNovelChat.show();
            else game.visualNovelChat.close();
        }
    });

    // 자동 진행 모드 (개인)
    game.settings.register('visual-novel-chat', 'autoAdvanceMode', {
        name: 'VN 실시간 모드',
        hint: '새 채팅이 오면 자동으로 표시 (끄면 클릭해서 넘기는 모드)',
        scope: 'client',
        config: true,
        type: Boolean,
        default: true
    });

    // 채팅창 위치(top/bottom) (개인)
    game.settings.register('visual-novel-chat', 'windowPosition', {
        name: '채팅창 위치',
        hint: 'VN 채팅창의 위치',
        scope: 'client',
        config: true,
        type: String,
        choices: { 'bottom': '하단', 'top': '상단' },
        default: 'bottom',
        onChange: () => {
            setTimeout(() => game.standingManager?.updateStandingAnchor?.(), 50);
        }
    });

    // 스탠딩 데이터 저장 (월드)
    game.settings.register('visual-novel-chat', 'characterData', {
        name: 'PC 스탠딩 데이터',
        scope: 'world',
        config: false,
        type: Object,
        default: {}
    });

    // 디버그 (개인)
    game.settings.register('visual-novel-chat', 'debugMode', {
        name: 'PC 연동 디버그 모드',
        hint: 'PC 연동 과정을 콘솔에 상세히 출력합니다',
        scope: 'client',
        config: true,
        type: Boolean,
        default: false
    });

    // 스탠딩 베이스라인 간격 (개인)
    game.settings.register('visual-novel-chat', 'standingOffsetPx', {
        name: 'VN 스탠딩 기준 간격(px)',
        hint: 'VN 채팅창 윗부분으로부터 스탠딩 베이스라인까지 간격',
        scope: 'client',
        config: true,
        type: Number,
        default: 14,
        range: { min: 0, max: 200, step: 1 },
        onChange: () => game.standingManager?.updateStandingAnchor?.()
    });

    // 토글 UI 배치 (개인)
    game.settings.register('visual-novel-chat', 'toggleUiPlacement', {
        name: '토글 UI 배치',
        hint: '감정 토글을 어디에 표시할지 설정 (도크/창 아래/둘 다)',
        scope: 'client',
        config: true,
        type: String,
        choices: {
            'dock': '채팅창 옆 도크에만',
            'inline': 'VN 창 아래에만',
            'both': '둘 다'
        },
        default: 'dock',
        onChange: () => game.standingManager?.refreshTogglePlacement?.()
    });

    // [신규] 실시간 동기화 ON/OFF (월드)
    game.settings.register('visual-novel-chat', 'syncRealtimeStanding', {
        name: '표정/스탠딩 실시간 동기화',
        hint: '사용자가 표정을 바꾸거나 스탠딩을 켜고/끄면 모든 클라이언트에 즉시 반영합니다.',
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    // [신규] 동기화 권한 (월드)
    game.settings.register('visual-novel-chat', 'syncAuthority', {
        name: '동기화 권한',
        hint: '어떤 사용자의 입력을 전원에게 반영할지 선택합니다.',
        scope: 'world',
        config: true,
        type: String,
        choices: {
            'everyone': '모든 사용자',
            'gm-only': 'GM만'
        },
        default: 'everyone'
    });
});

Hooks.once('ready', () => {
    game.visualNovelChat = new VisualNovelChat();
    game.standingManager = new StandingManager();

    // 설정이 활성화되어 있다면 자동으로 표시
    const isEnabled = game.settings.get('visual-novel-chat', 'enableVNMode');
    if (isEnabled) setTimeout(() => game.visualNovelChat.show(), 400);

    registerChatCommands();
    createVNMacros();

    ui.notifications.info('VN 채팅 모듈이 로드되었습니다! /standing 명령어를 사용할 수 있습니다.');
});

function registerChatCommands() {
    Hooks.on('chatMessage', (chatlog, messageText) => {
        if (messageText.startsWith('/standing ')) {
            const args = messageText.slice(10).trim().split(/\s+/);
            const characterRef = args[0];
            const emotion = args[1] || 'default';
            if (!game.settings.get('visual-novel-chat', 'enableVNMode')) {
                game.settings.set('visual-novel-chat', 'enableVNMode', true);
                game.visualNovelChat.show();
                setTimeout(() => game.standingManager.showStanding(characterRef, emotion), 400);
            } else {
                game.standingManager.showStanding(characterRef, emotion);
            }
            return false;
        }
        if (messageText.startsWith('/hide ')) {
            const characterRef = messageText.slice(6).trim();
            if (characterRef === 'all' || characterRef === 'standing') {
                // 전체 숨김은 로컬만 처리(원하면 소켓 확장 가능)
                game.standingManager.hideStanding();
                ui.notifications.info('모든 스탠딩이 숨겨졌습니다.');
            } else {
                const foundActor = game.actors.find(actor => actor.name.toLowerCase() === characterRef.toLowerCase());
                const characterId = foundActor ? foundActor.id : characterRef;
                game.standingManager.hideStanding(characterId);
                ui.notifications.info(`${characterRef} 스탠딩이 숨겨졌습니다.`);
            }
            return false;
        }
        if (messageText.startsWith('/pc list')) {
            game.standingManager.listAvailableCharacters();
            return false;
        }
        if (messageText.startsWith('/vn help') || messageText === '/standing') {
            const helpMessage = `
                <h3>🎭 VN 스탠딩 명령어 도움말</h3>
                <ul>
                    <li><code>/standing 캐릭터명 감정</code> - 스탠딩 표시/변경</li>
                    <li><code>/hide 캐릭터명</code> - 특정 스탠딩 숨기기</li>
                    <li><code>/hide all</code> - 모든 스탠딩 숨기기(로컬)</li>
                    <li><code>/pc list</code> - 사용 가능한 캐릭터 목록</li>
                </ul>`;
            ChatMessage.create({ content: helpMessage, whisper: [game.user.id] });
            return false;
        }
        return true;
    });

    // 일반 채팅 → 자동 연동(브로드캐스트 없음)
    Hooks.on('createChatMessage', (message) => {
        if (!game.settings.get('visual-novel-chat', 'enableVNMode')) return;
        if (!game.visualNovelChat) return;
        const content = message.content;
        if (content.startsWith('/')) return;

        const pc = message.speaker?.actor ?? null;
        let actorId = pc?.id || null;
        let actorName = pc?.name || message.speaker?.alias || message.user?.name || '익명';

        if (!actorId) {
            const token = canvas.tokens?.controlled?.[0];
            if (token?.actor && (token.actor.hasPlayerOwner || token.actor.type === 'character')) actorId = token.actor.id;
        }

        if (actorId) game.standingManager.autoChangeStanding({ id: actorId, name: actorName }); // 로컬만
        game.visualNovelChat.addMessage(actorName, content);
    });

    // 토큰 선택으로 자동 표시하던 기능은 제거(도크로만 조작)
    // Hooks.on('controlToken', ...) 제거
    Hooks.off('controlToken');
}

async function createVNMacros() {
    // VN 모드 토글
    const mToggle = game.macros.getName('VN 모드 토글');
    const toggleCmd = `
if (!game.visualNovelChat) return ui.notifications.error('VN 채팅 시스템이 로드되지 않았습니다.');
const current = game.settings.get('visual-novel-chat', 'enableVNMode');
await game.settings.set('visual-novel-chat', 'enableVNMode', !current);
if (!current) game.visualNovelChat.show(); else game.visualNovelChat.close();
`.trim();
    if (!mToggle) {
        await Macro.create({ name: 'VN 모드 토글', type: 'script', img: 'icons/svg/book.svg', command: toggleCmd });
    } else if (mToggle.command !== toggleCmd) {
        await mToggle.update({ command: toggleCmd });
    }

    // VN 명령어 도움말
    const mHelp = game.macros.getName('VN 명령어 도움말');
    const helpCmd = `
const helpMessage = \`
<h3>🎭 VN 스탠딩 명령어 도움말</h3>
<ul>
<li><code>/standing 캐릭터명 감정</code> - 스탠딩 표시/변경</li>
<li><code>/hide 캐릭터명</code> - 특정 스탠딩 숨기기</li>
<li><code>/hide all</code> - 모든 스탠딩 숨기기(로컬)</li>
<li><code>/pc list</code> - 사용 가능한 캐릭터 목록</li>
</ul>\`;
ChatMessage.create({ content: helpMessage, whisper: [game.user.id] });
`.trim();
    if (!mHelp) {
        await Macro.create({ name: 'VN 명령어 도움말', type: 'script', img: 'icons/svg/help.svg', command: helpCmd });
    } else if (mHelp.command !== helpCmd) {
        await mHelp.update({ command: helpCmd });
    }

    // VN 테스트
    const mTest = game.macros.getName('VN 테스트');
    const testCmd = `
await game.settings.set('visual-novel-chat', 'enableVNMode', true);
game.visualNovelChat.show();
setTimeout(() => {
  const firstPC = game.actors.find(a => a.hasPlayerOwner || a.type === 'character');
  if (firstPC) {
    game.standingManager.showStanding(firstPC.id, 'happy');
    game.visualNovelChat.addMessage(firstPC.name, '안녕하세요! VN 모드 테스트입니다!');
  } else {
    game.visualNovelChat.addMessage('시스템', 'VN 채팅창 테스트입니다. /standing 캐릭터명 감정');
  }
}, 300);
`.trim();
    if (!mTest) {
        await Macro.create({ name: 'VN 테스트', type: 'script', img: 'icons/svg/dice-target.svg', command: testCmd });
    } else if (mTest.command !== testCmd) {
        await mTest.update({ command: testCmd });
    }

    // PC 스탠딩 설정(오류 매크로 교체) → 캐릭터 목록을 여는 안전한 매크로로 교체
    const mCfg = game.macros.getName('PC 스탠딩 설정');
    const cfgCmd = `
if (!game.standingManager) return ui.notifications.warn('StandingManager가 없습니다.');
game.standingManager.listAvailableCharacters();
`.trim();
    if (!mCfg) {
        await Macro.create({ name: 'PC 스탠딩 설정', type: 'script', img: 'icons/svg/portrait.svg', command: cfgCmd });
    } else if (mCfg.command !== cfgCmd) {
        await mCfg.update({ command: cfgCmd });
    }
}