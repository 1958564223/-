/* ============================================================================
 * video-call-sandbox-host.js
 * ----------------------------------------------------------------------------
 * 视频通话「独立页面」入口（宿主侧）。
 *
 * 背景：
 *   通话久了发烫，实测把其它 screen 从 DOM 摘掉也不能解决 —— 所以改成换宿主：
 *   整个通话搬进一个只有约 150 节点的独立文档（video-call-sandbox.html）跑，
 *   加载的是和生产完全同一份模块文件，video-voice-call.js 一行没改。
 *   家庭影院 cinema-sandbox 用的是同一套思路。
 *
 * 本文件只负责三件事：
 *   1. 建 / 拆 iframe
 *   2. 把 host 单例数据（chat / apiConfig / globalSettings / character /
 *      worldBooks）postMessage 给沙盒
 *   3. 沙盒挂断后：从库同步 chat（⚠️ 关键，见 syncChatAfterSandbox）→ openChat
 *
 * 旧入口完全没动 —— 准备页上仍然是「视频接通」走老路，旁边多一个
 * 「独立页通话」按钮走这条路。测好了再把旧入口删掉、默认切过来。
 * ========================================================================== */
(function () {
  'use strict';

  var SANDBOX_SRC = 'video-call-sandbox.html';
  var FRAME_ID = 'video-call-sandbox-frame';

  var frame = null;
  var currentChatId = null;
  var sandboxReady = false;
  var pendingSummary = [];

  // ==========================================================================
  // 1. 给沙盒的数据快照
  // --------------------------------------------------------------------------
  // postMessage 走结构化克隆，天然深拷贝，沙盒改了不会反噬宿主内存。
  // ⚠️ 但正因为它改了不会反噬，沙盒写的库宿主也读不到 —— 见 syncChatAfterSandbox。
  // ==========================================================================
  function buildPayload(chatId) {
    var s = window.state;
    if (!s) return null;
    var chat = s.chats && s.chats[chatId];
    if (!chat) return null;

    return {
      chat: chat,
      apiConfig: s.apiConfig || {},
      globalSettings: s.globalSettings || {},
      character: s.character || null,
      worldBooks: s.worldBooks || [],
      qzoneSettings: s.qzoneSettings || { nickname: '' },
      messageWindows: s.messageWindows || {}
    };
  }

  function postToSandbox(msg) {
    if (!frame || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage(msg, '*'); } catch (e) { /* noop */ }
  }

  function sendInit() {
    var payload = buildPayload(currentChatId);
    if (!payload) {
      console.warn('[通话沙盒] 拿不到 chat，chatId =', currentChatId);
      return;
    }
    postToSandbox({ type: 'vcall:init', payload: payload });
  }

  // ==========================================================================
  // 2. 建 / 拆 iframe
  // ==========================================================================
  function openCallSandbox(chatId) {
    if (frame) return;                       // 已经开着
    var s = window.state;
    var id = chatId || (s && s.activeChatId);

    if (!id || !s || !s.chats || !s.chats[id]) {
      if (typeof window.showToast === 'function') window.showToast('找不到聊天数据', 'error');
      return;
    }
    currentChatId = id;
    sandboxReady = false;

    frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.src = SANDBOX_SRC;
    // iOS 硬要求：麦克风/摄像头/自动播放的授权必须在 iframe 内有真实用户手势，
    // 所以 allow 一定要带 camera + microphone + autoplay。
    frame.setAttribute('allow', 'camera; microphone; autoplay; encrypted-media; fullscreen');
    frame.setAttribute('allowusermedia', '');          // 老 WebKit 兼容
    frame.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;' +
      'background:#1c1c1e;';

    frame.addEventListener('load', function () {
      // 沙盒 load 后会自己发 needChat；这里也主动发一次，省一个来回
      sendInit();
    });

    document.body.appendChild(frame);

    // 兜底：3 秒还没 ready 就把 init 再推一次（沙盒那边 booted 后会忽略重复）
    setTimeout(function () {
      if (frame && !sandboxReady) sendInit();
    }, 3000);
  }

  function closeCallSandbox() {
    if (!frame) return;
    try { frame.remove(); } catch (e) { /* noop */ }
    frame = null;
    sandboxReady = false;
    currentChatId = null;
  }

  // ==========================================================================
  // 3. ⚠️ 沙盒写库之后，宿主内存必须补同步
  // --------------------------------------------------------------------------
  // 为什么必须做：
  //   沙盒和宿主是同一个 origin、同一个 IndexedDB，但【两份内存里的 chat 对象
  //   是独立的】。沙盒挂断时执行的是生产同一份 endVideoCall：
  //       chat.history.push({ content: '通话结束，时长 X分Y秒' })
  //       await db.chats.put(chat)          ← 写进了库
  //   而宿主内存里 state.chats[id] 还是通话前的旧对象，history 里没有那条。
  //   之后用户随便发一条消息 → 宿主 db.chats.put(chat) → **把库里的通话结束
  //   消息覆盖掉**。界面表现就是"通话记录偶尔消失一条"。
  //
  // 只补尾部不整份替换：
  //   state.chats[id].history 是 message-store.js 的"窗口缓存"（默认 50 条），
  //   直接用库里那份完整历史替换会让内存里突然多出几百条。
  // ==========================================================================
  async function syncChatAfterSandbox(chatId) {
    if (!chatId || !window.db || !window.state) return;
    try {
      var fresh = await window.db.chats.get(chatId);
      if (!fresh) return;

      var cur = window.state.chats[chatId];
      if (!cur) { window.state.chats[chatId] = fresh; return; }

      // --- history：只把库里多出来的尾部接上 ---
      var memHist = Array.isArray(cur.history) ? cur.history : [];
      var dbHist = Array.isArray(fresh.history) ? fresh.history : [];
      if (dbHist.length > memHist.length) {
        var lastMem = memHist.length ? memHist[memHist.length - 1] : null;
        var anchor = -1;
        if (lastMem && lastMem.timestamp) {
          for (var i = dbHist.length - 1; i >= 0; i--) {
            if (dbHist[i] && dbHist[i].timestamp === lastMem.timestamp) { anchor = i; break; }
          }
        }
        if (anchor >= 0 && anchor < dbHist.length - 1) {
          Array.prototype.push.apply(memHist, dbHist.slice(anchor + 1));
        } else if (anchor < 0) {
          // 内存里一条都对不上（可能之前被清过）→ 整份换成库里的
          cur.history = dbHist;
        }
      }

      // --- 其它字段：以库为准（callRecords / lastCallAt / unreadCount …）---
      Object.keys(fresh).forEach(function (k) {
        if (k === 'history') return;
        cur[k] = fresh[k];
      });
    } catch (e) {
      console.warn('[通话沙盒] 同步 chat 失败:', e);
    }
  }

  // ==========================================================================
  // 4. 收沙盒消息
  // ==========================================================================
  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow) return;
    var d = e.data || {};

    switch (d.type) {
      case 'vcall:needChat':
        sendInit();
        break;

      case 'vcall:ready':
        sandboxReady = true;
        console.log('[通话沙盒] 已就绪, chatId =', d.chatId);
        break;

      case 'vcall:openChat':
        // 沙盒挂断 → 同步库里新写的字段 → 摘 iframe → 回聊天页
        (async function () {
          var chatId = d.chatId || currentChatId;
          closeCallSandbox();
          await syncChatAfterSandbox(chatId);
          if (chatId && typeof window.openChat === 'function') {
            try { await window.openChat(chatId); } catch (err) { console.warn('[通话沙盒] openChat 失败:', err); }
          }
          flushPendingSummary(chatId);
        })();
        break;

      case 'vcall:chatUpdated':
        // 落库已发生，内存该刷新（不切屏）
        (async function () {
          await syncChatAfterSandbox(d.chatId || currentChatId);
          if (typeof window.renderChatList === 'function') {
            try { window.renderChatList(); } catch (err) { /* noop */ }
          }
        })();
        break;

      case 'vcall:summarizeCall':
        // 记忆总结留在宿主做（要调 AI + 写记忆库）
        pendingSummary.push({ chatId: d.chatId || currentChatId, transcript: d.transcript || '' });
        if (!frame) flushPendingSummary(d.chatId || currentChatId);
        break;

      case 'vcall:appendMessage':
        (async function () {
          await syncChatAfterSandbox(d.chatId || currentChatId);
          if (typeof window.appendMessage === 'function' && d.message) {
            try {
              var chat = window.state && window.state.chats && window.state.chats[d.chatId || currentChatId];
              if (chat) {
                await window.appendMessage(d.message, chat);
                await window.db.chats.put(chat);
              }
            } catch (err) { console.warn('[通话沙盒] appendMessage 失败:', err); }
          }
        })();
        break;

      case 'vcall:error':
        console.warn('[通话沙盒] 沙盒报错:', d.reason);
        if (typeof window.showToast === 'function') window.showToast('通话页启动失败：' + (d.reason || '未知'), 'error');
        break;

      default:
        break;
    }
  });

  // 记忆总结：等 iframe 关掉后再跑，避免跟挂断落库抢同一帧
  function flushPendingSummary(chatId) {
    if (!pendingSummary.length) return;
    var jobs = pendingSummary.filter(function (x) { return !chatId || x.chatId === chatId; });
    pendingSummary = pendingSummary.filter(function (x) { return chatId && x.chatId !== chatId; });
    jobs.forEach(function (job) {
      if (typeof window.summarizeCallTranscript !== 'function' || !job.transcript.trim()) return;
      Promise.resolve(window.summarizeCallTranscript(job.chatId, job.transcript))
        .catch(function (err) { console.warn('[通话沙盒] 记忆总结失败:', err); });
    });
  }

  // ==========================================================================
  // 5. 在准备页注入「独立页通话」入口
  // --------------------------------------------------------------------------
  // 只往宿主的 #live2d-call-prep-screen 里插，沙盒页里那份不插（避免套娃）。
  // Live2DCallPrep 只 querySelector('[data-role="call"]') 绑事件，不会重建
  // footer，所以往 footer 里追加按钮是安全的。
  // ==========================================================================
  var ENTRY_BTN_ID = 'sandbox-call-entry-btn';
  var entryObserved = false;

  function injectEntryButton() {
    if (document.getElementById(ENTRY_BTN_ID)) return true;
    var screen = document.getElementById('live2d-call-prep-screen');
    if (!screen) return false;
    var footer = screen.querySelector('.live2d-call-prep-footer');
    if (!footer) return false;

    var btn = document.createElement('button');
    btn.id = ENTRY_BTN_ID;
    btn.type = 'button';
    btn.textContent = '独立页通话（新）';
    btn.style.cssText = [
      'display:block', 'width:100%', 'margin:10px auto 0',
      'padding:11px 18px', 'border:1px dashed rgba(255,142,179,.85)',
      'border-radius:999px', 'background:rgba(255,255,255,.72)',
      'color:#c4537a', 'font:inherit', 'font-size:13px',
      '-webkit-tap-highlight-color:transparent'
    ].join(';');

    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openCallSandbox();
    });

    footer.appendChild(btn);
    return true;
  }

  function watchPrepScreen() {
    if (entryObserved) return;
    entryObserved = true;

    // 准备页可能还没显示 —— 用 MutationObserver 盯 .active，出现就插一次
    var screen = document.getElementById('live2d-call-prep-screen');
    if (!screen) return;
    injectEntryButton();

    try {
      new MutationObserver(function () {
        if (screen.classList.contains('active')) injectEntryButton();
      }).observe(screen, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {
      setInterval(function () {
        if (screen.classList.contains('active')) injectEntryButton();
      }, 800);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchPrepScreen);
  } else {
    watchPrepScreen();
  }

  // ==========================================================================
  // 6. 暴露
  // ==========================================================================
  window.openCallSandbox = openCallSandbox;
  window.closeCallSandbox = closeCallSandbox;
  window.syncChatAfterSandbox = syncChatAfterSandbox;
  window.isCallSandboxOpen = function () { return !!frame; };
})();
