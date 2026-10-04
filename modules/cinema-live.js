// ============================================================
// cinema-live.js — Cinema Room 的 Gemini 3.8 Live 桥接层 (v1.0.0)
//
// 【来源与边界】
//   本文件是从 modules/watch-together-live.js (1390 行) 迁移而来。
//   旧文件是「一起看电影」已经跑通并验证过的 Live 链路:
//     ✅ 视频 → canvas → JPEG → 1 FPS → Gemini
//     ✅ 用户边看边打字聊天
//     ✅ 每 ~5 分钟后台更新「当前剧情摘要」(单通道互斥)
//     ✅ 退出时: 总结 → 写 longTermMemory → 确认写库 → 才关 Live
//
//   ⚠️ 本文件【不重新设计协议】。Gemini Live 的协议层仍然是
//      modules/live-client.js, 一个字没改。
//      下面的抽帧 / 摘要 / 退出顺序 / 单通道互斥 / session resumption
//      全部是旧文件里已验证的逻辑原样搬过来。
//
//   本文件只改了三类东西 —— 这正是「Cinema Room 只是换了播放器、DOM、状态、UI」:
//     1. DOM 目标:  #cinema-video / #cinema-chat-messages / #cinema-plot-panel
//     2. 状态归属:  自己的 watchSession + chatId, 不再借 window.watchTogetherState
//     3. 抽帧尺寸:  新增【保持宽高比的 768 长边降采样】(旧版直接吃原始分辨率)
//
// 【人设 / 长期记忆】
//   人设 = chat.settings.aiPersona (跟主聊天同一个字段)
//   记忆 = chat.longTermMemory       (跟主聊天同一个数组, 只读)
//   跟旧观影完全一致, 不新建第二套人格或记忆库。
//   ⚠️ 房间里那两个小人是纯美术素材(设置里上传图片), 跟人设无关。
//
// 【抽帧降采样 — 为什么要改】
//   官方文档: 视频输入 1 FPS, 推荐 768x768 分辨率。
//   旧版直接 canvas.width = videoWidth (1920x1080 全量送), 单帧 base64 体积和
//   token 消耗都远超推荐值 —— 而输入 token 上限是 131,072, 送得越多撞得越快。
//   现在按长边缩到 768 且【严格保持宽高比】:
//     1920x1080 → 768x432      1080x1920 → 432x768
//     1080x1080 → 768x768      640x480   → 640x480 (不放大)
//   绝不把画面拉伸变形。
// ============================================================

