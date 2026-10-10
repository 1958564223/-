// ============================================================
// binaural/trajectory.js — 动态声相轨迹的纯计算层
// ------------------------------------------------------------
// 定位: 纯函数, 不碰 AudioContext / 不碰播放 / 不写任何全局状态。
//
// 【2026-10-10 架构改版】停顿切位 (Pause-Stepped IR Switch)
//
//   放弃"出声期连续 Crossfade", 改为:
//     出声期间 —— 单个 ConvolverNode + 固定 buffer, 方位【锁死】
//     停顿期间 —— 在静音区里瞬间换 buffer, 切到下一个方位
//
//   为什么这样才对:
//     梳状滤波只在【两个卷积器同时出声、各自卷积同一路输入】时存在。
//     单卷积直出时根本不存在第二个滤波器, 梳状在结构上归零, 音质 100% 纯净。
//     而停顿时输入接近静音, 换 buffer 引起的内部状态作废落在静音区里, 听不到。
//     代价是"位移"而不是"滑移"—— 但位移发生在听众听不见的瞬间。
//
//   另一条判据来自上游 binaural-voice 作者: "别在停顿里移动。停顿时没有声音,
//   听的人听不见移动的过程, 只会觉得声音从一只耳朵瞬移到另一只。"
//   早期版本照做成了"停顿期冻结、出声期滑移", 实测仍有明显梳状;
//   现在反过来理解 —— 把移动【整个搬进停顿里】, 两条判据就都满足了。
//
// 坐标约定 (用 HRIR 数据实证过, 见 tools/verify_hrir.py):
//   0=正前  90=左  180=正后  270=右, 【逆时针递增】
// ============================================================

