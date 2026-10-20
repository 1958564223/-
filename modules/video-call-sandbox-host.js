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

  // ⚠️ 必须带 ?v= —— 沙盒页是 iframe 里的独立 URL, 不带版本号时浏览器可能
  //    直接用本地缓存的旧副本, 改了 video-call-sandbox.html 等于没改。
  //    (sw.js 的 isLocalAsset 白名单里没有它, 所以 SW 不拦, 靠 ?v= 破浏览器缓存)
  var SANDBOX_SRC = 'video-call-sandbox.html?v=0.0.5';
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

    // 恢复宿主这边的准备页状态。
    // ⚠️ 准备页的退出按钮走 Live2DCallPrep.close()，它会写 inline display:none
    //    （它自己的注释就说了 inline display:none 会盖掉 .screen 的 display:flex）。
    //    宿主这边如果还留着 display:none，下次打开准备页是一片空白。
    try {
      var prep = document.getElementById('live2d-call-prep-screen');
      if (prep) prep.style.display = '';
    } catch (e) { /* noop */ }
  }

  // ==========================================================================
  // 3b. 回聊天页
  // --------------------------------------------------------------------------
  // ⚠️ 不能用 window.openChat —— 宿主的 openChat 是 chat-interface.js 里的
  //    内部函数，**从来没挂到 window**（我全项目搜过，只有 in-app-proactive-patrol.js
  //    也在用 typeof window.openChat === 'function' 判断，那边同样是静默失效的）。
  //    宿主暴露出来的是 window.showScreen（init-event-bindingsA.js:922）。
  //
  //    所以这里用 showScreen + 宿主自己的渲染函数组合。
  // ==========================================================================
  async function backToChat(chatId) {
    if (!chatId) return;
    try {
      if (window.state) window.state.activeChatId = chatId;
    } catch (e) { /* noop */ }

    // 刷新聊天页内容
    try {
      if (typeof window.renderChatInterface === 'function') {
        await window.renderChatInterface(chatId);
      } else if (typeof window.renderChatInterfaceProxy === 'function') {
        await window.renderChatInterfaceProxy(chatId);
      }
    } catch (e) {
      console.warn('[通话沙盒] 渲染聊天页失败:', e);
    }

    // 切到聊天页
    try {
      if (typeof window.showScreen === 'function') {
        window.showScreen('chat-interface-screen');
      }
    } catch (e) {
      console.warn('[通话沙盒] 切聊天页失败:', e);
    }
  }

  // ==========================================================================
  // 4. ⚠️ 沙盒写库之后，宿主内存必须补同步
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
          await backToChat(chatId);
          flushPendingSummary(chatId);
        })();
        break;

      case 'vcall:close':
        // 沙盒里的「取消 / 退出」—— 还没通话, 没有任何落库, 直接收工回聊天页。
        // ⚠️ 必须真的摘掉 iframe, 否则一个全屏 iframe 盖在宿主上,
        //    沙盒里又已经全屏空白 → 用户看到的就是"死机"。
        (async function () {
          var chatId = d.chatId || currentChatId;
          closeCallSandbox();
          await backToChat(chatId);
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
  // ⚠️⚠️ 这个按钮曾经「覆盖在每一个页面上」——首页、聊天页、设置页全都盖着。
  //    根因是两个叠在一起:
  //      1. 创建时 cssText 里写死 'display:block' —— 不管准备页在不在都显示;
  //      2. MutationObserver 的回调是
  //             if (screen.classList.contains('active')) injectEntryButton();
  //         只在【准备页变成 active】时才执行 —— 离开准备页时它根本不跑,
  //         按钮就永远留在页面上。而 showScreen 切屏时正是把 .active 从准备页
  //         拿掉 (chat-list.js:81-83), 所以「切到聊天页 = 准备页失去 active
  //         = 按钮该藏却没藏」。
  //
  // ✅ 现在的做法: 把按钮【挂进准备页内部】, 不再挂 document.body。
  //    .screen 靠 opacity:0 + visibility:hidden 隐藏, .screen.active 才 visible
  //    (css/base.css:159-176), Live2DCallPrep.close() 还会写 inline display:none。
  //    → 准备页不可见时, 里面的按钮跟着一起不可见, 结构上就不可能盖到别的页面。
  //    不需要任何 display 开关逻辑, 也就没有「忘了藏」的第二种可能。
  //
  //    按钮仍然是 position:fixed —— 准备页是 1300+px 的可滚动长页, 塞在内容流里
  //    会跑到 y≈1323 的首屏之外, 用户根本看不见。
  // ==========================================================================
  var ENTRY_BTN_ID = 'sandbox-call-entry-btn';
  var entryObserved = false;

  function injectEntryButton() {
    var btn = document.getElementById(ENTRY_BTN_ID);
    if (btn) return true;

    var screen = document.getElementById('live2d-call-prep-screen');
    if (!screen) return false;

    btn = document.createElement('button');
    btn.id = ENTRY_BTN_ID;
    btn.type = 'button';
    btn.textContent = '独立页通话（新）';
    btn.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      // 放在原「视频接通」主按钮上方一点, 不挡主按钮
      'bottom:calc(96px + env(safe-area-inset-bottom, 0px))',
      'z-index:100002',
      'width:calc(100% - 40px)', 'max-width:350px',
      'padding:12px 18px', 'border:1.5px dashed rgba(255,142,179,.9)',
      'border-radius:999px', 'background:rgba(255,255,255,.9)',
      'color:#c4537a', 'font:inherit', 'font-size:14px', 'font-weight:600',
      'box-shadow:0 4px 16px rgba(180,90,130,.22)',
      '-webkit-tap-highlight-color:transparent'
    ].join(';');

    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openCallSandbox();
    });

    // ⚠️ 挂进准备页【内部】, 不是 document.body —— 见上面的大段说明
    screen.appendChild(btn);
    return true;
  }

  function watchPrepScreen() {
    if (entryObserved) return;
    entryObserved = true;

    // 准备页可能还没显示 —— 用 MutationObserver 盯 .active，出现就插一次
    var screen = document.getElementById('live2d-call-prep-screen');
    if (!screen) return;
    injectEntryButton();

    // class / inline style 变了就确保按钮还在 (open/close 会改 style.display)
    try {
      new MutationObserver(function () {
        injectEntryButton();
      }).observe(screen, { attributes: true, attributeFilter: ['class', 'style'] });
    } catch (e) {
      setInterval(function () {
        injectEntryButton();
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
