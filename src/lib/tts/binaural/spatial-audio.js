// ============================================================
// binaural/spatial-audio.js — 双耳空间音频播放引擎 (Web Audio)
// ------------------------------------------------------------
// 定位: 聊天语音条专用的空间音频播放通道。
//       输入一个单声道 Blob, 走
//         BufferSource(单声道) -> ConvolverNode(双耳 HRIR) -> destination
//       输出一个可控的播放句柄 (暂停 / 继续 / 停止)。
//
// 三条硬约束 (决定了这里的每一个设计):
//   1. 【绝不影响现有播放】任何一步失败都往上抛, 由 tts-audio.js 回退到
//      <audio> 原路径。引擎自己绝不能"静默失败"造成无声。
//   2. 【绝不借用通话的 ctx】早期版本优先借 window.voiceCallSharedAudioContext
//      (它由彩铃点击授权、全项目从不 close)。2026-10-10 实测发现这是错的:
//      iPhone 上只要发生过一次输出路由变化(摘耳机 / 关蓝牙), 长期存活的
//      AudioContext 不会改道, Web Audio 会把声音送进一个已经不存在的设备 ->
//      【完全无声】, 而同一时刻 <audio> 照常出声(走的是另一条音频会话)。
//      实测确认: 关掉空间音频立刻恢复外放, 重新连上蓝牙耳机又好了。
//      现在改为: 聊天语音一律用自己的、播完即关的短命 ctx。既不碰也不关
//      别人的 ctx, call-lip-sync.js 的 getTapNode 与通话 TTS 队列完全不受影响,
//      又天然跟着当前输出设备走。
//   3. 【iOS user gesture】AudioContext 的创建与 resume 必须在点击手势内同步发生,
//      否则 Safari 会挂起 -> 无声。所以 prepare() 是同步的, 必须在点击处理函数
//      最开头调用, 之后才 await 网络和解码。
//
// 数据来源: Neumann KU100 近场 HRIR, Zenodo 2020, doi:10.5281/zenodo.4297951
//           CC BY 4.0 —— 署名见 hrir-data.js 的 ATTRIBUTION 与设置页。
// ============================================================