(function () {
  'use strict';

  // ---- DOM 目标 (Cinema Room 自己的, 不再指向旧观影) ----
  var VIDEO_ID = 'cinema-video';
  var CHAT_BOX_ID = 'cinema-chat-messages';
  var PLOT_PANEL_ID = 'cinema-plot-panel';
  var STATUS_ID = 'cinema-live-status';

  // 1 FPS —— 官方建议上限, 旧文件已验证
  var FRAME_INTERVAL_MS = 1000;
  var JPEG_QUALITY = 0.6;

  // 🔴 新增: 抽帧降采样长边上限 (官方推荐 768)
  var FRAME_MAX_DIM = 768;

  // ---- 阶段剧情摘要 (与旧文件一致) ----
  var WATCH_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
  var PLOT_SUMMARY_MAX_CHARS = 1500;
  var FINAL_MEMORY_TARGET_CHARS = 1000;
  var SUMMARY_REQUEST_TIMEOUT_MS = 45000;

  // 恢复 handle 单独存一个 key —— 不跟旧观影的 wt_ 那个互相覆盖
  var HANDLE_KEY = 'cinema_gemini_live_resume_handle';
  var MAX_RETRY = 5;
  var RETRY_BASE_MS = 2000;

  var _retryCount = 0;
  var _retryTimer = null;
  var _autoTried = false;
  // 上一轮是不是抖动(连上就断) —— ready 时据此决定要不要清退避
  var flapLast = false;

  // ============================================================
  // 观影 session 状态 (只在内存, 绝不落长期记忆)
  // ============================================================
  var watchSession = {
    watchSessionId: null,
    chatId: null,
    currentPlotSummary: '',
    summaryUpdatedAt: 0,
    summaryCount: 0,
    pendingSummary: null,
    summaryBusy: false,
    summaryTimer: null,
    queuedUserText: null,
    finalSummaryRequested: false,
    finalSummarySaved: false,
    finalSummaryText: '',
    chatLog: [],
    closed: false,
    leavePromise: null
  };

  function newWatchSession(chatId) {
    watchSession.watchSessionId = 'cr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    watchSession.chatId = chatId || null;
    watchSession.currentPlotSummary = '';
    watchSession.summaryUpdatedAt = 0;
    watchSession.summaryCount = 0;
    watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    watchSession.finalSummaryRequested = false;
    watchSession.finalSummarySaved = false;
    watchSession.finalSummaryText = '';
    watchSession.chatLog = [];
    watchSession.closed = false;
    watchSession.leavePromise = null;
    log('新的 Cinema watch session:', watchSession.watchSessionId);
    return watchSession.watchSessionId;
  }

  // ============================================================
  // 系统提示词 (迁移自 watch-together-live.js:88-161)
  // 人设/记忆来源字段与旧文件完全一致, 只改了措辞里的房间名。
  // ============================================================
  function buildSystemPrompt(chat) {
    var c = chat || {};
    var persona = (c.settings && c.settings.aiPersona) || '';
    var userPersona = (c.settings && c.settings.myPersona) || '';
    var myNickname = (c.settings && c.settings.myNickname) || '我';
    var charName = c.name || c.originalName || '角色';

    var memoryText = '';
    var mem = c.longTermMemory;
    if (Array.isArray(mem) && mem.length > 0) {
      var lines = [];
      for (var i = mem.length - 1; i >= 0; i--) {
        if (mem[i] && mem[i].content) lines.push('- ' + mem[i].content);
      }
      if (lines.length > 0) memoryText = lines.join('\n');
    }

    var out = [];

    out.push('# 你是谁');
    out.push('');
    out.push('你就是 330 里的「' + charName + '」。');
    out.push('用户是「' + myNickname + '」。');
    out.push('');
    if (persona) {
      out.push('## 你的角色设定');
      out.push('');
      out.push(persona);
      out.push('');
    }
    if (userPersona) {
      out.push('## 用户的角色');
      out.push('');
      out.push(userPersona);
      out.push('');
    }
    if (memoryText) {
      out.push('# 你和用户之间已经确立的记忆');
      out.push('');
      out.push('这些是你和用户之间真实发生过的事, 必须当作事实:');
      out.push('');
      out.push(memoryText);
      out.push('');
    }

    out.push('# 你现在的状态');
    out.push('');
    out.push('你正在 Cinema Room 里和用户一起看视频。');
    out.push('');
    out.push('- 你会持续收到视频画面帧（大约每秒一张 JPEG 图片），按时间顺序到达。');
    out.push('- 视频画面就是你的实时视觉输入，你能真的"看到"当前内容。');
    out.push('- 用户在房间聊天框里说的话是你的实时对话输入。');
    out.push('');
    out.push('## 怎么陪用户看');
    out.push('');
    out.push('1. 像真人一样自然地聊天、评论、吐槽、讨论，不要像在做视频分析报告。');
    out.push('2. 用户问你"现在在演什么""这个人是谁""刚才是怎么了"，就用你实际看到的画面回答。');
    out.push('3. 不要逐帧罗列画面，不要用"根据我的观察""作为一个 AI"这种说法。');
    out.push('4. 没看清就直说没看清，绝对不要编造你没收到的画面。');
    out.push('5. 保持你自己的说话方式和人设，不要变成一个中立助手。');
    out.push('6. 用中文，简洁自然。');
    out.push('');
    out.push('## 后台维护指令（重要）');
    out.push('');
    out.push('系统会偶尔给你发一条【【后台任务】】开头的消息，要求你更新一份"当前剧情摘要"。');
    out.push('遇到这类消息时：');
    out.push('- 严格按照要求输出一份简洁的剧情摘要，不要和你平时说话的语气混在一起。');
    out.push('- 不要加称呼、不要问问题、不要加评论和感受。');
    out.push('- 只输出摘要正文本身。');
    out.push('这是正常的维护行为，用户那边不会看到你这次回复。');

    return out.join('\n');
  }

  // ============================================================
  // 运行时状态
  // ============================================================
  var S = {
    enabled: false,
    client: null,
    frameTimer: null,
    canvas: null,
    ctx: null,
    framesSent: 0,
    paused: false,
    statusEl: null,
    bubbleEl: null,
    chatId: null,          // Cinema Room 自己的会话 chatId (不借旧观影的全局)
    autoMode: true,
    _userDisabled: false,
    _leaving: false
  };

  // ============================================================
  // 工具
  // ============================================================
  function log(msg, extra) {
    var line = '[Cinema-Live] ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) { /* noop */ }
    }
    console.log(line);
  }
  function logWarn(msg, extra) { console.warn('[Cinema-Live] ' + msg, extra === undefined ? '' : extra); }
  function logError(msg, extra) { console.error('[Cinema-Live] ' + msg, extra === undefined ? '' : extra); }

  function getVideo() { return document.getElementById(VIDEO_ID); }
  function getChatBox() { return document.getElementById(CHAT_BOX_ID); }

  function getCurrentChat() {
    try {
      if (typeof state !== 'undefined' && state && state.chats && S.chatId) {
        return state.chats[S.chatId] || null;
      }
    } catch (e) { /* noop */ }
    return null;
  }

  /**
   * Gemini Live API Key。
   * 存储位置与旧观影【完全相同】(chat.watchTogetherSettings.geminiApiKey),
   * 不新建第二份 key 存储 —— 这样旧设置里填过的直接能用。
   * Cinema Room 自己的设置 UI 也写回这个字段。
   */
  function getGeminiKey() {
    try {
      var chat = getCurrentChat();
      if (chat && chat.watchTogetherSettings) {
        return String(chat.watchTogetherSettings.geminiApiKey || '').trim();
      }
    } catch (e) { /* noop */ }
    return '';
  }

  function setGeminiKey(key) {
    var chat = getCurrentChat();
    if (!chat) return Promise.resolve(false);
    if (!chat.watchTogetherSettings) chat.watchTogetherSettings = {};
    chat.watchTogetherSettings.geminiApiKey = String(key || '').trim();
    return db.chats.put(chat).then(function () { return true; });
  }

  // ============================================================
  // 状态指示器 (挂在房间里, 不是 body 上的 fixed 条)
  // ============================================================
  var STATE_TEXT = {
    connecting: '🟡 连接中…',
    connected: '🟡 已连接, 初始化…',
    ready: '🟢 已连接',
    closed: '⚪ 已断开',
    error: '🔴 连接失败',
    idle: '⚪ 未启动'
  };

  function ensureStatusEl() {
    if (S.statusEl && S.statusEl.parentNode) return S.statusEl;
    var el = document.createElement('div');
    el.id = STATUS_ID;
    el.className = 'cinema-live-status';
    // ⚠️ 挂进顶栏标题行【右侧的占位容器】, 而不是 append 到 .cinema-room 上当 absolute 浮层。
    //   2026-10-04 用户反馈"绿色已连接放到视频框里了" —— 就是因为它 absolute
    //   挂在房间根上, top 算的是顶栏高度, 正好压在视频画面上。
    //   放进 flex 行里就没有这个问题: 它只占标题行的位置, 视频在它下面。
    //   样式全部走 CSS (.cinema-live-status), 这里不再写内联 —— 改样式只改一个地方。
    var host = document.getElementById('cinema-topbar-status');
    if (host) {
      host.appendChild(el);
    } else {
      // 房间 DOM 还没建 (理论上不会, open() 里才 enable) —— 兜底别让状态条消失
      el.style.position = 'absolute';
      el.style.left = '50%';
      el.style.top = 'calc(env(safe-area-inset-top, 0px) + var(--cinema-topbar-h, 58px) + 6px)';
      el.style.transform = 'translateX(-50%)';
      el.style.zIndex = '5';
      var room = document.getElementById('cinema-room');
      (room || document.body).appendChild(el);
    }
    S.statusEl = el;
    return el;
  }

  function renderStatus(state, detail) {
    var el = ensureStatusEl();
    var base = STATE_TEXT[state] || state;
    if (state === 'ready') {
      if (watchSession.summaryBusy) base = '⏳ 正在整理剧情…';
      else if (watchSession.finalSummaryRequested) base = '⏳ 正在整理观影记忆…';
      else base = S.paused ? '🟢 已连接 · 视频暂停' : '🟢 已连接 · 正在看';
    }
    // ⚠️ closed 也要显示 detail —— live-client.js:206 会把 WebSocket 关闭 code
    //   塞进 detail ('已断开 (code 1006)')。原来只在 error 时显示, 等于把
    //   断线原因直接丢了, 线上只能看到一句"已断开"没法排查 (2026-10-04 踩坑)。
    var showDetail = detail && (state === 'error' || state === 'closed');
    el.textContent = base + (showDetail ? '（' + detail + '）' : '');
    el.style.display = 'block';
  }

  function hideStatus() {
    if (S.statusEl) S.statusEl.style.display = 'none';
  }

  // ============================================================
  // 抽帧 —— 迁移自旧文件 :281-320, 新增等比降采样
  // ============================================================

  /**
   * 计算降采样后的画布尺寸。
   * 长边缩到 FRAME_MAX_DIM (768), 宽高比严格保持, 绝不拉伸。
   *   1920x1080 → 768x432        1080x1920 → 432x768
   *   1280x720  → 768x432        640x480   → 640x480 (小于 768 就不放大)
   */
  function computeFrameSize(vw, vh) {
    if (!vw || !vh) return { w: FRAME_MAX_DIM, h: FRAME_MAX_DIM };
    var scale = Math.min(1, FRAME_MAX_DIM / Math.max(vw, vh));
    return {
      w: Math.max(2, Math.round(vw * scale)),
      h: Math.max(2, Math.round(vh * scale))
    };
  }

  function ensureCanvas(video) {
    var size = computeFrameSize(video.videoWidth, video.videoHeight);
    if (!S.canvas) S.canvas = document.createElement('canvas');
    if (S.canvas.width !== size.w || S.canvas.height !== size.h) {
      S.canvas.width = size.w;
      S.canvas.height = size.h;
    }
    if (!S.ctx || S.ctx.canvas !== S.canvas) {
      S.ctx = S.canvas.getContext('2d');
    }
    return { ctx: S.ctx, w: size.w, h: size.h };
  }

  /**
   * 抽一帧 → 纯 base64 (不带 data: 前缀)。
   * 返回 null 表示这一帧抽不到 (暂停/未就绪/跨域)。
   */
  function grabFrameBase64(video) {
    if (!video || video.paused || video.ended) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    var box;
    try {
      box = ensureCanvas(video);
      // 等比绘制到降采样后的画布中心, 上下/左右留黑边(保持原比例, 不裁不拉伸)
      var sx = video.videoWidth, sy = video.videoHeight;
      var dw = box.w, dh = box.h;
      var scale = Math.min(dw / sx, dh / sy);
      var rw = sx * scale, rh = sy * scale;
      var ox = (dw - rw) / 2, oy = (dh - rh) / 2;
      box.ctx.fillStyle = '#000';
      box.ctx.fillRect(0, 0, dw, dh);
      box.ctx.drawImage(video, ox, oy, rw, rh);
    } catch (e) {
      log('drawImage 失败 (可能是跨域污染 canvas):', e.name + ' ' + e.message);
      return null;
    }

    var dataUrl;
    try {
      dataUrl = S.canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch (e2) {
      log('toDataURL 失败:', e2.name + ' ' + e2.message);
      return null;
    }
    if (!dataUrl || dataUrl.indexOf('base64,') === -1) return null;
    var base64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
    return base64 || null;
  }

  function startFrameLoop() {
    stopFrameLoop();
    S.frameTimer = setInterval(function () {
      if (!S.client || !S.client.isReady()) return;
      var video = getVideo();
      if (!video) return;
      if (video.paused || video.ended) {
        S.paused = true;
        renderStatus('ready');
        return;
      }
      if (S.paused) { S.paused = false; renderStatus('ready'); log('视频恢复播放, 继续发帧'); }
      var b64 = grabFrameBase64(video);
      if (!b64) return;
      S.framesSent++;
      S.client.sendVideoFrame(b64, 'image/jpeg');
      // 每 30 帧打一次, 免得刷屏
      if (S.framesSent % 30 === 0) {
        log('已发 ' + S.framesSent + ' 帧 (当前 ' + Math.round(b64.length * 0.75 / 1024) + 'KB/帧, t=' +
          video.currentTime.toFixed(1) + 's)');
      }
    }, FRAME_INTERVAL_MS);
    log('开始 1 FPS 视频帧发送 (长边降采样到 ' + FRAME_MAX_DIM + ', 保持宽高比)');
  }

  function stopFrameLoop() {
    if (S.frameTimer) {
      clearInterval(S.frameTimer);
      S.frameTimer = null;
      log('已停止视频帧发送');
    }
  }

  // ============================================================
  // 聊天 (Cinema Room 自己的容器)
  // ============================================================
  function appendSystemLine(text) {
    var box = getChatBox();
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'cinema-chat-sys';
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function appendUserBubble(text) {
    var box = getChatBox();
    if (!box) return;
    // ⚠️ 结构必须跟 renderGeminiBubble 一样: 外层 msg 套内层 bubble。
    //    原来这里是 `div.textContent = text` —— 文本直接塞在外层容器里,
    //    CSS 的 `.cinema-chat-msg.user > :last-child` 匹配到的是【文本节点】,
    //    文本节点没有背景, 所以用户消息完全没有气泡 (2026-10-04 用户反馈
    //    "AI 有气泡包裹, 用户没有")。要改一样的就改这里。
    var wrap = document.createElement('div');
    wrap.className = 'cinema-chat-msg user';
    var bubble = document.createElement('div');
    bubble.className = 'cinema-chat-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function getAvatarUrl() {
    try {
      var chat = getCurrentChat();
      if (chat && chat.settings && chat.settings.aiAvatar) return chat.settings.aiAvatar;
    } catch (e) { /* noop */ }
    return '';
  }

  /** 把 Gemini 的文字渲染成一个 assistant 气泡 (跨 turn 累加成整句) */
  function renderGeminiBubble(text) {
    var box = getChatBox();
    if (!box) { log('找不到聊天容器, Gemini 文字:', text); return; }
    // 🔴 原来写的是 `S.bubbleEl.parentNode === box`。
    //    但 S.bubbleEl 存的是【内层】的 .cinema-chat-bubble, 它的 parentNode
    //    是外层 .cinema-chat-msg, 永远不等于 box —— 于是每段流式文字都被判成
    //    "新气泡", 一句话被拆成三五个字一行 (2026-10-04 用户反馈)。
    //    正确判断: 只要这个节点还在消息容器里, 就是同一个气泡, 继续更新它。
    if (S.bubbleEl && box.contains(S.bubbleEl)) {
      S.bubbleEl.textContent = text;
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'cinema-chat-msg assistant';
      var avatar = getAvatarUrl();
      if (avatar) {
        var img = document.createElement('img');
        img.className = 'cinema-chat-avatar';
        img.src = avatar;
        img.alt = '';
        wrap.appendChild(img);
      }
      var content = document.createElement('div');
      content.className = 'cinema-chat-bubble';
      content.textContent = text;
      wrap.appendChild(content);
      box.appendChild(wrap);
      S.bubbleEl = content;
    }
    box.scrollTop = box.scrollHeight;
  }

  function resetBubble() { S.bubbleEl = null; }

  // ============================================================
  // 剧情记忆面板 (Cinema Room 自己的, 可查看 + 可编辑)
  // ⚠️ 只显示当前 session 的临时记忆, 绝不写 chat.longTermMemory
  // ============================================================
  var plotPanelEl = null;
  var plotPanelOpen = false;
  var plotEditing = false;
  var plotDraft = '';

  function plotPanelVisible() {
    // 2026-10-04: 改成【常驻】。
    // 原来只在 Live 连上 / 有摘要时才出现, 于是用户看到的是"什么都没有",
    // 而且只能靠那个已经被删掉的「剧情」按钮去打开 —— 两头都断了。
    // 现在: 只要聊天面板开着, 顶上永远有这一行折叠条 (收起时只占一行高)。
    return true;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toTimeString().slice(0, 5); } catch (e) { return '—'; }
  }

  function ensurePlotPanel() {
    if (plotPanelEl && plotPanelEl.parentNode) return plotPanelEl;
    var el = document.createElement('div');
    el.id = PLOT_PANEL_ID;
    el.className = 'cinema-plot-panel';
    plotPanelEl = el;
    // ⚠️ 必须挂进聊天面板【内部】, 不能绝对定位挂在房间底部 ——
    //    2026-10-04 用户反馈: 绝对定位那版正好压住聊天输入框, 什么都点不了。
    //    改成消息列表上方的可展开区域, 收起时只有一行标题, 不占地方也不挡任何东西。
    var host = document.getElementById('cinema-chat-panel');
    if (host) {
      var head = host.querySelector('.cinema-chat-head');
      if (head && head.nextSibling) host.insertBefore(el, head.nextSibling);
      else host.insertBefore(el, host.firstChild);
    } else {
      var room = document.getElementById('cinema-room');
      (room || document.body).appendChild(el);
    }
    return el;
  }

  function renderPlotPanel() {
    var el = ensurePlotPanel();
    if (!plotPanelVisible()) { el.classList.remove('open'); el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = buildPlotPanelHtml();
    plotPanelEl = el;
  }

  function buildPlotPanelHtml() {
    var head = 'Gemini 剧情记忆';
    if (!plotPanelOpen) {
      var dot = watchSession.summaryBusy ? '🟡' : (watchSession.currentPlotSummary ? '🟢' : '⚪');
      var savedTag = watchSession.finalSummarySaved ? ' · 记忆已存' : '';
      return '<div class="cinema-plot-head">' + dot + ' ' + esc(head) +
        '<span class="cinema-plot-meta">' + watchSession.summaryCount + ' 次' + esc(savedTag) + ' ▸</div>';
    }

    var busyHtml = watchSession.summaryBusy
      ? '<div class="cinema-plot-busy">⏳ 正在整理剧情，请稍等一下…</div>' : '';

    // 剧情摘要正文: 折叠时只读; 展开且点编辑时给 textarea
    var summaryBody;
    if (plotEditing) {
      summaryBody =
        '<textarea class="cinema-plot-edit" id="cinema-plot-edit">' +
        esc(plotDraft) + '</textarea>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="save">保存</button>' +
        '<button class="cinema-plot-btn ghost" data-plot="cancel">取消</button>' +
        '</div>' +
        '<div class="cinema-plot-hint">编辑只改本次观影的临时摘要，不影响长期记忆。</div>';
    } else if (watchSession.currentPlotSummary) {
      summaryBody =
        '<div class="cinema-plot-text">' + esc(watchSession.currentPlotSummary) + '</div>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="edit">编辑</button>' +
        '</div>';
    } else {
      summaryBody = '<div class="cinema-plot-text dim">（还没有剧情摘要，约 5 分钟后生成第一份）</div>';
    }

    var finalHtml = watchSession.finalSummaryText
      ? '<div class="cinema-plot-text">' + esc(watchSession.finalSummaryText) + '</div>'
      : '<div class="cinema-plot-text dim">（观影结束后生成）</div>';

    return '<div class="cinema-plot-head">' + esc(head) +
        '<span class="cinema-plot-meta">收起 ▾</span></div>' +
      '<div class="cinema-plot-body" data-noscroll="1">' +
      '<div class="cinema-plot-label">当前剧情摘要</div>' +
      summaryBody +
      busyHtml +
      '<div class="cinema-plot-stat">更新 ' + fmtTime(watchSession.summaryUpdatedAt) +
        ' · 次数 ' + watchSession.summaryCount + '</div>' +
      '<div class="cinema-plot-label">最终观影记忆</div>' +
      finalHtml +
      '</div>';
  }

  function togglePlotPanel() {
    plotPanelOpen = !plotPanelOpen;
    plotEditing = false;
    plotDraft = watchSession.currentPlotSummary || '';
    renderPlotPanel();
  }

  function startEditSummary() {
    plotDraft = watchSession.currentPlotSummary || '';
    plotEditing = true;
    renderPlotPanel();
  }

  function saveEditedSummary() {
    var ta = document.getElementById('cinema-plot-edit');
    var val = ta ? ta.value : plotDraft;
    watchSession.currentPlotSummary = String(val || '').trim();
    if (watchSession.summaryUpdatedAt === 0) watchSession.summaryUpdatedAt = Date.now();
    plotEditing = false;
    log('用户手动编辑了本次剧情摘要');
    renderPlotPanel();
  }

  // 面板点击 (事件委托, 避免重复绑定)
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var panel = t.closest('#' + PLOT_PANEL_ID);
    if (!panel) return;
    var act = t.getAttribute && t.getAttribute('data-plot');
    if (act === 'edit') { startEditSummary(); return; }
    if (act === 'save') { saveEditedSummary(); return; }
    if (act === 'cancel') { plotEditing = false; renderPlotPanel(); return; }
    if (t.closest('[data-noscroll]')) return;
    togglePlotPanel();
  }, true);

  // ============================================================
  /**
   * outputTranscription.text 是【到目前为止的累计全文】, 不是增量。
   *
   * ⚠️ 但"累计"的边界会随回合漂移, 所以实际收到过四种形态 (2026-10-04 连续踩了两次):
   *
   *   ① 完全重复          "点吃的呢。" → "点吃的呢。"      → 丢弃
   *   ② 标准累计          "找点吃" → "找点吃的呢。"          → 取新增 "的呢。"
   *   ③ 服务端重开一轮    上一回合尾巴被重发 (下面 ④)
   *   ④ 【尾巴重叠】      "…找点吃的呢。" + "点吃的呢。"     → 必须切掉重复的 5 个字
   *
   * ④ 才是"末几个字重复"的真凶。视频帧会推进回合 (TURN_COVERAGE=ALL_VIDEO),
   * 新回合的转写有时不是从零开始, 而是把上一回合最后几个字再吐一遍。
   * 只判 ①② 的话 ④ 会掉进"当新文本"分支, 直接拼上去 —— 用户看到的就是
   * "赶紧跳进去救人。救人。" / "…一懵一懵的。一愣一愣的。"
   *
   * 做法: 找出 prev 的尾巴和 text 的头最长重叠几个字, 从 text 里切掉。
   * 单字重叠不算 (句号/逗号撞一下太常见, 会误吞正常语气词), 除非整段都是重复。
   */
  function takeDelta(prev, text) {
    if (!text) return '';
    if (!prev) return text;
    if (text === prev) return '';                                   // ①
    if (text.indexOf(prev) === 0) return text.slice(prev.length);    // ②
    var max = Math.min(prev.length, text.length);
    for (var n = max; n > 0; n--) {
      if (n < 2 && n !== text.length) continue;   // 单字重叠: 只在"整段重复"时才认
      if (prev.slice(prev.length - n) === text.slice(0, n)) return text.slice(n);
    }
    return text;                                                    // 真的是新内容
  }

  // 模型文字统一入口 —— 「摘要不进气泡」的唯一保证点
  // 迁移自旧文件 :551-565
  // ============================================================
  var bubbleText = '';   // 当前 assistant 气泡的完整文本, 用户发新消息才清零

  function handleModelText(text, isFinal) {
    if (!text) return;
    if (watchSession.pendingSummary) {
      var p = watchSession.pendingSummary;
      p.buffer += takeDelta(p.lastText, text);   // 摘要同样要去重, 否则整段是重复堆的
      p.lastText = text;
      return;   // ⬅ 关键: 摘要文字绝不进聊天气泡
    }
    // 正常陪聊: 跨多个 turn 累加成【一整句】, 始终只占一个气泡
    bubbleText += takeDelta(bubbleText, text);
    if (bubbleText) renderGeminiBubble(bubbleText);
  }

  function recordChat(role, text) {
    if (!text) return;
    watchSession.chatLog.push({ role: role, text: String(text).slice(0, 500) });
    if (watchSession.chatLog.length > 60) watchSession.chatLog.shift();
  }

  // ============================================================
  // 摘要请求 —— 单通道, 绝不能与用户消息并发
  // 迁移自旧文件 :579-640
  // ============================================================
  function requestSummary(kind, instruction) {
    if (watchSession.pendingSummary) return Promise.reject(new Error('已有摘要请求在进行中'));
    if (!S.client || !S.client.isReady()) return Promise.reject(new Error('Live 未就绪'));

    var p = { kind: kind, buffer: '', resolve: null, timer: null };
    var promise = new Promise(function (resolve) { p.resolve = resolve; });

    watchSession.pendingSummary = p;
    watchSession.summaryBusy = true;
    renderStatus('ready');
    renderPlotPanel();

    p.timer = setTimeout(function () {
      if (watchSession.pendingSummary !== p) return;
      watchSession.pendingSummary = null;
      watchSession.summaryBusy = false;
      logWarn('[摘要] ' + kind + ' 请求超时 (' + SUMMARY_REQUEST_TIMEOUT_MS + 'ms)');
      renderStatus('ready');
      renderPlotPanel();
      p.resolve('');
    }, SUMMARY_REQUEST_TIMEOUT_MS);

    log('[摘要] 发起 ' + kind + ' 请求');
    var ok = S.client.sendUserText(instruction);
    if (!ok) {
      clearTimeout(p.timer);
      watchSession.pendingSummary = null;
      watchSession.summaryBusy = false;
      renderStatus('ready');
      return Promise.reject(new Error('发送失败 (Live 未就绪)'));
    }
    return promise;
  }

  function finishSummary(p) {
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    if (watchSession.pendingSummary === p) watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    renderStatus('ready');
    renderPlotPanel();
  }

  function flushQueuedUserText() {
    if (watchSession.queuedUserText) {
      var q = watchSession.queuedUserText;
      watchSession.queuedUserText = null;
      log('摘要完成, 补发排队的用户消息');
      doSendUserText(q);
    }
  }

  // ============================================================
  // 阶段剧情摘要 (每 ~5 分钟)
  // 迁移自旧文件 :646-716
  // ============================================================
  function buildStageSummaryInstruction() {
    var prev = watchSession.currentPlotSummary;
    var lines = [];
    lines.push('【【后台任务】】请更新"当前剧情摘要"。');
    lines.push('');
    if (prev) {
      lines.push('这是你上一版记录的当前剧情摘要:');
      lines.push('');
      lines.push(prev);
      lines.push('');
      lines.push('请根据你最近看到的新剧情, 更新这份摘要。要求:');
    } else {
      lines.push('这是你第一次记录这份剧情摘要。请根据到目前为止看到的内容, 写一份"目前剧情发展到了什么程度"的摘要。');
      lines.push('');
      lines.push('要求:');
    }
    lines.push('');
    lines.push('1. 只保留目前对理解整部影片最重要的剧情信息。');
    lines.push('2. 保持剧情连续性, 写清楚"看到这里, 剧情发展到了什么程度"。');
    lines.push('3. 删掉已经不重要的细节, 不要越积越长。');
    lines.push('4. 如果之前的判断被后面的剧情证明不对, 直接修正, 不要保留错误说法。');
    lines.push('5. 不记录每个镜头、不记录逐帧画面、不记录技术信息。');
    lines.push('6. 不要把猜测写成事实。');
    lines.push('7. 简洁, 中文, 控制在 ' + PLOT_SUMMARY_MAX_CHARS + ' 字以内。');
    lines.push('');
    lines.push('直接输出摘要正文, 不要加称呼、不要提问、不要加评论或感受。');
    return lines.join('\n');
  }

  function tickStageSummary() {
    // ⚠️⚠️ 每一条提前 return 的分支都必须重新排下一次定时器!
    //
    // 2026-10-04 用户实测: 视频断续放了十几分钟, 一份剧情摘要都没有, 退出也没写记忆。
    // 根因就是这里原来直接 `return` 而不重新排期 —— 只要有一次 tick 撞上
    // "视频暂停 / Live 没 ready / 正在总结", 定时器就彻底断了,
    // 之后哪怕一直正常播放也永远不会再生成摘要 (退出时的最终总结也被拖死)。
    //
    // 正确写法: 统一在 finally 里 scheduleStageSummary(), 保证链子不断。
    try {
      if (!S.enabled || watchSession.summaryBusy) return;
      if (watchSession.finalSummaryRequested) return;    // 要退出了, 不必再排
      var video = getVideo();
      if (!video || video.paused || video.ended) return; // 暂停中, finally 会重排
      if (!S.client || !S.client.isReady()) return;      // 还没 ready, finally 会重排

      requestSummary('stage', buildStageSummaryInstruction())
        .then(function (text) {
          if (text && text.trim()) {
            watchSession.currentPlotSummary = text.trim();
            watchSession.summaryUpdatedAt = Date.now();
            watchSession.summaryCount++;
            log('✅ 阶段剧情摘要已更新 (' + watchSession.summaryCount + ' 次)');
          } else {
            logWarn('阶段摘要返回空, 保留上一版');
          }
        })
        .catch(function (err) { logWarn('阶段摘要失败:', err.message); })
        .then(function () {
          finishSummary(watchSession.pendingSummary);
          flushQueuedUserText();
        });
    } catch (e) {
      logWarn('阶段摘要调度异常:', (e && e.message) || e);
    } finally {
      // 退房/禁用/要生成最终总结时不要再排 —— 那三种情况定时器本来就该停
      if (S.enabled && !watchSession.finalSummaryRequested && !S._leaving) {
        scheduleStageSummary();
      }
    }
  }

  function scheduleStageSummary() {
    if (watchSession.summaryTimer) clearTimeout(watchSession.summaryTimer);
    watchSession.summaryTimer = setTimeout(tickStageSummary, WATCH_SUMMARY_INTERVAL_MS);
  }

  function stopStageSummary() {
    if (watchSession.summaryTimer) {
      clearTimeout(watchSession.summaryTimer);
      watchSession.summaryTimer = null;
    }
  }

  // ============================================================
  // 最终观影记忆
  // 迁移自旧文件 :722-785
  // ============================================================
  function buildFinalSummaryInstruction() {
    var lines = [];
    lines.push('【【后台任务】】这次观影要结束了, 请生成【最终观影记忆】。');
    lines.push('');
    lines.push('# 你在这次观影中积累的当前剧情摘要');
    lines.push('');
    lines.push(watchSession.currentPlotSummary || '(这次没有留下剧情摘要)');
    lines.push('');

    var chatLines = [];
    for (var i = 0; i < watchSession.chatLog.length; i++) {
      var m = watchSession.chatLog[i];
      chatLines.push((m.role === 'user' ? '用户' : '你') + '：' + m.text);
    }
    if (chatLines.length) {
      lines.push('# 这次观影中你们的聊天');
      lines.push('');
      lines.push(chatLines.join('\n'));
      lines.push('');
    }

    lines.push('# 写一份【观影记忆】');
    lines.push('');
    lines.push('目标: 这段记忆以后会被存进你们的长期记忆里, 让你下次和用户聊天时,');
    lines.push('知道自己和用户一起看过什么、看到哪里、聊过什么、用户当时什么反应。');
    lines.push('');
    lines.push('必须包含:');
    lines.push('- 一起看了什么');
    lines.push('- 核心剧情发展');
    lines.push('- 重要人物或事件');
    lines.push('- 用户明显表达过的喜好、观点、吐槽');
    lines.push('- 用户特别在意的剧情');
    lines.push('- 你们讨论过的重要内容');
    lines.push('- 这次形成的共同话题或梗');
    lines.push('');
    lines.push('必须删除:');
    lines.push('- 逐帧画面、每个镜头的时间点');
    lines.push('- 没有长期价值的普通闲聊和寒暄');
    lines.push('- 重复的描述');
    lines.push('- 技术信息');
    lines.push('- 你自己的猜测');
    lines.push('');
    lines.push('写成一段自然的中文回忆, 像你真的记得这件事一样, 第一人称。');
    lines.push('开头写【观影记忆】。');
    lines.push('控制在 ' + FINAL_MEMORY_TARGET_CHARS + ' 字以内, 不要为了凑字数写废话。');
    return lines.join('\n');
  }

  /**
   * 写进 330 唯一的长期记忆库。
   * 写入范式与旧文件 / memory-summary.js / werewolf.js 完全一致:
   *   { content, timestamp, source } + await db.chats.put(chat)
   */
  function saveToLongTermMemory(chat, content) {
    var entry = {
      content: content,
      timestamp: Date.now(),
      source: 'cinema_watch_summary'
    };
    if (!chat.longTermMemory) chat.longTermMemory = [];
    chat.longTermMemory.push(entry);
    return db.chats.put(chat).then(function () {
      log('✅ 观影记忆已写入长期记忆库, source=cinema_watch_summary, ' + content.length + ' 字');
      return true;
    });
  }

  // ============================================================
  // session resumption / 重连
  // 迁移自旧文件 :851-909
  // ============================================================
  /**
   * 存档点自愈 (2026-10-04 用户反馈: 每次刷新都得手动点"清除断线存档点")
   *
   * 原来的死循环: 只要服务端发了 handle 就存 —— 包括那种马上就要断的连接。
   *   连上 → 发 H1 → 存 H1 → 秒断 → 刷新拿 H1 连 → 认不出 → 又发 H2 → 存 H2 …
   *   存档点一直在被污染, 所以永远得手动清。
   *
   * 现在两道保险:
   *   1) 带时间戳, 超过 HANDLE_TTL_MS 的一律不用(服务端早过期了)
   *   2) 只在连接【真的 ready 且没在抖动】时才存新 handle
   */
  var HANDLE_TTL_MS = 10 * 60 * 1000;

  function loadHandle() {
    try {
      var raw = localStorage.getItem(HANDLE_KEY);
      if (!raw) return '';
      var o;
      try { o = JSON.parse(raw); } catch (e) { saveHandle(null); return ''; }
      // 兼容早期存的裸字符串格式
      if (typeof o === 'string') { saveHandle(o); return Date.now() < HANDLE_TTL_MS ? o : ''; }
      if (!o || !o.handle) return '';
      if (Date.now() - (o.at || 0) > HANDLE_TTL_MS) {
        log('存档点已过期 (' + Math.round((Date.now() - (o.at || 0)) / 60000) + ' 分钟), 改用全新会话');
        saveHandle(null);
        return '';
      }
      return o.handle;
    } catch (e) { return ''; }
  }

  function saveHandle(h) {
    try {
      if (h) localStorage.setItem(HANDLE_KEY, JSON.stringify({ handle: h, at: Date.now() }));
      else localStorage.removeItem(HANDLE_KEY);
    } catch (e) { /* noop */ }
  }
  function clearRetry() {
    _retryCount = 0;
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  }

  /**
   * 连接被意外断开 → 安排重连 (指数退避)。
   *
   * ⚠️ 2026-10-04 修的坑: 原来只要"重连成功"就 clearRetry() 把退避清回 2s。
   *    但 Gemini Live 连上就被服务端掐掉时, 会变成
   *      断 → 2s → 连上 → 又断 → 2s → … 永远卡在最短退避, 疯狂刷屏。
   *    现在改成: 只有"连上后稳定活够 FLAP_STABLE_MS"才算真的恢复, 才清零。
   */
  var FLAP_STABLE_MS = 15000;   // 连续在线 15s 才算稳

  function scheduleReconnect(reason) {
    if (S._userDisabled || S._leaving) return;

    // 抖动检测: 上次连接没活够 FLAP_STABLE_MS 就断了 → 不清零, 继续往上加退避
    var lived = S.connectedAt ? (Date.now() - S.connectedAt) : 0;
    var flapped = !!S.connectedAt && lived < FLAP_STABLE_MS;
    flapLast = flapped;
    if (flapped) {
      logWarn('连接只活了 ' + Math.round(lived / 1000) + 's 就断, 判定为抖动, 退避继续加长');
    }

    if (_retryCount >= MAX_RETRY) {
      logWarn('重连次数用完 (' + MAX_RETRY + '), 放弃自动重连');
      appendSystemLine('⚠️ 连续重连 ' + MAX_RETRY + ' 次仍失败，已停止自动重连。原因：' + reason +
        '　可以在房间右上角 ⚙「设置」里确认 key 是否填对。');
      renderStatus('closed', '重连失败');
      return;
    }
    var delay = RETRY_BASE_MS * Math.pow(2, _retryCount);
    _retryCount++;
    logWarn('安排重连 (' + _retryCount + '/' + MAX_RETRY + '), ' + Math.round(delay / 1000) + 's 后重试, 原因: ' + reason);
    appendSystemLine('🔄 连接断开（' + reason + '），' + Math.round(delay / 1000) + ' 秒后重连…');
    renderStatus('connecting', '重连中 ' + _retryCount + '/' + MAX_RETRY);
    if (_retryTimer) clearTimeout(_retryTimer);
    _retryTimer = setTimeout(function () {
      _retryTimer = null;
      if (!S.enabled || S._userDisabled || S._leaving) return;
      if (!S.client) { enable(); return; }
      S.client.reconnect().then(function (ok) {
        if (ok) {
          // 只有稳定连上才清退避计数 (flapped 时不清)
          if (!flapped) clearRetry();
          startFrameLoop();
          log('✅ 重连成功, 上下文已恢复');
          appendSystemLine('✅ 已重新连接（对话上下文保留）');
        }
      }).catch(function (err) {
        log('重连失败:', err.message);
        // 重连也失败 -> 存档点八成是废的, 直接扔掉, 下一轮从全新会话开始
        if (S.connectedAt) saveHandle(null);
        scheduleReconnect(err.message);
      });
    }, delay);
  }

  // ============================================================
  // 启用 / 停用
  // 迁移自旧文件 :917-1080
  // ============================================================
  function onClientState(state, detail) {
    renderStatus(state, detail);
    if (state === 'connected' || state === 'ready') S.connectedAt = Date.now();
    if (state === 'ready') {
      if (!flapLast) clearRetry();
      flapLast = false;
      appendSystemLine('✅ Gemini Live 已连接，正在持续接收视频画面（1 帧/秒）');
      if (watchSession.closed || !watchSession.watchSessionId) {
        newWatchSession(S.chatId);
        appendSystemLine('📖 我会每隔几分钟整理一次剧情，方便待会儿写观影记忆。');
      }
      scheduleStageSummary();
      renderPlotPanel();
    } else if (state === 'closed' && S.autoMode && !S._userDisabled) {
      // 非用户主动关闭 → 走 session resumption 重连
      scheduleReconnect(detail || '连接被关闭');
    }
  }

  function enable() {
    if (S.enabled) return Promise.resolve(true);

    var apiKey = getGeminiKey();
    if (!apiKey) {
      appendSystemLine('⚠️ 还没填 Gemini Live API Key，点房间右上角 ⚙ 填一下就能边看边聊');
      renderStatus('error', '没填 API Key');
      return Promise.resolve(false);
    }
    if (typeof window.LiveClient !== 'function') {
      appendSystemLine('⚠️ live-client.js 没加载');
      renderStatus('error', 'live-client.js 未加载');
      return Promise.resolve(false);
    }

    S.enabled = true;
    S.framesSent = 0;
    S.paused = false;
    S._userDisabled = false;
    S._leaving = false;
    clearRetry();
    resetBubble();
    renderStatus('connecting');

    var chatForPrompt = getCurrentChat();
    if (chatForPrompt && !watchSession.chatId) newWatchSession(chatForPrompt.id);

    S.client = new window.LiveClient({
      apiKey: apiKey,
      systemPrompt: buildSystemPrompt(chatForPrompt),
      onState: onClientState,
      // ⬇ 关键路由: 有 pendingSummary → 进剧情记忆, 绝进气泡
      onModelText: handleModelText,
      // ⚠️ 这里【不要】resetBubble()。Gemini 的一个 turn 只是"一小段",
      //    一句完整的话常常横跨好几个 turn (TURN_COVERAGE=ALL_VIDEO, 视频帧会推进回合)。
      //    每个 turn 都重置气泡 -> 一句话被拆成三五个字一行 (2026-10-04 用户反馈)。
      //    气泡只在【用户发新消息】时由 doSendUserText 清。
      onTurnComplete: function () { onTurnCompleteInternal(); },
      onSessionResumption: function (info) {
        // ⚠️ 只在连接【真的 ready 了】才存。正在抖动的连接发来的存档点不能存 ——
        //    那个 handle 马上就是废的, 存下来会毒化下一次连接 (2026-10-04 死循环根因)。
        if (!info || !info.handle) return;
        if (!S.client || !S.client.isReady()) {
          log('连接还没 ready 就收到存档点, 丢弃(避免污染下次连接)');
          return;
        }
        saveHandle(info.handle);
        log('📌 已保存会话存档点');
      },
      onUsage: function (meta) {
        log('usage: total=' + meta.totalTokenCount + ' prompt=' + meta.promptTokenCount +
          ' response=' + meta.responseTokenCount);
      },
      onGoAway: function () { appendSystemLine('⚠️ 服务端即将断开连接'); },
      onError: function (err) { appendSystemLine('⚠️ Gemini Live 错误: ' + err.message); }
    });

    var savedHandle = loadHandle();
    if (savedHandle) S.client.setResumeHandle(savedHandle);

    log('开始连接 Gemini Live');

    return S.client.connect()
      .then(function () {
        return new Promise(function (resolve) {
          var waited = 0;
          var iv = setInterval(function () {
            waited += 200;
            if (S.client && S.client.isReady()) {
              clearInterval(iv);
              startFrameLoop();
              resolve(true);
            } else if (waited > 20000) {
              clearInterval(iv);
              log('等 setupComplete 超时 20s');
              // 拿旧存档点续不上 → 把它扔掉, 下次从全新会话开始。
              // 废掉的 handle 会让服务端一收到 setup 就关连接, 症状是"连上秒断"。
              if (savedHandle) { saveHandle(null); log('⚠️ 存档点续不上, 已清除, 下次用全新会话'); }
              appendSystemLine('⚠️ 等待 Gemini 初始化超时（20s）。已重置存档点，下次会开新会话。');
              resolve(false);
            } else if (S.client && (S.client.state === 'error' || S.client.state === 'closed')) {
              clearInterval(iv);
              if (savedHandle) { saveHandle(null); log('⚠️ 带着旧存档点连不上, 已清除'); }
              appendSystemLine('⚠️ 连接被服务端关闭（code ' + (S.client.state || '?') + '）。已重置存档点，下次开新会话。');
              resolve(false);
            }
          }, 200);
        });
      })
      .catch(function (err) {
        log('连接失败:', err.message);
        S.enabled = false;
        renderStatus('error', err.message);
        appendSystemLine('❌ Gemini Live 连接失败: ' + err.message);
        return false;
      });
  }

  function disable(reason) {
    log('停用 Gemini Live' + (reason ? ' (' + reason + ')' : ''));
    clearRetry();
    stopFrameLoop();
    if (S.client) {
      try { S.client.close(reason || 'disabled'); } catch (e) { /* noop */ }
      S.client = null;
    }
    S.enabled = false;
    S.paused = false;
    S._userDisabled = true;
    resetBubble();
    hideStatus();
    renderPlotPanel();
  }

  /**
   * 播放事件 → 自动连接。
   * 与旧观影一致: 没 key 就静默跳过并提示一次。
   */
  function autoConnect(reason) {
    if (!S.autoMode) return false;
    if (S.enabled || (S.client && (S.client.state === 'connecting' || S.client.state === 'ready'))) {
      if (S.enabled && S.client && S.client.isReady()) {
        S.paused = false;
        renderStatus('ready');
      }
      return false;
    }
    if (!getGeminiKey()) {
      if (!_autoTried) {
        _autoTried = true;
        appendSystemLine('💡 想让 Gemini 边看边懂？点右上角 ⚙ 填一下 Gemini Live API Key');
      }
      return false;
    }
    var video = getVideo();
    if (!video || !video.src) return false;
    log('自动连接 (触发: ' + (reason || 'video play') + ')');
    enable();
    return true;
  }

  // ============================================================
  // 退出流程 —— 严格保持旧文件已验证的顺序
  //   锁定 → 停止接受新请求 → 整理记忆 → 生成成功
  //   → 写 longTermMemory → 确认 await db.chats.put 成功
  //   → 关闭 Live → 退出房间
  //   ⚠️ 绝不能: 先关 Live 再总结 (关了就拿不到了)
  //   ⚠️ 失败时【不关 Live】, 不假装成功, 保持当前会话让用户重试
  // ============================================================
  function onLeaveCinema() {
    if (watchSession.leavePromise) return watchSession.leavePromise;
    S._leaving = true;
    stopStageSummary();
    watchSession.leavePromise = runFinalSummaryFlow()
      .catch(function (err) {
        logError('观影记忆流程异常:', err.message);
        return { saved: false, error: err.message };
      });
    return watchSession.leavePromise;
  }

  function runFinalSummaryFlow() {
    var chat = getCurrentChat();

    if (!S.enabled || !S.client || !S.client.isReady() || !chat) {
      log('没有可总结的 Live session, 直接退出');
      hardLeave();
      return Promise.resolve({ saved: false, skipped: true });
    }
    if (watchSession.finalSummaryRequested) {
      return watchSession.leavePromise || Promise.resolve({ saved: false, error: 'already_requested' });
    }
    watchSession.finalSummaryRequested = true;

    renderStatus('connecting');
    appendSystemLine('⏳ 正在整理这次观影记忆，请稍等一下……');
    renderPlotPanel();

    return waitForNoPendingSummary()
      .then(function () { return requestSummary('final', buildFinalSummaryInstruction()); })
      .then(function (text) {
        var content = (text || '').trim();
        if (!content) throw new Error('Gemini 没有返回观影记忆内容');
        watchSession.finalSummaryText = content;
        appendSystemLine('💾 正在保存观影记忆…');
        renderPlotPanel();
        return saveToLongTermMemory(chat, content);
      })
      .then(function () {
        // 只有 await db.chats.put 成功走到这里, 才算真的保存成功
        watchSession.finalSummarySaved = true;
        appendSystemLine('✅ 观影记忆已保存到长期记忆');
        renderPlotPanel();
        hardLeave();
        return { saved: true };
      })
      .catch(function (err) {
        // ⚠️ 失败时【不关 Live】, 让用户能重试
        logError('观影记忆未保存成功:', err.message);
        watchSession.finalSummaryRequested = false;
        S._leaving = false;
        appendSystemLine('⚠️ 观影记忆还没有生成成功：' + err.message);
        renderStatus('ready');
        renderPlotPanel();
        return { saved: false, error: err.message };
      });
  }

  function waitForNoPendingSummary() {
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 200;
        if (!watchSession.pendingSummary || waited > 3000) {
          if (watchSession.pendingSummary) {
            log('等待阶段摘要超时, 强制继续');
            var p = watchSession.pendingSummary;
            watchSession.pendingSummary = null;
            if (p.timer) clearTimeout(p.timer);
            watchSession.summaryBusy = false;
          }
          clearInterval(iv);
          resolve();
        }
      }, 200);
    });
  }

  function hardLeave() {
    watchSession.closed = true;
    stopStageSummary();
    S._leaving = true;
    disable('离开 Cinema Room');
    _autoTried = false;
    S._userDisabled = false;
    S.canvas = null;
    S.ctx = null;
    S.framesSent = 0;
    S.bubbleEl = null;
  }

  function retryFinalSummary() {
    if (watchSession.finalSummarySaved) return Promise.resolve({ saved: true });
    log('用户手动重试生成观影记忆');
    watchSession.leavePromise = runFinalSummaryFlow()
      .catch(function (err) { return { saved: false, error: err.message }; });
    return watchSession.leavePromise;
  }

  // ============================================================
  // 帧控制 / 消息 / 生命周期钩子
  // ============================================================
  function pauseFrames(reason) {
    if (!S.enabled) return;
    S.paused = true;
    log('暂停发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  function resumeFrames(reason) {
    if (!S.enabled || !S.client || !S.client.isReady()) return;
    S.paused = false;
    log('恢复发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  function doSendUserText(text) {
    var video = getVideo();
    var extra = (video && !video.paused && !video.ended)
      ? '' : '（视频当前是暂停/结束状态，只能根据之前收到的画面回答）';
    // 用户发了新消息 -> 上一句 assistant 的话收尾, 开一个新气泡
    resetBubble();
    bubbleText = '';
    recordChat('user', text);
    S.client.sendUserText(String(text || ''));
    appendUserBubble(text);
    if (extra) appendSystemLine(extra);
  }

  /**
   * Cinema Room 聊天框发消息。
   * @returns {boolean} true = 已被 Live 接管
   */
  function handleUserMessage(text) {
    if (!S.enabled) return false;
    if (watchSession.finalSummaryRequested) {
      appendSystemLine('⚠️ 正在整理这次观影记忆，请稍等…');
      return true;
    }
    if (!S.client || !S.client.isReady()) {
      appendSystemLine('⚠️ Gemini Live 还没就绪，暂时无法提问');
      return true;
    }
    // ⚠️ 关键: 摘要 turn 在途时【排队】, 绝不并发发第二个 turn
    if (watchSession.pendingSummary) {
      watchSession.queuedUserText = String(text || '');
      appendUserBubble(text);
      appendSystemLine('⏳ 正在整理剧情，你的消息会在整理完成后自动发出。');
      return true;
    }
    doSendUserText(text);
    return true;
  }

  function onTurnCompleteInternal() {
    if (watchSession.pendingSummary) {
      var p = watchSession.pendingSummary;
      var buf = (p.buffer || '').trim();
      p.resolve(buf);
      finishSummary(p);
      flushQueuedUserText();
    }
    // 普通陪聊的回合结束: 【什么都不做】, 气泡继续留着。
    // 一句话跨多个 turn 是常态, 只有用户发新消息才开新气泡。
  }

  /** 自然播放结束 → 停发帧, 不关 Live, 不退出房间, 用户还能继续聊 */
  function onVideoEnded() {
    if (!S.enabled) return;
    S.paused = true;
    log('视频播放结束, 停止发帧 (session 保留)');
    renderStatus('ready');
  }

  /** 换片 → 结束旧 session, 旧摘要丢弃(临时记忆), 重开新 session */
  function onVideoSourceChanged() {
    log('视频源已更换, 结束旧 watch session (其剧情摘要不写入长期记忆)');
    stopStageSummary();
    watchSession.currentPlotSummary = '';
    watchSession.summaryCount = 0;
    watchSession.summaryUpdatedAt = 0;
    watchSession.finalSummaryText = '';
    watchSession.finalSummarySaved = false;
    watchSession.finalSummaryRequested = false;
    watchSession.chatLog = [];
    plotPanelOpen = false;
    plotEditing = false;
    S.canvas = null;
    S.ctx = null;
    S.framesSent = 0;
    if (S.enabled) disable('视频源更换');
    else newWatchSession(S.chatId);
    renderPlotPanel();
  }

  // ============================================================
  // 导出
  // ============================================================
  window.CinemaLive = {
    // 会话绑定
    setChat: function (chatId) {
      S.chatId = chatId || null;
      if (S.chatId) {
        if (!watchSession.chatId || watchSession.chatId !== S.chatId) newWatchSession(S.chatId);
      }
    },
    getChatId: function () { return S.chatId; },

    // 生命周期
    enable: enable,
    disable: disable,
    autoConnect: autoConnect,
    onLeaveCinema: onLeaveCinema,
    retryFinalSummary: retryFinalSummary,
    pauseFrames: pauseFrames,
    resumeFrames: resumeFrames,
    handleUserMessage: handleUserMessage,
    onVideoEnded: onVideoEnded,
    onVideoSourceChanged: onVideoSourceChanged,

    // 剧情面板
    togglePlotPanel: togglePlotPanel,
    // 常驻折叠条: 房间打开聊天面板时主动拉一次, 保证那一行一定在
    // (之前只在 Live 状态变化时被动刷, 没连上就永远不出现)
    renderPlotPanel: renderPlotPanel,
    isPlotPanelOpen: function () { return plotPanelOpen; },

    // key
    getGeminiKey: getGeminiKey,
    setGeminiKey: setGeminiKey,
    hasKey: function () { return !!getGeminiKey(); },

    // 状态
    isEnabled: function () { return S.enabled; },
    isReady: function () { return !!(S.client && S.client.isReady()); },
    getStats: function () {
      return {
        enabled: S.enabled,
        ready: !!(S.client && S.client.isReady()),
        framesSent: S.framesSent,
        paused: S.paused,
        chatId: S.chatId,
        frameSize: S.canvas ? (S.canvas.width + 'x' + S.canvas.height) : 'n/a',
        state: S.client ? S.client.state : 'idle'
      };
    },
    getWatchSession: function () {
      return {
        watchSessionId: watchSession.watchSessionId,
        chatId: watchSession.chatId,
        currentPlotSummary: watchSession.currentPlotSummary,
        summaryUpdatedAt: watchSession.summaryUpdatedAt,
        summaryCount: watchSession.summaryCount,
        summaryBusy: watchSession.summaryBusy,
        finalSummaryRequested: watchSession.finalSummaryRequested,
        finalSummarySaved: watchSession.finalSummarySaved,
        finalSummaryText: watchSession.finalSummaryText,
        chatCount: watchSession.chatLog.length
      };
    },
    // 迁移自检用: 确认降采样逻辑
    computeFrameSize: computeFrameSize
  };

  log('cinema-live.js 已加载 (迁移自 watch-together-live.js; 协议层用 live-client.js)');
})();
