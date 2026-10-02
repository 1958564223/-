// ============================================================
// watch-together-live.js
// 「一起看电影」的 Gemini 3.8 Live 桥接层
//
// 分工:
//   modules/live-client.js       纯协议层 (WebSocket / 消息 / session resumption), 不碰 DOM
//   modules/watch-together-live.js  ← 本文件: 桥接层 (抽帧 / 人设 / 剧情摘要 / UI / 生命周期)
//
// v0.4.0 能力:
//   ✅ 本地视频 → canvas → JPEG → 1 FPS → Gemini Live
//   ✅ 用户打字 → Gemini → 文字回答 (带角色人设 + 长期记忆)
//   ✅ 每 ~5 分钟后台更新一次「当前剧情摘要」(单通道, 会短暂占用 model turn)
//   ✅ 主动退出时: 先请求最终观影记忆 → 写 330 唯一长期记忆库 → 确认保存 → 才关 Live
//   ✅ 剧情摘要只存内存, 【绝不】写 chat.longTermMemory
//
// v0.3.0: 旧的"定时截图 + Whisper + 手动调用API"链路已从 init-features.js
// 整体移除, 本模块是「一起看电影」唯一的 AI 理解通道。
// ============================================================

(function () {
  'use strict';

  var VIDEO_ID = 'watch-together-video';

  // 1 FPS —— 官方建议上限 (live.md.txt / 官方示例都是 max 1 frame per second)
  var FRAME_INTERVAL_MS = 1000;
  // JPEG 质量沿用已验证的参数 (init-features.js:4595 用的就是 0.6)
  var JPEG_QUALITY = 0.6;

  // ============================================================
  // 阶段剧情摘要间隔 (集中一处, 方便以后调成 3/5/10 分钟)
  // ============================================================
  var WATCH_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

  // 阶段摘要的目标长度 (超了就在下一轮被重新压缩)
  var PLOT_SUMMARY_MAX_CHARS = 1500;
  // 最终观影记忆的目标长度
  var FINAL_MEMORY_TARGET_CHARS = 1000;

  // 最终总结请求超时 (超时不算成功, 让用户能重试)
  var SUMMARY_REQUEST_TIMEOUT_MS = 45000;

  // ============================================================
  // 观影 session 状态 (运行时, 绝不落长期记忆)
  // ============================================================
  var watchSession = {
    watchSessionId: null,      // 本次观影的唯一 ID
    chatId: null,             // 观影对应的 chat
    currentPlotSummary: '',   // 当前剧情摘要 (始终只有这一份, 每轮重新压缩)
    summaryUpdatedAt: 0,      // 最近一次更新时间
    summaryCount: 0,          // 已成功生成的阶段摘要次数
    pendingSummary: null,     // { kind:'stage'|'final', resolve, timer }
    summaryBusy: false,       // 正在整理剧情 (UI 提示用)
    summaryTimer: null,       // 阶段摘要定时器
    queuedUserText: null,     // 摘要期间用户发的消息 (排队, 不并发)
    finalSummaryRequested: false,  // 防止重复点退出
    finalSummarySaved: false,      // 真正的"已保存"标志 (写库成功才置 true)
    finalSummaryText: '',          // 生成出来的观影记忆原文
    chatLog: [],                  // 本次观影的聊天记录 (供最终总结用)
    closed: false
  };

  function newWatchSession(chatId) {
    watchSession.watchSessionId = 'ws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    watchSession.chatId = chatId;
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
    log('新的 watch session:', watchSession.watchSessionId);
    return watchSession.watchSessionId;
  }

  // ============================================================
  // 系统提示词: 张怀瑾人设 + 现有长期记忆 + 观影行为
  // ============================================================
  // ⚠️ 人设来源 = chat.settings.aiPersona, 与主聊天 (ai-response.js) 完全同一个字段,
  //    不新造人格、不做简化版。
  // ⚠️ 长期记忆来源 = chat.longTermMemory, 与主聊天同一个数组, 只读不写。
  // ⚠️ 按要求【不注入】世界书 / 向量记忆 / 结构化记忆。

  function buildSystemPrompt(chat) {
    var c = chat || {};
    var persona = (c.settings && c.settings.aiPersona) || '';
    var userPersona = (c.settings && c.settings.myPersona) || '';
    var myNickname = (c.settings && c.settings.myNickname) || '我';
    var charName = c.name || c.originalName || '角色';

    var memoryText = '';
    var mem = c.longTermMemory;
    if (Array.isArray(mem) && mem.length > 0) {
      // 格式对齐主聊天 (prompt-manager.js:32 / ai-response.js 的 map 写法)
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
    out.push('你正在和用户一起看视频。');
    out.push('');
    out.push('- 你会持续收到视频画面帧（大约每秒一张 JPEG 图片），按时间顺序到达。');
    out.push('- 视频画面就是你的实时视觉输入，你能真的"看到"当前内容。');
    out.push('- 用户在聊天框里说的话是你的实时对话输入。');
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
  // 状态
  // ============================================================

  var S = {
    enabled: false,          // Live 模式开关
    client: null,            // LiveClient 实例
    frameTimer: null,        // 抽帧定时器
    canvas: null,
    ctx: null,
    framesSent: 0,
    paused: false,           // 视频暂停 → 停发帧但不销毁 session
    statusEl: null,
    lastRenderedText: '',
    autoMode: true,       // 方案 A: 播就自动连
    _userDisabled: false, // 用户手动关的 (别自动连回来)
    _leaving: false       // 正在离开观影 (别触发重连)
  };

  // ============================================================
  // 小工具
  // ============================================================

  function log(msg, extra) {
    var line = '[WT-Live] ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) { /* noop */ }
    }
    console.log(line);
  }

  function getVideo() {
    return document.getElementById(VIDEO_ID);
  }

  /**
   * 读 Gemini Live 的 API Key。
   *
   * 存哪: chat.watchTogetherSettings.geminiApiKey —— 跟这个弹窗里已有的
   *       Whisper API Key 同一个位置、同一种写法 (各人填各人的, 存在本机浏览器)。
   *
   * 为什么不用 ephemeral token / 后端:
   *   每人填自己的 key, 不存在"把别人的 key 托管在服务器"这个风险场景,
   *   ephemeral token 的保护意义就不存在了。而且浏览器同源策略不管 WebSocket,
   *   前端可以直接连官方 wss 端点, 零后端零 CORS。
   */
  function getCurrentChat() {
    try {
      if (typeof state !== 'undefined' && state && state.chats) {
        var cid = (window.watchTogetherState && window.watchTogetherState.chatId) || null;
        if (cid) return state.chats[cid] || null;
      }
    } catch (e) { /* noop */ }
    return null;
  }

  function getGeminiKey() {
    try {
      var chat = getCurrentChat();
      if (chat && chat.watchTogetherSettings) {
        return String(chat.watchTogetherSettings.geminiApiKey || '').trim();
      }
    } catch (e) { /* noop */ }
    return '';
  }

  // ============================================================
  // 状态指示器 (用户第十二节: 只需 ●已连接 / ●正在看视频, 不要求漂亮)
  // ============================================================

  function ensureStatusEl() {
    if (S.statusEl && S.statusEl.parentNode) return S.statusEl;
    var el = document.createElement('div');
    el.id = 'wt-live-status';
    el.setAttribute('style', [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      'top:calc(env(safe-area-inset-top, 0px) + 10px)',
      'z-index:100002',
      'background:rgba(17,24,39,.86)', 'color:#fff',
      'padding:6px 12px', 'border-radius:999px',
      'font-size:12px', 'font-weight:600', 'line-height:1.4',
      'display:flex', 'align-items:center', 'gap:6px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'pointer-events:none', 'white-space:nowrap'
    ].join(';'));
    document.body.appendChild(el);
    S.statusEl = el;
    return el;
  }

  var STATE_TEXT = {
    connecting: '🟡 Gemini Live 连接中…',
    connected: '🟡 已连接, 初始化…',
    ready: '🟢 已连接',
    closed: '⚪ 已断开',
    error: '🔴 连接失败',
    idle: '⚪ 未启动'
  };

  function renderStatus(state, detail) {
    var el = ensureStatusEl();
    var base = STATE_TEXT[state] || state;
    if (state === 'ready') {
      // v0.4.0: 摘要期间明确提示, 不要让用户以为 Live 卡死
      if (watchSession.summaryBusy) {
        base = '⏳ 正在整理剧情，请稍等一下…';
      } else {
        base = S.paused ? '🟢 已连接 · 视频暂停' : '🟢 已连接 · 正在看视频';
      }
    }
    el.textContent = base + (detail && state === 'error' ? '（' + detail + '）' : '');
    el.style.display = 'block';
  }

  // ============================================================
  // 抽帧 (复用已验证的 canvas 能力, 不另起一套)
  // ============================================================

  function ensureCanvas(video) {
    if (!S.canvas) {
      S.canvas = document.createElement('canvas');
    }
    S.canvas.width = video.videoWidth;
    S.canvas.height = video.videoHeight;
    if (!S.ctx || S.ctx.canvas !== S.canvas) {
      S.ctx = S.canvas.getContext('2d');
    }
    return S.ctx;
  }

  /**
   * 抽一帧 → base64 (纯 base64, 不带 data: 前缀)。
   * 返回 null 表示这一帧抽不到 (暂停/未就绪/跨域), 调用方负责跳过。
   */
  function grabFrameBase64(video) {
    if (!video || video.paused || video.ended) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    try {
      var ctx = ensureCanvas(video);
      ctx.drawImage(video, 0, 0);
    } catch (e) {
      log('drawImage 失败 (可能是跨域污染 canvas):', e.name + ' ' + e.message);
      return null;
    }

    // toDataURL 同步返回, 拆掉 "data:image/jpeg;base64," 前缀
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
      // 暂停/结束 → 跳过这一帧, 但 session 保留
      if (video.paused || video.ended) {
        S.paused = true;
        renderStatus('ready');
        return;
      }
      if (S.paused) {           // 从暂停恢复
        S.paused = false;
        renderStatus('ready');
        log('视频恢复播放, 继续发帧');
      }
      var b64 = grabFrameBase64(video);
      if (!b64) return;
      S.framesSent++;
      S.client.sendVideoFrame(b64, 'image/jpeg');
      log('video frame sent #' + S.framesSent + ' (' + Math.round(b64.length * 0.75 / 1024) + 'KB, t=' +
        video.currentTime.toFixed(1) + 's)');
    }, FRAME_INTERVAL_MS);
    log('开始 1 FPS 视频帧发送');
  }

  function stopFrameLoop() {
    if (S.frameTimer) {
      clearInterval(S.frameTimer);
      S.frameTimer = null;
      log('已停止视频帧发送');
    }
  }

  // ============================================================
  // 消息显示 (复用现有「一起看电影」聊天框)
  // ============================================================

  function appendSystemLine(text) {
    var box = document.getElementById('watch-together-chat-messages');
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'watch-together-system-message';
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  /** 把 Gemini 的文字渲染成一个 assistant 气泡 */
  function renderGeminiBubble(text) {
    var box = document.getElementById('watch-together-chat-messages');
    if (!box) {
      log('找不到聊天消息容器, Gemini 文字:', text);
      return;
    }
    // 简单的"同文合并"策略: 同一轮里不断来的是同一个气泡的增量, 就地更新
    if (S._bubbleEl && S._bubbleEl.parentNode === box) {
      S._bubbleEl.textContent = text;
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'watch-together-message assistant';
      var avatar = document.createElement('img');
      avatar.className = 'watch-together-message-avatar';
      try {
        var chat = (typeof state !== 'undefined' && state && state.chats && state.chats[window.watchTogetherState && window.watchTogetherState.chatId]) || null;
        avatar.src = (chat && chat.settings && chat.settings.aiAvatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
      } catch (e) {
        avatar.src = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
      }
      var content = document.createElement('div');
      content.className = 'watch-together-message-content';
      content.textContent = text;
      wrap.appendChild(avatar);
      wrap.appendChild(content);
      box.appendChild(wrap);
      S._bubbleEl = content;
    }
    box.scrollTop = box.scrollHeight;
  }

  function resetBubble() {
    S._bubbleEl = null;
  }

  // ============================================================
  // 「3.8 剧情记忆」可展开面板 (调试 + 观察用)
  // ⚠️ 这里显示的都是【当前 watch session 的临时记忆】,
  //    不会写进 chat.longTermMemory。
  // ============================================================
  var plotPanelEl = null;
  var plotPanelOpen = false;
  var plotPanelPinned = false;   // 用户手动点过 → Live 关了也保留面板
  // v0.4.1 修复: 原来面板初始 display:none, 而展开入口又在面板自己身上 →
  //   永远点不开, 剧情摘要用户完全看不见。
  // v0.4.2 修复: 可见性不能硬绑 S.enabled, 否则 Live 一关就再也看不到本次摘要。
  //   改成: Live 启用时常驻显示; 用户手动展开后即使 Live 关了也保留(方便回看)。

  function plotPanelVisible() {
    return S.enabled || plotPanelPinned || !!watchSession.currentPlotSummary ||
      !!watchSession.finalSummaryText || watchSession.summaryCount > 0;
  }

  function ensurePlotPanel() {
    if (plotPanelEl && plotPanelEl.parentNode) return plotPanelEl;
    var el = document.createElement('div');
    el.id = 'wt-plot-panel';
    el.setAttribute('style', [
      'position:fixed', 'right:12px', 'bottom:96px', 'z-index:100001',
      'width:300px', 'max-width:78vw',
      'background:rgba(17,24,39,.95)', 'color:#e5e7eb',
      'border-radius:12px', 'box-shadow:0 8px 28px rgba(0,0,0,.4)',
      'font-size:12px', 'line-height:1.55',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'overflow:hidden', 'cursor:pointer'
    ].join(';'));
    plotPanelEl = el;
    document.body.appendChild(el);
    return el;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try {
      var d = new Date(ts);
      return d.toTimeString().slice(0, 8);
    } catch (e) { return '—'; }
  }

  function renderPlotPanel() {
    var el = ensurePlotPanel();
    // Live 没启用时整个隐藏 (不占屏幕)
    if (!plotPanelVisible()) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = buildPlotPanelHtml(!plotPanelOpen);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function buildPlotPanelHtml(collapsed) {
    var video = getVideo();
    var vname = '';
    try {
      vname = video && video.src ? (video.src.split('/').pop() || '').slice(0, 40) : '';
    } catch (e) { /* noop */ }

    var head = 'Gemini Live 剧情记忆' + (collapsed ? ' ▸' : ' ▾');

    if (collapsed) {
      var dot = watchSession.summaryBusy ? '🟡' : (watchSession.currentPlotSummary ? '🟢' : '⚪');
      var cnt = watchSession.summaryCount;
      var savedTag = watchSession.finalSummarySaved ? ' · 记忆已存' : '';
      return '<div style="padding:8px 10px;display:flex;align-items:center;gap:6px">' +
        dot + ' ' + esc(head) +
        '<span style="color:#9ca3af;margin-left:auto">' + cnt + ' 次' + esc(savedTag) + ' ▸</span></div>';
    }

    var busyHtml = watchSession.summaryBusy
      ? '<div style="margin-top:8px;padding:6px 8px;background:rgba(250,204,21,.18);' +
        'border:1px solid rgba(250,204,21,.45);border-radius:8px;color:#fde68a">' +
        '⏳ 正在整理剧情，请稍等一下…</div>'
      : '';

    var summaryHtml = watchSession.currentPlotSummary
      ? esc(watchSession.currentPlotSummary)
      : '<span style="color:#6b7280">（还没有剧情摘要，约 5 分钟后生成第一份）</span>';

    var finalHtml = watchSession.finalSummaryText
      ? esc(watchSession.finalSummaryText)
      : '<span style="color:#6b7280">（观影结束后生成）</span>';

    return '<div style="padding:8px 10px;font-weight:700;' +
      'border-bottom:1px solid rgba(255,255,255,.12);display:flex;align-items:center;gap:6px">' +
      esc(head) + '<span style="color:#9ca3af;margin-left:auto;font-weight:400">收起 ▾</span></div>' +
      '<div data-noscroll="1" style="padding:8px 10px;cursor:default">' +
      '<div style="color:#9ca3af;margin-bottom:3px">当前视频</div>' +
      '<div style="margin-bottom:7px">' + esc(vname || '（未加载）') + '</div>' +

      '<div style="color:#9ca3af;margin-bottom:3px">当前剧情摘要</div>' +
      '<div style="white-space:pre-wrap;word-break:break-word;max-height:220px;' +
      'overflow:auto;background:rgba(255,255,255,.05);padding:7px;border-radius:7px;margin-bottom:7px">' +
      summaryHtml + '</div>' +

      busyHtml +

      '<div style="display:flex;gap:12px;color:#9ca3af;margin:7px 0;font-size:11px">' +
      '<span>更新：' + fmtTime(watchSession.summaryUpdatedAt) + '</span>' +
      '<span>次数：' + watchSession.summaryCount + '</span>' +
      '</div>' +

      '<div style="color:#9ca3af;margin-bottom:3px">最终观影记忆</div>' +
      '<div style="white-space:pre-wrap;word-break:break-word;max-height:160px;' +
      'overflow:auto;background:rgba(255,255,255,.05);padding:7px;border-radius:7px">' +
      finalHtml + '</div>' +
      '</div>';
  }

  function togglePlotPanel() {
    plotPanelOpen = !plotPanelOpen;
    // 用户主动点过 → 之后即使 Live 关了, 面板也保留(方便回看这次的摘要)
    if (plotPanelOpen) plotPanelPinned = true;
    renderPlotPanel();
  }

  //
  // 技术前提 (已在审计中确认):
  //   Live 是【单通道有状态协议】, 每次 clientContent+turnComplete:true
  //   必然产生一个 model turn, 协议没有"内部请求/不返回"这种标记。
  //   所以摘要请求必然会让模型回一段文字。
  //
  //   → 唯一可靠的拦截点是我们自己的 onModelText 回调:
  //     有 pendingSummary 时, 文字进剧情记忆; 没有时, 文字进气泡。
  //     摘要文字 100% 不会出现在用户聊天气泡里。
  //
  //   → 期间模型不能正常陪聊 (单通道)。UI 会显示"正在整理剧情"提示。
  //   → 摘要期间用户发的消息【排队】, 不并发发第二个 turn, 绝对不破坏当前 turn。
  // ============================================================

  /**
   * 模型文字统一入口 (路由分发)。
   * 这是"摘要不进气泡"的唯一保证点。
   */
  function handleModelText(text, isFinal) {
    if (!text) return;

    // 后台摘要请求 → 只进剧情记忆
    if (watchSession.pendingSummary) {
      var p = watchSession.pendingSummary;
      // 增量拼接 (outputTranscription 是流式增量, 靠 _lastTranscription 去重)
      p.buffer = (p.buffer ? p.buffer : '') + text;
      log('[摘要] 收到后台输出 (' + p.kind + ')', JSON.stringify(text.slice(0, 60)));
      return;   // ⬅ 关键: 不调用 renderGeminiBubble
    }

    // 正常陪聊
    renderGeminiBubble(text);
  }

  /** 记录本次观影的聊天 (供最终总结用, 只在内存) */
  function recordChat(role, text) {
    if (!text) return;
    watchSession.chatLog.push({ role: role, text: String(text).slice(0, 500) });
    // 只留最近 60 条, 防止长时间观影无限增长
    if (watchSession.chatLog.length > 60) watchSession.chatLog.shift();
  }

  /**
   * 发一个后台摘要请求并等待结果。
   * ⚠️ 绝不能与用户消息并发 (会破坏 Live 单通道)。
   */
  function requestSummary(kind, instruction) {
    if (watchSession.pendingSummary) {
      return Promise.reject(new Error('已有摘要请求在进行中'));
    }
    if (!S.client || !S.client.isReady()) {
      return Promise.reject(new Error('Live 未就绪'));
    }

    var p = {
      kind: kind,
      buffer: '',
      resolve: null,
      timer: null
    };
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

  /** 摘要请求收尾 (无论成功失败都要调用) */
  function finishSummary(p) {
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    if (watchSession.pendingSummary === p) watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    renderStatus('ready');
    renderPlotPanel();
  }

  /** 摘要期间排队的用户消息, 摘要完成后补发 */
  function flushQueuedUserText() {
    if (watchSession.queuedUserText) {
      var q = watchSession.queuedUserText;
      watchSession.queuedUserText = null;
      log('摘要完成, 补发排队的用户消息');
      doSendUserText(q);
    }
  }

  /**
   * 阶段剧情摘要: 基于【上一版摘要 + 最近几分钟的新剧情】重新压缩。
   * 始终只保留一份 currentPlotSummary, 不追加历史。
   */
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
    // 条件: 已启用 / 没在忙 / 视频在播 / 没在做最终总结
    if (!S.enabled || watchSession.summaryBusy) return;
    if (watchSession.finalSummaryRequested) return;
    var video = getVideo();
    if (!video || video.paused || video.ended) return;   // 暂停时不产生无意义摘要
    if (!S.client || !S.client.isReady()) return;

    requestSummary('stage', buildStageSummaryInstruction())
      .then(function (text) {
        if (text && text.trim()) {
          watchSession.currentPlotSummary = text.trim();
          watchSession.summaryUpdatedAt = Date.now();
          watchSession.summaryCount++;
          log('✅ 阶段剧情摘要已更新 (' + watchSession.summaryCount + ' 次, ' +
            watchSession.currentPlotSummary.length + ' 字)');
          renderPlotPanel();
        } else {
          logWarn('阶段摘要返回空, 保留上一版');
        }
      })
      .catch(function (err) {
        logWarn('阶段摘要失败:', err.message);
      })
      .then(function () {
        finishSummary(watchSession.pendingSummary);
        flushQueuedUserText();
        scheduleStageSummary();
      });
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

  /** 写进 330 唯一的长期记忆库 (完全沿用项目现有范式) */
  function saveToLongTermMemory(chat, content) {
    // ⚠️ 写入范式对齐 memory-summary.js:3778 / data-management.js:3206 / werewolf.js:991
    //    结构: { content, timestamp, source }  +  await db.chats.put(chat)
    var entry = {
      content: content,
      timestamp: Date.now(),
      source: 'watch_together_summary'
    };
    if (!chat.longTermMemory) chat.longTermMemory = [];
    chat.longTermMemory.push(entry);
    return db.chats.put(chat).then(function () {
      log('✅ 观影记忆已写入长期记忆库, source=watch_together_summary, ' + content.length + ' 字');
      return true;
    });
  }

  /**
   * 自动连接 (第一阶段 UX 方案 A: 播就连, 不用手动点按钮)。
   * 由 <video> 的 play 事件触发。
   *
   * 守卫条件 (任一不满足就静默跳过, 不打扰用户):
   *   - 已经连着 (已启用 或 正在连) → 什么都不做
   *   - 没填 key → 提示一次, 之后不再打扰
   *   - 不是本地视频 (blob:) → 第一阶段不支持, 静默跳过
   *   - 本次会话已经因为没 key 提示过了 → 不重复提示
   */
  var _autoTried = false;   // 本次观影会话是否已尝试过自动连接 (防抖)

  function autoConnect(reason) {
    if (!S.autoMode) return false;
    if (S.enabled || (S.client && (S.client.state === 'connecting' || S.client.state === 'ready'))) {
      // 已经在连或已连 → 只恢复发帧
      if (S.enabled && S.client && S.client.isReady()) {
        S.paused = false;
        renderStatus('ready');
      }
      return false;
    }
    if (!getGeminiKey()) {
      if (!_autoTried) {
        _autoTried = true;
        log('没填 Gemini key, 跳过自动连接 (只提示这一次)');
        appendSystemLine('💡 想让 Gemini 边看边懂？点「设置」齿轮填一下 Gemini Live API Key');
      }
      return false;
    }
    var video = getVideo();
    if (!video || !video.src || video.src.indexOf('blob:') !== 0) {
      // 第一阶段只支持本地视频
      return false;
    }
    log('自动连接 (触发: ' + (reason || 'video play') + ')');
    enable();
    return true;
  }

  /**
   * 用户关闭「一起看电影」→ 顺便重置自动连接的防抖状态,
   * 下次进来还能重新自动连。
   */
  function resetAutoState() {
    _autoTried = false;
  }

  function setAutoMode(on) {
    S.autoMode = !!on;
    log('自动连接模式: ' + (S.autoMode ? '开' : '关'));
  }

  // ============================================================
  // 长时间观看不断线 — session resumption
  // ============================================================
  // 官方 live.md.txt:249   setup 里带 sessionResumption → 服务端持续发 SessionResumptionUpdate
  // 官方 live.md.txt:353  重连时把 handle 塞回 setup 即可接着上次对话
  //
  // 已知硬限制 (第一阶段不改, 记录下来):
  //   音视频会话约 2 分钟、纯音频约 15 分钟是服务端上限, 超过会被断。
  //   resumption 能保住"对话上下文", 但【不能】让连接无限延长。
  //   要真正无限就得加 contextWindowCompression (live.md.txt:250), 那是下一阶段的事。

  var HANDLE_KEY = 'wt_gemini_live_resume_handle';
  var MAX_RETRY = 5;          // 最多重试 5 次
  var RETRY_BASE_MS = 2000;    // 指数退避基数: 2s, 4s, 8s, 16s, 32s
  var _retryCount = 0;
  var _retryTimer = null;

  function loadHandle() {
    try { return localStorage.getItem(HANDLE_KEY) || ''; } catch (e) { return ''; }
  }
  function saveHandle(h) {
    try {
      if (h) localStorage.setItem(HANDLE_KEY, h);
      else localStorage.removeItem(HANDLE_KEY);
    } catch (e) { /* noop */ }
  }
  function clearRetry() {
    _retryCount = 0;
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  }

  /**
   * 连接被意外断开 → 安排重连 (指数退避)。
   * 用户主动关闭 / 离开观影 时不会走到这里。
   */
  function scheduleReconnect(reason) {
    if (S._userDisabled || S._leaving) return;
    if (_retryCount >= MAX_RETRY) {
      logWarn('重连次数用完 (' + MAX_RETRY + '), 放弃自动重连');
      appendSystemLine('⚠️ 多次重连失败，已停止自动重连。你可以点标题栏「Gemini Live」手动重连。');
      renderStatus('closed', '重连失败');
      return;
    }
    var delay = RETRY_BASE_MS * Math.pow(2, _retryCount);
    _retryCount++;
    logWarn('安排重连 (' + _retryCount + '/' + MAX_RETRY + '), ' + delay + 'ms 后重试, 原因: ' + reason);
    appendSystemLine('🔄 连接断开，' + Math.round(delay / 1000) + ' 秒后自动重连…');
    renderStatus('connecting', '重连中');
    if (_retryTimer) clearTimeout(_retryTimer);
    _retryTimer = setTimeout(function () {
      _retryTimer = null;
      if (!S.enabled || S._userDisabled || S._leaving) return;
      if (!S.client) {
        // client 没了 (比如视频源换了), 重新走 enable
        enable();
        return;
      }
      S.client.reconnect().then(function (ok) {
        if (ok) {
          clearRetry();
          startFrameLoop();
          log('✅ 重连成功, 上下文已恢复');
          appendSystemLine('✅ 已重新连接（对话上下文保留）');
        }
      }).catch(function (err) {
        log('重连失败:', err.message);
        scheduleReconnect(err.message);
      });
    }, delay);
  }

  // ============================================================
  // 启用 / 停用
  // ============================================================

  // LiveClient 状态变化 → 更新顶部状态条 + 同步标题栏按钮
  // (按钮平时不用点, 它只是反映"现在到底连着没有", 以及提供临时开关)
  function onClientState(state, detail) {
    renderStatus(state, detail);
    if (typeof window.__wtSyncLiveBtn === 'function') {
      var on = (state === 'ready' || state === 'connected' || state === 'connecting');
      window.__wtSyncLiveBtn(state === 'connecting' ? false : on);
    }
    if (state === 'ready') {
      clearRetry();                       // 连上了, 重试计数归零
      appendSystemLine('✅ Gemini Live 已连接，正在持续接收视频画面（1 帧/秒）');
      log('Live 就绪, 开始发帧');
      // v0.4.0: 开一个新的 watch session 并启动阶段摘要循环
      // ⚠️ reconnect 也会走到这里 —— 换 watchSessionId 但【不】触发最终总结
      //    (最终总结只由用户主动退出触发), 所以不会因重连产生重复记忆。
      if (watchSession.closed || !watchSession.watchSessionId) {
        newWatchSession(S.chatId);
        appendSystemLine('📖 我会每隔几分钟在「剧情记忆」里整理一次剧情，方便待会儿写观影记忆。');
      }
      scheduleStageSummary();
      renderPlotPanel();
    } else if (state === 'closed' && S.autoMode && !S._userDisabled) {
      // 非用户主动关闭 → 走 session resumption 重连
      scheduleReconnect('连接被关闭');
    }
  }

  /**
   * 开启 Gemini Live 模式。
   * @returns {Promise<boolean>} 是否成功连上
   */
  function enable() {
    if (S.enabled) return Promise.resolve(true);

    var apiKey = getGeminiKey();
    if (!apiKey) {
      var msg = '没填 Gemini Live API Key，请点「设置」按钮（齿轮）填一下';
      log('无法启动:', msg);
      appendSystemLine('⚠️ ' + msg);
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

    var chatForPrompt = null;
    try {
      if (typeof state !== 'undefined' && state && state.chats) {
        // chatId 来源与 getGeminiKey() 一致 (window.watchTogetherState.chatId)
        var cid = (window.watchTogetherState && window.watchTogetherState.chatId) || null;
        if (cid) {
          S.chatId = cid;
          chatForPrompt = state.chats[cid] || null;
        }
      }
    } catch (e) { /* noop */ }
    if (!watchSession.chatId && chatForPrompt) newWatchSession(chatForPrompt.id);

    S.client = new window.LiveClient({
      apiKey: apiKey,          // 每人自己的 key 直连, 零后端
      // 人设 = 主聊天同一个 aiPersona; 长期记忆 = 主聊天同一个 longTermMemory
      systemPrompt: buildSystemPrompt(chatForPrompt),
      onState: onClientState,
      // ⬇ 关键路由: 有 pendingSummary → 进剧情记忆, 绝进气泡
      onModelText: handleModelText,
      onTurnComplete: function () {
        resetBubble();
        onTurnCompleteInternal();
      },
      // ── session resumption: 服务端每给一个存档点就存起来, 重连时用得上 ──
      onSessionResumption: function (info) {
        if (info && info.handle) {
          saveHandle(info.handle);
          if (info.resumable) {
            log('📌 存档点已保存 (断线可恢复, resumable=true)');
          }
        } else if (info && !info.resumable) {
          log('服务端说当前不可恢复 (resumable=false), 重连将从新会话开始');
        }
      },
      onUsage: function (meta) {
        log('usage: total=' + meta.totalTokenCount + ' prompt=' + meta.promptTokenCount +
          ' response=' + meta.responseTokenCount);
      },
      onGoAway: function () {
        appendSystemLine('⚠️ 服务端即将断开连接');
      },
      onError: function (err) {
        appendSystemLine('⚠️ Gemini Live 错误: ' + err.message);
      }
    });

    // 带上上次保存的 handle (如果还在有效期内), 这样刷新页面/断网重连也能续上对话
    var savedHandle = loadHandle();
    if (savedHandle) {
      S.client.setResumeHandle(savedHandle);
      log('已载入上次的 session handle (长度 ' + savedHandle.length + '), 将尝试恢复对话');
    }

    log('开始连接 Gemini Live (authMode=key, 零后端)');

    return S.client.connect()
      .then(function () {
        // connect() resolve 只代表 WS 打开, 还要等 setupComplete
        return new Promise(function (resolve) {
          var waited = 0;
          var iv = setInterval(function () {
            waited += 200;
            if (S.client && S.client.isReady()) {
              clearInterval(iv);
              startFrameLoop();
              resolve(true);      // 提示文案由 onClientState 统一发, 这里不重复
            } else if (waited > 20000) {
              clearInterval(iv);
              log('等 setupComplete 超时 20s');
              appendSystemLine('⚠️ 等待 Gemini 初始化超时（setup 未完成）');
              resolve(false);
            } else if (S.client && (S.client.state === 'error' || S.client.state === 'closed')) {
              clearInterval(iv);
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

  /**
   * 关闭 Gemini Live 模式 (销毁 session)。
   * 视频暂停时【不要】调这个 —— 那是 pauseFrames() 的场景。
   */
  function disable(reason) {
    log('停用 Gemini Live' + (reason ? ' (' + reason + ')' : ''));
    clearRetry();                      // 取消任何待执行的重连
    stopFrameLoop();
    if (S.client) {
      try { S.client.close(reason || 'disabled'); } catch (e) { /* noop */ }
      S.client = null;
    }
    S.enabled = false;
    S.paused = false;
    S._userDisabled = true;      // 用户主动关的 → 别自动连回来
    resetBubble();
    renderStatus('closed');
    if (S.statusEl) S.statusEl.style.display = 'none';
    if (typeof window.__wtSyncLiveBtn === 'function') window.__wtSyncLiveBtn(false);
    renderPlotPanel();          // v0.4.1: Live 关了 → 面板跟着隐藏
  }

  /**
   * v0.4.0 用户主动退出一起看电影。
   *
   * ⚠️ 严格顺序 (用户第七节要求):
   *    锁定 session → 停止接受新请求 → 请求最终观影记忆 → 生成成功
   *    → 写入 330 唯一长期记忆库 → 确认 await db.chats.put 成功
   *    → 关闭 Live → 真正退出
   *
   *    绝不能: 先关 Live 再总结 (关了就拿不到了)
   *
   * @returns {Promise<{saved:boolean, error?:string}>}
   *   init-features.js 必须 await 它, 只有 saved 或明确失败后才继续关闭弹窗。
   */
  function onLeaveWatchTogether() {
    // 防重复: 已经在流程里就直接返回同一个 promise
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

  /** 真正的流程: 总结 → 写库 → 确认 */
  function runFinalSummaryFlow() {
    var chat = null;
    try {
      if (typeof state !== 'undefined' && state && state.chats) {
        chat = state.chats[watchSession.chatId] || null;
      }
    } catch (e) { /* noop */ }

    // 没有有效的 session / Live 不可用 → 直接放行退出, 不产生记忆
    if (!S.enabled || !S.client || !S.client.isReady() || !chat) {
      log('没有可总结的 Live session, 直接退出');
      hardLeave();
      return Promise.resolve({ saved: false, skipped: true });
    }

    // 锁定: 防止重复点退出 / 换视频 / 重连重复触发
    if (watchSession.finalSummaryRequested) {
      log('最终总结已在进行中, 忽略重复请求');
      return watchSession.leavePromise || Promise.resolve({ saved: false, error: 'already_requested' });
    }
    watchSession.finalSummaryRequested = true;

    renderStatus('connecting', '正在整理观影记忆');
    appendSystemLine('⏳ 正在整理这次观影记忆，请稍等一下…');
    renderPlotPanel();

    // 等当前可能正在跑的阶段摘要结束, 避免两个 turn 打架
    var waitReady = waitForNoPendingSummary();

    return waitReady
      .then(function () {
        return requestSummary('final', buildFinalSummaryInstruction());
      })
      .then(function (text) {
        var content = (text || '').trim();
        if (!content) {
          throw new Error('Gemini 没有返回观影记忆内容');
        }
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
        // ⚠️ 失败时【不关 Live】, 让用户能重试 (用户第四节)
        logError('观影记忆未保存成功:', err.message);
        watchSession.finalSummaryRequested = false;   // 允许重试
        S._leaving = false;
        appendSystemLine('⚠️ 观影记忆还没有生成成功：' + err.message);
        renderStatus('ready');
        renderPlotPanel();
        if (typeof window.__wtShowRetrySummary === 'function') window.__wtShowRetrySummary();
        return { saved: false, error: err.message };
      });
  }

  /** 等当前阶段摘要 turn 结束 (最多等 3 秒, 免得卡死退出) */
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

  /** 真正关闭 Live (只有在不需要总结, 或总结已保存后才走这里) */
  function hardLeave() {
    watchSession.closed = true;
    stopStageSummary();
    S._leaving = true;
    disable('离开一起看电影');
    resetAutoState();
    S._userDisabled = false;
    S.canvas = null;
    S.ctx = null;
    S.framesSent = 0;
  }

  /** 重试生成观影记忆 (失败后由 UI 调用) */
  function retryFinalSummary() {
    if (watchSession.finalSummarySaved) {
      return Promise.resolve({ saved: true });
    }
    log('用户手动重试生成观影记忆');
    watchSession.leavePromise = runFinalSummaryFlow()
      .catch(function (err) {
        logError('重试仍然失败:', err.message);
        return { saved: false, error: err.message };
      });
    return watchSession.leavePromise;
  }

  /** 视频暂停 → 停发帧, 保留 session (用户第十节要求) */
  function pauseFrames(reason) {
    if (!S.enabled) return;
    S.paused = true;
    log('暂停发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  /** 视频继续 → 恢复发帧 */
  function resumeFrames(reason) {
    if (!S.enabled || !S.client || !S.client.isReady()) return;
    S.paused = false;
    log('恢复发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  /** 真正把用户消息发给 Gemini (已确保没有摘要 turn 在途) */
  function doSendUserText(text) {
    var video = getVideo();
    var extra = (video && !video.paused && !video.ended)
      ? '' : '（视频当前是暂停/结束状态，只能根据之前收到的画面回答）';
    resetBubble();
    recordChat('user', text);
    S.client.sendUserText(String(text || ''));
    appendSystemLine('💬 ' + text + extra);
  }

  /**
   * 用户在「一起看电影」输入框发消息时调用。
   * @returns {boolean} 是否被 Live 模式接管 (false = 应走旧逻辑/主 API)
   */
  function handleUserMessage(text) {
    if (!S.enabled) return false;

    // 正在做最终总结 → 不接受新提问
    if (watchSession.finalSummaryRequested) {
      appendSystemLine('⚠️ 正在整理这次观影记忆，请稍等…');
      return true;
    }

    if (!S.client || !S.client.isReady()) {
      appendSystemLine('⚠️ Gemini Live 还没就绪，暂时无法提问');
      return true;   // 接管了, 不要落到主 API
    }

    // ⚠️ 关键: 摘要 turn 在途时【排队】, 绝不并发发第二个 turn 破坏 Live
    if (watchSession.pendingSummary) {
      watchSession.queuedUserText = String(text || '');
      appendSystemLine('⏳ 正在整理剧情，请稍等一下…你的消息会在整理完成后自动发出。');
      log('摘要进行中, 用户消息已排队');
      return true;
    }

    doSendUserText(text);
    return true;
  }

  /** 回合结束: 摘要收尾 + 补发排队消息 */
  function onTurnCompleteInternal() {
    log('Gemini 回合结束');
    if (watchSession.pendingSummary) {
      var p = watchSession.pendingSummary;
      var buf = (p.buffer || '').trim();
      if (buf) p.resolve(buf);
      else p.resolve('');
      finishSummary(p);
      flushQueuedUserText();
    }
  }

  /** 视频 ended → 停发帧, 不销毁 session (用户第十节要求) */
  function onVideoEnded() {
    if (!S.enabled) return;
    S.paused = true;
    log('视频播放结束, 停止发帧 (session 保留)');
    renderStatus('ready');
  }

  /**
   * 视频源被替换 (用户重新选了本地文件) → 断开并开新 watch session
   * 旧 session 的剧情摘要【不写入长期记忆】, 只是丢弃 (它是临时记忆)
   */
  function onVideoSourceChanged() {
    var oldId = watchSession.watchSessionId;
    log('视频源已更换, 结束旧 watch session: ' + oldId + ' (其剧情摘要不写入长期记忆)');
    stopStageSummary();
    watchSession.currentPlotSummary = '';
    watchSession.summaryCount = 0;
    watchSession.summaryUpdatedAt = 0;
    watchSession.finalSummaryText = '';
    watchSession.finalSummarySaved = false;
    watchSession.finalSummaryRequested = false;
    watchSession.chatLog = [];
    // v0.4.2: 换视频 → 折叠并解除 pinned, 新一轮从零开始
    plotPanelOpen = false;
    plotPanelPinned = false;
    S.canvas = null;
    S.ctx = null;
    S.framesSent = 0;
    if (S.enabled) {
      // Live 保持连接, 只是换观察对象; 等下次 play 会重新开 session
      disable('视频源更换');
    } else {
      newWatchSession(S.chatId);
    }
    renderPlotPanel();
  }

  // ============================================================
  // 导出
  // ============================================================

  window.WatchTogetherLive = {
    enable: enable,
    disable: disable,
    autoConnect: autoConnect,
    onLeaveWatchTogether: onLeaveWatchTogether,
    setAutoMode: setAutoMode,
    resetAutoState: resetAutoState,
    pauseFrames: pauseFrames,
    resumeFrames: resumeFrames,
    handleUserMessage: handleUserMessage,
    onVideoEnded: onVideoEnded,
    onVideoSourceChanged: onVideoSourceChanged,
    retryFinalSummary: retryFinalSummary,
    togglePlotPanel: togglePlotPanel,
    isEnabled: function () { return S.enabled; },
    isReady: function () { return !!(S.client && S.client.isReady()); },
    getStats: function () {
      return {
        enabled: S.enabled,
        ready: !!(S.client && S.client.isReady()),
        framesSent: S.framesSent,
        paused: S.paused,
        state: S.client ? S.client.state : 'idle'
      };
    },
    // v0.4.0 剧情记忆 (只读, 供面板和调试用; 绝不落长期记忆)
    getWatchSession: function () {
      return {
        watchSessionId: watchSession.watchSessionId,
        currentPlotSummary: watchSession.currentPlotSummary,
        summaryUpdatedAt: watchSession.summaryUpdatedAt,
        summaryCount: watchSession.summaryCount,
        summaryBusy: watchSession.summaryBusy,
        finalSummaryRequested: watchSession.finalSummaryRequested,
        finalSummarySaved: watchSession.finalSummarySaved,
        finalSummaryText: watchSession.finalSummaryText,
        chatCount: watchSession.chatLog.length
      };
    }
  };

  // 剧情记忆面板的点击 (事件委托, 避免重复绑定)
  // v0.4.1: 点面板【空白处/标题栏】切换展开; 点了正文区(可滚动)不切换
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var panel = t.closest('#wt-plot-panel');
    if (!panel) return;
    // 正文容器上标了 data-noscroll, 点它是为了滚动内容, 不是切换
    if (t.closest('[data-noscroll]')) return;
    togglePlotPanel();
  }, true);

  log('watch-together-live.js 已加载 (桥接层: 视频帧 + 陪聊 + 剧情摘要 + 观影记忆)');
})();