(function () {
  'use strict';

  var PREFERRED_SAMPLE_RATE = 48000;   // HRIR 原生 48k, 首选它可避免重采样
  var POSITION_KEYS = ['left', 'right', 'behind', 'front'];

  // 方位约定: 逆时针, 0=前 90=左 180=后 270=右 (已用 HRIR 数据实证)
  var POSITIONS = {
    left:   { label: '左耳',   azimuthDeg: 90,  distanceM: 0.25 },
    right:  { label: '右耳',   azimuthDeg: 270, distanceM: 0.25 },
    behind: { label: '脑后',   azimuthDeg: 180, distanceM: 0.31 },
    front:  { label: '面前',   azimuthDeg: 0,   distanceM: 0.42 }
  };

  var DISTANCES = {
    near:  { label: '贴近 (25cm)', distanceM: 0.25 },
    mid:   { label: '常规 (50cm)', distanceM: 0.5 },
    far:   { label: '较远 (1m)',   distanceM: 1.0 }
  };

  var DEFAULT_SETTINGS = {
    enabled: false,        // 默认关闭: 新功能不应在未验证前改变所有人的听感
    position: 'right',
    distance: 'near'
  };

  // ---- 状态 ----
  // ownCtx 是【本条语音专用】的短命 ctx: prepare() 在手势里建, 播完(卷积尾巴
  // 走完)就 close 掉。绝不长期复用 —— 长期复用正是 iOS 输出路由失效的根源,
  // 详见文件头约束 2。
  var ownCtx = null;
  var active = null;              // 当前播放句柄的内部状态
  var lastError = '';
  var routeWatchBound = false;    // 路由变化监听是否已挂(只挂一次)

  // ------------------------------------------------------------
  // 基础能力检测
  // ------------------------------------------------------------
  function getAudioContextClass() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function isSupported() {
    var Ctx = getAudioContextClass();
    if (!Ctx) return false;
    // ConvolverNode / createBuffer 的真实能力在 ensureContext 里探测(需要实例),
    // 这里只做"有没有 AudioContext 构造器"的粗判, 避免为了探测就创建一个 ctx。
    return true;
  }

  /**
   * 关掉自己的 ctx。这是本模块【唯一】允许调用 close 的地方 ——
   * 通话那条链的 window.voiceCallSharedAudioContext 归它们自己管, 本模块
   * 既不借也不关(见文件头约束 2)。
   */
  function closeOwnCtx() {
    var c = ownCtx;
    if (!c) return;
    ownCtx = null;
    // 插值出来的双耳 buffer 缓存跟着旧 ctx 一起作废(只清这层, 不动解析好的二进制)
    try {
      if (window.TtsBinauralHrir && typeof window.TtsBinauralHrir.clearIrCache === 'function') {
        window.TtsBinauralHrir.clearIrCache();
      }
    } catch (e) { /* ignore */ }
    try {
      if (c.state !== 'closed' && typeof c.close === 'function') c.close();
    } catch (e) { /* 关不掉就算了, 只是多占一个 ctx */ }
  }

  /**
   * 输出设备变了就把自己的 ctx 丢掉, 下次 prepare() 会建一个新的 ——
   * 新建时拿到的是当前真实路由, 而不是那个已经断开的老设备。
   *
   * devicechange 只在部分浏览器上会触发(iOS 基本不触发), visibilitychange
   * 在手机上更常与"拔耳机/切输出"同时发生, 两条都挂上, 挂不上也不影响 ——
   * 主保险是"每条语音一个短命 ctx"。
   */
  function onRouteMayHaveChanged() {
    if (!ownCtx) return;
    // 还有在播的不动它, 打断当前这条语音比修路由更糟
    if (active && active.playing) return;
    closeOwnCtx();
  }

  function bindRouteWatchers() {
    if (routeWatchBound) return;
    routeWatchBound = true;
    try {
      if (window.navigator && window.navigator.mediaDevices
        && typeof window.navigator.mediaDevices.addEventListener === 'function') {
        window.navigator.mediaDevices.addEventListener('devicechange', onRouteMayHaveChanged);
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) onRouteMayHaveChanged();
        });
      }
    } catch (e) { /* ignore */ }
  }

  function ownCtxHealthy() {
    return !!(ownCtx && ownCtx.state !== 'closed' && typeof ownCtx.createConvolver === 'function');
  }

  /**
   * 拿到可用 ctx。同步执行 (不吃 await), 供 prepare() 在手势内调用。
   * @returns {AudioContext|null}
   */
  function ensureContext() {
    var Ctx = getAudioContextClass();
    if (!Ctx) return null;

    bindRouteWatchers();

    // 只用自己那条短命 ctx, 借来的永远不进这条链
    if (!ownCtxHealthy()) {
      closeOwnCtx();
      try {
        ownCtx = new Ctx({ sampleRate: PREFERRED_SAMPLE_RATE, latencyHint: 'playback' });
      } catch (e) {
        // 老 Safari 不认 options, 退回无参构造
        try {
          ownCtx = new Ctx();
        } catch (e2) {
          lastError = 'ctx_create_failed:' + (e2 && e2.message);
          ownCtx = null;
          return null;
        }
      }
    }
    if (ownCtx.state === 'suspended' && typeof ownCtx.resume === 'function') {
      ownCtx.resume().catch(function () { /* 下面统一查 state */ });
    }
    return ownCtx;
  }

  /**
   * 在用户手势内同步预热。必须在点击处理函数最开头调用,
   * 等它返回后再去 await 网络, iOS 才认这次授权。
   */
  function prepare() {
    return ensureContext();
  }

  function getContext() {
    var ctx = ensureContext();
    return ctx && ctx.state === 'running' ? ctx : null;
  }

  function getSampleRate() {
    var ctx = getContext();
    return ctx ? ctx.sampleRate : 0;
  }

  // ------------------------------------------------------------
  // 设置读取
  // ------------------------------------------------------------
  function getSettings() {
    var tts = (window.state && window.state.apiConfig && window.state.apiConfig.tts) || {};
    var raw = tts.binaural || {};
    var trajApi = window.TtsBinauralTrajectory;
    var trajectories = (trajApi && trajApi.TRAJECTORIES) || { static: { label: '静态固定', mode: 'none' } };
    var settings = {
      enabled: raw.enabled === true,
      position: POSITIONS[raw.position] ? raw.position : DEFAULT_SETTINGS.position,
      distance: DISTANCES[raw.distance] ? raw.distance : DEFAULT_SETTINGS.distance,
      // 2026-10-10: 动态轨迹。默认 static, 保持改造前行为逐字一致。
      trajectory: trajectories[raw.trajectory] ? raw.trajectory : 'static'
    };
    var pos = POSITIONS[settings.position];
    var dist = DISTANCES[settings.distance];
    settings.azimuthDeg = pos.azimuthDeg;
    settings.distanceM = dist.distanceM;
    settings.isDynamic = !!(trajectories[settings.trajectory]
      && trajectories[settings.trajectory].mode
      && trajectories[settings.trajectory].mode !== 'none');
    settings.label = (settings.isDynamic ? trajectories[settings.trajectory].label + ' · ' : '')
      + pos.label + ' · ' + dist.label;
    return settings;
  }

  function isEnabled() {
    return getSettings().enabled;
  }

  // ------------------------------------------------------------
  // 解码辅助
  // ------------------------------------------------------------
  function blobToArrayBuffer(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') {
      return blob.arrayBuffer();
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('blob_read_failed')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  function decodeAudio(ctx, arrayBuffer) {
    return new Promise(function (resolve, reject) {
      var p;
      try {
        p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      } catch (e) {
        reject(e);
        return;
      }
      // 现代浏览器返回 Promise; 老 Safari 只走回调 —— 两条都接上, 且只 settle 一次
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  /**
   * 强制单声道。
   * ConvolverNode 在 "双声道输入 + 双声道 IR" 时走的是真立体声矩阵 (L→L, R→R),
   * 那不是我们要的; 只有单声道输入 + 双声道 IR 才会得到"一只耳一个 HRIR"。
   */
  function toMono(audioBuffer, ctx) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer;
    var out = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    var dst = out.getChannelData(0);
    var n = audioBuffer.numberOfChannels;
    for (var c = 0; c < n; c++) {
      var src = audioBuffer.getChannelData(c);
      for (var i = 0; i < dst.length; i++) dst[i] += src[i] / n;
    }
    return out;
  }

  // ------------------------------------------------------------
  // 播放
  // ------------------------------------------------------------
  function stop() {
    if (!active) return false;
    var st = active;
    active = null;
    teardownSource(st);
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
    // chain 里是本模块自己创建的节点 (动态路径有 conv+gain 共 4 个),
    // 只 disconnect 自己的, 绝不碰借来的 ctx 上的其他节点。
    for (var i = 0; i < (st.chain || []).length; i++) {
      try { st.chain[i].disconnect(); } catch (e) { /* ignore */ }
    }
    if (st.onstate) {
      try { st.onstate('stopped'); } catch (e) { /* ignore */ }
    }
    return true;
  }

  function teardownSource(st) {
    if (st.source) {
      try { st.source.onended = null; } catch (e) { /* ignore */ }
      try { st.source.stop(); } catch (e) { /* 已自然结束 */ }
      try { st.source.disconnect(); } catch (e) { /* ignore */ }
      st.source = null;
    }
  }

  // ============================================================
  // 输出监听 + 静音兜底 (2026-10-13)
  // ------------------------------------------------------------
  // 为什么需要这一段: iPhone 上出现过"开了空间音频就彻底没声音, 关掉就好"的
  // 故障, 而同一时刻 <audio> 播放完全正常。前两轮排查(梳状调参 / 输出路由)
  // 都没命中, 说明光靠静态推理排不掉这种问题 —— 与其继续猜, 不如让代码自己量。
  //
  // 做法: 在卷积器后面挂一个 AnalyserNode 量【实际输出】, 同时按播放位置取
  // 【同一时刻的输入采样】。当"输入此刻明明有声, 而输出量出来几乎是零"时,
  // 就说明音频图是死的 —— 这不是判断, 是测量。
  //
  // "同一时刻输入"这个对照是关键: 只看输出的话, 语音里的句读停顿会被误判成
  // 故障。所以必须先确认那个位置上的输入采样本身确实响。
  //
  // 判定成立就【自动回退 <audio>】。项目的硬约束是"绝不能无声" —— 宁可这一条
  // 没有空间感, 也不能让用户什么都听不到。
  // ============================================================
  var DIAG_MAX = 30;
  var WATCHDOG_MS = 120;
  var SILENT_HITS_TO_GIVE_UP = 2;
  var diagnostics = [];

  function diag(event, detail) {
    diagnostics.push({
      t: Date.now(),
      event: event,
      detail: detail == null ? '' : String(detail)
    });
    if (diagnostics.length > DIAG_MAX) diagnostics.shift();
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[双耳空间音频]', event, detail == null ? '' : detail);
      }
    } catch (e) { /* ignore */ }
  }

  function getDiagnostics() {
    return diagnostics.slice();
  }

  function absAt(x, i) {
    var v = x[i];
    return v < 0 ? -v : v;
  }

  function peakOf(audioBuffer) {
    var x = audioBuffer.getChannelData(0);
    var p = 0;
    for (var i = 0; i < x.length; i++) {
      var a = absAt(x, i);
      if (a > p) p = a;
    }
    return p;
  }

  /** AnalyserNode 只用来"旁听", 不往 destination 接, 所以不会改变输出电平。 */
  function makeOutputMonitor(ctx) {
    var an = ctx.createAnalyser();
    an.fftSize = 2048;
    var buf = new Float32Array(an.fftSize);
    return {
      node: an,
      peak: function () {
        try { an.getFloatTimeDomainData(buf); } catch (e) { return 0; }
        var p = 0;
        for (var i = 0; i < buf.length; i++) {
          var a = buf[i] < 0 ? -buf[i] : buf[i];
          if (a > p) p = a;
        }
        return p;
      }
    };
  }

  /**
   * 静音看门狗。命中即停掉空间播放并回调 onSilentFallback, 由上层落回 <audio>。
   */
  function startWatchdog(st, onSilentFallback) {
    function tick() {
      st.watchdog = setTimeout(tick, WATCHDOG_MS);
      if (!st.playing || st.finished || st.silent || !st.monitor) return;
      // 源本身就没声音(全零)时无可验证, 不判故障
      if (st.inPeak < 1e-6) return;

      var pos = st.offset + (st.ctx.currentTime - st.startedAt);
      var x = st.buffer.getChannelData(0);
      var sr = st.buffer.sampleRate || st.ctx.sampleRate;
      var i = Math.floor(pos * sr);
      if (i < 0 || i >= x.length) return;

      // 同一时刻输入本来就是静音 -> 那是语音里的句读停顿, 不是故障
      var xi = absAt(x, i);
      if (xi < st.inPeak * 0.01) { st.silentHits = 0; return; }

      var out = st.monitor.peak();
      var floor = Math.max(1e-5, st.inPeak * 0.02);   // 比输入低 34dB 视为死了
      if (out >= floor) { st.silentHits = 0; return; }

      st.silentHits++;
      if (st.silentHits < SILENT_HITS_TO_GIVE_UP) return;

      st.silent = true;
      diag('output_silent',
        'pos=' + pos.toFixed(2) + 's'
        + ' inSample=' + xi.toFixed(4)
        + ' outPeak=' + out.toFixed(6)
        + ' inPeak=' + st.inPeak.toFixed(4)
        + ' ctxState=' + st.ctx.state
        + ' sr=' + st.ctx.sampleRate
        + ' traj=' + (st.trajectory || 'static'));
      stop();
      if (onSilentFallback) {
        try { onSilentFallback('output_silent'); } catch (e) { /* ignore */ }
      }
    }
    st.watchdog = setTimeout(tick, WATCHDOG_MS);
  }

  // ============================================================
  // 音频链构造 —— 停顿切位 (Pause-Stepped IR Switch)
  // ------------------------------------------------------------
  // 结构: BufferSource(单声道) -> ConvolverNode(单条, 双耳 HRIR) -> destination
  //
  // ⚠️ 2026-10-10 架构改版: 彻底移除了 A/B 双卷积 + 增益交叉淡化。
  //
  //   为什么必须换掉: 旧方案在【出声期间】同时跑两个卷积器, 各自卷积同一路输入。
  //   两条路径的到达时间差半毫秒左右 —— 这就是梳状滤波的成因。实测数据:
  //     淡化0.22s/步进0.90s  ->  梳状 29.9%
  //     淡化0.09s/步进0.45s  ->  梳状 19.0%
  //     淡化0.05s/步进0.45s  ->  梳状 19.0%   (淡化再短, 纹丝不动)
  //     淡化0.03s/步进0.15s  ->  梳状  7.5%   (已经压到很夸张了)
  //   即"每步只跨 9 度、淡化只有 30 毫秒"仍有 7.5% 残留, 用户实测反馈"还是有杂音"。
  //   根因是结构性的, 调参救不了 —— 只要两个滤波器同时出声就有相位抵消。
  //
  //   现在的做法: 出声期间【全场只有一个卷积器一个 buffer】, 梳状在结构上归零,
  //   音质就是 HRIR 本身, 100% 干净。方位只在停顿(静音区)里瞬切, 那时输入接近 0,
  //   换 buffer 引起的内部状态作废落在无声处, 听不到。
  //
  //   代价是"位移"而不是"滑移"。但位移发生在听众听不见的瞬间, 这正是我们要的。
  //
  // 静态路径与动态路径现在共用同一个单卷积结构, 区别只有"要不要换 buffer"。
  // ============================================================
  function makeConvolver(ctx, ir) {
    var conv = ctx.createConvolver();
    // 自己做响度对齐(见 hrir-data.getStereoIr), 关掉浏览器内置归一化,
    // 避免"归一化 × 我的增益"两次缩放。不认这个属性的实现默认 true, 语义一致。
    try { conv.normalize = false; } catch (e) { /* 老实现忽略 */ }
    conv.buffer = ir;
    conv.connect(ctx.destination);
    return conv;
  }

  function setupStatic(st, ir) {
    var conv = makeConvolver(st.ctx, ir);
    st.convolver = conv;
    st.inputs = [conv];
    st.chain = [conv];
    attachMonitor(st, ir);
  }

  /** 把旁听用的 AnalyserNode 挂在卷积器输出上, 顺带记一次 IR 的实测幅度。 */
  function attachMonitor(st, ir) {
    if (!st.ctx || typeof st.ctx.createAnalyser !== 'function') return;
    try {
      var m = makeOutputMonitor(st.ctx);
      st.monitor = m;
      st.chain.push(m.node);
      st.convolver.connect(m.node);      // 旁听, 不接 destination

      // IR 峰值: 真机上如果它是 0, 说明取到的根本不是有效的 HRIR
      st.irPeak = 0;
      for (var c = 0; c < ir.numberOfChannels; c++) {
        var d = ir.getChannelData(c);
        for (var i = 0; i < d.length; i++) {
          var a = d[i] < 0 ? -d[i] : d[i];
          if (a > st.irPeak) st.irPeak = a;
        }
      }
    } catch (e) {
      st.monitor = null;
    }
  }

  /**
   * 动态轨迹: 单卷积器 + 停顿切位调度。
   *
   * 停顿表在播放【之前】就算好了 —— MiniMax 一次返回整段音频 (stream:false),
   * 我们本来就要在播放前把整段 decode 成 AudioBuffer, 所以可以直接对整段做 RMS
   * 分析得出全部切位时刻。不需要在播放时"听着切", 也就不会有检测漂移。
   */
  function setupDynamic(st, hrirApi, set, trajApi, trajectory, fromAz, fromDist) {
    var ctx = st.ctx;

    var timeline = trajApi.buildVoicedTimeline(st.buffer);
    var pauses = trajApi.findPauses(timeline);
    var plan = trajApi.buildPausePlan({
      trajectory: trajectory,
      fromAz: fromAz,
      fromDist: fromDist,
      toDist: trajApi.NEAR_DIST,
      pauses: pauses
    });

    var firstIr = hrirApi.getStereoIr(set, ctx, fromAz, fromDist);
    var conv = makeConvolver(ctx, firstIr);

    st.convolver = conv;
    st.inputs = [conv];
    st.chain = [conv];
    st.pausePlan = plan;
    st.pauseIndex = 0;
    st.pauseCount = pauses.length;
    attachMonitor(st, firstIr);

    // 一个合法停顿都没有 -> 整条保持起始方位, 行为等同静态。记一笔方便排查。
    if (plan.length === 0) {
      console.info('[双耳空间音频] 这条语音没检测到足够长的停顿, 方位保持不动。');
    }

    st.onStep = function () {
      function tick() {
        if (!st.playing || st.finished) return;
        // 真实播放位置。用 st.offset 起算, 这样暂停后 resume 也能对得上
        // (resume 时 startAt 传入的是续播偏移, st.startedAt 会重置)。
        var pos = st.offset + (ctx.currentTime - st.startedAt);
        var guard = 0;
        while (st.pauseIndex < plan.length && plan[st.pauseIndex].t <= pos && guard++ < 64) {
          var key = plan[st.pauseIndex];
          st.pauseIndex++;
          try {
            // 【切位】直接换 buffer —— 没有增益节点, 没有第二个卷积器。
            // 出声期间不存在任何相位抵消的可能。
            conv.buffer = hrirApi.getStereoIr(set, ctx, key.az, key.dist);
          } catch (e) {
            console.warn('[双耳空间音频] 切位失败, 保持当前方位:', e);
          }
        }
        st.timer = setTimeout(tick, trajApi.STEP_TIMER_MS);
      }
      tick();
    };
  }


  /**
   * 播放一条单声道语音到指定空间位置。
   * @param {{blob: Blob, azimuthDeg?: number, distanceM?: number, trajectory?: string,
   *          onended?: Function, onstate?: Function}} opts
   * @returns {Promise<Object>} 句柄 { pause, resume, stop, isPlaying, getDuration }
   * @throws {Error} 任何一步失败都抛出 —— 调用方负责回退到 <audio>
   */
  async function play(opts) {
    opts = opts || {};
    if (!opts.blob) throw new Error('spatial_no_blob');

    // 前一次还没放完就先停掉, 避免两段叠着响
    stop();

    var ctx = getContext();
    if (!ctx) throw new Error('spatial_no_ctx');
    if (typeof ctx.createConvolver !== 'function') throw new Error('spatial_no_convolver');

    // ---- HRIR ----
    var hrirApi = window.TtsBinauralHrir;
    if (!hrirApi) throw new Error('spatial_no_hrir_module');
    var set = await hrirApi.load();
    if (!set) throw new Error('spatial_no_hrir_data');
    // 加载完再确认一次: 等待期间 ctx 可能被系统挂起或关闭
    if (ctx.state !== 'running') throw new Error('spatial_ctx_not_running:' + ctx.state);
    if (!window.TtsBinauralHrir) throw new Error('spatial_hrir_module_gone');

    // ---- 静态 or 动态 ----
    var trajectory = opts.trajectory || 'static';
    var trajApi = window.TtsBinauralTrajectory;
    var trajDef = trajApi && trajApi.TRAJECTORIES ? trajApi.TRAJECTORIES[trajectory] : null;
    var isDynamic = !!(trajDef && trajDef.mode && trajDef.mode !== 'none');

    // ---- 解码 (两条路径共用) ----
    var arrayBuffer = await blobToArrayBuffer(opts.blob);
    var decoded = await decodeAudio(ctx, arrayBuffer);
    if (!decoded || !decoded.length) throw new Error('spatial_empty_decode');
    var mono = toMono(decoded, ctx);

    if (ctx.state !== 'running') throw new Error('spatial_ctx_died:' + ctx.state);

    var st = {
      ctx: ctx,
      source: null,
      buffer: mono,
      inputs: [],   // BufferSource 要连到的节点
      chain: [],    // 结束时统一 disconnect
      offset: 0,
      startedAt: 0,
      playing: false,
      finished: false,
      onended: opts.onended || null,
      onstate: opts.onstate || null,
      tailMs: 80,
      timer: null,
      onStep: null,
      convolver: null,
      monitor: null,        // AnalyserNode 旁听, 量实际输出
      inPeak: 0,            // 解码后单声道的峰值, 用来判断"输出是不是死得太离谱"
      irPeak: 0,
      silentHits: 0,
      silent: false,
      watchdog: null,
      onSilentFallback: opts.onsilent || null,
      trajectory: trajectory,
      pausePlan: null,   // 停顿切位表: [{t, az, dist}]
      pauseIndex: 0,
      pauseCount: 0,
      dynamic: isDynamic
    };

    if (isDynamic) {
      var firstIr = hrirApi.getStereoIr(set, ctx, opts.azimuthDeg, opts.distanceM);
      if (!firstIr || firstIr.numberOfChannels !== 2) throw new Error('spatial_bad_ir');
      st.tailMs = Math.ceil((firstIr.length / ctx.sampleRate) * 1000) + 40;
      setupDynamic(st, hrirApi, set, trajApi, trajectory, opts.azimuthDeg, opts.distanceM);
    } else {
      var ir = hrirApi.getStereoIr(set, ctx, opts.azimuthDeg, opts.distanceM);
      if (!ir || ir.numberOfChannels !== 2) throw new Error('spatial_bad_ir');
      st.tailMs = Math.ceil((ir.length / ctx.sampleRate) * 1000) + 40;
      setupStatic(st, ir);
    }

    // 图建完再量: 输入峰值 + IR 峰值都拿到了, 记一条可供真机排查的现场
    st.inPeak = peakOf(mono);
    diag('play_start',
      'traj=' + st.trajectory
      + ' ctxState=' + ctx.state
      + ' sr=' + ctx.sampleRate
      + ' decodeCh=' + decoded.numberOfChannels
      + ' decodeDur=' + decoded.duration.toFixed(2) + 's'
      + ' inPeak=' + st.inPeak.toFixed(4)
      + ' irPeak=' + (st.irPeak || 0).toFixed(4));

    function startAt(offset) {
      var src = ctx.createBufferSource();
      src.buffer = st.buffer;
      // 静态与动态都是单卷积, inputs 恒为 [convolver]; 保留循环是为了
      // 万一将来链路前面还要插节点, 不必再动这里的接线。
      for (var i = 0; i < st.inputs.length; i++) src.connect(st.inputs[i]);
      src.onended = function () {
        if (st.source !== src) return;      // 被 pause/stop 换掉了, 不是自然结束
        st.source = null;
        st.playing = false;
        st.finished = true;
        if (active === st) active = null;
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
        if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
        // 等卷积尾巴抽完再摘节点, 否则末尾几个采样会被切断
        setTimeout(function () {
          for (var c = 0; c < st.chain.length; c++) {
            try { st.chain[c].disconnect(); } catch (e) { /* ignore */ }
          }
          // 尾巴走完就把这条语音专用的 ctx 关掉。下次播放会在用户手势里重新建,
          // 拿到的是【当前】输出设备 —— 这正是治 iOS "摘耳机后外放彻底无声"的那一剂。
          // stop() 里故意不关: play() 一进来就调 stop(), 那时 prepare() 刚在手势里
          // 建好 ctx, 关掉就得在 gesture 之外重建, iOS 会重新挂起。
          if (ownCtx === st.ctx) closeOwnCtx();
        }, st.tailMs);
        if (st.onended) {
          try { st.onended(); } catch (e) { /* ignore */ }
        }
      };
      src.start(0, offset);
      st.source = src;
      st.offset = offset;
      st.startedAt = ctx.currentTime;
      st.playing = true;
      // 关键帧调度随播放一起启动; 暂停时 tick 会因 !st.playing 自然停摆
      if (typeof st.onStep === 'function') st.onStep();
      // 静音看门狗: 万一这台设备上音频图是死的, 立刻交回上层落回 <audio>
      startWatchdog(st, st.onSilentFallback);
    }

    startAt(0);
    active = st;
    if (st.onstate) {
      try { st.onstate('playing'); } catch (e) { /* ignore */ }
    }

    return {
      pause: function () {
        if (!st.playing || st.finished) return false;
        st.offset = st.offset + (ctx.currentTime - st.startedAt);
        teardownSource(st);
        st.playing = false;
        if (st.onstate) {
          try { st.onstate('paused'); } catch (e) { /* ignore */ }
        }
        return true;
      },
      resume: function () {
        if (st.playing || st.finished) return false;
        if (ctx.state !== 'running') return false;
        if (st.offset >= st.buffer.duration - 0.01) return false;
        startAt(st.offset);
        if (st.onstate) {
          try { st.onstate('playing'); } catch (e) { /* ignore */ }
        }
        return true;
      },
      stop: function () { return stop(); },
      isPlaying: function () { return st.playing; },
      getDuration: function () { return st.buffer.duration; }
    };
  }

  function isPlaying() {
    return !!(active && active.playing);
  }

  function isActive() {
    return !!active;
  }

  // ------------------------------------------------------------
  window.TtsSpatialAudio = {
    POSITIONS: POSITIONS,
    DISTANCES: DISTANCES,
    POSITION_KEYS: POSITION_KEYS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ATTRIBUTION: window.TtsBinauralHrir ? window.TtsBinauralHrir.ATTRIBUTION : null,

    isSupported: isSupported,
    ensureContext: ensureContext,
    prepare: prepare,
    getContext: getContext,
    getSampleRate: getSampleRate,
    getSettings: getSettings,
    isEnabled: isEnabled,
    play: play,
    // 暂停/继续只走 play() 返回的句柄 —— 那里才持有 offset 与 convolver 引用;
    // 全局层面只暴露 stop(), 供 stopChatMessageTtsOnly 之类不需要续播的场景使用。
    stop: stop,
    isPlaying: isPlaying,
    isActive: isActive,
    // 真机排查用: 最近若干条现场记录 (播放参数 / 实测输出 / 判定结果)
    getDiagnostics: getDiagnostics,
    getLastError: function () { return lastError; },
    // 供测试
    _setLastError: function (v) { lastError = v; },
    _debugActive: function () {
      return active ? {
        playing: active.playing,
        offset: active.offset,
        rate: active.ctx.sampleRate,
        // 2026-10-10: 聊天语音不再借用通话共享 ctx, 这里恒为 false。保留字段
        // 只是不想让可能在读它的排查代码炸掉。
        borrowed: false
      } : null;
    }
  };
})();
