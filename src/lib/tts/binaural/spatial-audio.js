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
//   2. 【不碰通话链路】优先借用 window.voiceCallSharedAudioContext(已由彩铃点击
//      授权、且全项目从不 close), 借不到才自建。本模块只创建自己的节点并在结束时
//      disconnect 自己的节点, 从不修改/关闭任何别人的 ctx, 因此 call-lip-sync.js
//      的 getTapNode 与通话 TTS 队列完全不受影响。
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
  var ownCtx = null;              // 自建的 ctx (借用不到时才建)
  var borrowedCtx = null;         // 上次借用的共享 ctx
  var active = null;              // 当前播放句柄的内部状态
  var lastError = '';

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

  function isCallBusy() {
    try {
      return typeof window.isCallTtsPlaying === 'function' && window.isCallTtsPlaying();
    } catch (e) {
      return false;
    }
  }

  function sharedCtxHealthy() {
    var ctx = window.voiceCallSharedAudioContext;
    if (!ctx) return false;
    if (ctx.state === 'closed') return false;
    if (typeof ctx.createConvolver !== 'function') return false;
    // 通话正在播 TTS 时不借 —— 避免两条链路在同一张音频图上互相干扰
    if (isCallBusy()) return false;
    return true;
  }

  function ownCtxHealthy() {
    return !!(ownCtx && ownCtx.state !== 'closed' && typeof ownCtx.createConvolver === 'function');
  }

  /**
   * 拿到可用 ctx。同步执行 (不吃 await), 供 prepare() 在手势内调用。
   * @returns {AudioContext|null}
   */
  function ensureContext() {
    // 1) 优先借用通话链路的共享 ctx —— 它已 resume, 不必再赌一次 iOS 授权
    if (sharedCtxHealthy()) {
      borrowedCtx = window.voiceCallSharedAudioContext;
      if (borrowedCtx.state === 'suspended' && typeof borrowedCtx.resume === 'function') {
        borrowedCtx.resume().catch(function () { /* 非手势环境静默失败, 下面会查 state */ });
      }
      if (borrowedCtx.state === 'running') return borrowedCtx;
    }

    // 2) 自建 (整个生命周期只建一次)
    var Ctx = getAudioContextClass();
    if (!Ctx) return null;

    if (!ownCtxHealthy()) {
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
  // 音频链构造
  // ------------------------------------------------------------
  // 一条链 = ConvolverNode -> GainNode -> destination
  //   静态路径只用一条; 动态路径用 A/B 两条并联, 靠两个 GainNode 交叉淡化换方位。
  //
  // 为什么用【互补线性】而不是等功率(cos/sin)淡化:
  //   两个 Convolver 吃的是【同一个输入】, 输出高度相关。等功率淡化会让
  //   中间总功率鼓出 +3dB; 互补线性因为两路相关, 反而是平的。
  //   同理, 换 buffer 必须先装到【增益为 0】的那条上, 换的瞬间听不到, 不会有咔哒声。
  // ============================================================
  function makeConvChain(ctx, ir, gainValue) {
    var conv = ctx.createConvolver();
    // 自己做响度对齐(见 hrir-data.getStereoIr), 关掉浏览器内置归一化,
    // 避免"归一化 × 我的增益"两次缩放。不认这个属性的实现默认 true, 语义一致。
    try { conv.normalize = false; } catch (e) { /* 老实现忽略 */ }
    conv.buffer = ir;
    var gain = ctx.createGain();
    gain.gain.value = gainValue;
    conv.connect(gain);
    gain.connect(ctx.destination);
    return { conv: conv, gain: gain, state: { value: gainValue } };
  }

  /**
   * 把某条链的增益平滑推到目标值。
   * cancelAndHoldAtTime 能保住"此刻正在播的自动化值", 不支持的老浏览器
   * 退回 cancelScheduledValues + setValueAtTime(用我们自己记的目标值近似)。
   */
  function rampGain(node, value, atTime, dur) {
    var param = node.gain.gain;
    var last = node.state.value;
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(atTime);
      } else {
        param.cancelScheduledValues(atTime);
        param.setValueAtTime(last, atTime);
      }
    } catch (e) {
      try { param.cancelScheduledValues(atTime); param.setValueAtTime(last, atTime); } catch (e2) { /* ignore */ }
    }
    param.linearRampToValueAtTime(value, atTime + dur);
    node.state.value = value;
  }

  function setupStatic(st, ir) {
    // ⚠️ 静态路径刻意【不插 GainNode】 —— 它必须与引入动态轨迹之前逐字等价:
    //   ConvolverNode -> destination, 一个增益节点都不多建。
    //   动态路径才需要增益来做交叉淡化。
    var conv = st.ctx.createConvolver();
    try { conv.normalize = false; } catch (e) { /* 老实现忽略 */ }
    conv.buffer = ir;
    conv.connect(st.ctx.destination);
    st.inputs = [conv];
    st.chain = [conv];
    st.slotA = null;
    st.slotB = null;
  }

  /**
   * 动态轨迹: A/B 双卷积并联 + 关键帧调度。
   *
   * 关键帧时间轴来自 trajectory 模块的【出声时间】换算, 所以停顿期间
   * 相邻关键帧的墙钟间隔被自动拉开 —— 停顿里不推进, 不会瞬移。
   */
  function setupDynamic(st, hrirApi, set, trajApi, trajectory, fromAz, fromDist) {
    var ctx = st.ctx;

    var timeline = trajApi.buildVoicedTimeline(st.buffer);
    var plan = trajApi.buildPlan({
      trajectory: trajectory,
      fromAz: fromAz,
      fromDist: fromDist,
      toDist: trajApi.NEAR_DIST,
      speechDuration: timeline.speechDuration
    });

    var keys = [];
    for (var i = 0; i < plan.length; i++) {
      keys.push({
        t: trajApi.speechTimeToWall(timeline, plan[i].speechT),
        az: plan[i].az,
        dist: plan[i].dist
      });
    }
    st.keys = keys;
    st.keyIndex = 1;
    st.lastStepAt = null;   // 上一次开始交叉淡化的墙钟时刻, 用于"淡出未走完就不换 buffer"的守卫

    var firstIr = hrirApi.getStereoIr(set, ctx, keys[0].az, keys[0].dist);
    var A = makeConvChain(ctx, firstIr, 1);   // 当前主导
    var B = makeConvChain(ctx, firstIr, 0);   // 待接管, 此刻增益 0 完全听不到
    st.slotA = A;
    st.slotB = B;
    st.inputs = [A.conv, B.conv];             // 源同时喂两边
    st.chain = [A.conv, A.gain, B.conv, B.gain];

    /**
     * 推进到一个新关键帧。
     * @returns {boolean} true = 已推进; false = 本次跳过(调用方应重试)
     */
    function applyStep(key) {
      var now = ctx.currentTime;

      // ⚠️ 守卫 —— 这一条是"咔哒声"的主要来源。
      //   换 convolver.buffer 会让该节点的内部卷积状态作废, 输出上出现台阶。
      //   如果上一次交叉淡化还没走完, 待接管的那条链此刻仍有可听增益,
      //   台阶就变成了听得见的咔哒。所以淡出未走完时直接放弃本次推进,
      //   下一个 tick 自动重试; 步进间隔远大于淡化时长时不会真的触发。
      if (st.lastStepAt != null && (now - st.lastStepAt) < trajApi.CROSSFADE_SEC) return false;

      var ir;
      try {
        ir = hrirApi.getStereoIr(set, ctx, key.az, key.dist);
      } catch (e) { return false; }
      if (!ir || ir.numberOfChannels !== 2) return false;

      // state.value 记的是上一次 ramp 的【目标值】, 因此较大的那条就是当前主导
      var incoming = (A.state.value >= B.state.value) ? B : A;
      var outgoing = (incoming === B) ? A : B;

      // 双保险: 换 buffer 之前先把 incoming 的增益硬压到 0 并取消一切待执行的自动化。
      // 有了上面的守卫它此刻本来就该是 0, 这句只为防浏览器在自动化边界上的细微出入。
      try {
        incoming.gain.gain.cancelScheduledValues(now);
        incoming.gain.gain.setValueAtTime(0, now);
      } catch (e) { /* ignore */ }
      incoming.state.value = 0;

      // 此时增益确认为 0, 换 buffer 在输出上听不到
      incoming.conv.buffer = ir;

      // 淡化起点就是 currentTime (它已经是渲染量子的起点, 不会落在量子内部),
      // 两条链用互补线性同步 ramp, 任意时刻 g_in + g_out === 1, 中途无幅度台阶。
      rampGain(incoming, 1, now, trajApi.CROSSFADE_SEC);
      rampGain(outgoing, 0, now, trajApi.CROSSFADE_SEC);
      st.lastStepAt = now;
      return true;
    }

    st.onStep = function () {
      function tick() {
        if (!st.playing || st.finished) return;
        var elapsed = ctx.currentTime - st.startedAt;
        var guard = 0;
        while (st.keyIndex < keys.length && keys[st.keyIndex].t <= elapsed && guard++ < 64) {
          // 淡出未走完就 break, 保留 keyIndex 供下次 tick 重试(不丢步进)
          if (!applyStep(keys[st.keyIndex])) break;
          st.keyIndex++;
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
      slotA: null,
      slotB: null,
      keys: null,
      keyIndex: 0,
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

    function startAt(offset) {
      var src = ctx.createBufferSource();
      src.buffer = st.buffer;
      // 动态路径下 inputs 是并联的 A/B 两条 convolver, 源要同时喂两边
      for (var i = 0; i < st.inputs.length; i++) src.connect(st.inputs[i]);
      src.onended = function () {
        if (st.source !== src) return;      // 被 pause/stop 换掉了, 不是自然结束
        st.source = null;
        st.playing = false;
        st.finished = true;
        if (active === st) active = null;
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
        // 等卷积尾巴抽完再摘节点, 否则末尾几个采样会被切断
        setTimeout(function () {
          for (var c = 0; c < st.chain.length; c++) {
            try { st.chain[c].disconnect(); } catch (e) { /* ignore */ }
          }
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
    getLastError: function () { return lastError; },
    // 供测试
    _setLastError: function (v) { lastError = v; },
    _debugActive: function () {
      return active ? {
        playing: active.playing,
        offset: active.offset,
        rate: active.ctx.sampleRate,
        borrowed: active.ctx === borrowedCtx
      } : null;
    }
  };
})();