(function () {
  'use strict';

  // ------------------------------------------------------------
  // 轨迹定义
  // ------------------------------------------------------------
  var TRAJECTORIES = {
    static: {
      label: '静态固定',
      mode: 'none',
      hint: '整条语音固定在一个位置'
    },
    whisper: {
      label: '耳畔轻语 (移动到对侧耳朵)',
      mode: 'oppositeEar',
      hint: '整条说完到达对侧耳朵; 走后脑(180°), 绝不穿脸'
    },
    orbit: {
      label: '360° 水平环绕',
      mode: 'fullTurn',
      // 【显式整圈】绝不用最短路 + 模运算: 0° 与 360° 是同一点,
      // 最短路会把"转一圈"算成 0 位移 = 原地不动。
      // 方向显式写死, 不推导。+360 = 逆时针 = 与本项目方位角递增方向一致
      // (前->左->后->右->前)。想改成顺时针只要把这里改成 -360, 其余逻辑不用动。
      turnDeg: 360,
      hint: '每遇到一个停顿转一格, 整条说完刚好绕回起点'
    },
    approach: {
      label: '由远及近 (拉近到耳畔)',
      mode: 'distanceOnly',
      hint: '方位不动, 每个停顿把距离拉近一格, 最后贴到耳畔'
    }
  };

  var DEFAULT_TRAJECTORY = 'static';

  var NEAR_DIST = 0.25;
  var FAR_DIST = 1.0;

  // 出声时间线参数 (与 binaural_voice.py 同款)
  var HOP_SEC = 0.01;
  var VOICED_THRESHOLD = 0.05; // 低于峰值 5% 算静
  var GAP_FILL_FRAMES = 40;    // 字间 <0.4s 的小缝算在出声(不算切位点)
  var SMOOTH_FRAMES = 20;

  // ---- 停顿切位参数 ----
  // 合法停顿的最短时长。低于它就不切 —— 换 buffer 需要一点静默裕量。
  var MIN_PAUSE_SEC = 0.12;
  // 安全边距: 停顿开头先等这么久再切, 让上一次发声留下的卷积尾巴(约 2.7ms)抽干净。
  var RING_GUARD_SEC = 0.025;
  // 轮询间隔。停顿切位对时间精度要求不高, 慢一点无妨。
  var STEP_TIMER_MS = 30;

  // ------------------------------------------------------------
  // 方位角路径 —— 耳到耳必须走后脑, 不能穿脸
  // ------------------------------------------------------------
  /**
   * 与 binaural_voice.py 的 az_path 同款: 先取最短边; 但若最短边超过 150°
   * (意味着要横穿整个头部), 改走另一边 —— 那条路是绕到脑后。
   */
  function azPath(a0, a1) {
    a0 = ((a0 % 360) + 360) % 360;
    a1 = ((a1 % 360) + 360) % 360;
    var short = ((((a1 - a0 + 180) % 360) + 360) % 360) - 180;
    if (Math.abs(short) <= 150) return short;
    return a1 - a0;
  }

  function normalizeAz(az) {
    return ((az % 360) + 360) % 360;
  }

  // ------------------------------------------------------------
  // 出声时间线 (RMS 包络 -> voiced 掩码)
  // ------------------------------------------------------------
  /**
   * @param {{getChannelData:(c:number)=>Float32Array, length:number, sampleRate:number}} audioBuffer 单声道
   * @returns {{hopSec:number, voiced:Uint8Array, tau:Float32Array,
   *            speechDuration:number, duration:number}}
   */
  function buildVoicedTimeline(audioBuffer) {
    var sr = audioBuffer.sampleRate;
    var x = audioBuffer.getChannelData(0);
    var hop = Math.max(1, Math.round(sr * HOP_SEC));
    var frames = Math.max(1, Math.floor(x.length / hop));
    var rms = new Float32Array(frames);

    var peak = 0;
    for (var i = 0; i < frames; i++) {
      var start = i * hop;
      var end = Math.min(x.length, start + hop);
      var s = 0;
      for (var k = start; k < end; k++) s += x[k] * x[k];
      var r = Math.sqrt(s / Math.max(1, end - start));
      rms[i] = r;
      if (r > peak) peak = r;
    }

    var th = peak * VOICED_THRESHOLD;
    var voiced = new Uint8Array(frames);
    for (var f = 0; f < frames; f++) voiced[f] = rms[f] > th ? 1 : 0;

    // 字间小缝填成出声, 免得一句话被切成十几段, 每段都切一次位
    var i2 = 0;
    while (i2 < frames) {
      var j = i2;
      while (j < frames && !voiced[j]) j++;
      if (i2 > 0 && j < frames && (j - i2) < GAP_FILL_FRAMES) {
        for (var g = i2; g < j; g++) voiced[g] = 1;
      }
      i2 = Math.max(j, i2 + 1);
    }

    // 0.2s 移动平均, 避免 voiced 在阈值附近抖动导致"假停顿"
    var smooth = new Float32Array(frames);
    var acc = 0;
    var win = SMOOTH_FRAMES;
    for (var m = 0; m < frames; m++) {
      acc += voiced[m];
      if (m >= win) acc -= voiced[m - win];
      smooth[m] = acc / Math.min(win + 1, m + 1);
    }

    var tau = new Float32Array(frames);
    var total = 0;
    for (var n = 0; n < frames; n++) {
      total += smooth[n] * HOP_SEC;
      tau[n] = total;
    }

    return {
      hopSec: HOP_SEC,
      voiced: voiced,
      tau: tau,
      speechDuration: total,
      duration: frames * HOP_SEC
    };
  }

  function speechTimeToWall(tl, speechT) {
    if (!(speechT > 0)) return 0;
    if (speechT >= tl.speechDuration) return tl.duration;
    var tau = tl.tau;
    for (var i = 0; i < tau.length; i++) {
      if (tau[i] >= speechT) return i * tl.hopSec;
    }
    return tl.duration;
  }

  // ------------------------------------------------------------
  // 找合法停顿 (切位点)
  // ------------------------------------------------------------
  /**
   * 在 voiced 掩码里找连续静音段, 只保留"两头都有声音"的。
   *
   * 为什么两头都要有声音 —— 切位点的意义是"换到新方位后还要有声音能听见":
   *   · 前面没声音(开头静音) -> 换了方位也听不出来, 只会让第一条字直接出现在
   *     终点位置。"由远及近"会一开口就已经贴到耳朵, 与"动态=起点"的语义相反。
   *   · 后面没声音(结尾静音) -> 换了方位没有东西可听, 白换一次 buffer。
   *     纯静音整段则被这条规则一次挡掉两个问题。
   *
   * 切位时刻取【停顿开头 + 安全边距】而不是正中间: 那时发声留下的卷积尾巴
   * (128 抽头 ≈ 2.7ms) 早已抽干, 换 buffer 的内部状态作废落在纯静音里, 听不到。
   *
   * @param {object} timeline buildVoicedTimeline 的结果
   * @returns {Array<{index:number, t:number, dur:number, start:number, end:number}>}
   *   t 是"在第几秒换 buffer"(已加安全边距), 单位秒, 直接对应播放时间轴
   */
  function findPauses(timeline, minPauseSec, guardSec) {
    var minPause = minPauseSec == null ? MIN_PAUSE_SEC : minPauseSec;
    var guard = guardSec == null ? RING_GUARD_SEC : guardSec;
    var v = timeline.voiced;
    var hop = timeline.hopSec;
    var out = [];
    var i = 0;

    while (i < v.length) {
      if (v[i]) { i++; continue; }
      var j = i;
      while (j < v.length && !v[j]) j++;
      var dur = (j - i) * hop;
      // 必须是"语音中间的停顿": 前面有声音(否则一开口就在终点位置),
      // 后面也得有声音(否则换完方位没东西可听, 白换一次)。
      var midSpeech = i > 0 && j < v.length;
      // 还必须长到"扣掉两头安全边距后还剩得下换 buffer 的时机"
      if (midSpeech && dur >= minPause && dur >= guard * 2 + 0.01) {
        out.push({
          index: out.length,
          start: i * hop,
          end: j * hop,
          dur: dur,
          t: i * hop + guard
        });
      }
      i = j;
    }
    return out;
  }

  // ------------------------------------------------------------
  // 轨迹编排: 把【停顿】一一映射到【方位关键点】
  // ------------------------------------------------------------
  /**
   * 每遇到一个合法停顿就顺次走一格; 停顿有多少个, 整条角度就被均分成多少份。
   * 停顿多 -> 每格角度小 -> 位移细碎(但都在静音里, 听不出);
   * 停顿少 -> 每格角度大 -> 位移粗(同样在静音里)。
   * 两种情况听感都不受"滑移"影响, 这正是停顿切位的核心好处。
   *
   * @param {{trajectory:string, fromAz:number, fromDist:number,
   *          pauses:Array, toDist?:number}} opts
   * @returns {Array<{t:number, az:number, dist:number}>}
   */
  function buildPausePlan(opts) {
    opts = opts || {};
    var def = TRAJECTORIES[opts.trajectory] || TRAJECTORIES[DEFAULT_TRAJECTORY];
    var fromAz = Number(opts.fromAz) || 0;
    var fromDist = Number(opts.fromDist) || NEAR_DIST;
    var toDist = Number(opts.toDist) || NEAR_DIST;
    var pauses = opts.pauses || [];

    var delta = 0;
    if (def.mode === 'oppositeEar') {
      // 对侧耳朵。azPath 保证不穿脸: 90(左) -> 270(右) 增量固定 +180, 途经 180(后脑)。
      delta = azPath(fromAz, normalizeAz(fromAz + 180));
    } else if (def.mode === 'fullTurn') {
      delta = def.turnDeg;   // 显式整圈, 不做模运算
    } else if (def.mode === 'distanceOnly') {
      delta = 0;
      fromDist = FAR_DIST;
      toDist = NEAR_DIST;
    }

    if (def.mode === 'none' || pauses.length === 0) return [];

    var plan = [];
    for (var i = 0; i < pauses.length; i++) {
      var p = (i + 1) / pauses.length;   // 走完这一格后到达的位置
      plan.push({
        t: pauses[i].t,
        pauseIndex: pauses[i].index,
        az: normalizeAz(fromAz + delta * p),
        dist: fromDist + (toDist - fromDist) * p
      });
    }
    return plan;
  }

  window.TtsBinauralTrajectory = {
    TRAJECTORIES: TRAJECTORIES,
    DEFAULT_TRAJECTORY: DEFAULT_TRAJECTORY,
    NEAR_DIST: NEAR_DIST,
    FAR_DIST: FAR_DIST,
    MIN_PAUSE_SEC: MIN_PAUSE_SEC,
    RING_GUARD_SEC: RING_GUARD_SEC,
    STEP_TIMER_MS: STEP_TIMER_MS,
    HOP_SEC: HOP_SEC,
    azPath: azPath,
    normalizeAz: normalizeAz,
    buildVoicedTimeline: buildVoicedTimeline,
    speechTimeToWall: speechTimeToWall,
    findPauses: findPauses,
    buildPausePlan: buildPausePlan
  };
})();
