export class VisualNovelChat {
  constructor() {
    this.isVisible = false;
    this.messageQueue = [];
    this.currentMessage = null;
    this.isTyping = false;
    this.typingSpeed = 30;
    this.autoAdvance = true;
    this.currentCharacterIndex = 0;
    this.isDragging = false;
    this.dragRAF = null; // 드래그 중 앵커 업데이트 throttle
    this.loadSettings();
  }

  loadSettings() {
    this.autoAdvance = game.settings.get('visual-novel-chat', 'autoAdvanceMode');
  }

  show() {
    if (this.isVisible) return;
    this.createWindow();
    this.ensureStandingLayer();
    this.isVisible = true;

    // 표시 직후 정렬
    setTimeout(() => {
      game.standingManager?.updateStandingAnchor?.();
      game.standingManager?.refreshTogglePlacement?.();
      game.standingManager?.initQuickDock?.(); // 도크 상시
      game.standingManager?.updateQuickDock?.();
      game.standingManager?.repositionAllToggles?.();
    }, 0);
  }

  createWindow() {
    $('#vn-chat-overlay').remove();

    const position = game.settings.get('visual-novel-chat', 'windowPosition');
    const overlay = $(`
      <div id="vn-chat-overlay" class="${position}">
        <div class="vn-window">
          <div class="vn-drag-bar" style="
            position:absolute;top:0;left:0;right:0;height:25px;cursor:move;
            background:linear-gradient(90deg, rgba(66,153,225,0.1), transparent);
            border-bottom:1px solid rgba(66,153,225,0.2);
            display:flex;align-items:center;justify-content:center;
            user-select:none;opacity:0;transition:opacity 0.2s;">
            <span style="color:#63b3ed;font-size:10px;">드래그</span>
          </div>
          <div class="vn-controls"><button class="vn-close-btn" title="VN 모드 끄기">✕</button></div>
          <div class="vn-speaker-area" style="margin-top:25px;"><div class="vn-speaker-name">시스템</div></div>
          <div class="vn-content-area">
            <div class="vn-text-display">VN 모드가 활성화되었습니다!</div>
            <div class="vn-mode-indicator">
              <span class="mode-status">${this.autoAdvance ? 'AUTO' : 'MANUAL'}</span>
              <button class="vn-mode-toggle" title="모드 전환">⚙</button>
            </div>
            <div class="vn-continue-hint" style="display:none;">클릭하여 계속...</div>
          </div>
        </div>
      </div>
    `);

    $('body').append(overlay);
    this.setupDragFunctionality();
    this.attachEvents();

    // 리사이즈 시 정렬
    $(window).off('resize.vn').on('resize.vn', () => {
      game.standingManager?.updateStandingAnchor?.();
      game.standingManager?.updateQuickDock?.();
      game.standingManager?.repositionAllToggles?.();
    });

    overlay.hide().fadeIn(250);
  }

  ensureStandingLayer() {
    if ($('#vn-standing-layer').length === 0) {
      $('body').append('<div id="vn-standing-layer" class="vn-standing-container"></div>');
    }
  }

  setupDragFunctionality() {
    const overlay = $('#vn-chat-overlay');
    const dragBar = $('.vn-drag-bar');
    const vnWindow = $('.vn-window');

    vnWindow.on('mouseenter', () => { if (!this.isDragging) dragBar.css('opacity', '0.8'); });
    vnWindow.on('mouseleave', () => { if (!this.isDragging) dragBar.css('opacity', '0'); });

    let startX, startY, startLeft, startTop;

    dragBar.on('mousedown', (e) => {
      this.isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = overlay[0].getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      overlay.css({ position: 'fixed', left: startLeft + 'px', top: startTop + 'px', transform: 'none', zIndex: 1500 });
      dragBar.css('opacity', '1');

      $(document).on('mousemove.vn-drag', (e) => {
        if (!this.isDragging) return;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        const maxLeft = $(window).width() - overlay.outerWidth();
        const maxTop = $(window).height() - overlay.outerHeight();
        let newLeft = Math.max(0, Math.min(startLeft + deltaX, maxLeft));
        let newTop = Math.max(0, Math.min(startTop + deltaY, maxTop));
        overlay.css({ left: newLeft + 'px', top: newTop + 'px' });

        // 드래그 중에도 스탠딩 앵커를 따라가게 실시간 업데이트 (rAF throttle)
        if (!this.dragRAF) {
          this.dragRAF = requestAnimationFrame(() => {
            this.dragRAF = null;
            game.standingManager?.updateStandingAnchor?.();
          });
        }
      });

      $(document).on('mouseup.vn-drag', () => {
        this.isDragging = false;
        $(document).off('mousemove.vn-drag mouseup.vn-drag');
        overlay.css('z-index', 999);
        dragBar.css('opacity', '0');
        game.standingManager?.updateStandingAnchor?.();
        game.standingManager?.updateQuickDock?.();
      });

      e.preventDefault();
    });
  }

