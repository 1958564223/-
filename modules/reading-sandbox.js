// ============================================================
// modules/reading-sandbox.js
// 读书屋 · 沙盒侧 (跑在 reading-sandbox/index.html 里)
//
// 【这个文件的边界】
//   只做三件事:
//     ① 渲染 (书架 / 阅读室)
//     ② 交互 (翻页 / 选段提问 / 拖分隔条)
//     ③ 跟宿主对话 (postMessage)
//
//   【不碰的事】
//     · 不碰 IndexedDB —— 沙盒和宿主同源, 技术上能开同一个库, 但那会撞
//       versionchange 冲突, 而且老代码里 "db.close() 自愈" 那条路能把宿主库
//       的自动重开永久关掉 (sw.js 里记过: 症状是"存不下 / 整页刷新前全都存不进去")。
//     · 不自己发 AI 请求 —— 沙盒里没有 ai-response.js / utils.js / live-client.js,
//       主 API 要是谷歌原生地址, 自己拼必然 404。请求交给宿主代打。
//
// 【跟宿主的消息协议】详见 reading-sandbox/index.html 顶部的注释。
// ============================================================

(function () {
  'use strict';

  var LOG = '[ReadingSandbox] ';

  function log(msg, extra) {
    console.log(LOG + msg, extra === undefined ? '' : extra);
  }
  function logWarn(msg, extra) {
    console.warn(LOG + '⚠️ ' + msg, extra === undefined ? '' : extra);
  }

  // ============================================================
  // 状态
  // ============================================================
  var S = {
    view: 'hall',          // 'hall' | 'reader'
    books: [],
    book: null,            // 当前书 { id, title, pageCount, currentPage, ... }
    pageNo: 0,
    pageCount: 0,
    pageText: '',
    chapterTitle: '',
    chapterLine: '',      // 章节的原始标题行 (由分页层给, 渲染层不自己猜)
    selected: '',          // 用户圈出来的那句
    pickedText: '',        // 浮标弹出那一刻的选区原文 (点浮标时选区可能已经被系统清掉)
    fabHolding: false,     // 手指正按在浮标上 —— 这期间不许藏浮标
    chatBusy: false,
    chatSeq: 0,
    lastAiBubble: null,
    hostApiConfig: null,
    chat: null             // 宿主给的聊天对象
  };

  // ============================================================
  // DOM
  // ============================================================
  var el = {};
  function grab() {
    var ids = [
      'rr-boot', 'rr-boot-msg', 'rr-root', 'rr-hall', 'rr-hall-close', 'rr-search',
      'rr-import-btn', 'rr-file-input', 'rr-grid', 'rr-empty',
      'rr-reader', 'rr-back', 'rr-book-title', 'rr-page-label',
      'rr-page-area', 'rr-page-card', 'rr-chapter', 'rr-page-text', 'rr-picked',
      'rr-pick-fab', 'rr-prev', 'rr-next', 'rr-page-num',
      'rr-splitter', 'rr-chat', 'rr-chat-toggle', 'rr-chat-hint', 'rr-chat-body',
      'rr-chat-input', 'rr-send-btn', 'rr-toast', 'rr-import', 'rr-import-title',
      'rr-import-bar', 'rr-import-sub'
    ];
    for (var i = 0; i < ids.length; i++) {
      el[ids[i].replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] =
        document.getElementById(ids[i]);
    }
  }

  // ============================================================
  // 跟宿主通信
  // ============================================================
  var IN_IFRAME = (window.parent && window.parent !== window);

  function post(msg) {
    if (!IN_IFRAME) return false;
    try {
      window.parent.postMessage(msg, '*');
      return true;
    } catch (e) {
      logWarn('发给宿主失败:', e);
      return false;
    }
  }

  // ============================================================
  // 提示条
  // ============================================================
  var toastTimer = null;
  function toast(text, ms) {
    if (!el.rrToast) return;
    el.rrToast.textContent = String(text || '');
    el.rrToast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.rrToast) el.rrToast.classList.remove('on');
    }, ms || 2600);
  }

  // ============================================================
  // 视图切换
  // ============================================================
  function showView(name) {
    S.view = name;
    if (el.rrHall) el.rrHall.classList.toggle('active', name === 'hall');
    if (el.rrReader) el.rrReader.classList.toggle('active', name === 'reader');
    if (name === 'hall') {
      // 退回书架时把这一页的位置存一下, 下次进来接着读
      saveProgress();
      // 顺便跟宿主要一份最新的书架 (刚导入的书 / 刚删掉的书要立刻反映出来)
      post({ type: 'reading:needBooks' });
    }
  }

  // ============================================================
  // 书架大厅
  // ============================================================
  function renderHall() {
    if (!el.rrGrid) return;
    var q = (el.rrSearch && el.rrSearch.value ? el.rrSearch.value : '').trim().toLowerCase();
    var list = S.books.filter(function (b) {
      if (!q) return true;
      return String(b.title || '').toLowerCase().indexOf(q) >= 0;
    });

    el.rrGrid.innerHTML = '';
    if (el.rrEmpty) el.rrEmpty.style.display = list.length ? 'none' : 'block';

    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var card = document.createElement('div');
      card.className = 'rr-book-card';
      card.setAttribute('data-book-id', String(b.id));

      var pct = b.pageCount > 0
        ? Math.min(100, Math.round(((b.currentPage || 0) + 1) / b.pageCount * 100))
        : 0;
      var chars = b.charCount > 10000
        ? (b.charCount / 10000).toFixed(1) + ' 万字'
        : (b.charCount || 0) + ' 字';

      card.innerHTML =
        '<div class="rr-cover"></div>' +
        '<button class="rr-del" title="从书架移除">🗑</button>' +
        '<div class="rr-meta">' +
          '<div class="rr-name"></div>' +
          '<div class="rr-stat"></div>' +
          '<div class="rr-bar"><i></i></div>' +
        '</div>';
      // 书名用 textContent —— 避免书名里的尖括号把 HTML 撑坏
      card.querySelector('.rr-name').textContent = b.title || '未命名';
      card.querySelector('.rr-stat').textContent =
        chars + ' · ' + (b.pageCount || 0) + ' 页' + (pct > 0 ? ' · 已读 ' + pct + '%' : '');
      var bar = card.querySelector('.rr-bar i');
      if (bar) bar.style.width = pct + '%';
      card.querySelector('.rr-cover').style.backgroundImage =
        'url("../assets/reading-room/reading-hall-bg-thumb.webp")';

      card.addEventListener('click', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('rr-del')) return;
        openBook(b.id);
      });
      card.querySelector('.rr-del').addEventListener('click', function (e) {
        e.stopPropagation();
        confirmDelete(b);
      });

      el.rrGrid.appendChild(card);
    }
  }

  function confirmDelete(b) {
    if (window.confirm('确定要把《' + (b.title || '这本书') + '》从书架移除吗？')) {
      post({ type: 'reading:deleteBook', bookId: b.id });
      toast('已移除');
    }
  }

  // ============================================================
  // 阅读室
  // ============================================================

  /**
   * 渲染这一页
   *
   * ⚠️ 章节标题【不在这儿自己猜】—— 用分页层存好的 chapterLine。
   *   之前这里跟 reading-storage.js 各写一份正则, 两边判定不一致的时候
   *   (第1卷第1段：xxx 这种正文被一边当标题一边不当) 整页正文就没了。
   *   现在只有 reading-storage.js 一处说了算。
   */
  function renderPage() {
    if (!el.rrPageText) return;
    var lines = String(S.pageText || '').split('\n');
    var html = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      var trimmed = line.trim();
      if (S.chapterLine && trimmed === S.chapterLine) {
        var t = trimmed.replace(/^=+\s*/, '').replace(/\s*=+$/, '').replace(/^【|】$/g, '');
        html.push('<div class="rr-ch-line">' + escapeHtml(t) + '</div>');
      } else {
        html.push('<p>' + escapeHtml(line) + '</p>');
      }
    }
    el.rrPageText.innerHTML = html.join('');

    if (el.rrChapter) {
      if (S.chapterTitle) {
        el.rrChapter.textContent = S.chapterTitle;
        el.rrChapter.style.display = 'block';
      } else {
        el.rrChapter.style.display = 'none';
      }
    }

    var label = S.pageCount ? ((S.pageNo + 1) + ' / ' + S.pageCount) : '— / —';
    if (el.rrPageLabel) el.rrPageLabel.textContent = label;
    if (el.rrPageNum) el.rrPageNum.textContent = label;
    if (el.rrPrev) el.rrPrev.disabled = S.pageNo <= 0;
    if (el.rrNext) el.rrNext.disabled = !S.pageCount || S.pageNo >= S.pageCount - 1;
    if (el.rrPageArea) el.rrPageArea.scrollTop = 0;

    renderPicked();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderPicked() {
    if (!el.rrPicked) return;
    if (S.selected) {
      // ⚠️ 只显示前 60 字 —— 整句塞进来会撑成 6 行, 把正文挡掉一大半。
      //   完整那句照样原样带去给 AI, 这里只是给人看的提示。
      var shown = S.selected.length > 60 ? S.selected.substring(0, 60) + '…' : S.selected;
      el.rrPicked.innerHTML = '<b>已圈出：</b>' + escapeHtml(shown);
      el.rrPicked.classList.add('on');
    } else {
      // ⚠️ 连文字一起清 —— 之前只摘 class, 结果选区没了提示条里还留着上一句,
      //   看着像"还圈着", 其实是脏数据。
      el.rrPicked.innerHTML = '';
      el.rrPicked.classList.remove('on');
    }
    // 提示条是 sticky 贴在底部的 → 底下要留出它的高度, 否则最后一段正文被它盖住
    if (el.rrPageArea) el.rrPageArea.classList.toggle('has-picked', !!S.selected);
  }

  function openBook(bookId) {
    var book = null;
    for (var i = 0; i < S.books.length; i++) {
      if (S.books[i].id === bookId) { book = S.books[i]; break; }
    }
    if (!book) { toast('找不到这本书'); return; }
    S.book = book;
    S.pageCount = book.pageCount || 0;
    S.pageNo = Math.max(0, Math.min(book.currentPage || 0, Math.max(0, S.pageCount - 1)));
    S.pageText = '';
    S.chapterTitle = '';
    S.chapterLine = '';
    S.selected = '';
    S.pickedText = '';
    if (el.rrBookTitle) el.rrBookTitle.textContent = book.title || '未命名';
    showView('reader');
    requestPage(S.pageNo);
  }

  function requestPage(pageNo) {
    if (!S.book) return;
    post({ type: 'reading:requestPage', bookId: S.book.id, pageNo: pageNo });
  }

  function saveProgress() {
    if (!S.book) return;
    post({ type: 'reading:saveProgress', bookId: S.book.id, pageNo: S.pageNo });
  }

  function turnPage(delta) {
    if (!S.book || !S.pageCount) return;
    var next = S.pageNo + delta;
    if (next < 0 || next >= S.pageCount) return;
    S.pageNo = next;
    S.selected = '';
    S.pickedText = '';
    hideFab();
    requestPage(S.pageNo);
    saveProgress();
  }

  // ============================================================
  // 选段提问
  // ============================================================
  function currentSelectionText() {
    try {
      var sel = window.getSelection();
      if (!sel) return '';
      var txt = String(sel.toString() || '').trim();
      return txt;
    } catch (e) { return ''; }
  }

  function showFab() {
    if (!el.rrPickFab) return;
    var txt = currentSelectionText();
    if (!txt) { hideFab(); return; }
    // ⚠️ 把选区原文存下来 —— 真机上"点浮标"这一步, 系统可能已经把选区清掉了
    //   (手指抬起 → touchend → 选区消失), 到时候再读 getSelection() 就是空,
    //   结果用户点了"问 AI"没反应。存快照才能保证点得到。
    S.pickedText = txt;
    var rect = null;
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (e) { /* noop */ }
    el.rrPickFab.classList.add('on');
    if (rect) {
      var top = Math.max(8, rect.top - 42);
      var left = Math.min(window.innerWidth - 96, Math.max(8, rect.left + rect.width / 2 - 42));
      el.rrPickFab.style.top = top + 'px';
      el.rrPickFab.style.left = left + 'px';
    } else {
      el.rrPickFab.style.top = '120px';
      el.rrPickFab.style.left = '16px';
    }
  }

  function hideFab() {
    if (el.rrPickFab) el.rrPickFab.classList.remove('on');
    // ⚠️ 这里【不】清 S.pickedText —— 点浮标的流程是"先取值再 hideFab",
    //   清早了就把刚选好的句子丢了。快照由 pickSelection / turnPage 各自负责清。
  }

  function pickSelection() {
    // 先拿原文再 hideFab —— hideFab 不清快照, 两者互不影响
    var txt = S.pickedText || currentSelectionText();
    hideFab();
    if (!txt) { toast('先长按选中一句话'); return; }
    S.selected = txt;
    S.pickedText = '';
    renderPicked();
    // 展开聊天窗口 (收着的话先把选中的句子存着, 展开后带过去)
    if (el.rrChat && el.rrChat.classList.contains('collapsed')) toggleChat(false);
    toast('已圈住这句，可以直接问 AI 了');
    if (el.rrChatInput) {
      el.rrChatInput.focus();
      try { el.rrChatInput.setSelectionRange(el.rrChatInput.value.length, el.rrChatInput.value.length); } catch (e) { /* noop */ }
    }
  }

  // ============================================================
  // 聊天窗口
  // ============================================================
  function appendMsg(role, text) {
    if (!el.rrChatBody) return null;
    var d = document.createElement('div');
    d.className = 'rr-msg ' + (role === 'user' ? 'user' : (role === 'sys' ? 'sys' : 'ai'));
    d.textContent = String(text || '');
    el.rrChatBody.appendChild(d);
    el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
    return d;
  }

  function setChatBusy(busy) {
    S.chatBusy = !!busy;
    if (el.rrSendBtn) el.rrSendBtn.disabled = !!busy;
    if (el.rrSendBtn) el.rrSendBtn.textContent = busy ? '…' : '发送';
  }

  function sendChat() {
    if (S.chatBusy) return;
    var text = (el.rrChatInput && el.rrChatInput.value ? el.rrChatInput.value : '').trim();
    if (!text) return;

    var selected = S.selected;
    var pageCtx = {
      bookTitle: S.book ? S.book.title : '',
      chapterTitle: S.chapterTitle,
      pageNo: S.pageNo,
      pageCount: S.pageCount,
      text: S.pageText
    };

    appendMsg('user', text);
    if (el.rrChatInput) el.rrChatInput.value = '';
    S.selected = '';
    S.pickedText = '';
    renderPicked();

    var bubble = appendMsg('ai', '');
    S.lastAiBubble = bubble;
    setChatBusy(true);

    var reqId = 'rc' + (++S.chatSeq) + '_' + Date.now();
    post({
      type: 'reading:chat',
      requestId: reqId,
      text: text,
      selected: selected,
      pageContext: pageCtx
    });
  }

  function onChatDelta(d) {
    if (!S.lastAiBubble) S.lastAiBubble = appendMsg('ai', '');
    S.lastAiBubble.textContent += String(d.delta || '');
    if (el.rrChatBody) el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
  }

  function onChatDone(d) {
    setChatBusy(false);
    var text = String(d.text || '').trim();
    if (S.lastAiBubble) {
      S.lastAiBubble.textContent = text || S.lastAiBubble.textContent;
    } else if (text) {
      appendMsg('ai', text);
    }
    S.lastAiBubble = null;
    if (el.rrChatBody) el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
  }

  function onChatError(d) {
    setChatBusy(false);
    appendMsg('sys', '⚠️ ' + String(d.error || '聊天失败'));
    S.lastAiBubble = null;
  }

  function toggleChat(force) {
    if (!el.rrChat) return;
    var collapsed = el.rrChat.classList.contains('collapsed');
    // ⚠️ 原来写的是 want = collapsed —— 那"点一下收起"会变成"点一下保持收起",
    //   第一次点没反应, 第二次点才收。
    var want = (typeof force === 'boolean') ? force : !collapsed;
    el.rrChat.classList.toggle('collapsed', want);
    if (el.rrChatToggle) {
      el.rrChatToggle.style.transform = want ? 'rotate(180deg)' : '';
    }
  }

  // ---- 分隔条拖动 ----
  function bindSplitter() {
    if (!el.rrSplitter) return;
    var dragging = false;

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      var y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
      var h = window.innerHeight - y;
      var min = 140, max = window.innerHeight * 0.72;
      if (h < min) h = min;
      if (h > max) h = max;
      document.documentElement.style.setProperty('--rr-chat-h', h + 'px');
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchend', onEnd);
    }

    function onStart(e) {
      dragging = true;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    }

    el.rrSplitter.addEventListener('mousedown', onStart);
    el.rrSplitter.addEventListener('touchstart', onStart, { passive: false });
  }

  // ============================================================
  // 导入
  // ============================================================
  function startImport(file) {
    if (!file) return;
    if (el.rrImport) {
      el.rrImport.classList.add('on');
      if (el.rrImportTitle) el.rrImportTitle.textContent = '正在导入《' + file.name + '》';
      if (el.rrImportSub) el.rrImportSub.textContent = '正在读文件…';
      if (el.rrImportBar) el.rrImportBar.style.width = '0%';
    }
    post({ type: 'reading:importFile', file: file, title: file.name });
  }

  function onImportProgress(d) {
    if (!el.rrImport) return;
    var total = Number(d.totalBytes) || 0;
    var read = Number(d.readBytes) || 0;
    if (el.rrImportBar) {
      var pct = total > 0 ? Math.min(100, Math.round(read / total * 100)) : 0;
      el.rrImportBar.style.width = pct + '%';
    }
    if (el.rrImportSub) {
      el.rrImportSub.textContent = '正在切页… ' +
        (total > 0 ? (read / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB' : '') +
        (d.pageNo ? ' · 已切 ' + d.pageNo + ' 页' : '');
    }
  }

  function onImportDone(d) {
    if (el.rrImport) el.rrImport.classList.remove('on');
    toast('《' + (d.title || '') + '》导入了，' + (d.pageCount || 0) + ' 页');
    post({ type: 'reading:needBooks' });
  }

  function onImportError(d) {
    if (el.rrImport) el.rrImport.classList.remove('on');
    toast('导入失败：' + (d.error || '未知错误'), 4000);
  }

  // ============================================================
  // 收宿主消息
  // ============================================================
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (!d || typeof d !== 'object') return;

    switch (d.type) {
      case 'reading:init':
        S.chat = d.chat || null;
        if (d.chat && d.chat.apiConfig) S.hostApiConfig = d.chat.apiConfig;
        if (el.rrBoot) el.rrBoot.classList.add('hide');
        if (el.rrRoot) el.rrRoot.hidden = false;
        break;

      case 'reading:apiConfig':
        S.hostApiConfig = d.apiConfig || null;
        break;

      case 'reading:books':
        S.books = Array.isArray(d.books) ? d.books : [];
        renderHall();
        break;

      case 'reading:page':
        if (d.error) { toast('这一页取不到：' + d.error, 3500); break; }
        S.pageNo = Number(d.pageNo) || 0;
        S.pageText = String(d.text || '');
        S.chapterTitle = String(d.chapterTitle || '');
        S.chapterLine = String(d.chapterLine || '');
        if (d.pageCount) S.pageCount = d.pageCount;
        if (d.bookTitle && el.rrBookTitle) el.rrBookTitle.textContent = d.bookTitle;
        renderPage();
        // 报给宿主 → 主聊天那边的 AI 知道你在读什么
        post({
          type: 'reading:pageState',
          bookId: S.book ? S.book.id : null,
          title: S.book ? S.book.title : '',
          pageNo: S.pageNo,
          pageCount: S.pageCount,
          chapterTitle: S.chapterTitle,
          snippet: S.pageText.substring(0, 600)
        });
        break;

      case 'reading:importProgress':
        onImportProgress(d);
        break;

      case 'reading:importDone':
        onImportDone(d);
        break;

      case 'reading:importError':
        onImportError(d);
        break;

      case 'reading:chatDelta':
        onChatDelta(d);
        break;

      case 'reading:chatDone':
        onChatDone(d);
        break;

      case 'reading:chatError':
        onChatError(d);
        break;

      case 'reading:vv':
        // 宿主转发的真实可视视口 (iOS 键盘) + 状态栏高度
        if (typeof d.height === 'number' && d.height > 0) {
          document.documentElement.style.setProperty('--rr-vv-height', d.height + 'px');
          document.documentElement.style.setProperty('--rr-vv-top', Math.max(0, d.offsetTop || 0) + 'px');
        }
        // ⚠️ 状态栏高度: iframe 里 env(safe-area-inset-top) 量不到 (基本是 0),
        //   宿主是顶层文档, 它量得到真值 → 在这里转成 CSS 变量, 顶栏用它往下让。
        if (typeof d.safeTop === 'number' && d.safeTop >= 0) {
          document.documentElement.style.setProperty('--rr-safe-top', d.safeTop + 'px');
        }
        break;

      default:
        break;
    }
  });

  // ============================================================
  // 退出
  // ============================================================
  function closeRoom() {
    saveProgress();
    post({ type: 'reading:closed' });
  }

  // ============================================================
  // 启动
  // ============================================================
  function bindUi() {
    if (el.rrBack) el.rrBack.addEventListener('click', function () { showView('hall'); });
    if (el.rrHallClose) el.rrHallClose.addEventListener('click', closeRoom);
    if (el.rrPrev) el.rrPrev.addEventListener('click', function () { turnPage(-1); });
    if (el.rrNext) el.rrNext.addEventListener('click', function () { turnPage(1); });
    if (el.rrSearch) el.rrSearch.addEventListener('input', renderHall);

    if (el.rrImportBtn) {
      el.rrImportBtn.addEventListener('click', function () {
        if (el.rrFileInput) el.rrFileInput.click();
      });
    }
    if (el.rrFileInput) {
      el.rrFileInput.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        e.target.value = null;
        if (f) startImport(f);
      });
    }

    if (el.rrSendBtn) el.rrSendBtn.addEventListener('click', sendChat);
    if (el.rrChatInput) {
      el.rrChatInput.addEventListener('input', function () {
        if (el.rrSendBtn) el.rrSendBtn.disabled = !el.rrChatInput.value.trim() && !S.chatBusy;
        // 输入框随内容长高 (最多 4 行)
        el.rrChatInput.style.height = 'auto';
        el.rrChatInput.style.height = Math.min(el.rrChatInput.scrollHeight, 110) + 'px';
      });
      el.rrChatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChat();
        }
      });
    }
    if (el.rrChatToggle) el.rrChatToggle.addEventListener('click', function () { toggleChat(); });

    // 选段
    if (el.rrPickFab) {
      // ⚠️ 真机要点: 手指按下的瞬间就把选区快照抓住, 并把浮标"锁住"。
      //   手指按住 → 系统清选区 → selectionchange → 浮标被藏 → click 不触发,
      //   这一串不堵住的话, 手机上"问 AI"按钮点了没反应。
      var grabOnPress = function () {
        if (!S.pickedText) S.pickedText = currentSelectionText();
        S.fabHolding = true;
        // 兜底: 万一这次没走到 click (手指滑走了), 别把锁永久留着
        setTimeout(function () { S.fabHolding = false; }, 800);
      };
      el.rrPickFab.addEventListener('mousedown', grabOnPress);
      el.rrPickFab.addEventListener('touchstart', grabOnPress, { passive: true });
      el.rrPickFab.addEventListener('click', function (e) {
        // ⚠️ 必须 stopPropagation —— 浮标是 #rr-page-area 的子节点,
        //   不拦的话事件冒泡到"点两侧翻页", 选一句话会顺手翻一页。
        e.stopPropagation();
        S.fabHolding = false;
        pickSelection();
      });
    }
    if (el.rrPageText) {
      var checkSel = function () {
        setTimeout(function () {
          if (currentSelectionText()) showFab();
          else hideFab();
        }, 10);
      };
      el.rrPageText.addEventListener('mouseup', checkSel);
      el.rrPageText.addEventListener('touchend', checkSel);
    }
    document.addEventListener('selectionchange', function () {
      if (S.view !== 'reader') return;
      // ⚠️ 手指正按在浮标上的时候不许藏它 ——
      //   真机上"点浮标"这一步, 系统会先清掉选区 → 选区没了 → 这里把浮标
      //   display:none → 手指抬起来时 click 根本不会触发 → 按钮看起来就是坏的。
      if (S.fabHolding) return;
      if (currentSelectionText()) showFab();
      else hideFab();
    });

    // 点正文左右两侧翻页 (点在正文上不翻 —— 选中文字时才不冲突)
    if (el.rrPageArea) {
      el.rrPageArea.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.rr-page-text')) return;
        // ⚠️ "问 AI"浮标就在 #rr-page-area 里面 —— 点它绝不能翻页。
        //   这里再挡一道 (浮标自己的 click 里也 stopPropagation 了, 双保险)。
        if (e.target && e.target.closest && e.target.closest('.rr-pick-fab')) return;
        if (currentSelectionText()) return;
        var x = e.clientX || 0;
        var w = window.innerWidth;
        if (x > w * 0.72) turnPage(1);
        else if (x < w * 0.28) turnPage(-1);
      });
    }

    bindSplitter();
  }

  function boot() {
    grab();
    bindUi();
    showView('hall');
    if (!IN_IFRAME) {
      // 单独在浏览器里打开这一页 → 本地兜底 (方便开发时调试)
      if (el.rrBoot) el.rrBoot.classList.add('hide');
      if (el.rrRoot) el.rrRoot.hidden = false;
      appendMsg('sys', '这是单独打开的读书屋页面, 连不上 330 宿主, 只能看界面。');
      return;
    }
    post({ type: 'reading:needChat' });
    post({ type: 'reading:ready' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 页面被换掉 / 重载时告诉宿主把 iframe 收掉
  // ⚠️ 不然宿主那边只剩一个盖住整屏的 iframe, 外面点不动 (影院踩过这个坑)
  window.addEventListener('pagehide', function () {
    try { post({ type: 'reading:closed' }); } catch (e) { /* noop */ }
  });

  // 暴露给调试
  window.__readingSandbox = {
    state: S,
    renderHall: renderHall,
    renderPage: renderPage,
    turnPage: turnPage,
    sendChat: sendChat
  };
})();
