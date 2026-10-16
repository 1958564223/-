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
//   ⚠️ 2026-10-11 起【不再注入 longTermMemory】(原因见 buildSystemPrompt 里的长注释)。
//      看剧时只给人设(语气), 不喂生活记忆 —— 记忆会跟剧情抢注意力, 让接话变蠢。
//      观影记忆精炼是另一条独立指令, 不受影响。
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
  // 2026-10-09 放宽: 原来 1500 / 1000 / 400 三处都偏紧。
  // 文字几乎不占空间, 而这些数字一旦卡死, 模型只能写废话 —— 那才是真丢信息。
  var PLOT_SUMMARY_MAX_CHARS = 2000;      // 长剧: 每 5 分钟滚动摘要
  var FINAL_MEMORY_TARGET_CHARS = 1500;   // 退出时的最终观影记忆
  var SERIES_OUTLINE_MAX_CHARS = 1500;    // 短剧: 每 20 集合并出的总纲
  var SUMMARY_REQUEST_TIMEOUT_MS = 45000;

  // 🔴 2026-10-10 摘要收尾判据: 静默多少毫秒算"这次说完了"。
  //
  // 【为什么不再用 turnComplete 收摘要】(用户实测: 手动总结死活不落盘 + 片段漏进聊天框)
  //   turnComplete 是【音频回合】的边界, 不是"这段文字说完了"的保证。
  //   观影时 1 FPS 一直在送帧 → 回合被不停推进。于是发完请求后,
  //   极容易撞上一个【上一回合正在收尾】:
  //     ① 上一回合的尾巴文字到达 → handleModelText 把它塞进新请求的 buffer, gotText=true
  //     ② 那个回合的 turnComplete 到达 → onTurnCompleteInternal 看到 gotText 就 resolve
  //        → 收走的是【半截 + 上集尾巴】
  //     ③ 用户真正要的总结正文这才开始吐 → pendingSummary 已 null → 全漏进聊天框
  //   10-09 加的 gotText 门只能防"一个字都没到就收", 防不住"收早了" —— 症状一模一样。
  //
  // 【新办法: 不看回合边界, 只看"安静了多久"】
  //   每次收到一个字就重置静默计时; 连续 SUMMARY_SETTLE_MS 没新字 → 判定说完, resolve。
  //   流式输出时字与字之间的间隔远小于 2 秒, 所以只有真的说完了才会安静下来。
  //   这样收摘要跟回合边界彻底解耦, 无论它落在哪个 turn 上都无所谓。
  var SUMMARY_SETTLE_MS = 2000;

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
    // 摘要被强行丢弃后的"迟到文本"静默窗口 (毫秒时间戳)。
    // 丢弃之后模型可能还在把这半句吐完, 那段字绝不能进下一次摘要的 buffer。
    summaryGhostUntil: 0,
    summaryTimer: null,
    queuedUserText: null,
    finalSummaryRequested: false,
    finalSummarySaved: false,
    finalSummaryText: '',
    chatLog: [],
    closed: false,
    leavePromise: null,
    // 已累计的【视频实际播放】毫秒数, 不是墙上时钟。
    // 用来实现"暂停时计时也暂停, 回来接着算"(2026-10-07 用户要求)。
    playedMs: 0,
    playingSince: 0,          // 正在播放时的起点戳; 暂停时为 0
    // 本轮摘要计时是什么时候起的 (按 playedMs 坐标系)。暂停不重置它,
    // 恢复后靠 scheduleStageSummary() 算还差多少。
    lastSummaryStartedAt: 0,
    // ---- 短剧专用 (2026-10-07) ----
    kind: 'film',              // 'film' = 长剧 | 'series' = 短剧
    seriesKey: null,           // 短剧: 剧名
    seriesTitle: '',           // 短剧: 剧名(显示用)
    seriesLastEp: 0,           // 短剧: 已看到第几集
    seriesOutline: '',         // 短剧: 总纲(每 20 集合并一次, 跨场保留)
    episodeMemories: [],       // 短剧: 本次攒的单集记忆 [{ep, text}]
    // 🔴 2026-10-10 用户实测: 退出再进来播第3集, 总结写成"第一集"。
    //   nowPlayingEp = 宿主传来的【这次实际播的集号】(用户点的按钮),
    //   onVideoEnded 播完时直接用它, 不再用 seriesLastEp+1 去猜 ——
    //   猜在"草稿恢复还没跑完"时序下会把第3集当第1集, 还会覆盖掉第1集的记忆。
    nowPlayingEp: 0,
    // ---- 短剧前情提要 (2026-10-15) ----
    // 【它解决什么】episodeMemories / seriesOutline 全是内存里的, 退出精炼成功后
    //   一律清空, 下次进来模型对这部剧是零认知 —— 用户看第 3 集时问"刚那个人是谁",
    //   它答不上来, 后面总结剧情也容易断片。
    //   seriesRecap = 上一场退出时生成的跨场底稿 (从 Dexie 读出来的整行),
    //   进片时喂回模型; 本次退出时重写覆盖。
    seriesRecap: null,
    seriesRecapInjectPending: false   // 切剧时置 true, 等 Live ready 后发注入回合
  };

  /** 当前这次 play 段已跑了多久 (ms); 没在播放时返回 0 */
  function currentPlaySegmentMs() {
    if (!watchSession.playingSince) return 0;
    return Date.now() - watchSession.playingSince;
  }

  /** 已播放总时长 (ms) —— 暂停期间不算 */
  function totalPlayedMs() {
    return watchSession.playedMs + currentPlaySegmentMs();
  }

  /** 开始累计 (video play 时调) */
  function markPlaying() {
    if (!watchSession.playingSince) watchSession.playingSince = Date.now();
  }

  /** 暂停累计 (video pause / ended 时调) —— 把这一段结算进 playedMs */
  function markPaused() {
    if (!watchSession.playingSince) return;
    watchSession.playedMs += Date.now() - watchSession.playingSince;
    watchSession.playingSince = 0;
  }

  /**
   * 按【已播放时长】重排摘要定时器, 而不是每次都排满 5 分钟。
   *
   * 旧写法是 setTimeout(5分钟) 然后 finally 里无条件重排 —— 暂停一次就丢 5 分钟,
   * 因为定时器在暂停期间照跑, 只是 tick 撞到 video.paused 就 return。
   * 现在改成: 暂停时把剩余时间原样冻结, 恢复后接着算剩下的那部分。
   *
   * ⚠️ 同时必须清掉 watchSession.summaryTimer, 否则旧定时器还在飞,
   *    会跟新算出来的剩余时间打架 (两套定时器同时 tick)。
   */
  function scheduleStageSummary(delayMs) {
    if (watchSession.summaryTimer) {
      clearTimeout(watchSession.summaryTimer);
      watchSession.summaryTimer = null;
    }
    var waited = 0;
    // ⚠️ 必须用 !== null 之类的显式判断, 不能用真值判断 ——
    // lastSummaryStartedAt 初始就是 0, 用 if (lastSummaryStartedAt) 会把
    // "本轮起点恰好是 0" 误判成 "本轮还没起表", 于是每次都重排满 5 分钟,
    // 变成永远等不到那一次。
    if (watchSession.lastSummaryStartedAt !== null && watchSession.lastSummaryStartedAt !== undefined) {
      waited = totalPlayedMs() - watchSession.lastSummaryStartedAt;
      if (waited < 0) waited = 0;          // 换片重置后可能出现负数
    }
    var remaining = WATCH_SUMMARY_INTERVAL_MS - waited;
    if (remaining < 0) remaining = 0;
    var delay = (delayMs === undefined) ? remaining : delayMs;
    watchSession.summaryTimer = setTimeout(tickStageSummary, delay);
  }

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
    watchSession.playedMs = 0;
    watchSession.playingSince = 0;
    watchSession.lastSummaryStartedAt = 0;
    watchSession.kind = 'film';
    watchSession.seriesKey = null;
    watchSession.seriesTitle = '';
    watchSession.seriesLastEp = 0;
    watchSession.seriesOutline = '';
    watchSession.episodeMemories = [];
    watchSession.nowPlayingEp = 0;
    watchSession.seriesRecap = null;
    watchSession.seriesRecapInjectPending = false;
    log('新的 Cinema watch session:', watchSession.watchSessionId);
    return watchSession.watchSessionId;
  }

  // ============================================================
  // 系统提示词 (迁移自 watch-together-live.js:88-161)
  // 人设来源跟旧文件一致; 但 2026-10-11 起【不再注入长期记忆】(见函数内注释)。
  // ============================================================
  function buildSystemPrompt(chat) {
    var c = chat || {};
    var persona = (c.settings && c.settings.aiPersona) || '';
    var userPersona = (c.settings && c.settings.myPersona) || '';
    var rawNick = (c.settings && c.settings.myNickname) || '';
    // 🔴 2026-10-11 用户要求: 昵称是默认的「我」(或没填) 时, 提示词里改用「用户」称呼,
    //   其他昵称照常。
    //   原因(用户原话): "光说我他哪知道是谁" —— 「我」在提示词里指代不清,
    //   模型分不清那是"用户名"还是"第一人称代词"。
    //   有真实昵称时保留原样, 并用「」标出"这是个名字"。
    var userRef = (!rawNick || rawNick === '我') ? '用户' : ('「' + rawNick + '」');
    var charName = c.name || c.originalName || '角色';

    // 🔴 2026-10-11 不再把 longTermMemory 注入系统提示词 (用户实测: 接话降智、说雷霆语言)
    //
    //   原来这里会把【最近 5 条长期记忆全文】拼进提示词, 每条可能上千字 → 最多上万字。
    //   问题不在于"多", 而在于【方向冲突】: 这些记忆讲的都是用户和角色的生活往事,
    //   跟正在看的剧毫无关系; 而看片时每秒还有一帧画面要处理。
    //   模型一边要跟着剧情, 一边被生活记忆的腔调往回拽 —— 用户看到的就是"接话蠢、雷霆语言"。
    //
    //   用户的对照组: 早先的独立测试页【没有注入记忆】时, 聊剧情明显更好。
    //   同一个模型、同一套画面, 唯一差别就是少喂了这些 → 这是最硬的证据。
    //
    //   所以影院只保留人设(语气来源), 不再喂记忆。
    //   ⚠️ 注意: 这只影响【看剧时的系统提示词】; 退出时的「观影记忆精炼」是另一条
    //      独立指令, 剧情内容自己带过去, 不依赖这里。删掉不会丢观影记忆。
    //   ⚠️ AI 侧气泡里仍然会显示角色头像(getAvatarUrl 读的是 chat.settings.aiAvatar,
    //      跟这里无关)。

    var out = [];
    out.push('# 你是谁');
    out.push('');
    out.push('你就是「' + charName + '」。');
    if (persona) {
      out.push('');
      out.push('## 你的角色设定');
      out.push('');
      out.push(persona);
    }
    out.push('');

    // 🔴 2026-10-11 用户实测: 女主被人追, 用户说"好紧张", 模型回"别怕, 玄澈会保护你的"
    //   —— 它把【看剧的用户】当成了【剧中的女主角】。
    //
    //   第一版修法写成了"反面例子 (❌/✅)"。用户指出这不对:
    //     举例是让模型自己在"例子"和"当下"之间做映射, 多一层心智负担。
    //     正确做法是【直接用陈述句把性质讲清楚】—— 讲清了, 它自然就不会认错人。
    //
    //   所以这一版改成正面叙述三件事:
    //     1. 你俩在家里的家庭影院一起看电视 (场景)
    //     2. 你看到的是【这部剧的剧情内容】(不是"视觉输入"这种技术说法)
    //     3. 跟你说话的是坐在旁边一起看的人, TA 不在电视里 (身份)
    out.push('# 现在是什么情况');
    out.push('');
    out.push('你和' + userRef + '正在家里的家庭影院一起看电视。');
    out.push(userRef + '就坐在你旁边，跟你一块儿看。');
    out.push('电视上正在放一部剧 —— 你看到的视频帧就是【这部剧的剧情内容】，是电视剧里的人和事。');
    out.push('画面是一张一张连续送过来的。');
    out.push('');
    out.push('# 跟你聊天的是谁');
    out.push('');
    out.push('跟你说话的是' + userRef + '，和你一起看剧的那个人 —— TA 是真人，坐在你旁边。');
    out.push('TA 不在电视里，也不是剧里的任何角色。');
    out.push('电视剧里的人物和情节（谁保护谁、谁喜欢谁、谁跟谁有什么过往）都只发生在电视上，');
    out.push('和你俩没有关系，不要往 TA 身上套。');
    out.push('TA 跟你说话，就是在跟你聊这部剧、或者随便闲聊，不是剧里的人在说话。');
    out.push('');
    if (userPersona) {
      out.push('# ' + userRef + '是什么人');
      out.push('');
      out.push(userPersona);
      out.push('');
    }
    out.push('# 怎么陪 TA 看');
    out.push('');
    out.push('1. 像真人一样自然地聊天、评论、吐槽、讨论，就像坐在沙发上一起看剧。');
    out.push('2. TA 的感慨和吐槽（比如"好紧张""好帅""气死我了"）是在跟你聊剧情，');
    out.push('   接住这个情绪跟 TA 一起聊就行，不要当成剧里的人在说话，也不要当成 TA 在向你求助。');
    out.push('3. TA 问"现在在演什么""这个人是谁""刚才是怎么了"，就用你看到的剧情回答。');
    out.push('4. 不要逐帧罗列画面，不要用"根据我的观察""作为一个 AI"这种说法。');
    out.push('5. 没看清就直说没看清，不要编造你没看到的剧情。');
    out.push('6. 保持你自己的说话方式和人设，不要变成一个中立助手。');
    out.push('7. 用中文，简洁自然。');
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

  function resetBubble() { S.bubbleEl = null; bubbleStreamId++; }

  // ============================================================
  // 剧情记忆面板 (Cinema Room 自己的, 可查看 + 可编辑)
  // ⚠️ 只显示当前 session 的临时记忆, 绝不写 chat.longTermMemory
  // ============================================================
  var plotPanelEl = null;
  // 2026-10-16: 删掉了 plotPanelOpen (原来是"聊天面板里那条折叠条"的展开标志)。
  //   剧情记忆现在是独立页面, 开合状态看 #cinema-plot-sheet 上的 .open 类。
  // 正在编辑哪一块: null = 没在编辑 | 'summary' = 当前剧情摘要 | 'ep:N' = 短剧第 N 集
  var plotEditing = null;
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
    // 🔴 2026-10-16 改: 挂进【独立的剧情记忆页】(cinema-plot-sheet),
    //   不再挂聊天面板。
    //   原来挂在聊天面板里当一条常驻折叠条, 用户反馈"又要显示剧情, 又要显示聊天记录,
    //   想改点剧情总结, 键盘一弹看都不怎么看的见" —— 挤在聊天框里, 手机屏根本不够分。
    //   现在由顶栏「记忆」按钮开一个底部上滑页, 跟设置/片单同一套。
    var host = document.getElementById('cinema-plot-sheet');
    if (host) {
      var head = host.querySelector('.cinema-source-head');
      if (head && head.nextSibling) host.insertBefore(el, head.nextSibling);
      else host.appendChild(el);
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

  /** 编辑用的 textarea + 保存/取消 (2026-10-07: 长剧摘要 + 短剧每集 共用) */
  function editBoxHtml(id, val) {
    return '<textarea class="cinema-plot-edit" id="' + id + '">' + esc(val) + '</textarea>' +
      '<div class="cinema-plot-edit-bar">' +
      '<button class="cinema-plot-btn" data-plot="save">保存</button>' +
      '<button class="cinema-plot-btn ghost" data-plot="cancel">取消</button>' +
      '</div>';
  }

  /**
   * 短剧专属那一块: 总纲 + 本次攒了多少集 (2026-10-07)
   *
   * 2026-10-07 补: 每集记忆都可以手动改。
   *   为什么这个最有用: 退出时的【最终观影记忆】是拿
   *   「当前剧情摘要 + 各集剧情」重新写的, 所以把每集改对,
   *   最终存进长期记忆的那条自然就跟着对了。
   */
  function buildSeriesHtml() {
    var eps = watchSession.episodeMemories || [];
    var epText;
    if (!eps.length) {
      epText = '<span class="dim">（还没攒到, 每看完一集自动记一条）</span>';
    } else {
      var rows = eps.map(function (e) {
        var tag = 'ep:' + e.ep;
        if (plotEditing === tag) {
          return '<div class="cinema-plot-ep editing">第' + e.ep + '集：' +
            editBoxHtml('cinema-plot-ep-edit', e.text) +
            '<div class="cinema-plot-hint">改完保存, 退出时的最终观影记忆会按你改过的内容重新写。</div>' +
            '</div>';
        }
        return '<div class="cinema-plot-ep">第' + e.ep + '集：' + esc(e.text) +
          '<button class="cinema-plot-btn tiny" data-plot="edit:' + tag + '">改</button>' +
          '</div>';
      });
      epText = rows.join('');
    }

    var outlineBlock = watchSession.seriesOutline
      ? '<div class="cinema-plot-text">' + esc(watchSession.seriesOutline) + '</div>'
      : '<div class="cinema-plot-text dim">（还没有总纲, 攒够 ' + SERIES_MERGE_AT + ' 集自动合并）</div>';

    // ---- 前情提要 (2026-10-15) ----
    // 放在最上面: 它是唯一跨场的东西, 也是下次进影院时模型唯一会知道的事。
    // 不给"编辑"按钮 —— 用户明说这块只要显示 + 手动删除。
    var rec = watchSession.seriesRecap;
    var recapHtml;
    if (rec && (rec.text || '').trim()) {
      recapHtml =
        '<div class="cinema-plot-text">' + esc(rec.text) + '</div>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="del-recap">删除</button>' +
        '<span class="cinema-plot-hint">到第 ' + (rec.lastEp || 0) + ' 集 · 更新于 ' +
          fmtTime(rec.updatedAt) + '</span>' +
        '</div>';
    } else {
      recapHtml = '<div class="cinema-plot-text dim">（还没有。看完点退出时会自动生成一份，下次进来就会自动带上）</div>';
    }

    return '<div class="cinema-plot-label">前情提要（跨场保留 · 下次进影院自动带上）</div>' +
        recapHtml +
        '<div class="cinema-plot-label">总纲（攒够 ' + SERIES_MERGE_AT + ' 集合并一次, 一直保留）</div>' +
        outlineBlock +
        '<div class="cinema-plot-label">本次已记 ' + eps.length + ' 集'
          + (watchSession.seriesLastEp ? ' · 看到第 ' + watchSession.seriesLastEp + ' 集' : '')
          + (eps.length ? ' · 点「改」可以自己修正' : '') + '</div>' +
        epText;
  }

  /**
   * 本次实际攒下了多少条记忆 (2026-10-07 用户真机截图反馈)
   *
   * 症状: 短剧看完一集, 展开面板里明明写着「本次已记 1 集」而且有第1集摘要,
   *       收起后那行却显示「0 次」, 状态点还是灰的 ⚪。
   *
   * 根因: 收起那行读的是 watchSession.summaryCount —— 那是【5 分钟定时摘要】的次数。
   *       而短剧模式下一集一条是走 watchSession.episodeMemories 的, 根本不经过
   *       summaryCount。所以短剧攒了 1 集, summaryCount 仍然是 0。
   *       展开面板里那句「本次已记 N 集」读的是另一个数据源, 两边对不上。
   *       状态点同理, 只看 currentPlotSummary, 短剧模式下它一直是空的 → 永远灰点。
   *
   * 改法: 统一一个"到底记了几条"的口径 —— 短剧看集数, 普通观影看定时摘要次数,
   *       取两者里更大的那个, 避免任何模式下都显示 0。
   */
  function memoryCount() {
    var eps = (watchSession.episodeMemories || []).length;
    var timed = watchSession.summaryCount || 0;
    return Math.max(eps, timed);
  }

  /** 有短剧集数就用「集」, 没有才用「次」—— 单位跟着数据源走 */
  function memoryUnit() {
    return (watchSession.episodeMemories || []).length > 0 ? ' 集' : ' 次';
  }

  /** 到底有没有记到东西(任一路径算过就算) */
  function hasAnyMemory() {
    return !!(watchSession.currentPlotSummary
      || watchSession.seriesOutline
      || (watchSession.episodeMemories || []).length
      || watchSession.summaryCount);
  }

  function buildPlotPanelHtml() {
    // 🔴 2026-10-16: 不再有"收起的一行标题"那一套了。
    //   原来这是聊天面板顶部一条可折叠的条 (点一下展开、再点收起), 因为它只能
    //   挤在聊天框里才有意义。现在它是独立页面, 由顶栏「记忆」按钮开、页面自带的
    //   「关闭」按钮收, 进来永远是展开的完整正文 —— 用户要的就是"能好好看清楚能改"。
    var busyHtml = watchSession.summaryBusy
      ? '<div class="cinema-plot-busy">⏳ 正在整理剧情，请稍等一下…</div>' : '';

    // 剧情摘要正文: 折叠时只读; 展开且点编辑时给 textarea
    var summaryBody;
    if (plotEditing === 'summary') {
      summaryBody = editBoxHtml('cinema-plot-edit', plotDraft) +
        '<div class="cinema-plot-hint">改这里没用, 退出时的最终观影记忆会按你改过的内容重新写一遍。</div>';
    } else if (watchSession.currentPlotSummary) {
      summaryBody =
        '<div class="cinema-plot-text">' + esc(watchSession.currentPlotSummary) + '</div>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="edit:summary">编辑</button>' +
        '</div>';
    } else {
      // 短剧是【按集】记忆的, 不是按 5 分钟。照抄普通观影那句"约 5 分钟后生成第一份"
      // 会让人以为功能没生效(用户真机截图就是被这句 + 「0 次」双重误导)。
      summaryBody = watchSession.kind === 'series'
        ? '<div class="cinema-plot-text dim">（短剧按集记忆：每看完一集自动记一条，看下面「本次已记」）</div>'
        : '<div class="cinema-plot-text dim">（还没有剧情摘要，约 5 分钟后生成第一份）</div>';
    }

    var finalHtml = watchSession.finalSummaryText
      ? '<div class="cinema-plot-text">' + esc(watchSession.finalSummaryText) + '</div>'
      : '<div class="cinema-plot-text dim">（观影结束后生成）</div>';

    // 🔴 2026-10-10 手动生成区。
    //   之前退出流程会自动总结, 失败就没了; 现在改成用户自己点, 点一次失败可以再点。
    //   已保存 / 正在生成 / 压根没内容 → 三种情况按钮都禁用, 免得点了没反应。
    var finalizeBar = '';
    if (!watchSession.finalSummarySaved) {
      var canFinalize = draftHasContent() && !watchSession.summaryBusy && !watchSession.pendingSummary;
      finalizeBar =
        '<div class="cinema-plot-finalize">' +
        '<button class="cinema-plot-btn primary' + (canFinalize ? '' : ' disabled') +
        '" data-plot="finalize"' + (canFinalize ? '' : ' disabled') + '>' +
        (watchSession.summaryBusy ? '⏳ 正在整理…' : '💾 生成观影记忆') + '</button>' +
        '<div class="cinema-plot-hint">' +
        (draftHasContent()
          ? '随时可以点。存进长期记忆后点顶部「退出」离开房间；失败可以反复点，你的记忆不会丢。'
          : '看剧时这里会攒剧情记忆，有了之后就能生成。') +
        '</div></div>';
    }

    // 🔴 状态点保留: 收起时那一行没了, 但进来一眼要能看出"有没有在整理/有没有记忆"。
    //   放在正文最上面, 当页面自己的状态条用。
    var dot = watchSession.summaryBusy ? '🟡' : (hasAnyMemory() ? '🟢' : '⚪');
    var savedTag = watchSession.finalSummarySaved ? ' · 记忆已存' : '';

    return '<div class="cinema-plot-head">' + dot + ' 本次已记 ' + memoryCount() + memoryUnit() +
        esc(savedTag) + '</div>' +
      '<div class="cinema-plot-body" data-noscroll="1">' +
      '<div class="cinema-plot-label">当前剧情摘要</div>' +
      summaryBody +
      busyHtml +
      (watchSession.kind === 'series' ? buildSeriesHtml() : '') +
      '<div class="cinema-plot-stat">更新 ' + fmtTime(watchSession.summaryUpdatedAt) +
        ' · 已记 ' + memoryCount() + memoryUnit() + '</div>' +
      '<div class="cinema-plot-label">最终观影记忆</div>' +
      finalHtml +
      finalizeBar +
      '</div>';
  }

  // ⚠️ 2026-10-16 删掉了 togglePlotPanel()。它是给"聊天面板里那条折叠条"用的
  //   (点一下展开、再点收起)。剧情记忆现在是独立页面, 开由顶栏「记忆」按钮、
  //   关由页面自带的「关闭」按钮, 进来永远是展开的 —— 没有可折叠的东西了。

  /** 开始编辑某一块。target: 'summary' 或 'ep:N' */
  function startEditSummary(target) {
    var eps = watchSession.episodeMemories || [];
    if (String(target).indexOf('ep:') === 0) {
      var ep = parseInt(String(target).slice(3), 10);
      for (var i = 0; i < eps.length; i++) {
        if (eps[i].ep === ep) { plotDraft = eps[i].text || ''; break; }
      }
      plotEditing = 'ep:' + ep;
    } else {
      plotDraft = watchSession.currentPlotSummary || '';
      plotEditing = 'summary';
    }
    renderPlotPanel();
  }

  function saveEditedSummary() {
    var eps = watchSession.episodeMemories || [];

    if (String(plotEditing).indexOf('ep:') === 0) {
      var ep = parseInt(String(plotEditing).slice(3), 10);
      var taEp = document.getElementById('cinema-plot-ep-edit');
      var vEp = taEp ? taEp.value : plotDraft;
      var newText = String(vEp || '').trim();
      for (var i = 0; i < eps.length; i++) {
        if (eps[i].ep === ep) {
          // 存空会让那一行变成「第N集：」什么都没有, 看着像坏了 —— 留原文并提示
          if (!newText) {
            log('第 ' + ep + ' 集没填内容, 已保留原文');
          } else {
            eps[i].text = newText;
            log('用户手动修正了第 ' + ep + ' 集剧情');
          }
          break;
        }
      }
      plotEditing = null;
      renderPlotPanel();
      return;
    }

    var ta = document.getElementById('cinema-plot-edit');
    var val = ta ? ta.value : plotDraft;
    watchSession.currentPlotSummary = String(val || '').trim();
    if (watchSession.summaryUpdatedAt === 0) watchSession.summaryUpdatedAt = Date.now();
    plotEditing = null;
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
    if (act && act.indexOf('edit') === 0) { startEditSummary(act.slice(5)); return; }
    if (act === 'save') { saveEditedSummary(); return; }
    if (act === 'cancel') { plotEditing = null; renderPlotPanel(); return; }
    if (act === 'finalize') {
      // 🔴 2026-10-10 手动生成。不用 await —— 它自己会 appendSystemLine 报进度/结果,
      //   这里只是触发器, 面板会随状态刷新。
      log('用户点了「生成观影记忆」');
      generateFinalMemory();
      return;
    }
    // 🔴 2026-10-15 手动删除这部剧的前情提要。
    //   ⚠️ 文案第一版写成"这次退出时还是会重新生成一份" —— 那是拿最窄的场景
    //   (正在看这部剧的中途删掉、然后退出) 去吓用户。用户的实际用法是"看完了、
    //   不看了、才删", 那种情况下删掉就是永久没了。这版照实说两种情况。
    if (act === 'del-recap') {
      var r = watchSession.seriesRecap;
      if (!r || !(r.text || '').trim()) return;
      var msg = '确定要删除《' + (r.title || watchSession.seriesTitle || '这部剧') + '》的前情提要吗？\n\n' +
        '删了就真的没了，不会自己长回来。\n' +
        '只有你以后又看这部剧、看完退出的时候，才会重新生成一份新的。';
      if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
      deleteCurrentSeriesRecap();
      return;
    }
    // ⚠️ 2026-10-16: 原来这里收尾是 togglePlotPanel() —— 点面板空白处就折叠。
    //   剧情记忆现在是独立页面, 点空白不该有副作用 (尤其会把刚滚到的位置重置掉),
    //   所以面板内的点击一律只处理按钮, 什么都不做。
    return;
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
  var bubbleStreamId = 0;  // 当前这句话的唯一号。chatLog 靠它判断"是不是同一句还在流"
                            // → 同一句只留一条, 被后续增量覆盖, 不产生几十条碎片。

  function handleModelText(text, isFinal) {
    if (!text) return;

    // ⚠️ 2026-10-09: 摘要被【强行丢弃】后的迟到文本窗口。
    //   退出时如果上一条摘要还在跑, 我们会掐掉它换发最终总结;
    //   但模型那半句还在往回吐。这些迟到的字属于【已经作废的那次请求】,
    //   一旦被新请求的 buffer 收下, 最终观影记忆就又变成半截单集剧情。
    //   这段时间内一律丢弃, 也不置 gotText。
    if (watchSession.summaryGhostUntil && Date.now() < watchSession.summaryGhostUntil) {
      return;
    }

    if (watchSession.pendingSummary) {
      var p = watchSession.pendingSummary;
      p.gotText = true;
      p.lastTextAt = Date.now();
      p.buffer += takeDelta(p.lastText, text);   // 摘要同样要去重, 否则整段是重复堆的
      p.lastText = text;
      // 🔴 每次收到字就重新起算静默计时 —— 说完了自然会安静下来, 计时到点才收。
      //   这取代了"靠 turnComplete 收", 见 SUMMARY_SETTLE_MS 的说明。
      if (typeof p.armSettle === 'function') p.armSettle();
      return;   // ⬅ 关键: 摘要文字绝不进聊天气泡
    }
    // 正常陪聊: 跨多个 turn 累加成【一整句】, 始终只占一个气泡
    bubbleText += takeDelta(bubbleText, text);
    if (bubbleText) renderGeminiBubble(bubbleText);
    // ⚠️ 只在回合收尾 (isFinal) 记一条【完整句子】, 绝不逐字记。
    //   中途增量进来时 bubbleText 还在长, 这时候记下来的是半截。
    if (isFinal) recordAssistantFinal(bubbleText);
  }

  function recordChat(role, text) {
    if (!text) return;
    var t = String(text).trim();
    if (!t) return;
    // 只记一句完整的话 —— 记录发生在"一句话说完"的时刻, 不是逐字流式时,
    // 否则同一句会被记成几十条碎片。
    // ⚠️ 2026-10-10: 之前只 recordChat('user'), 角色这边的回应从来没被记过,
    //   而 buildFinalSummaryInstruction 里明明写了 m.role === 'user' ? '用户' : '你'
    //   —— 双边对话才是"一起观影的回忆", 只记一边等于丢了现场。
    var last = watchSession.chatLog[watchSession.chatLog.length - 1];
    if (last && last.role === role && last.streamingId === bubbleStreamId) {
      last.text = t.slice(0, 500);   // 同一句还在流 → 覆盖, 不追加
      return;
    }
    watchSession.chatLog.push({ role: role, text: t.slice(0, 500), streamingId: bubbleStreamId, at: Date.now() });
    // ⚠️ 60 条上限以前会把【一整场】的吐槽前文挤掉。这里改成 200 条:
    //   草稿要落 localStorage, 200 条 × 500 字上限 ≈ 100KB, 完全放得下。
    //   另外开头留一条"本场开场提示", 让角色知道这次观影之前聊过什么。
    if (watchSession.chatLog.length > 200) watchSession.chatLog.splice(1, 1);
  }

  /** 记一句完整的角色回复。isFinal=true 才算这句话说完了。 */
  function recordAssistantFinal(text) {
    if (!text) return;
    var t = String(text).trim();
    if (!t) return;
    var last = watchSession.chatLog[watchSession.chatLog.length - 1];
    if (last && last.role === 'assistant' && last.streamingId === bubbleStreamId) {
      last.text = t.slice(0, 500);   // 同一句收尾 → 覆盖成最终文本
      return;
    }
    watchSession.chatLog.push({ role: 'assistant', text: t.slice(0, 500), streamingId: bubbleStreamId, at: Date.now() });
    if (watchSession.chatLog.length > 200) watchSession.chatLog.splice(1, 1);
  }

  // ============================================================
  // 摘要请求 —— 单通道, 绝不能与用户消息并发
  // 迁移自旧文件 :579-640
  // ============================================================
  function requestSummary(kind, instruction) {
    if (watchSession.pendingSummary) return Promise.reject(new Error('已有摘要请求在进行中'));
    if (!S.client || !S.client.isReady()) return Promise.reject(new Error('Live 未就绪'));

    // ⚠️⚠️ 2026-10-09 必须先排掉上一回合残留的转写全文 (用户实测: 看两集短剧,
    //   退出后的「最终观影记忆」整段变成了某一集的单集剧情原文)。
    //
    //   live-client.js 的 _lastTranscription 收到新转写就赋值, turnComplete 时又重抛它,
    //   但【从头到尾没有任何地方清空过它】(只在构造函数初始化为 '')。
    //   所以上一回合的全文会一直挂着, 之后任何一个 turnComplete 都会把它再喂一遍。
    //
    //   对正常聊天无害 (bubbleText 有 takeDelta 去重), 但摘要请求换人时是致命的:
    //   新的 p 的 lastText 是空的, takeDelta 去不了重 → 上一集的单集记忆全文
    //   被当成这次最终总结的内容收走, gotText 也被置 true, 竞态门形同虚设。
    //
    //   这里主动清一次, 让"这次摘要"只可能收到这次之后的文本。
    try { S.client._lastTranscription = ''; } catch (e) { /* noop */ }

    var p = {
      kind: kind, buffer: '', lastText: '',
      resolve: null, timer: null, settleTimer: null,
      lastTextAt: 0,
      // gotText: 见 handleModelText / onTurnCompleteInternal 的竞态说明。
      // 摘要请求发出去之后, 必须【真的收到模型的字】才允许被收走。
      gotText: false
    };
    var promise = new Promise(function (resolve) { p.resolve = resolve; });

    watchSession.pendingSummary = p;
    watchSession.summaryBusy = true;
    renderStatus('ready');
    renderPlotPanel();

    /**
     * 判定"这次摘要说完了" —— 连续 SUMMARY_SETTLE_MS 没新字。
     * 挂在 p.settleTimer 上, 每次 handleModelText 收到字就重新调一次(重新计时)。
     *
     * 为什么不用 turnComplete: 见 SUMMARY_SETTLE_MS 上面的注释。
     * 回合边界被视频帧推着走, 撞上上一回合收尾就会收早 → 漏进聊天框。
     */
    p.armSettle = function () {
      if (watchSession.pendingSummary !== p) return;   // 已被别的路径收走
      if (p.settleTimer) clearTimeout(p.settleTimer);
      if (!p.gotText) return;                          // 一个字都没吐, 继续等
      p.settleTimer = setTimeout(function () {
        if (watchSession.pendingSummary !== p) return;
        var buf = (p.buffer || '').trim();
        log('[摘要] ' + kind + ' 静默 ' + (SUMMARY_SETTLE_MS / 1000) + 's, 判定说完 (' + buf.length + ' 字)');
        p.resolve(buf);
        finishSummary(p);
      }, SUMMARY_SETTLE_MS);
    };

    p.timer = setTimeout(function () {
      if (watchSession.pendingSummary !== p) return;
      if (p.settleTimer) clearTimeout(p.settleTimer);   // 超时收走前先掐掉静默计时, 防二次 resolve
      watchSession.pendingSummary = null;
      watchSession.summaryBusy = false;
      logWarn('[摘要] ' + kind + ' 请求超时 (' + SUMMARY_REQUEST_TIMEOUT_MS + 'ms)');
      // 超时作废后, 已经吐出来的那半句可能还在继续流 —— 开静默窗口把它们丢掉,
      // 免得流进下一次摘要的 buffer (同 waitForNoPendingSummary 里的说明)。
      // 只在真的吐过字时才开, 免得连正常聊天都被误吞三秒。
      if (p.gotText) {
        watchSession.summaryGhostUntil = Date.now() + 3000;
        try { if (S.client) S.client._lastTranscription = ''; } catch (e) { /* noop */ }
      }
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
    if (p.settleTimer) clearTimeout(p.settleTimer);   // 静默计时器也要收, 别在收完后又 resolve 一次
    if (watchSession.pendingSummary === p) watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    // 摘要收尾后同样排掉 _lastTranscription, 免得这一整段全文在之后的
    // turnComplete 上被重抛, 混进下一次摘要 (同 requestSummary 里的说明)。
    // 正常聊天气泡有自己的 takeDelta, 清掉不影响连续性 ——
    // 下一次增量到达时 t !== '' 会正常重新赋值。
    try { if (S.client) S.client._lastTranscription = ''; } catch (e) { /* noop */ }
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
            // ⚠️ 这行必须加 (2026-10-07 用户实测: 摘要出来了, 计数一直 0)。
            //
            // 原因: summaryCount++ 跑在【微任务】里 —— onTurnCompleteInternal
            // 里 p.resolve() 只是把回调排进微任务队列, 同一轮里紧接着的
            // finishSummary() 已经同步调过 renderPlotPanel() 了, 那次渲染
            // 读到的还是旧计数。之后再没人触发渲染, 于是计数永远停在 0,
            // 而摘要正文因为别的路径刷新过又能显示出来。
            renderPlotPanel();
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
      // 本轮 5 分钟已满 → 下一轮从现在重新起算。
      // 但退房/禁用/要生成最终总结时不要再排 —— 那三种情况定时器本来就该停。
      if (S.enabled && !watchSession.finalSummaryRequested && !S._leaving) {
        watchSession.lastSummaryStartedAt = totalPlayedMs();
        scheduleStageSummary();
      }
    }
  }

  // ============================================================
  // 短剧 (2026-10-07 用户设计)
  //
  // 长剧 = 一集二三十分钟, 每 5 分钟摘一次, 退出时统一精炼。
  // 短剧 = 一集一两分钟, 5 分钟的粒度太粗 (一集可能一次都没总结到)。
  //       改成【一集一记】, 攒够 20 集合并成一条总纲, 单集记忆当场丢掉。
  //
  // 为什么必须合并, 不能攒着:
  //   看到第 300 集时如果把 300 条单集记忆全喂给 Gemini 精炼,
  //   上下文撑不住 —— 退出时总结必然失败, 整场白看。
  //   合并后喂的永远是 "一份总纲 + 最多 20 条新单集", 恒定。
  // ============================================================

  var SERIES_MERGE_AT = 20;          // 攒够多少集合并一次

  // ⚠️ 2026-10-09 改: 原来是「一句话, 不超过 40 字。」
  //
  //   问题: 短剧一集 1~2 分钟, 有完整的起承转合。40 字装不下,
  //         模型只能写成"主角通过伪装接近那位大人"这种废话 ——
  //         不是模型降智, 是提示词在逼它糊弄。
  //
  //   为什么这一处该放开、而阶段摘要(1500字)和最终记忆(1000字)不该动:
  //     · 单集总结的职责是【记录】"这集演了什么"  → 要装得下
  //     · 阶段/最终总结的职责是【压缩】成长文      → 短才对
  //   三个数字本来就该是三种量级, 之前误用了同一个思路。
  var SERIES_EPISODE_HINT =
    '用 300~400 字写完整, 不要压缩成一句话短评或一句评语。' +
    '这一集的剧情以后还要当成长期记忆用, 写漏了后面就补不回来。';

  /** 记一次单集剧情。ep = 集号 */
  function addEpisodeMemory(ep, text) {
    var t = String(text || '').trim();
    if (!t) return false;
    // 同一集重复总结(重播/重复触发) → 覆盖, 别堆两条
    var exist = null;
    for (var i = 0; i < watchSession.episodeMemories.length; i++) {
      if (watchSession.episodeMemories[i].ep === ep) { exist = watchSession.episodeMemories[i]; break; }
    }
    if (exist) {
      // 重播同一集会覆盖 —— 这是对的。但如果覆盖时长度差很多,
      // 多半是集号算错了(比如把新一集当成了旧集) → 记一条日志方便事后核对,
      // 别让它静悄悄把上一集的记忆换掉。
      var oldLen = (exist.text || '').length;
      if (oldLen && Math.abs(oldLen - t.length) > oldLen * 0.5) {
        logWarn('⚠️ 第 ' + ep + ' 集记忆被覆盖且长度变化很大 (' + oldLen + ' → ' + t.length +
          ' 字), 确认一下集号对不对');
      }
      exist.text = t;
    }
    else { watchSession.episodeMemories.push({ ep: ep, text: t }); }
    watchSession.episodeMemories.sort(function (a, b) { return a.ep - b.ep; });
    if (ep > watchSession.seriesLastEp) watchSession.seriesLastEp = ep;
    log('📺 记下第 ' + ep + ' 集剧情 (累计 ' + watchSession.episodeMemories.length + ' 条)');
    renderPlotPanel();
    return true;
  }

  /** 一集播完 → 要一条单集记忆 */
  function requestEpisodeSummary(ep) {
    if (watchSession.finalSummaryRequested || S._leaving) return Promise.resolve('');
    if (!S.client || !S.client.isReady()) return Promise.resolve('');
    if (watchSession.pendingSummary) return Promise.resolve('');   // 单通道, 别并发

    var instruction = [];
    instruction.push('【【后台任务】】你刚刚看完了' + (watchSession.seriesTitle ? '《' + watchSession.seriesTitle + '》' : '这部短剧') + '的【第 ' + ep + ' 集】。');
    // 🔴 2026-10-10 用户实测: 不写集号, 模型会自己重新编号, 把第3集写成"第一集"。
    //   它只能靠上下文猜(前面是第1、2集的记忆), 所以这里必须把真实集号【说清楚】。
    instruction.push('这是第 ' + ep + ' 集 —— 不是第 1 集, 也不是本次的第一集。');
    instruction.push('根据你刚才连续看到的画面, 写出【第 ' + ep + ' 集】讲了什么。');
    instruction.push('');
    instruction.push('必须写清这四件事:');
    instruction.push('1. 这一集出场的人物是谁(用画面里能认出来的称呼或身份, 不要叫"那位大人");');
    instruction.push('2. 发生了什么关键事件, 谁对谁做了什么;');
    instruction.push('3. 有什么冲突或转折;');
    instruction.push('4. 这一集结尾停在哪里。');
    instruction.push('');
    instruction.push(SERIES_EPISODE_HINT);
    instruction.push('');
    // ⚠️ 集号前缀: 让每条单集记忆自带"第X集"标记。
    //   这样合并总纲 / 退出精炼时, 集号跟着文字一起走, 不会散架。
    instruction.push('⚠️ 正文【第一句必须以"第 ' + ep + ' 集，"开头】, 然后接剧情。');
    instruction.push('这是为了标明集号, 不是让你重复标题, 整段就正常写下去。');
    instruction.push('');
    instruction.push('只输出正文, 不要客套、不要分析、不要"根据我的观察"这种说法。');
    if (watchSession.episodeMemories.length) {
      instruction.push('');
      instruction.push('前面已经记过的集(不要重复写, 只写这一集):');
      var recent = watchSession.episodeMemories.slice(-3);
      for (var i = 0; i < recent.length; i++) {
        instruction.push('第 ' + recent[i].ep + ' 集：' + recent[i].text);
      }
    }

    return requestSummary('episode', instruction.join('\n'))
      .then(function (text) {
        var t = (text || '').trim();
        if (!t) { logWarn('第 ' + ep + ' 集没总结出内容'); return ''; }
        addEpisodeMemory(ep, t);
        return t;
      })
      .catch(function (err) { logWarn('第 ' + ep + ' 集总结失败:', err.message); return ''; });
  }

  /**
   * 攒够 20 集 → 把这批单集记忆合并进总纲, 然后【丢掉单集记忆】。
   *
   * 为什么可以放心丢: 合并成功后信息已经进 seriesOutline 了,
   * 而总纲要一路带到退出时的最终精炼 —— 所以不会丢剧情。
   */
  function maybeMergeSeriesOutline() {
    if (watchSession.episodeMemories.length < SERIES_MERGE_AT) return Promise.resolve(false);
    var batch = watchSession.episodeMemories.slice(0, SERIES_MERGE_AT);
    var rest = watchSession.episodeMemories.slice(SERIES_MERGE_AT);

    var title = watchSession.seriesTitle || '这部短剧';
    var instruction = [];
    instruction.push('【【后台任务】】你已经看完 ' + title + ' 的前 ' + batch.length + ' 集。');
    instruction.push('请把这 ' + batch.length + ' 集的剧情, 合并成【一份总纲】。');
    instruction.push('');
    if (watchSession.seriesOutline) {
      instruction.push('# 之前已有的总纲(要接在它后面, 不要重复已有内容)');
      instruction.push('');
      instruction.push(watchSession.seriesOutline);
      instruction.push('');
    }
    instruction.push('# 这 ' + batch.length + ' 集各集剧情');
    instruction.push('');
    for (var i = 0; i < batch.length; i++) {
      instruction.push('第 ' + batch[i].ep + ' 集：' + batch[i].text);
    }
    instruction.push('');
    instruction.push('# 总纲怎么写');
    instruction.push('- 用【连贯的一段话】讲清楚到第 ' + batch[batch.length - 1].ep + ' 集为止的主线剧情');
    instruction.push('- 保留关键转折和主要人物, 砍掉过场和重复');
    instruction.push('- 控制在 ' + SERIES_OUTLINE_MAX_CHARS + ' 字以内');
    instruction.push('- 直接写正文, 不要标题、不要分集罗列');

    log('📚 攒够 ' + batch.length + ' 集, 合并成总纲…');

    return requestSummary('merge', instruction.join('\n'))
      .then(function (text) {
        var t = (text || '').trim();
        if (!t) {
          // 合并失败 → 【绝不能丢单集记忆】, 否则这 20 集真没了
          logWarn('总纲合并失败, 保留这 ' + batch.length + ' 条单集记忆不丢');
          return false;
        }
        watchSession.seriesOutline = watchSession.seriesOutline
          ? (watchSession.seriesOutline + '\n' + t)
          : t;
        // 记住这批合并到第几集 —— 清掉单集记忆之后, 剩下的 rest 里最大的 ep
        // 可能小于 batch 末尾, 不显式记录的话"看到第几集"会往回退。
        var lastMerged = batch[batch.length - 1].ep;
        if (lastMerged > watchSession.seriesLastEp) watchSession.seriesLastEp = lastMerged;
        watchSession.episodeMemories = rest;      // ← 只有成功才丢
        log('✅ 总纲已更新 (第 ' + batch[batch.length - 1].ep + ' 集为止), 剩 ' + rest.length + ' 条单集记忆');
        renderPlotPanel();
        return true;
      })
      .catch(function (err) {
        logWarn('总纲合并失败:', err.message);
        return false;
      });
  }

  /** 切到短剧模式 (进剧场时由 cinema-room.js 调) */
  function setSeries(key, title) {
    var k = key || null;
    // 🔴 2026-10-15 同一部剧的每一集都会再调一次 setSeries, 所以只有【真的换了剧】
    //   才清场 —— 判据是 key 变了, 不是"调了没调"。
    var sameDrama = (watchSession.kind === 'series' && watchSession.seriesKey === k);

    if (!sameDrama) {
      // 【为什么必须清】退出总结失败会存草稿, 下次进影院 restoreDraft() 把它恢复回来。
      //   如果那时候用户选的是另一部剧, 旧剧的单集记忆/总纲就会跟新剧的一起攒 ——
      //   退出时那份混着旧剧剧情的前情提要, 会【永久写进新剧的那一行】。
      //   前情提要是按剧存的, 污染一旦写进去就固定下来了, 比以前更难得察觉。
      if ((watchSession.episodeMemories && watchSession.episodeMemories.length) ||
          (watchSession.seriesOutline || '').trim()) {
        // 先存草稿把上一部剧的记忆保住 (saveDraft 读的是还没改的 watchSession),
        // 再清干净 —— 直接扔掉等于让那几集白看。
        log('⚠️ 换剧了: 《' + (watchSession.seriesTitle || '上一部') + '》还没存进长期记忆的 ' +
          watchSession.episodeMemories.length + ' 条已转存草稿, 不会带进《' + (title || k) + '》');
        saveDraft();
      }
      watchSession.episodeMemories = [];
      watchSession.seriesOutline = '';
      watchSession.seriesLastEp = 0;
      watchSession.nowPlayingEp = 0;
    }

    watchSession.kind = 'series';
    watchSession.seriesKey = k;
    watchSession.seriesTitle = title || '';
    prepareSeriesRecap(k);
  }

  // ============================================================
  // 短剧前情提要 (2026-10-15)
  //
  // 【为什么必须有】
  //   之前 episodeMemories / seriesOutline 全在 watchSession 内存里, 退出精炼成功后
  //   clearDraft() 一清, 下次进影院模型对这部剧是【零认知】。用户碎片时间看四集就退,
  //   下次回来接第 5 集, 它不知道前面演了什么 —— 用户原话「他总结中间剧情的时候
  //   就会有点懵逼」。
  //
  //   更狠的一点: seriesOutline 从来只喂给「20 集合并」和「退出精炼」两个后台任务,
  //   从没进过模型的实时上下文 (buildStageSummaryInstruction / requestEpisodeSummary
  //   都不带它)。所以【当次会话里模型对这部剧也是零认知】, 不只是下次。
  //   buildSystemPrompt 更是在 2026-10-11 被刻意清空了 (接话降智), 绝对不能往里加东西。
  //
  // 【所以怎么注入】
  //   不碰系统提示词, 走 sendUserText —— 会话中途唯一能进模型上下文的通道
  //   (live-client.js 的 systemInstruction 只在 setup 送一次)。
  //   两个时机都要覆盖:
  //     · 进影院时 Live 还没连 → 置 seriesRecapInjectPending, 等 onClientState('ready')
  //     · 已经在看片才切剧 → Live 是 ready 的, 直接发
  //   requestSummary 会把模型那句回话收进自己的 buffer (handleModelText 里
  //   pendingSummary 分支 return 掉了), 所以不会漏进气泡。
  // ============================================================

  var RECAP_MARK = '【前情提要】';        // 生成时的分界标记, 解析靠它
  var MEMORY_MARK = '【观影记忆】';
  var RECAP_MAX_CHARS = 1800;

  /**
   * 找标题行, 宽松匹配。
   *
   * ⚠️ 为什么不能只认死字符串 (2026-10-15 用户实测踩到):
   *   第一次退出时指令里【没有】旧提要, 模型老老实实按格式输出, 解析成功。
   *   从第二次起旧提要进了指令, 模型的排版就变了 —— 可能写成 `**前情提要**`、
   *   `前情提要：`, 也可能把两段【写反了】(前情提要写在观影记忆前面)。
   *   死认 `【前情提要】` 的话, 这些统统解析失败 → recap 是空串 →
   *   persistSeriesRecapSafely 第一行就 return → 【一条都没写】。
   *   症状就是"观影记忆照常存、前情提要永远停在第一次那版", 完全看不出哪里坏了。
   *
   * 先找带方括号的严格标记, 找不到再退到宽松匹配, 最后再兜底别的写法。
   */
  function findHeading(text, strictMark, looseName) {
    var at = text.indexOf(strictMark);
    if (at >= 0) return { at: at, end: at + strictMark.length, strict: true };
    // **前情提要** / 〔前情提要〕 / 前情提要: / 前情提要：
    //
    // 🔴 必须是【独占一行】才算标题 (上面加了 ^ $ 和 m 修饰符)。不这么限的话,
    //   观影记忆正文里随口一句"我们上次说的前情提要…"就会被当成标题,
    //   记忆被拦腰砍断、后半截变成提要 —— 比解析失败严重得多。
    //   宁可漏认一个标题 (那样只是不更新提要), 也绝不能砍断记忆。
    var re = new RegExp('^[ \\t>]*[【\\[〔*#]{0,2}[ \\t]*' + looseName +
      '[ \\t]*[】\\]〕*#]{0,2}[ \\t]*[:：]?[ \\t]*$', 'm');
    var m = text.match(re);
    if (m) return { at: m.index, end: m.index + m[0].length, strict: false };
    return null;
  }

  function cleanSlice(text, from, to) {
    return String(text || '').slice(from, to).trim();
  }

  /**
   * 把模型那一次回复拆成【观影记忆】+【前情提要】。
   *
   * 🔴 铁律: 宁可不要前情提要, 也绝不能动观影记忆 ——
   *   观影记忆是要进长期记忆的, 里面混进一整段剧情提要就是污染。
   *   所以任何一种"观影记忆被写没了"的情况, 都退回整段当观影记忆。
   */
  function splitFinalSummaryAndRecap(text) {
    var t = String(text || '').trim();
    if (!t) return { memory: '', recap: '' };

    var r = findHeading(t, RECAP_MARK, '前情提要');
    var m = findHeading(t, MEMORY_MARK, '观影记忆');

    // 两个标题都没找到 → 模型这次压根没分两段, 整段当观影记忆 (等于退回旧行为)
    if (!r && !m) {
      logWarn('[前情提要] 输出里没认出【前情提要】标题, 本次不更新提要 (原文前 80 字: ' +
        t.slice(0, 80).replace(/\n/g, ' ') + ')');
      return { memory: t, recap: '' };
    }

    var memory = '', recap = '';
    if (m && r && m.at < r.at) {
      // 正常顺序: 观影记忆 → 前情提要
      memory = cleanSlice(t, m.end, r.at);
      recap = cleanSlice(t, r.end, t.length);
    } else if (m && r) {
      // 🔴 两段写反了 —— 第一版死认"标记一定在后面", 这种情况直接判成"没提要",
      //   于是提要永远停在第一次那版。这次必须能认出来。
      recap = cleanSlice(t, r.end, m.at);
      memory = cleanSlice(t, m.end, t.length);
      logWarn('[前情提要] 模型把两段写反了 (前情提要写在前面), 已按位置拆开');
    } else if (m && !r) {
      memory = cleanSlice(t, m.end, t.length);
    } else {
      // 只有前情提要标题: 前面那段没标题, 当观影记忆
      var before = cleanSlice(t, 0, r.at);
      memory = before;
      recap = cleanSlice(t, r.end, t.length);
    }

    // 观影记忆被写没了 → 保守: 整段当观影记忆, 不更新提要
    if (!memory) {
      logWarn('[前情提要] 观影记忆那半段是空的, 保守起见整段当观影记忆, 本次不更新提要');
      return { memory: t, recap: '' };
    }
    if (!recap) {
      logWarn('[前情提要] 前情提要那半段是空的, 本次不更新提要');
      return { memory: memory, recap: '' };
    }

    if (recap.length > RECAP_MAX_CHARS) {
      logWarn('[前情提要] 超长 (' + recap.length + ' 字), 截断到 ' + RECAP_MAX_CHARS);
      recap = recap.slice(0, RECAP_MAX_CHARS);
    }
    return { memory: memory, recap: recap };
  }

  /**
   * 拿存储层, 拿不到就当没有。
   * 用 typeof 判 window 而不是直接读 —— 抠源码跑逻辑测试时 (check-series-memory.cjs
   * 正是把这一段原样抠出来在 Node 里跑的) 根本没有 window, 直接读会 ReferenceError
   * 把 setSeries 整个炸掉。
   */
  function cinemaStorage() {
    return (typeof window !== 'undefined' && window.CinemaStorage) || null;
  }

  /** 切剧时读这部剧的前情提要。读不到就当没有, 绝不影响看剧。 */
  function prepareSeriesRecap(key) {
    var k = key ? String(key) : '';
    if (!k) {
      watchSession.seriesRecap = null;
      watchSession.seriesRecapInjectPending = false;
      return;
    }
    // 同步先把上一部剧残留的清掉 —— 慢一拍读回来也会串台
    watchSession.seriesRecap = null;
    watchSession.seriesRecapInjectPending = true;

    var CS = cinemaStorage();
    if (!CS || typeof CS.loadSeriesRecap !== 'function') {
      watchSession.seriesRecapInjectPending = false;   // 表都还没有, 后面也不会有
      return;
    }
    // 记下这次的会话号: 切剧切得比读盘快的话, 这一行的结果就过期了, 必须丢掉
    var mine = watchSession.watchSessionId;
    CS.loadSeriesRecap(k).then(function (row) {
      if (watchSession.watchSessionId !== mine || watchSession.seriesKey !== k) return;
      watchSession.seriesRecap = row || null;
      renderPlotPanel();
      if (row && (row.text || '').trim()) {
        log('📖 读到《' + (row.title || k) + '》的前情提要 (' + (row.text || '').length + ' 字)');
        maybeInjectSeriesRecap();
      } else {
        // 这部剧还没有提要 (第一次看)。pending 必须落闸 —— 留着它的话以后每次
        // Live ready 都会白跑一趟 maybeInjectSeriesRecap。
        watchSession.seriesRecapInjectPending = false;
      }
    }).catch(function (e) {
      logWarn('读前情提要失败(忽略):', e && e.message);
      watchSession.seriesRecapInjectPending = false;
    });
  }

  /** Live 早就连着 (中途切剧) → 立刻注入; 还没连 → 留给 onClientState('ready')。 */
  function maybeInjectSeriesRecap() {
    if (!watchSession.seriesRecapInjectPending) return;
    if (!S.client || !S.client.isReady()) return;     // 等 ready
    injectSeriesRecap();
  }

  /** 把前情提要作为一个回合塞进 Live 上下文。模型的回话被 requestSummary 收走, 不进气泡。 */
  function injectSeriesRecap() {
    var rec = watchSession.seriesRecap;
    var text = String((rec && rec.text) || '').trim();
    if (!text || watchSession.seriesRecapInjectPending === false) return;
    watchSession.seriesRecapInjectPending = false;    // 先落闸, 防重入

    var instruction = [];
    instruction.push('【【后台任务】】《' + (rec.title || watchSession.seriesTitle || '这部短剧') +
      '》的【前情提要】在下面。这是我们之前一起看过这部剧的剧情进度，请记住：');
    instruction.push('');
    instruction.push(text);
    instruction.push('');
    instruction.push('这是背景资料，不是现在要讨论的内容。');
    instruction.push('看完只回一个字「好」，不要复述、不要评论、不要提问、不要接着往下说剧情。');

    requestSummary('recap', instruction.join('\n'))
      .then(function () { log('✅ 前情提要已喂给模型'); })
      .catch(function (err) { logWarn('前情提要注入失败(忽略):', err && err.message); });
  }

  /**
   * 写前情提要 (2026-10-15 加了兜底)。返回 Promise, 但**永远不 reject**。
   *
   * 【为什么要兜底】用户实测: "第一次总结了前情提要, 之后怎么进出都不再总结, 看到 60 集还在 44"。
   *   症状是观影记忆照常存、提要永远冻结、界面毫无提示 —— 因为写提要的函数
   *   收到空内容时【第一行就返回】, 一条没写, 也没人知道。
   *   根因是共享调用那次没吐出可识别的提要段落 (排版跑偏 / 被截断 / 模型只把旧提要
   *   复述了一遍), 而"排版"是模型的事, 不是我们能指望的。
   *
   *   所以: 主路还是"一次调用出两份" (快), 但只要没拿到提要, 就【补一次只写提要的
   *   专门调用】。宁可多花一次调用, 也不能让这个功能静悄悄地停摆 ——
   *   静默失败是最难查的失败。
   */
  function saveSeriesRecapWithFallback(recapText) {
    try {
      var key = watchSession.seriesKey;
      var hasNewEp = watchSession.kind === 'series' && key &&
        watchSession.episodeMemories && watchSession.episodeMemories.length > 0;

      // 主路拿到了 → 直接写, 结束
      if (String(recapText || '').trim()) {
        persistSeriesRecapSafely(recapText);
        return Promise.resolve(true);
      }

      // 没拿到。什么情况下值得补一次:
      //   · 这次确实攒到了新的单集记忆(有东西可写)
      //   · 以前存过提要(说明用户在看这部剧, 提要是要更新的), 或者这是第一次写
      var hadRecap = !!(watchSession.seriesRecap && (watchSession.seriesRecap.text || '').trim());
      if (!hasNewEp) { logWarn('[前情提要] 这次没产出提要, 且本次没有新的单集记忆, 跳过'); return Promise.resolve(false); }
      if (!hadRecap && !(watchSession.episodeMemories.length >= 2)) {
        logWarn('[前情提要] 这次没产出提要, 只攒了 1 集, 不补调用 (信息太少没意义)');
        return Promise.resolve(false);
      }
      // 唯一硬条件是 Live 还在。finalSummaryRequested 不用管 —— 这个函数本来就只在
      // 退出流程 / 手动生成那两条链上被调, 那时它必定是 true。
      if (!S.client || !S.client.isReady()) {
        logWarn('[前情提要] 想补一次专门的调用, 但 Live 没就绪, 放弃');
        return Promise.resolve(false);
      }

      log('📖 共享调用没产出提要, 补一次【只写前情提要】的调用…');
      return requestSummary('recapOnly', buildRecapOnlyInstruction())
        .then(function (text) {
          var t = String(text || '').trim();
          // 这次只有一段, 模型可能自作主张加个标题, 顺手剥掉
          t = stripHeadingNoise(t);
          if (!t) { logWarn('[前情提要] 补调用也没写出内容, 本次不更新'); return false; }
          persistSeriesRecapSafely(t);
          return true;
        })
        .catch(function (e) {
          logWarn('[前情提要] 补调用失败(不影响观影记忆):', e && e.message);
          return false;
        });
    } catch (e) {
      logWarn('[前情提要] 兜底逻辑异常(不影响观影记忆):', e && e.message);
      return Promise.resolve(false);
    }
  }

  /** 剥掉模型可能加的标题行 / 分隔线 */
  function stripHeadingNoise(text) {
    var t = String(text || '').trim();
    t = t.replace(/^[【\[]?\s*(前情提要|已看到第\s*\d+\s*集)\s*[】\]]?\s*[:：]?\s*/i, '');
    t = t.replace(/^[-=—*#]{2,}\s*/, '');
    return t.trim();
  }

  /** 只写提要的专门指令 (共享调用失败时的兜底) */
  function buildRecapOnlyInstruction() {
    var title = watchSession.seriesTitle || '这部短剧';
    var lines = [];
    lines.push('【【后台任务】】刚才那份回复里没有可用的【前情提要】段落。');
    lines.push('这次【只写前情提要】，不要写观影记忆，不要解释，不要加标题，不要写分隔线。');
    lines.push('');
    var prev = String((watchSession.seriesRecap && watchSession.seriesRecap.text) || '').trim();
    if (prev) {
      lines.push('# 已经有的前情提要（旧版本，必须保留并在其基础上更新）');
      lines.push('');
      lines.push(prev);
      lines.push('');
    }
    var eps = watchSession.episodeMemories || [];
    if (eps.length) {
      lines.push('# 这次新看的各集');
      lines.push('');
      for (var i = 0; i < eps.length; i++) lines.push('第 ' + eps[i].ep + ' 集：' + eps[i].text);
      lines.push('');
    }
    lines.push('# 要求');
    lines.push('- 直接输出前情提要正文，第一句就是【已看到第 ' + Math.max(1, watchSession.seriesLastEp || 0) + ' 集】。');
    lines.push('- 客观剧情、第三人称、连贯一段，不分点，不写"观影记忆"，不加任何标题或 --- 。');
    lines.push('- 旧提要里的信息全部保留，只补新看的部分。');
    lines.push('- 控制在 ' + RECAP_MAX_CHARS + ' 字以内。');
    return lines.join('\n');
  }

  /**
   * 写前情提要。**绝不让它影响观影记忆已保存这件事。**
   *
   * 它是附加项: 写失败只提示一句, 观影记忆照样算保存成功、照样清草稿、照样退房间。
   * 绝不能让它 reject 到主链路的 .catch —— 那会把 finalSummaryRequested 复位,
   * 用户看到的是"观影记忆没存上", 实际存上了, 纯属冤。
   */
  function persistSeriesRecapSafely(recapText) {
    try {
      var text = String(recapText || '').trim();
      var key = watchSession.seriesKey;
      if (!text || !key || watchSession.kind !== 'series') return;
      var CS = cinemaStorage();
      if (!CS || typeof CS.saveSeriesRecap !== 'function') return;

      CS.saveSeriesRecap({
        key: key,
        title: watchSession.seriesTitle || '',
        text: text,
        lastEp: watchSession.seriesLastEp || 0
      }).then(function (row) {
        if (!row) return;
        watchSession.seriesRecap = row;          // 面板立刻显示新的
        log('📖 前情提要已存 (' + row.text.length + ' 字, 到第 ' + (row.lastEp || 0) + ' 集)');
        // ⚠️ 退出流程里这条回调跟 hardLeave() 只差几十毫秒, 那时房间已经在拆。
        //   renderPlotPanel() 里的 ensurePlotPanel() 发现元素被摘了就【重新造一个
        //   挂回 DOM】, 房间已经不在就 fallback 挂 document.body —— 主页面上会留个
        //   孤儿面板。退出途中一律不刷面板 (内存里的值已经记好了, 下次进来照样读得到)。
        if (!watchSession.closed && !S._leaving) renderPlotPanel();
      }).catch(function (e) {
        logWarn('前情提要写入失败(不影响观影记忆):', e && e.message);
        appendSystemLine('⚠️ 观影记忆已存上，但这部剧的前情提要这次没存成功。');
      });
    } catch (e) {
      logWarn('前情提要写入异常(不影响观影记忆):', e && e.message);
    }
  }

  /** 用户手动删除这部剧的前情提要。 */
  function deleteCurrentSeriesRecap() {
    var key = watchSession.seriesKey;
    if (!key) return Promise.resolve(false);
    var CS = cinemaStorage();
    if (!CS || typeof CS.deleteSeriesRecap !== 'function') return Promise.resolve(false);
    return CS.deleteSeriesRecap(key).then(function (ok) {
      if (ok) {
        watchSession.seriesRecap = null;
        log('🗑 已删除《' + (watchSession.seriesTitle || key) + '》的前情提要');
        renderPlotPanel();
      }
      return ok;
    }).catch(function (e) {
      logWarn('删前情提要失败:', e && e.message);
      return false;
    });
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

    // 短剧: 总纲要单独拎出来 (2026-10-07 用户设计)。
    // 它是"前 N 集合并后的压缩版", 属于跨场资产, 不能跟单集记忆混在一块被丢掉。
    var outline = (watchSession.seriesOutline || '').trim();
    if (outline) {
      lines.push('# 这部剧目前看到哪 (总纲, 之前每 20 集合并过一次)');
      lines.push('');
      lines.push(outline);
      lines.push('');
    }

    // 短剧: 本次攒下的单集记忆
    var seriesEp = Array.isArray(watchSession.episodeMemories) ? watchSession.episodeMemories : [];
    if (seriesEp.length) {
      lines.push('# 本次看完的各集剧情');
      lines.push('');
      for (var e = 0; e < seriesEp.length; e++) {
        lines.push('第 ' + seriesEp[e].ep + ' 集：' + seriesEp[e].text);
      }
      lines.push('');
    }

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

    // ⚠️ 短剧: 明确禁止回去翻画面 (2026-10-07 用户要求)。
    // 短剧一集两分钟, 画面帧又碎又密, 让模型"再看一遍画面补细节"只会
    // 又慢又容易崩。上面的文字已经是它该知道的全部。
    if (watchSession.kind === 'series') {
      lines.push('⚠️ 重要: **只根据上面这些文字来写**。');
      lines.push('不要回头去看视频画面找细节 —— 画面帧碎又密, 翻它们会非常慢而且容易失败。');
      lines.push('文字里没写的情节, 就当作没看到, 不要自己补。');
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
    lines.push('- 你的猜测');
    lines.push('');
    lines.push('写成一段自然的中文回忆, 像你真的记得这件事一样, 第一人称。');
    lines.push('开头写【观影记忆】。');
    lines.push('控制在 ' + FINAL_MEMORY_TARGET_CHARS + ' 字以内, 不要为了凑字数写废话。');

    // ---- 顺便再写一份【前情提要】(2026-10-15, 短剧才有) ----
    //
    // 为什么加在【同一次调用】里而不是单独再调一次:
    //   退出本来就慢 (要等模型吐字), 再加一轮往返用户要多等好几秒;
    //   两份内容吃的是同一批文本, 分两次调反而可能各写各的、前后对不上。
    //   代价是格式可能跑偏 —— splitFinalSummaryAndRecap() 已经兜住了:
    //   认不出标记就整段当观影记忆, 等于退回今天的行为, 前情提要只是没有而已。
    //
    // 这份东西的定位跟观影记忆【完全不同】, 不能混:
    //   观影记忆 = 我们一起看过的回忆 → 进长期记忆, 讲感受讲互动
    //   前情提要 = 这部剧讲到哪里了     → 留在戏里, 下次进影院喂回模型当背景
    if (watchSession.kind === 'series') {
      // 🔴 2026-10-15 第一版这里漏了旧提要, 等于让模型凭空重写。
      //   指令里写着"以之前已有的提要为基础更新", 但旧提要根本没进指令 ——
      //   模型看不见它, 只能照着【本次这几集】重写一份, 然后覆盖掉旧的那份。
      //   后果: 看 1~4 集存下提要, 下次看 5~8 集, 存回来就只剩 5~8 集,
      //   第 1~4 集演过谁、发生过什么当场蒸发 —— 跨场问"刚那人是谁"照样答不出。
      //   这跟没做这个功能是一回事, 所以旧的必须先喂进去。
      var prevRecap = String((watchSession.seriesRecap && watchSession.seriesRecap.text) || '').trim();
      if (prevRecap) {
        lines.push('# 这部剧【之前已有的前情提要】（覆盖前的旧版本）');
        lines.push('');
        lines.push(prevRecap);
        lines.push('');
        lines.push('⚠️ 你下面要写的新前情提要是【替换】掉这一份，所以新写的那份必须把上面的信息全部带上。');
        lines.push('只写这次看的这几集是错的 —— 那样第 1 集到上次之间的剧情就永久没了。');
        lines.push('人物、关系、关键转折要跟旧提要里写的一致，别换名字、别漏掉。');
        lines.push('');
      }
      lines.push('# 再写一份【' + RECAP_MARK + '】');
      lines.push('');
      lines.push('这份是给【下次看这部剧】时用的 —— 那时候本次的单集记忆和聊天记录都已经清空了，');
      lines.push('只有这份提要留下来。所以它必须【独立完整】：');
      lines.push('不要写"如前所述""接着上次""前面提到的"这种依赖上下文的说法。');
      lines.push('');
      lines.push('要求：');
      lines.push('- 客观剧情，第三人称。只讲这部剧本身发生的事。');
      lines.push('- 不要写你和用户的感受、评论、互动 —— 那些是【观影记忆】的活。');
      lines.push('- 覆盖从第 1 集到第 ' + Math.max(1, watchSession.seriesLastEp || 0) + ' 集的主线：主要人物、关键事件、重要转折、现在停在哪。');
      if (prevRecap) {
        lines.push('- 以上面那份旧的前情提要为基础更新：已有的信息全部保留，只补这次新增的。');
      } else {
        // ⚠️ 没有旧提要时【绝不能】还说"以之前那份为基础" —— 那是在叫模型去更新
        //   一份它根本看不到的东西, 实测会写成"我之前的提要提到…", 直接把水搅浑。
        lines.push('- 这是第一次给这部剧写前情提要，把从第 1 集到现在的主线一次讲清楚，别漏前面几集。');
      }
      lines.push('- 开头写【已看到第 N 集】。');
      lines.push('- 不分点罗列，写成连贯的一段。');
      lines.push('- 控制在 ' + RECAP_MAX_CHARS + ' 字以内。');
      lines.push('');
      lines.push('# 输出格式（必须严格照做，不要解释）');
      lines.push('第一部分：开头写【观影记忆】，然后是上面要求的那段回忆。');
      lines.push('空一行。');
      lines.push('第二部分：写 ' + RECAP_MARK + ' 这四个字（不带别的），然后空一行，再写前情提要正文。');
      lines.push('两段之间不要用 --- 或其他分隔线。');
    }

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
  // 未总结草稿 (2026-10-10)
  //
  // 起因: 用户实测 —— API 临时抽风导致退出总结失败, 两集白看, 退出后什么都没留下。
  //   (旧设计把"退出时总结"当成唯一落盘点, 它失败 = 整场丢失)
  //
  // 现在: 退出改为【手动生成 + 失败可重试】(数据不清), 但用户也可能
  //   "这次 API 不行, 我先退出, 等换个时间再来总结"。
  //   所以补一层 localStorage 草稿兜底:
  //     · 任何"要离开但长期记忆还没写成功"的时刻 → 存草稿
  //     · 下次进影院自动恢复 → 用户再点一次生成
  //     · 【精炼成功才清草稿】(用户原话: "总结精炼完了才清记录")
  //
  // 为什么存 localStorage 而不是新建 Dexie 表:
  //   草稿是"当前这次没总结完的临时数据", 不需要跨设备同步/索引查询。
  //   localStorage 同步读写几百 KB 完全够, 而且【不用 bump db schema】——
  //   避开了 init-db-schema.js ?v= 那道容易忘、忘了一定出真机事故的坎。
  // ============================================================
  var DRAFT_KEY = 'cinema_watch_draft';
  var DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天没动就当过期, 免得长期占地方

  /** 这次观影有没有"值得留一手"的记忆 (单集记忆 / 剧情摘要 / 总纲) */
  function draftHasContent() {
    return ((watchSession.episodeMemories && watchSession.episodeMemories.length > 0) ||
      !!(watchSession.currentPlotSummary || '').trim() ||
      !!(watchSession.seriesOutline || '').trim());
  }

  /** 把当前未总结的记忆存成本地草稿。幂等(覆盖写), 反复调无害。 */
  function saveDraft() {
    if (!draftHasContent()) return;
    try {
      var draft = {
        chatId: watchSession.chatId,
        kind: watchSession.kind,
        seriesKey: watchSession.seriesKey,
        seriesTitle: watchSession.seriesTitle,
        seriesLastEp: watchSession.seriesLastEp,
        nowPlayingEp: watchSession.nowPlayingEp,
        seriesOutline: watchSession.seriesOutline,
        episodeMemories: watchSession.episodeMemories,
        currentPlotSummary: watchSession.currentPlotSummary,
        chatLog: watchSession.chatLog,
        savedAt: Date.now()
      };
      var json = JSON.stringify(draft);
      localStorage.setItem(DRAFT_KEY, json);
      log('💾 未总结的观影记忆已存草稿 (' + (watchSession.episodeMemories || []).length +
        ' 条, ' + Math.round(json.length / 1024) + 'KB)');
    } catch (e) {
      // QuotaExceeded 等 —— 草稿存不下【绝不能影响正常退出】, 只记日志
      logWarn('存草稿失败(不影响退出):', e.message);
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
  }

  /** 读草稿。空 / 过期 / 损坏 / 无有效内容 → null (并顺手清掉无效的)。 */
  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !Array.isArray(d.episodeMemories)) { clearDraft(); return null; }
      if (!d.episodeMemories.length && !(d.currentPlotSummary || '').trim() && !(d.seriesOutline || '').trim()) {
        clearDraft(); return null;
      }
      if (Date.now() - (d.savedAt || 0) > DRAFT_TTL_MS) { clearDraft(); return null; }
      return d;
    } catch (e) {
      logWarn('读草稿失败(忽略):', e.message);
      return null;
    }
  }

  /**
   * 进影院时恢复上次没总结完的记忆。
   *
   * 只在 setChat (进影院 / 切角色) 时调 —— 【换片时不恢复】:
   *   换片是用户主动开始看新的, 旧草稿该继续留在 localStorage 等他处理,
   *   不该在毫无提示的情况下塞进新片子里。
   *
   * 草稿跟角色绑定: 换个角色进影院, 别的角色的剧不该混进来 (返回 false, 草稿保留)。
   */
  function restoreDraft() {
    var d = loadDraft();
    if (!d) return false;
    if (d.chatId && watchSession.chatId && d.chatId !== watchSession.chatId) return false;
    watchSession.kind = d.kind || 'film';
    watchSession.seriesKey = d.seriesKey || null;
    watchSession.seriesTitle = d.seriesTitle || '';
    watchSession.seriesLastEp = d.seriesLastEp || 0;
    watchSession.nowPlayingEp = d.nowPlayingEp || 0;
    watchSession.seriesOutline = d.seriesOutline || '';
    watchSession.episodeMemories = d.episodeMemories;
    watchSession.currentPlotSummary = d.currentPlotSummary || '';
    watchSession.chatLog = Array.isArray(d.chatLog) ? d.chatLog : [];
    var n = watchSession.episodeMemories.length;
    log('↩️ 恢复上次未总结的观影记忆 (' + n + ' 条, ' + (watchSession.seriesTitle || '长剧') + ')');
    appendSystemLine('↩️ 上次有 ' + n + ' 条' +
      (watchSession.seriesTitle ? '《' + watchSession.seriesTitle + '》' : '') +
      '的观影记忆还没存进长期记忆，已经帮你恢复。看完了点「生成观影记忆」补上就行。');
    renderPlotPanel();
    return true;
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

      // 🔴 2026-10-16 用户实测「连了断了连, 最后彻底连不上」的根因。
      //
      //   原来写的是 `reconnect().then(function (ok) { if (ok) { …报成功… } })`,
      //   但 reconnect() 返回的是 connect() 的 Promise, 而 connect() 在
      //   **ws.onopen** 就 resolve 了 —— 而且 resolve 的是【客户端实例本身】,
      //   不是布尔值 (live-client.js:191 `resolve(self)`)。
      //   于是 `ok` 永远为真 → 每次重连都报"✅ 重连成功, 上下文已恢复"并重启帧循环,
      //   哪怕 setupComplete 根本没来、服务端下一秒就关掉了。
      //   外面看日志全是绿的, 实际是个死连接 —— 用户完全看不出发生了什么。
      //
      //   修法: socket 打开【不等于】会话可用, 必须等 isReady() 真的为真。
      S.client.reconnect()
        .then(function () { return waitUntilReady(WAIT_READY_MS); })
        .then(function (ready) {
          if (!ready) {
            logWarn('重连后 ' + Math.round(WAIT_READY_MS / 1000) + 's 内没进入可发送状态, 按失败处理');
            // 这种连接多半是拿废存档点续上来的。清掉它 —— 注意要【连客户端对象里那个
            // 一起清】, 只删 localStorage 没用: 下次 reconnect() 读的是 this._resumeHandle,
            // 它还留着那个废 handle, 于是永远拿同一个死 handle 去续, 死循环。
            saveHandle(null);
            try { if (S.client) S.client.setResumeHandle(null); } catch (e) { /* noop */ }
            scheduleReconnect('重连后没能进入可发送状态');
            return;
          }
          // 只有稳定连上才清退避计数 (flapped 时不清)
          if (!flapped) clearRetry();
          startFrameLoop();
          log('✅ 重连成功, 上下文已恢复');
          appendSystemLine('✅ 已重新连接（对话上下文保留）');
        })
        .catch(function (err) {
          log('重连失败:', err.message);
          // 重连也失败 -> 存档点八成是废的, 直接扔掉, 下一轮从全新会话开始
          saveHandle(null);
          try { if (S.client) S.client.setResumeHandle(null); } catch (e) { /* noop */ }
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
      // 🔴 2026-10-15 前情提要注入。
      //   必须放在 newWatchSession 之后 —— 它会把 seriesRecap 重置掉。
      //   连上的这一刻是"进影院先连 Live、后选剧"那条路径的唯一注入时机:
      //   那时 setSeries 已经置了 injectPending, 但当时 S.client 还没 ready, 发不出去。
      //   （中途切剧那条路径在 prepareSeriesRecap 里就发掉了, 这里第二次调用是空转。）
      maybeInjectSeriesRecap();
      // 起播放表。视频此刻可能已经是暂停态(比如进来时没自动播),
      // 那就不起, 等 play 事件 resumeFrames 再起 —— 免得暂停时也在算时间。
      var v0 = getVideo();
      if (v0 && !v0.paused && !v0.ended && !S.paused) markPlaying();
      scheduleStageSummary();
      renderPlotPanel();
    } else if (state === 'closed' && S.autoMode && !S._userDisabled) {
      // 🔴 2026-10-16: 断线这一刻先把在途的摘要请求作废 (理由见 abortPendingSummary)。
      //   少了这一句, 那个请求会赖到 45s 超时, 期间新一集一集都不再总结,
      //   而且模型吐的字全被它吞掉 —— 用户实测"看完一集没总结起, 重看一遍还是没有"。
      abortPendingSummary('连接断开');
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
              if (savedHandle) {
                saveHandle(null);
                // ⚠️ 2026-10-16: 光删 localStorage 没用 —— 客户端对象里那个
                //   _resumeHandle 还留着, 下次重连照样拿废的去续。一起清。
                try { S.client.setResumeHandle(null); } catch (e) { /* noop */ }
                log('⚠️ 存档点续不上, 已清除, 下次用全新会话');
              }
              appendSystemLine('⚠️ 等待 Gemini 初始化超时（20s）。已重置存档点，正在重连…');
              // 🔴 原来这里只 resolve(false) 就结束了 —— 而调用方 autoConnect 根本不看
              //   返回值, 于是"把废 handle 清干净"做完了, 却【没有任何人再发起下一次连接】,
              //   连接就死在这儿了 (用户实测"整死连不上模型")。这里主动排一次重连。
              scheduleReconnect('等待 Gemini 初始化超时');
              resolve(false);
            } else if (S.client && (S.client.state === 'error' || S.client.state === 'closed')) {
              clearInterval(iv);
              if (savedHandle) {
                saveHandle(null);
                try { S.client.setResumeHandle(null); } catch (e) { /* noop */ }
                log('⚠️ 带着旧存档点连不上, 已清除');
              }
              appendSystemLine('⚠️ 连接被服务端关闭（code ' + (S.client.state || '?') + '）。已重置存档点，正在重连…');
              scheduleReconnect('连接被服务端关闭');
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
    stopStageSummary();      // 连 Live 都断了, 摘要定时器必须跟着停
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

    // ⚠️ 必须在这里就停帧 (2026-10-07 用户发现: 退出总结花很久)。
    //
    // 以前帧循环要一直发到 hardLeave() 里的 disable() 才停 —— 也就是
    // "让 Gemini 写总结" 这整段时间里, 它每秒还在收一张 JPEG。
    // 用户看到的现象就是: 点退出后卡很久才出结果, 因为模型要先消化
    // 整场累积的视觉输入, 才能吐出那几百字。
    stopFrameLoop();

    // 有文字摘要 → 走纯文本精炼 (快); 没有 → 沿用当前会话总结 (慢但至少有画面)。
    var textMode = !!(watchSession.currentPlotSummary || '').trim();
    log(textMode
      ? '退出总结: 已有文字摘要, 走纯文本精炼 (不送视频帧)'
      : '退出总结: 无文字摘要, 沿用当前会话总结');

    renderStatus('connecting');
    appendSystemLine('⏳ 正在整理这次观影记忆，请稍等一下……');
    renderPlotPanel();

    return waitForNoPendingSummary()
      .then(function () { return requestSummary('final', buildFinalSummaryInstruction()); })
      .then(function (text) {
        // 🔴 2026-10-15: 一次调用出两份, 在这里拆开。
        //   拆不出来就整段当观影记忆 (见 splitFinalSummaryAndRecap) —— 行为不倒退。
        var parts = splitFinalSummaryAndRecap(text);
        if (!parts.memory) throw new Error('Gemini 没有返回观影记忆内容');
        watchSession.finalSummaryText = parts.memory;
        appendSystemLine('💾 正在保存观影记忆…');
        renderPlotPanel();
        return saveToLongTermMemory(chat, parts.memory).then(function () {
          // 观影记忆【写库确认成功】之后才处理提要。
          // 顺序反过来会出现"提要记下了、观影记忆其实没存上"的错位状态。
          //
          // ⚠️ 必须 await: 兜底可能要补一次 Live 调用, 而下一次 .then 里紧跟着 hardLeave()
          //   会把 Live 关掉 —— 不等的话补调用刚发出就断线, 提要照样丢。
          //   这个函数永远 resolve 不 reject, 所以不会把主链路带崩。
          return saveSeriesRecapWithFallback(parts.recap);
        });
      })
      .then(function () {
        // 只有 await db.chats.put 成功走到这里, 才算真的保存成功
        watchSession.finalSummarySaved = true;
        // 🔴 2026-10-10: 【精炼成功才清草稿】(用户原话: "总结精炼完了才清记录")。
        //   顺序很重要 —— 先确认写库成功, 再清本地草稿。反过来的话,
        //   写库失败时草稿已经没了, 又变成"什么都没留下"。
        clearDraft();
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
        // 顺手存一份草稿: 用户可能觉得"这次 API 不行", 直接退出换时间再总结。
        saveDraft();
        appendSystemLine('⚠️ 观影记忆还没有生成成功：' + err.message);
        renderStatus('ready');
        renderPlotPanel();
        return { saved: false, error: err.message };
      });
  }

  /**
   * 作废当前在途的摘要请求。
   *
   * 🔴 2026-10-16 用户实测 (连不上 + 总结出岔子) 的真凶之一:
   *   连接断掉时, 在途的那个摘要请求没人管, 会一直赖到它自己的 45s 超时。
   *   这段窗口里:
   *     ① requestEpisodeSummary 第一行 `if (pendingSummary) return ''` → 后面每一集
   *       都不再总结 (用户原话"一集短剧看完了之后记忆总结出岔子了, 没总结起")
   *     ② handleModelText 里 `if (pendingSummary)` 会把模型吐的【每一个字】都收进
   *       这个僵尸 buffer, 一个字都不进气泡 → 看着像"连上了但不理我"
   *   所以断线这一刻必须立刻把它作废, 而不是等它自己超时。
   */
  function abortPendingSummary(reason) {
    var p = watchSession.pendingSummary;
    if (!p) return false;
    watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    if (p.timer) clearTimeout(p.timer);
    if (p.settleTimer) clearTimeout(p.settleTimer);
    // 迟到的那些字一律丢掉, 别流进下一次摘要 (同 waitForNoPendingSummary 里的理由)
    watchSession.summaryGhostUntil = Date.now() + 3000;
    try { if (S.client) S.client._lastTranscription = ''; } catch (e) { /* noop */ }
    logWarn('已作废在途的摘要请求(' + (reason || '未说明') + '), 那一次的内容作废');
    return true;
  }

  function waitForNoPendingSummary() {
    // ⚠️⚠️ 2026-10-09: 上限从 3000ms 提到 20000ms。
    //
    //   短剧一集 1~2 分钟就要出一份 300~400 字的单集记忆, 生成十几秒很正常。
    //   以前只等 3 秒就强行掐掉换发最终总结 —— 用户点退出时如果刚好撞上
    //   某一集的单集记忆还在生成, 那半句就会流进最终总结的 buffer。
    //   反正退出流程本来就必须等最终总结生成完 (常常十几秒), 多等这点不亏。
    //
    //   真的超时了也不能就这么算了: 开一个静默窗口, 把掐掉之后迟到的文本丢掉。
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 200;
        if (!watchSession.pendingSummary || waited > 20000) {
          if (watchSession.pendingSummary) {
            log('等待在途摘要超时 (' + waited + 'ms), 强制继续');
            abortPendingSummary('等待超时');
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

    // 🔴 2026-10-10 最后一层保险: 要走人了, 但最终观影记忆还没写成功
    //   → 先把内存里这些单集记忆存成 localStorage 草稿。
    //   这一行是"退出换时间再总结"能成立的根基: 页面一关内存就没了,
    //   草稿在, 下次进影院 restoreDraft() 就能捡回来, 不会白看。
    //   (已成功保存的会话 finalSummarySaved=true, 这里跳过, 不留垃圾草稿)
    if (!watchSession.finalSummarySaved) saveDraft();
    // ⚠️ 退出时自己把这次的播放时间账结清 (2026-10-07)。
    //
    // 不加这一行也能跑 —— 因为重连时 onClientState 里那个
    // "closed || !watchSessionId" 会命中, 由 newWatchSession() 顺手清。
    // 但那等于【清理依赖下游有人来擦】: 将来任何一条"重连但不清场"的路径
    // (比如短剧换集连播) 都会把旧时间账带进新会话。
    //
    // 语义上也该在这里清: 退出 = 这次会话彻底结束, 账就该当场结掉。
    markPaused();
    watchSession.playedMs = 0;
    watchSession.lastSummaryStartedAt = 0;
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
  // 手动生成最终观影记忆 (2026-10-10)
  //
  // 【为什么要有这条独立路径】
  //   原来退出流程 = 自动总结 → 写库 → 关房间, 是一条不可逆的单向道:
  //   一旦 Gemini 那次调用失败, 用户除了重试什么都做不了, 而页面一关内存就没了。
  //   (2026-10-10 用户实测: API 临时抽风 → 两集全丢)
  //
  //   现在分成两件独立的事:
  //     · generateFinalMemory()  ← 这里: 生成 + 写库, 【不退出房间】
  //     · 关房间                 ← 独立动作, 任何时候都能走
  //   失败不清数据(episodeMemories 一直留着), 按钮可以无限点。
  // ============================================================

  // 等 Live 就绪的最长时间 (ms)。超过就认失败, 回草稿, 让用户再点。
  // 不能无限等 —— 那会让用户看着界面一直转。
  var WAIT_READY_MS = 20000;

  /**
   * 轮询等 Live 连接就绪。resolve(true)=连上了, resolve(false)=超时。
   * 每 500ms 看一次; 用户手动 disable 或离开房间会提前退出。
   */
  function waitUntilReady(ms) {
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 500;
        if (S.client && S.client.isReady()) { clearInterval(iv); resolve(true); return; }
        // 用户主动停用 / 离开了 → 别傻等
        if (S._userDisabled || S._leaving || !S.enabled) { clearInterval(iv); resolve(false); return; }
        if (waited >= ms) { clearInterval(iv); resolve(false); }
      }, 500);
    });
  }

  function generateFinalMemory(opts) {
    var o = opts || {};
    if (watchSession.finalSummarySaved) return Promise.resolve({ saved: true, alreadySaved: true });
    // _waiting 是"正在等连接"的状态位, 用来防止"等 → 连上 → 递归 → 又判死/又等"的套娃。
    // 它是【在等待期间才置 true】, 且一旦进来先放行自己, 所以不会挡自己递归。
    if (o._waiting && (S.client && S.client.isReady())) o = Object.assign({}, o, { _waiting: false });
    if (!draftHasContent()) {
      return Promise.resolve({ saved: false, error: '这次还没有可总结的剧情记忆' });
    }
    // 已经有摘要在跑 → 拒掉, 防止点两次并发两个请求(单通道)。
    if (!o._waiting && (watchSession.summaryBusy || watchSession.pendingSummary)) {
      return Promise.resolve({ saved: false, error: '正在整理中，请等一下' });
    }
    var chat = getCurrentChat();
    if (!chat) return Promise.resolve({ saved: false, error: '没有找到角色会话' });

    // 🔴 2026-10-10 病根1: 连接判死成"死开关"(用户实测: 进去点总结连不上, 播第三集一直重连)
    //   旧写法只看"这一瞬间 isReady()", 而 Live 本来就在靠指数退避自愈。
    //   点按钮时正好落在退避间隔 → isReady()=false → 直接判死返回。
    //   而"等连接回来"没人触发, 连接一回来按钮还是判死 → 彻底死结, 也退不出。
    //
    //   改成: 没连上时【等它连上】再生成, 而不是直接判死。
    //   上限 WAIT_READY_MS, 超时才认失败 —— 能等, 但不会无限等。
    if (!S.client || !S.client.isReady()) {
      // 🔴 2026-10-10 用户实测: 带着草稿进影院直接点总结 → 连不上 API,
      //   因为 autoConnect 里有 `if (!video.src) return false` —— 只有在【播视频】时才连。
      //   但"精炼草稿"根本不需要画面: 剧情梗概、单集记忆、吐槽全都在草稿里,
      //   只要 Gemini 连上写一段文字就够了。所以这里【主动把 Live 连上】再生成,
      //   不该逼用户先播一集视频才能总结。
      if (!S.enabled) {
        // Live 压根没启动过 → 主动 enable()。需要 key; 没 key enable() 会自己提示并返回 false。
        if (!getGeminiKey()) {
          saveDraft();
          return Promise.resolve({ saved: false, error: '还没填 Gemini API Key，先到房间右上角 ⚙ 填一下（记忆已存草稿，不会丢）' });
        }
        appendSystemLine('⏳ 正在连接 Gemini 来整理你的观影记忆……');
        renderPlotPanel();
        // enable() 内部会校验 key / LiveClient 是否就绪, 失败返回 false
        return enable().then(function (started) {
          if (!started) {
            saveDraft();
            return { saved: false, error: 'Gemini 连不上，记忆已存草稿，连上后再点一次即可' };
          }
          // 已发起连接 → 等它 ready 后递归继续(带 _waiting 标记)
          return waitUntilReady(WAIT_READY_MS).then(function (ok) {
            if (!ok) {
              saveDraft();
              appendSystemLine('⚠️ Gemini 一直没连上，这次没存上（记忆已存草稿，连上后再点一次即可）');
              renderPlotPanel();
              return { saved: false, error: 'Gemini 一直没连上，记忆已存草稿，连上后再点一次' };
            }
            return generateFinalMemory(Object.assign({}, o, { _waiting: true }));
          });
        });
      }
      appendSystemLine('⏳ Gemini 正在重连，等它连上就自动帮你生成……');
      renderPlotPanel();
      return waitUntilReady(WAIT_READY_MS).then(function (ok) {
        if (!ok) {
          saveDraft();
          appendSystemLine('⚠️ Gemini 一直没连上，这次没存上（记忆已存草稿，连上后再点一次即可）');
          renderPlotPanel();
          return { saved: false, error: 'Gemini 一直没连上，记忆已存草稿，连上后再点一次' };
        }
        // 连上了 → 递归一次(带 _waiting 标记), 此时若又有别的请求在跑会被闸门拒掉
        return generateFinalMemory(Object.assign({}, o, { _waiting: true }));
      });
    }

    // 手动生成时【不设 S._leaving】—— 那会把帧循环和重连一起关掉, 房间就废了。
    if (!watchSession.finalSummaryRequested) {
      watchSession.finalSummaryRequested = true;
    }
    var wasPaused = S.paused;
    pauseFrames('手动生成观影记忆');      // 停帧, 让它专心写文字
    appendSystemLine(o.quiet ? '' : '⏳ 正在整理这次观影记忆，请稍等……');
    renderPlotPanel();

    // 🔴 2026-10-10 用 try/finally 包住整条链, 保证【一定会复位】。
    //   之前 flag 复位写在链尾的 .then 里, 一旦中途 promise 断掉/抛异常,
    //   flag 就永久卡在 true —— 而 handleUserMessage / resumeFrames 都拿它当闸门,
    //   结果是"连接还在但什么都发不出去、一直重连也连上了不理我"的死锁 (用户实测)。
    //   这一个 flag 卡住 = 整场观影变成死局, 绝不能漏复位。
    return waitForNoPendingSummary()
      .then(function () { return requestSummary('final', buildFinalSummaryInstruction()); })
      .then(function (text) {
        // 🔴 2026-10-15: 同 runFinalSummaryFlow, 一次调用出两份, 这里拆开
        var parts = splitFinalSummaryAndRecap(text);
        if (!parts.memory) throw new Error('Gemini 没有返回观影记忆内容');
        watchSession.finalSummaryText = parts.memory;
        appendSystemLine('💾 正在保存观影记忆…');
        renderPlotPanel();
        return saveToLongTermMemory(chat, parts.memory).then(function () {
          // 同 runFinalSummaryFlow: 兜底可能要补一次调用, 这里要等它 (见那边的注释)
          return saveSeriesRecapWithFallback(parts.recap);
        });
      })
      .then(function () {
        watchSession.finalSummarySaved = true;
        // 🔴 写库确认成功 → 才清草稿 (同 runFinalSummaryFlow 里的顺序理由)
        clearDraft();
        appendSystemLine('✅ 观影记忆已保存到长期记忆');
        return { saved: true };
      })
      .catch(function (err) {
        logError('手动生成观影记忆失败:', err.message);
        // 失败【绝不清数据】: 单集记忆还在, 按钮还能再点。
        saveDraft();   // 顺手留一手, 防用户点完就走 / 手机息屏
        appendSystemLine('⚠️ 这次没存上：' + err.message +
          '（你的记忆都还在，可以再点一次「生成观影记忆」）');
        return { saved: false, error: err.message };
      })
      .then(function (r) {
        // 无论成功失败都要把现场恢复, 否则用户看片会莫名其妙卡住不播了
        watchSession.finalSummaryRequested = false;
        finishSummary(watchSession.pendingSummary);
        flushQueuedUserText();
        if (!wasPaused && S.enabled && S.client && S.client.isReady()) {
          resumeFrames('手动生成完成');
        }
        renderStatus('ready');
        renderPlotPanel();
        return r;
      }, function (err) {
        // 上游抛异常时【也要】复位 —— 这里就是防 flag 卡死的那道兜底
        watchSession.finalSummaryRequested = false;
        finishSummary(watchSession.pendingSummary);
        saveDraft();
        logError('手动生成观影记忆(上游异常):', (err && err.message) || err);
        appendSystemLine('⚠️ 这次没存上：' + ((err && err.message) || '未知错误') +
          '（你的记忆都还在，可以再点一次「生成观影记忆」）');
        renderStatus('ready');
        renderPlotPanel();
        return { saved: false, error: (err && err.message) || '未知错误' };
      });
  }

  // ============================================================
  // 帧控制 / 消息 / 生命周期钩子
  // ============================================================
  function pauseFrames(reason) {
    if (!S.enabled) return;
    S.paused = true;
    // 计时冻结: 把这段播放时长结算进去, 然后把定时器收掉。
    // 不清掉的话它会在暂停期间空转到点, 白白吃掉一轮 5 分钟 (用户 2026-10-07 要求)。
    markPaused();
    stopStageSummary();
    log('暂停发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  function resumeFrames(reason) {
    if (!S.enabled || !S.client || !S.client.isReady()) return;
    S.paused = false;
    // 计时恢复: 从头起算播放时长, 再按"这一轮还差多少"重新排定时器。
    markPlaying();
    if (!watchSession.finalSummaryRequested && !watchSession._leaving) {
      scheduleStageSummary();
    }
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
    // ══════════════════════════════════════════════════════════════════════
    // 🔴 2026-10-10 摘要去掉了 turnComplete 依赖 (用户实测: 手动总结不落盘 + 片段漏进聊天框)
    //
    // 【这里现在什么都不收】—— 摘要统一由 SUMMARY_SETTLE_MS 静默计时器收
    //   (见 handleModelText 里的 p.armSettle())。
    //
    // 【为什么必须拿掉】原来的 gotText 门只防"一个字都没到就收", 防不住"收太早":
    //   观影时 1 FPS 送帧 → 回合被不停推进 → 发完摘要请求极容易撞上【上一回合收尾】。
    //   撞上时: 上一回合尾巴 → 塞进新 buffer 且 gotText=true → 该回合 turnComplete
    //   → 当场 resolve 一个半截 buffer → 真正的正文随后到达时 pendingSummary 已 null,
    //   全部漏进聊天框, 且写库拿到的内容是残缺的。
    //   静默计时跟回合边界解耦, 撞不撞回合都无所谓。
    //
    // 【保留】下面只是日志, 方便排查时看到回合在推进。
    // ══════════════════════════════════════════════════════════════════════
    if (watchSession.pendingSummary) {
      log('[摘要] 回合收尾 (不据此收摘要, 等静默计时器; 已吐 ' +
        (watchSession.pendingSummary.buffer || '').length + ' 字)');
      return;
    }
    // 普通陪聊的回合结束: 【什么都不做】, 气泡继续留着。
    // 一句话跨多个 turn 是常态, 只有用户发新消息才开新气泡。
  }

  /** 短剧换集 → 只结掉本次播放时长, 【不清场、不重连、不清摘要】(2026-10-07)
   *
   * 跟 onVideoSourceChanged 的区别: 那个是"换片"= 换了一部完全不同的东西,
   * 旧摘要作废是对的; 这个是"同一部剧的下一集", 摘要和连接都得留着。
   */
  function onSeriesEpisodeChanged() {
    markPaused();
    stopStageSummary();
    watchSession.currentPlotSummary = '';      // 单集记忆才是短剧的载体
    watchSession.summaryCount = 0;
    watchSession.summaryUpdatedAt = 0;
    watchSession.lastSummaryStartedAt = 0;      // 下一集重新起 5 分钟
    if (S.enabled) {
      markPlaying();                           // 新片马上要播, 接着起表
      scheduleStageSummary();
    }
    renderPlotPanel();
  }

  /** 自然播放结束 → 停发帧, 不关 Live, 不退出房间, 用户还能继续聊 */
  function onVideoEnded() {
    // 短剧: 一集播完 → 记这一集剧情 + 看够 20 集就合并 (2026-10-07)
    if (watchSession.kind === 'series') {
      // 🔴 2026-10-10 用户实测: 退出再进来播第3集, 总结却写成"第一集"。
      //   原来用 seriesLastEp+1 猜集号 —— 草稿恢复时序一错, seriesLastEp 还是 0,
      //   第3集就被记成第1集, addEpisodeMemory(1,...) 还会【覆盖掉草稿里的第1集记忆】。
      //   现在优先用宿主传来的【确切集号】(用户点的那个按钮); 没有才回退到猜。
      var ep = watchSession.nowPlayingEp > 0 ? watchSession.nowPlayingEp : (watchSession.seriesLastEp + 1);
      // 用掉了 nowPlayingEp 就清掉, 避免下次连播时又用它(串到下一集)
      watchSession.nowPlayingEp = 0;
      markPaused();
      stopStageSummary();
      log('第 ' + ep + ' 集播完, 记录剧情…');
      renderStatus('ready');
      requestEpisodeSummary(ep).then(function () {
        // 记完这集, "看过"才推进到本集
        if (ep > watchSession.seriesLastEp) watchSession.seriesLastEp = ep;
        renderPlotPanel();
        // 攒够就合并 (失败不丢数据, 逻辑在 maybeMergeSeriesOutline 里)
        return maybeMergeSeriesOutline();
      }).catch(function (err) {
        logWarn('第 ' + ep + ' 集记录失败:', err.message);
      });
      return;
    }

    if (!S.enabled) return;
    S.paused = true;
    // 播完 = 这段播放时长到此为止, 收表 + 收定时器。
    // 下一轮计时从 resumeFrames 再起 (用户手动重播或换片)。
    markPaused();
    stopStageSummary();
    log('视频播放结束, 停止发帧 (session 保留)');
    renderStatus('ready');
  }

  /** 换片 → 结束旧 session, 旧摘要丢弃(临时记忆), 重开新 session */
  function onVideoSourceChanged() {
    log('视频源已更换, 结束旧 watch session (其剧情摘要不写入长期记忆)');
    stopStageSummary();
    markPaused();          // 换片时若正在播放, 先把这一段落账, 别留悬空起点
    watchSession.currentPlotSummary = '';
    watchSession.summaryCount = 0;
    watchSession.summaryUpdatedAt = 0;
    watchSession.finalSummaryText = '';
    watchSession.finalSummarySaved = false;
    watchSession.finalSummaryRequested = false;
    watchSession.chatLog = [];
    plotEditing = null;
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
        if (!watchSession.chatId || watchSession.chatId !== S.chatId) {
          newWatchSession(S.chatId);
          // 🔴 2026-10-10 进影院先捡草稿 —— 只在这里恢复, 换片(onVideoSourceChanged)不恢复,
          //   免得旧片子的记忆莫名其妙混进新片。
          restoreDraft();
        }
      }
    },
    getChatId: function () { return S.chatId; },

    // 生命周期
    enable: enable,
    disable: disable,
    autoConnect: autoConnect,
    onLeaveCinema: onLeaveCinema,
    retryFinalSummary: retryFinalSummary,
    /**
     * 🔴 2026-10-10 手动生成最终观影记忆。写库成功但不退出房间,
     *   失败不清数据、可无限重试。UI 层(退出按钮/兜底弹框)也调它。
     */
    generateFinalMemory: generateFinalMemory,
    /** 有没有还没存进长期记忆的观影记忆 (UI 据此决定退出时要不要拦一下) */
    hasUnsavedMemory: function () {
      return draftHasContent() && !watchSession.finalSummarySaved;
    },
    /**
     * 放弃这次记忆, 强制走人 (2026-10-07)。
     *
     * 为什么需要它: 退出时如果 Gemini 返回空 (常见于 iOS 切后台把 Live 掐断),
     * 正常流程会一直卡在房间里 —— 用户实测被彻底关住, 重试也没用。
     * 这个入口让 UI 层能给一条兜底出路: 不保存记忆, 但必须能离开。
     */
    forceLeave: function (reason) {
      log('强制退出(不保存记忆): ' + (reason || '未说明'));
      watchSession.finalSummaryRequested = false;
      watchSession.leavePromise = null;
      S._leaving = false;
      hardLeave();
      return true;
    },
    pauseFrames: pauseFrames,
    resumeFrames: resumeFrames,
    handleUserMessage: handleUserMessage,
    onVideoEnded: onVideoEnded,
    onVideoSourceChanged: onVideoSourceChanged,

    // ---- 短剧 (2026-10-07) ----
    setSeries: setSeries,
    setSeriesProgress: function (key, title, lastEp, outline, nowPlayingEp) {
      if (key) watchSession.seriesKey = key;
      if (title !== undefined) watchSession.seriesTitle = title;
      if (lastEp !== undefined && lastEp !== null) watchSession.seriesLastEp = Number(lastEp) || 0;
      if (outline !== undefined && outline !== null) watchSession.seriesOutline = String(outline || '');
      // 🔴 2026-10-10 用户实测: 退出再进来播第3集, 总结却写成"第一集"。
      //   根因是 Live 只知道 seriesLastEp, 播完时用 seriesLastEp+1 猜集号;
      //   草稿恢复时序一错, seriesLastEp 还是 0 → 第3集被当成第1集, 还会覆盖旧记忆。
      //   宿主那边知道用户点的【确切集号】, 传过来直接用, 不猜。
      if (nowPlayingEp !== undefined && nowPlayingEp !== null) {
        watchSession.nowPlayingEp = Number(nowPlayingEp) || 0;
      }
      watchSession.kind = 'series';
    },
    requestEpisodeSummary: requestEpisodeSummary,
    maybeMergeSeriesOutline: maybeMergeSeriesOutline,
    onSeriesEpisodeChanged: onSeriesEpisodeChanged,
    getSeriesState: function () {
      return {
        kind: watchSession.kind,
        key: watchSession.seriesKey,
        title: watchSession.seriesTitle,
        lastEp: watchSession.seriesLastEp,
        outline: watchSession.seriesOutline,
        pending: watchSession.episodeMemories.length,
        outlineLen: (watchSession.seriesOutline || '').length
      };
    },

    // 剧情面板 (2026-10-16: 不再有 togglePlotPanel, 开关在 cinema-room.js 的 setPlotSheet)
    renderPlotPanel: renderPlotPanel,
    isPlotPanelOpen: function () {
      // 现在"开着"= 独立页面带了 .open 类, 不再是内存里那个折叠标志
      var sheet = document.getElementById('cinema-plot-sheet');
      return !!(sheet && sheet.classList.contains('open'));
    },

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