  close() {
    if (!this.isVisible) return;
    $('#vn-chat-overlay').fadeOut(200, function () { $(this).remove(); });
    $(window).off('resize.vn');

    // 스탠딩/도크 정리
    $('#vn-standing-layer').remove();
    $('.emotion-toggle').remove();
    // 도크는 VN 모드 끄면 함께 제거
    $('#vn-quick-dock').remove();
    $('.vn-quick-popover').remove();

    this.isVisible = false;
    this.messageQueue = [];
    this.currentMessage = null;
  }

  forceClose() {
    this.close();
    game.settings.set('visual-novel-chat', 'enableVNMode', false);
  }

  attachEvents() {
    $('.vn-close-btn').off('click').on('click', () => this.forceClose());
    $('.vn-mode-toggle').off('click').on('click', () => {
      this.autoAdvance = !this.autoAdvance;
      game.settings.set('visual-novel-chat', 'autoAdvanceMode', this.autoAdvance);
      $('.mode-status').text(this.autoAdvance ? 'AUTO' : 'MANUAL');
    });
    $('.vn-content-area').off('click').on('click', () => {
      if (this.isTyping) this.skipTyping();
      else if (!this.autoAdvance && this.messageQueue.length > 0) this.showNextMessage();
    });
  }

  addMessage(speaker, content) {
    if (!this.isVisible) {
      this.show();
      setTimeout(() => {
        this.messageQueue.push({ speaker, content });
        if (this.autoAdvance && !this.isTyping) this.showNextMessage();
        else if (!this.autoAdvance) $('.vn-continue-hint').show();
      }, 300);
      return;
    }
    this.messageQueue.push({ speaker, content });
    if (this.autoAdvance && !this.isTyping) this.showNextMessage();
    else if (!this.autoAdvance) $('.vn-continue-hint').show();
  }

  showNextMessage() {
    if (this.messageQueue.length === 0 || this.isTyping) return;
    this.currentMessage = this.messageQueue.shift();
    $('.vn-speaker-name').text(this.currentMessage.speaker);
    $('.vn-continue-hint').hide();
    this.startTypingAnimation(this.currentMessage.content);
  }

  startTypingAnimation(text) {
    this.isTyping = true;
    this.currentCharacterIndex = 0;
    const textDisplay = $('.vn-text-display');
    textDisplay.text('').addClass('typing');

    const typeNext = () => {
      if (this.currentCharacterIndex < text.length) {
        textDisplay.text(text.substring(0, this.currentCharacterIndex + 1));
        this.currentCharacterIndex++;
        setTimeout(typeNext, this.typingSpeed);
      } else this.finishTyping();
    };
    typeNext();
  }

  finishTyping() {
    this.isTyping = false;
    $('.vn-text-display').removeClass('typing');
    if (!this.autoAdvance && this.messageQueue.length > 0) $('.vn-continue-hint').show();
    else if (this.autoAdvance && this.messageQueue.length > 0) setTimeout(() => this.showNextMessage(), 800);
  }

  skipTyping() {
    if (!this.isTyping || !this.currentMessage) return;
    this.isTyping = false;
    $('.vn-text-display').text(this.currentMessage.content).removeClass('typing');
    if (!this.autoAdvance && this.messageQueue.length > 0) $('.vn-continue-hint').show();
  }

  getStandingContainer() {
    return $('#vn-standing-layer');
  }
}