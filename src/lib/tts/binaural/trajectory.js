// ============================================================
// binaural/trajectory.js — 动态声相轨迹的纯计算层
// ------------------------------------------------------------
// 定位: 纯函数, 不碰 AudioContext / 不碰播放 / 不写任何全局状态。
//       只回答两个问题:
//         1) 这段语音里哪些时刻"有人在出声" (停顿时方位必须冻结, 不能移动)
//         2) 在【出声时间】里, 方位角与距离该走到哪
//
// 坐标约定 (用 HRIR 数据实证过, 见 tools/verify_hrir.py):
//   0=正前  90=左  180=正后  270=右, 【逆时针递增】
//   判据: az=90 处左耳通道能量是右耳的 161 倍; az=270 正好反过来。
//
// ⚠️ 为什么必须做 voiced 检测, 不能简单地按 0→duration 线性移动:
//   上游 binaural-voice 作者的实测结论 —— "别在停顿里移动。停顿时没有声音,
//   听的人听不见移动的过程, 只会觉得声音从一只耳朵瞬移到另一只"。
//   MiniMax t2a_v2 不返回逐字时间戳, 移动时机只能靠本地音频能量推断。
//   buildVoicedTimeline 就是 binaural_voice.py 那段 RMS 包络检测的 JS 移植。
//   效果: 关键帧的时间轴是"出声时间", 换算回墙钟后, 停顿区间里相邻关键帧
//         会被自然拉开 —— 停顿期间根本不推进, 从根上杜绝瞬移。
// ============================================================

(function () {
  'use strict';

  // ------------------------------------------------------------
  // 轨迹定义
  // ------------------------------------------------------------
  // 全部以"用户当前选定的位置"为起点, 所以位置设置在任何模式下都有意义。
  var TRAJECTORIES = {
    static: {
      label: '静态固定',
      mode: 'none',
      hint: '整条语音固定在一个位置'
    },
    whisper: {
      label: '耳畔轻语 (移动到对侧耳朵)',
      mode: 'oppositeEar',
      hint: '从当前方位一边说一边挪到对侧耳朵; 走后脑(180°), 绝不穿脸'
    },
    orbit: {
      label: '360° 水平环绕',
      mode: 'fullTurn',
      // 【显式整圈】绝不用最短路 + 模运算: 0° 与 360° 是同一点,
      // 最短路会把 "转一圈" 算成 0 位移 = 原地不动。
      // 方向显式写死, 不推导。+360 = 逆时针 = 与本项目方位角递增方向一致
      // (前→左→后→右→前)。想改成顺时针只要把这里改成 -360, 其余逻辑不用动。
      turnDeg: 360,
      hint: '从当前方位完整绕一整圈回到起点'
    },
    approach: {
      label: '由远及近 (拉近到耳畔)',
      mode: 'distanceOnly',
      hint: '方位不动, 距离从 1m 逐渐拉到 25cm 耳畔'
    }
  };

  var DEFAULT_TRAJECTORY = 'static';

  var NEAR_DIST = 0.25;   // 数据集最近的一档
  var FAR_DIST = 1.0;

  // 出声时间线参数 (与 binaural_voice.py 同款)
  var HOP_SEC = 0.01;         // 10ms 一格
  var VOICED_THRESHOLD = 0.05; // 低于峰值 5% 算静
  var GAP_FILL_FRAMES = 40;    // 字间 <0.4s 的小缝算在出声
  var SMOOTH_FRAMES = 20;      // 0.2s 平滑, 让走停有缓冲

  // 交叉淡化时长 —— 2026-10-10 实测后从 0.22s 压到 0.09s。
  //
  // 为什么这里会产生梳状滤波(comb filtering):
  //   两个 ConvolverNode 吃的是【同一个输入】, 卷积出的是同一段语音的两个延迟版本。
  //   在交叉淡化期间它们被同时加权求和, 而两条路径的到达时间(HRIR 首个显著峰)
  //   差半毫秒左右 —— 这正是相位抵消的条件, 听起来就是"梳状/颤动"。
  //   缩短淡化时长只能缩短它【持续多久】, 不能让它消失, 但能让它在听感上
  //   从"持续的怪异感"变成"极短的一下", 代价必须靠更小的步进来补 (见下)。
  //
  // ⚠️ 别再往小了压: 淡化越短, 输出幅值变化越陡, 咔哒声反而越明显。
  var CROSSFADE_SEC = 0.09;

  // 步进间隔 —— 2026-10-10 实测后从 0.9s 压到 0.2s。
  //
  // ⚠️ 实测结论 (见 _reports/binaural-audit/measure_combf.cjs, 6s 环绕信号):
  //
  //   配置                每步跨度  梳状强度
  //   淡化0.22 / 步进0.90    51.4°    29.9%
  //   淡化0.09 / 步进0.45    25.7°    19.0%
  //   淡化0.05 / 步进0.45    25.7°    19.0%   <- 淡化再短, 梳状一点没降
  //   淡化0.09 / 步进0.22    12.9°    10.3%
  //   淡化0.03 / 步进0.15     9.0°     7.5%
  //
  //   【关键结论】在步进跨度不变的前提下, 把淡化从 0.22 压到 0.09 再压到 0.05,
  //   梳状强度纹丝不动 (19.0% -> 19.0%)。真正压下来的是【步进跨度】本身:
  //   步进减半, 梳状强度几乎减半。
  //
  //   原因: 梳状滤波的幅度正比于"两条 HRIR 有多不像"。淡化时长只决定它
  //   出现多久, 不决定它有多强; 每步跨多少度才决定强度。
  var STEP_SEC = 0.2;
  var STEP_TIMER_MS = 20;      // 关键帧轮询间隔(随步进变密而加密)

  // ------------------------------------------------------------
  // 方位角路径 —— 耳到耳必须走后脑, 不能穿脸
  // ------------------------------------------------------------
  /**
   * 求从 a0 走到 a1 的角度增量。
   * 与 binaural_voice.py 的 az_path 同款: 先取最短边; 但若最短边超过 150°
   * (意味着要横穿整个头部), 改走另一边 —— 那条路是绕到脑后。
   * @param {number} a0 起点方位
   * @param {number} a1 终点方位
   * @returns {number} 增量(度), 可正可负
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
  // 出声时间线
  // ------------------------------------------------------------
  /**
   * RMS 包络 -> voiced 掩码 -> 累积"出声时间"
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

    // 字间小缝(<0.4s)填成出声, 免得一句话被切成十几段, 每段都走一步
    var i2 = 0;
    while (i2 < frames) {
      var j = i2;
      while (j < frames && !voiced[j]) j++;
      if (i2 > 0 && j < frames && (j - i2) < GAP_FILL_FRAMES) {
        for (var g = i2; g < j; g++) voiced[g] = 1;
      }
      i2 = Math.max(j, i2 + 1);
    }

    // 0.2s 移动平均, 让"开始走/停下来"有缓冲
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

  /**
   * 出声时间 -> 墙钟秒数 (tau 单调不减, 顺序扫即可)
   * @param {object} tl buildVoicedTimeline 的结果
   * @param {number} speechT 目标出声秒数
   * @returns {number} 墙钟秒数
   */
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
  // 轨迹编排
  // ------------------------------------------------------------
  /**
   * 算出整段语音的走位关键帧。时间轴是【出声时间】, 不是墙钟时间。
   * @param {{trajectory:string, fromAz:number, fromDist:number,
   *          toDist?:number, speechDuration:number, stepSec?:number}} opts
   * @returns {Array<{speechT:number, az:number, dist:number}>}
   */
  function buildPlan(opts) {
    opts = opts || {};
    var def = TRAJECTORIES[opts.trajectory] || TRAJECTORIES[DEFAULT_TRAJECTORY];
    var fromAz = Number(opts.fromAz) || 0;
    var fromDist = Number(opts.fromDist) || NEAR_DIST;
    var toDist = Number(opts.toDist) || NEAR_DIST;
    var speechDuration = Math.max(0, Number(opts.speechDuration) || 0);
    var stepSec = opts.stepSec || STEP_SEC;

    if (def.mode === 'none' || speechDuration <= 0) {
      return [{ speechT: 0, az: normalizeAz(fromAz), dist: fromDist }];
    }

    var delta = 0;
    if (def.mode === 'oppositeEar') {
      // 对侧耳朵。azPath 保证不穿脸: 90(左) -> 270(右) 增量是 +180, 途经 180(后脑)。
      delta = azPath(fromAz, normalizeAz(fromAz + 180));
    } else if (def.mode === 'fullTurn') {
      // 整圈: 显式跨度, 不做模运算归零
      delta = def.turnDeg;
    } else if (def.mode === 'distanceOnly') {
      delta = 0;
      fromDist = FAR_DIST;
      toDist = NEAR_DIST;
    }

    var steps = Math.max(1, Math.ceil(speechDuration / stepSec));
    var plan = [];
    for (var i = 0; i <= steps; i++) {
      var p = i / steps;
      plan.push({
        speechT: p * speechDuration,
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
    CROSSFADE_SEC: CROSSFADE_SEC,
    STEP_SEC: STEP_SEC,
    STEP_TIMER_MS: STEP_TIMER_MS,
    HOP_SEC: HOP_SEC,
    azPath: azPath,
    normalizeAz: normalizeAz,
    buildVoicedTimeline: buildVoicedTimeline,
    speechTimeToWall: speechTimeToWall,
    buildPlan: buildPlan
  };
})();
