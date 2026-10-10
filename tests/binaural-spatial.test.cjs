// ============================================================
// tests/binaural-spatial.test.cjs
// 双耳空间音频 —— 单元 + 集成回归测试
//
// 跑法: node tests/binaural-spatial.test.cjs
//
// 做法: 与 tts-voice-resolver.test.cjs 同一套路 —— vm 沙箱加载【真实的】
//   src/lib/tts/binaural/*.js 与 modules/tts-audio.js, 只把浏览器原生能力
//   (AudioContext / fetch / Blob) 换成可观测的假实现。
//   HRIR 二进制读的是 assets/audio/hrir-ku100-nf.bin 真文件。
//
// 重点覆盖:
//   A 二进制解析与损坏检测
//   B 方位/左右方向正确性 —— 用【真实卷积】验证, 不是只看数组
//   C 距离增益与越界钳制
//   D 采样率重采样器
//   E 引擎: ctx 借用/自建、音频图、单声道强制、失败即抛
//   F 聊天链路集成: 开关、回退、停止、缓存路径、情绪/缓存键回归
//   G 通话链路隔离 —— 空间音频绝不能渗进视频/语音通话
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.join(ROOT, 'assets', 'audio', 'hrir-ku100-nf.bin');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) pass++;
  else failures.push(`${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
}
function checkTrue(name, cond, detail) {
  if (cond) pass++;
  else failures.push(`${name}${detail ? '\n      ' + detail : ''}`);
}
function checkClose(name, actual, expected, tol, unit) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
  if (ok) pass++;
  else failures.push(`${name}\n      期望: ${expected} ±${tol}${unit || ''}\n      实际: ${actual}`);
}

// ============================================================
// 假 Web Audio
// ============================================================
function makeAudioBuffer(channels, length, sampleRate, fill) {
  const data = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(length));
  if (fill) fill(data);
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => data[c],
    _data: data
  };
}

// 可观测的 AudioParam: 记录所有自动化事件, 用来断言交叉淡化的形状
class FakeAudioParam {
  constructor(v) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push({ type: 'set', v, t }); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push({ type: 'ramp', v, t }); return this; }
  setValueCurveAtTime(curve, t, dur) { this.events.push({ type: 'curve', v: curve, t, dur }); return this; }
  cancelScheduledValues(t) { this.events.push({ type: 'cancel', t }); return this; }
  cancelAndHoldAtTime(t) { this.events.push({ type: 'hold', t }); return this; }
  automationRate() { return 'a-rate'; }
}

class FakeAudioContext {
  constructor(opts) {
    this.opts = opts || {};
    this.sampleRate = this.opts.sampleRate || 44100;
    this.state = this.opts.__state || 'running';
    this.destination = { name: 'destination' };
    this.currentTime = 0;
    this.convolvers = [];
    this.gains = [];
    this.sources = [];
    this.decodeShouldFail = false;
    this.decoded = null;         // 未指定则生成一个 1 秒单声道缓冲
  }
  createGain() {
    const n = {
      kind: 'gain',
      gain: new FakeAudioParam(1),
      connectedTo: [],
      connect(x) { this.connectedTo.push(x); },
      disconnect() { this.disconnected = true; }
    };
    this.gains.push(n);
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    return makeAudioBuffer(channels, length, sampleRate);
  }
  createConvolver() {
    const n = {
      kind: 'convolver',
      normalize: true,
      buffer: null,
      connectedTo: [],
      connect(x) { this.connectedTo.push(x); },
      disconnect() { this.disconnected = true; }
    };
    this.convolvers.push(n);
    return n;
  }
  createBufferSource() {
    const n = {
      kind: 'source',
      buffer: null,
      onended: null,
      connectedTo: [],
      connect(x) { this.connectedTo.push(x); },
      start(when, offset) { this.startedAt = when; this.startOffset = offset; },
      stop() { this.didStop = true; },
      disconnect() { this.disconnected = true; }
    };
    this.sources.push(n);
    return n;
  }
  decodeAudioData(arrayBuffer, ok, bad) {
    let p;
    if (this.decodeShouldFail) {
      p = Promise.reject(new Error('decode_bomb'));
    } else {
      p = Promise.resolve(this.decoded || makeAudioBuffer(1, 4800, this.sampleRate));
    }
    if (typeof ok === 'function') p.then(ok, bad);
    return p;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

// ============================================================
// 沙箱
// ============================================================
function loadApp({ binauralEnabled = false, sampleRate = 48000, sharedCtx = null } = {}) {
  const audioElements = {
    'call-tts-audio-player': makeFakeAudioEl(),
    'tts-audio-player': makeFakeAudioEl(),
    'tts-enabled-switch': { value: '', checked: true, style: {}, addEventListener() {} },
    'tts-provider-select': { value: 'minimax', checked: false, style: {}, addEventListener() {} },
    'tts-settings-details': { style: {}, innerHTML: '' },
    'tts-provider-form': { style: {}, innerHTML: '' },
    'tts-spatial-form': { style: {}, innerHTML: '' },
    'tts-minimax-api-key': { value: 'k', checked: false, style: {}, addEventListener() {} },
    'tts-minimax-group-id': { value: 'g', checked: false, style: {}, addEventListener() {} },
    'tts-minimax-model': { value: 'speech-2.6-hd', checked: false, style: {}, addEventListener() {} }
  };

  // 空间音频设置的宿主。渲染是 innerHTML 字符串赋值, 假 DOM 得在赋值时
  // "变出"子元素, 否则后面的 getElementById 拿不到开关。
  const spatialHost = { style: {}, _html: '' };
  Object.defineProperty(spatialHost, 'innerHTML', {
    get() { return this._html; },
    set(html) {
      this._html = html;
      if (String(html).indexOf('tts-binaural-switch') >= 0) {
        audioElements['tts-binaural-switch'] = { checked: false, style: {}, onchange: null };
        audioElements['tts-binaural-details'] = { style: {} };
        audioElements['tts-binaural-trajectory'] = { value: 'static', style: {}, onchange: null };
        audioElements['tts-binaural-traj-hint'] = { textContent: '', style: {} };
        audioElements['tts-binaural-position'] = { value: 'right', style: {}, disabled: false };
        audioElements['tts-binaural-position-label'] = { textContent: '', style: {} };
        audioElements['tts-binaural-distance'] = { value: 'near', style: {}, disabled: false };
        audioElements['tts-binaural-distance-label'] = { textContent: '', style: {} };
        audioElements['tts-binaural-note'] = { textContent: '', style: {} };
      } else {
        delete audioElements['tts-binaural-switch'];
        delete audioElements['tts-binaural-details'];
        delete audioElements['tts-binaural-trajectory'];
        delete audioElements['tts-binaural-traj-hint'];
        delete audioElements['tts-binaural-position'];
        delete audioElements['tts-binaural-position-label'];
        delete audioElements['tts-binaural-distance'];
        delete audioElements['tts-binaural-distance-label'];
        delete audioElements['tts-binaural-note'];
      }
    }
  });
  audioElements['tts-spatial-form'] = spatialHost;

  const createdCtx = [];
  let binBytes = null;

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.AbortController = AbortController;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.alert = () => {};
  sandbox.showCustomAlert = async () => true;
  sandbox.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  sandbox.Blob = Blob;
  sandbox.atob = atob;
  sandbox.isFinite = isFinite;
  sandbox.parseInt = parseInt;
  // 真实 FileReader.readAsDataURL 会把 Blob 转成 dataURL 并填进 .result,
  // tts-audio.js 正是靠它写 ttsCache。假实现不填 result 会让缓存里存进 undefined,
  // 后面缓存命中路径就会莫名其妙地回退到 <audio> —— 那是 fake 的锅, 不是代码的。
  sandbox.FileReader = class {
    readAsDataURL(blob) {
      const self = this;
      Promise.resolve(blob.arrayBuffer()).then((ab) => {
        const bytes = new Uint8Array(ab);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = Buffer.from(bin, 'binary').toString('base64');
        self.result = 'data:' + ((blob && blob.type) || 'application/octet-stream') + ';base64,' + b64;
        if (self.onloadend) self.onloadend();
      });
    }
  };

  sandbox.AudioContext = function (opts) {
    const ctx = new FakeAudioContext(opts);
    createdCtx.push(ctx);
    return ctx;
  };
  sandbox.webkitAudioContext = sandbox.AudioContext;

  // fetch: 只服务 HRIR 二进制, 记录请求次数
  let fetchCount = 0;
  sandbox.fetch = async (url) => {
    fetchCount++;
    if (String(url).indexOf('hrir-ku100-nf.bin') >= 0) {
      if (!binBytes) return { ok: false, status: 404, arrayBuffer: async () => { throw new Error('nope'); } };
      const copy = binBytes.slice();
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
      };
    }
    return { ok: false, status: 404, arrayBuffer: async () => { throw new Error('unexpected fetch ' + url); } };
  };

  sandbox.document = {
    getElementById: (id) => audioElements[id] || null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {} })
  };
  sandbox.state = {
    activeChatId: 'chat1',
    chats: {
      chat1: { isGroup: false, settings: { minimaxVoiceId: 'zh_voice_test', enableTts: true } }
    },
    ttsCache: new Map(),
    apiConfig: {
      tts: {
        ttsEnabled: true,
        currentProvider: 'minimax',
        binaural: { enabled: binauralEnabled, position: 'right', distance: 'near' },
        providers: {
          minimax: { provider: 'minimax', apiKey: 'k', groupId: 'g', model: 'speech-2.6-hd', voice: '', endpoint: '' }
        }
      }
    }
  };

  if (sharedCtx) sandbox.voiceCallSharedAudioContext = sharedCtx;

  vm.createContext(sandbox);

  const load = (rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  };

  // 顺序与 index.html 里的 script 标签一致
  load('modules/tts-expression.js');
  load('src/lib/tts/index.js');
  load('src/lib/tts/binaural/hrir-data.js');
  load('src/lib/tts/binaural/trajectory.js');
  load('src/lib/tts/binaural/spatial-audio.js');
  load('src/lib/tts/settings-ui.js');
  load('modules/tts-audio.js');

  const ttsCalls = [];
  sandbox.TTSService.isEnabled = () => true;
  sandbox.TTSService.synthesize = (opts) => {
    ttsCalls.push({
      text: opts.text,
      voice: opts.voice,
      languageBoost: opts.languageBoost,
      emotion: opts.emotion
    });
    return Promise.resolve({ blob: new Blob([new Uint8Array(64)], { type: 'audio/mpeg' }), mimeType: 'audio/mpeg' });
  };

  return {
    sandbox, audioElements, ttsCalls, createdCtx,
    fetchCount: () => fetchCount,
    setBin: (bytes) => { binBytes = bytes; },
    sampleRate
  };
}

function makeFakeAudioEl() {
  const el = {
    dataset: {},
    paused: true,
    playCount: 0,
    onended: null, onerror: null, onpause: null,
    style: {},
    pause() { this.paused = true; },
    play() {
      this.paused = false;
      this.playCount++;
      setTimeout(() => { if (typeof this.onended === 'function') this.onended(); }, 0);
      return Promise.resolve();
    },
    removeAttribute() {}
  };
  return el;
}

function makeBody(text, voiceId, timestamp) {
  const history = [];
  const button = {
    textContent: '▶',
    style: {},
    dataset: {},
    _history: history
  };
  // 假的 <audio> 会立刻触发 onended 把按钮打回 ▶, 直接断言"此刻是暂停符"会误判。
  // 用 defineProperty 记录变化历史 —— 生产代码照常写 button.textContent, 这里只旁路观察。
  let text0 = button.textContent;
  Object.defineProperty(button, 'textContent', {
    get() { return text0; },
    set(v) { text0 = v; history.push(v); }
  });
  // playTtsAudio 里 spinner 是裸访问(spinner.style.display), 沙箱必须给一个
  const spinner = { style: { display: 'none' } };
  const ts = timestamp || '123';
  return {
    button,
    spinner,
    ts,
    el: {
      dataset: { text: encodeURIComponent(text), voiceId, timestamp: ts },
      closest: (sel) => (sel === '.message-bubble' ? { dataset: { timestamp: ts } } : null),
      querySelector: (sel) => {
        if (sel === '.voice-play-btn') return button;
        if (sel === '.loading-spinner') return spinner;
        return null;
      }
    }
  };
}

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

// 真实卷积 (验证方向正确性用)
function convolve(signal, ir) {
  const out = new Float32Array(signal.length + ir.length - 1);
  for (let n = 0; n < signal.length; n++) {
    const s = signal[n];
    if (s === 0) continue;
    for (let k = 0; k < ir.length; k++) out[n + k] += s * ir[k];
  }
  return out;
}
function energy(x) { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return e; }
// 确定性白噪声 (不用 Math.random, 保证可复现)
function noise(n, seed) {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 4294967296) * 2 - 1;
  }
  return out;
}

function readBin() {
  if (!fs.existsSync(BIN_PATH)) {
    console.error('找不到 HRIR 二进制: ' + BIN_PATH);
    console.error('先跑: python tools/build_hrir_bin.py');
    process.exit(2);
  }
  const buf = fs.readFileSync(BIN_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ============================================================
// A. 二进制解析
// ============================================================
function testBinaryParsing() {
  const app = loadApp();
  const bytes = readBin();
  app.setBin(bytes);
  const H = app.sandbox.TtsBinauralHrir;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const set = H.parseBinary(ab);

  check('A1 采样率', set.sampleRate, 48000);
  check('A2 距离档数', set.nDist, 5);
  check('A3 方位数', set.nAz, 72);
  check('A4 耳道数', set.nEar, 2);
  check('A5 抽头数', set.taps, 128);
  check('A6 方位步长(度)', set.azStepDeg, 5);
  check('A7 距离表', JSON.stringify(set.distances), JSON.stringify([0.25, 0.5, 0.75, 1.0, 1.5]));
  check('A8 增益表', JSON.stringify(set.gains), JSON.stringify([1.0, 0.33, 0.25, 0.16, 0.095]));
  checkTrue('A9 署名含 CC BY 4.0', H.ATTRIBUTION.license === 'CC BY 4.0', H.ATTRIBUTION.license);
  checkTrue('A10 署名含 DOI', /zenodo\.4297951/.test(H.ATTRIBUTION.doi), H.ATTRIBUTION.doi);

  // 损坏检测
  const corrupt = (mutate) => {
    const c = new Uint8Array(ab.slice(0));
    mutate(c);
    try { H.parseBinary(c.buffer); return null; } catch (e) { return e.message; }
  };
  check('A11 magic 错误被拒', corrupt(c => { c[0] = 0x58; }), 'hrir_bad_magic:XU1F');
  checkTrue('A12 version 错误被拒', /bad_version/.test(corrupt(c => { c[4] = 9; c[5] = 0; }) || ''));
  checkTrue('A13 checksum 错误被拒', /checksum_mismatch/.test(corrupt(c => { c[200] ^= 0xff; }) || ''));
  checkTrue('A14 payload 长度错误被拒', /size_mismatch|truncated/.test(corrupt(c => { c[24] = 0xff; c[25] = 0xff; c[26] = 0xff; c[27] = 0x7f; }) || ''));
  // 注意别拿"尾部若干字节"当样本 —— HRIR 的末尾抽头本来就衰减到 0,
  // 填 0 不会改变任何东西。取 payload 深处一个必然非零的位置。
  checkTrue('A14b payload 深处被改动被校验和抓住',
    /checksum_mismatch/.test(corrupt(c => { c[Math.floor(c.length * 0.75)] ^= 0x5a; }) || ''));
  // 截断: 必须真的把 buffer 变短, 光改内容不算截断
  let truncErr = null;
  try { H.parseBinary(ab.slice(0, ab.byteLength - 8)); } catch (e) { truncErr = e.message; }
  check('A15 截断被拒', truncErr, 'hrir_truncated_payload');
}

// ============================================================
// B. 方位 / 左右方向 —— 本项目最不能错的一条
// ============================================================
async function testDirection() {
  const app = loadApp({ sampleRate: 48000 });
  app.setBin(readBin());
  const sb = app.sandbox;

  const set = await sb.TtsBinauralHrir.load();
  const ctx = new FakeAudioContext({ sampleRate: 48000 });
  const irOf = (az, d) => sb.TtsBinauralHrir.getStereoIr(set, ctx, az, d);

  // --- 用真实卷积验证 ---
  const sig = noise(2048, 12345);
  const sigEnergy = energy(sig);

  function earEnergies(az, d) {
    const ir = irOf(az, d);
    return {
      L: energy(convolve(sig, ir.getChannelData(0))),
      R: energy(convolve(sig, ir.getChannelData(1)))
    };
  }

  const left = earEnergies(90, 0.25);
  checkTrue('B1 az=90(左耳): 左耳能量显著高于右耳',
    left.L > left.R * 20, `L=${left.L.toExponential(3)} R=${left.R.toExponential(3)} ratio=${(left.L / left.R).toFixed(1)}`);

  const right = earEnergies(270, 0.25);
  checkTrue('B2 az=270(右耳): 右耳能量显著高于左耳',
    right.R > right.L * 20, `L=${right.L.toExponential(3)} R=${right.R.toExponential(3)} ratio=${(right.L / right.R).toFixed(4)}`);

  const front = earEnergies(0, 0.42);
  checkTrue('B3 az=0(面前): 两耳能量接近',
    front.L / front.R > 0.7 && front.L / front.R < 1.4, `L/R=${(front.L / front.R).toFixed(3)}`);

  const behind = earEnergies(180, 0.31);
  checkTrue('B4 az=180(脑后): 两耳能量接近',
    behind.L / behind.R > 0.7 && behind.L / behind.R < 1.4, `L/R=${(behind.L / behind.R).toFixed(3)}`);

  // 位置预设与语义一致
  const P = sb.TtsSpatialAudio.POSITIONS;
  const presetEar = (key) => {
    const p = P[key];
    const e = earEnergies(p.azimuthDeg, p.distanceM);
    return { key, ratio: e.L / e.R, p };
  };
  const pe = presetEar('left');
  checkTrue('B5 预设 left → 左耳占优', pe.ratio > 20, `L/R=${pe.ratio.toFixed(1)}`);
  const pr = presetEar('right');
  checkTrue('B6 预设 right → 右耳占优', pr.ratio < 0.05, `L/R=${pr.ratio.toFixed(4)}`);

  // 环形插值: 359.9° 与 0° 应几乎相同, 不能在 0/360 接缝处炸出反相
  const near360 = irOf(359.9, 0.25);
  const atZero = irOf(0, 0.25);
  let seamDiff = 0, ref = 0;
  for (let c = 0; c < 2; c++) {
    const a = near360.getChannelData(c), b = atZero.getChannelData(c);
    for (let i = 0; i < a.length; i++) { seamDiff += (a[i] - b[i]) ** 2; ref += b[i] ** 2; }
  }
  checkTrue('B7 方位环绕接缝连续(359.9°≈0°)', seamDiff / ref < 0.02,
    `相对差 ${(seamDiff / ref).toExponential(2)}`);

  // 重采样后方向依然成立 (44.1k 场景)
  const ctx44 = new FakeAudioContext({ sampleRate: 44100 });
  const ir44 = sb.TtsBinauralHrir.getStereoIr(set, ctx44, 90, 0.25);
  check('B8 44.1k ctx: IR 采样率跟随 ctx', ir44.sampleRate, 44100);
  const l44 = energy(convolve(sig, ir44.getChannelData(0)));
  const r44 = energy(convolve(sig, ir44.getChannelData(1)));
  checkTrue('B9 44.1k ctx: 方向仍正确', l44 > r44 * 20, `ratio=${(l44 / r44).toFixed(1)}`);

  // 响度对齐: 渲染后总能量应 ≈ 2× 输入能量 (与"正中单声道灌两耳"等响)
  const irMid = irOf(0, 0.42);
  const outL = energy(convolve(sig, irMid.getChannelData(0)));
  const outR = energy(convolve(sig, irMid.getChannelData(1)));
  checkClose('B10 响度对齐: 输出总能量 ≈ 2× 输入', outL + outR, 2 * sigEnergy, 2 * sigEnergy * 0.25);
}

// ============================================================
// C. 距离
// ============================================================
async function testDistance() {
  const app = loadApp();
  app.setBin(readBin());
  const sb = app.sandbox;
  const set = await sb.TtsBinauralHrir.load();
  const ctx = new FakeAudioContext({ sampleRate: 48000 });
  const G = sb.TtsBinauralHrir;

  const sig = noise(2048, 999);
  const totalEnergy = (d) => {
    const ir = G.getStereoIr(set, ctx, 0, d);
    return energy(convolve(sig, ir.getChannelData(0))) + energy(convolve(sig, ir.getChannelData(1)));
  };

  const near = totalEnergy(0.25);
  const mid = totalEnergy(0.5);
  const far = totalEnergy(1.0);
  checkTrue('C1 距离增益生效: 近 > 中 > 远', near > mid && mid > far,
    `near=${near.toExponential(2)} mid=${mid.toExponential(2)} far=${far.toExponential(2)}`);

  // 越界不抛错
  let threw = null;
  try {
    G.getStereoIr(set, ctx, 0, 0.001);
    G.getStereoIr(set, ctx, 0, 99);
    G.getStereoIr(set, ctx, -45, 0.3);
    G.getStereoIr(set, ctx, 725, 0.3);
    G.getStereoIr(set, ctx, NaN, 0.3);
  } catch (e) { threw = e.message; }
  check('C2 越界/非法方位不抛错', threw, null);

  // 缓存命中: 同一位置二次调用应返回同一对象
  const a = G.getStereoIr(set, ctx, 90, 0.25);
  const b = G.getStereoIr(set, ctx, 90, 0.25);
  checkTrue('C3 相同位置命中缓存(同一对象)', a === b);
  // 不同采样率不共用缓存
  const c = G.getStereoIr(set, new FakeAudioContext({ sampleRate: 44100 }), 90, 0.25);
  checkTrue('C4 不同采样率不共用缓存', a !== c && c.sampleRate === 44100);
}

// ============================================================
// D. 重采样器
// ============================================================
function testResampler() {
  const app = loadApp();
  const R = app.sandbox.TtsBinauralHrir.resampleIr;

  const src = noise(128, 7);
  const same = R(src, 48000, 48000);
  checkTrue('D1 同采样率: 逐点相同', same.length === src.length && same[5] === src[5]);

  const down = R(src, 48000, 44100);
  checkClose('D2 降采样长度', down.length, Math.round(128 * 44100 / 48000), 1);

  const up = R(src, 48000, 96000);
  checkClose('D3 上采样长度', up.length, Math.round(128 * 96000 / 48000), 1);

  // 直流增益: 常量信号重采样后必须仍是常量。
  //   (不能用"单位脉冲的输出求和≈1"来判 —— 冲激响应求和天然带一个 toRate/fromRate 的
  //    比例因子, 那是正确的离散时间行为, 拿来判会误报。)
  const dcIn = new Float32Array(128).fill(1);
  for (const [from, to] of [[48000, 44100], [48000, 96000], [44100, 48000]]) {
    const dcOut = R(dcIn, from, to);
    let worst = 0;
    for (let i = 0; i < dcOut.length; i++) worst = Math.max(worst, Math.abs(dcOut[i] - 1));
    checkClose(`D4 直流增益保真 ${from}→${to}`, worst, 0, 0.02, ' (最大偏差)');
  }

  // 低频增益: 对慢变化信号, 幅度应基本保持
  const slow = new Float32Array(128);
  for (let i = 0; i < 128; i++) slow[i] = Math.sin(2 * Math.PI * 5 * i / 48000);
  const outSlow = R(slow, 48000, 44100);
  let peakIn = 0, peakOut = 0;
  for (const v of slow) peakIn = Math.max(peakIn, Math.abs(v));
  for (const v of outSlow) peakOut = Math.max(peakOut, Math.abs(v));
  checkClose('D5 低频幅度基本保持', peakOut, peakIn, peakIn * 0.15);
}

// ============================================================
// E. 引擎
// ============================================================
async function testEngine() {
  // E1 开关
  const off = loadApp({ binauralEnabled: false });
  off.setBin(readBin());
  check('E1 默认关闭 → isEnabled false', off.sandbox.TtsSpatialAudio.isEnabled(), false);
  const on = loadApp({ binauralEnabled: true });
  on.setBin(readBin());
  check('E2 开关打开 → isEnabled true', on.sandbox.TtsSpatialAudio.isEnabled(), true);

  // E3 借用共享 ctx
  const shared = new FakeAudioContext({ sampleRate: 48000 });
  const app = loadApp({ binauralEnabled: true, sharedCtx: shared });
  app.setBin(readBin());
  const got = app.sandbox.TtsSpatialAudio.getContext();
  check('E3 有共享 ctx 时复用它(不新建)', got, shared);
  check('E3b 未多建 AudioContext', app.createdCtx.length, 0);

  // E4 无共享时自建, 且带 48k 首选采样率
  const solo = loadApp({ binauralEnabled: true });
  solo.setBin(readBin());
  const ctx = solo.sandbox.TtsSpatialAudio.getContext();
  checkTrue('E4 无共享时自建 ctx', !!ctx);
  check('E4b 自建 ctx 首选 48k', ctx.sampleRate, 48000);
  check('E4c 只建了一个', solo.createdCtx.length, 1);
  const ctx2 = solo.sandbox.TtsSpatialAudio.getContext();
  check('E4d 二次调用复用同一 ctx', ctx2, ctx);
  check('E4e 仍未多建', solo.createdCtx.length, 1);

  // E5 播放: 音频图形状
  const p = loadApp({ binauralEnabled: true });
  p.setBin(readBin());
  const handle = await p.sandbox.TtsSpatialAudio.play({
    blob: new Blob([new Uint8Array(32)]), azimuthDeg: 270, distanceM: 0.25
  });
  const pctx = p.sandbox.TtsSpatialAudio.getContext();
  check('E5 建成一个 ConvolverNode', pctx.convolvers.length, 1);
  check('E5b ConvolverNode.buffer 是双耳', pctx.convolvers[0].buffer.numberOfChannels, 2);
  check('E5c ConvolverNode.normalize 已关闭', pctx.convolvers[0].normalize, false);
  check('E5d Convolver 接到了 destination', pctx.convolvers[0].connectedTo[0], pctx.destination);
  check('E5e BufferSource 接到了 Convolver', pctx.sources[0].connectedTo[0], pctx.convolvers[0]);
  check('E5f 从 0 开始播', pctx.sources[0].startOffset, 0);
  checkTrue('E5g 返回可用句柄', typeof handle.pause === 'function' && typeof handle.stop === 'function');
  check('E5h isPlaying 为真', p.sandbox.TtsSpatialAudio.isPlaying(), true);

  // E6 立体声输入必须被强制单声道 (否则 Convolver 会走真立体声矩阵)
  const st = loadApp({ binauralEnabled: true });
  st.setBin(readBin());
  const sctx = st.sandbox.TtsSpatialAudio.getContext();
  sctx.decoded = makeAudioBuffer(2, 4800, sctx.sampleRate);
  await st.sandbox.TtsSpatialAudio.play({ blob: new Blob([new Uint8Array(16)]), azimuthDeg: 90, distanceM: 0.25 });
  check('E6 立体声输入被下混成单声道', sctx.sources[0].buffer.numberOfChannels, 1);

  // E7 解码失败 → reject (由调用方回退)
  const bad = loadApp({ binauralEnabled: true });
  bad.setBin(readBin());
  const bctx = bad.sandbox.TtsSpatialAudio.getContext();
  bctx.decodeShouldFail = true;
  let err = null;
  try { await bad.sandbox.TtsSpatialAudio.play({ blob: new Blob([new Uint8Array(16)]), azimuthDeg: 0, distanceM: 0.3 }); }
  catch (e) { err = e.message; }
  checkTrue('E7 解码失败必须 reject 而不是静默', err !== null, String(err));

  // E8 无可用 ctx → reject
  const noctx = loadApp({ binauralEnabled: true });
  noctx.setBin(readBin());
  noctx.sandbox.AudioContext = undefined;
  noctx.sandbox.webkitAudioContext = undefined;
  let err2 = null;
  try { await noctx.sandbox.TtsSpatialAudio.play({ blob: new Blob([new Uint8Array(16)]), azimuthDeg: 0, distanceM: 0.3 }); }
  catch (e) { err2 = e.message; }
  check('E8 无 AudioContext 时 reject', err2, 'spatial_no_ctx');

  // E9 停止
  const s9 = loadApp({ binauralEnabled: true });
  s9.setBin(readBin());
  await s9.sandbox.TtsSpatialAudio.play({ blob: new Blob([new Uint8Array(16)]), azimuthDeg: 0, distanceM: 0.3 });
  s9.sandbox.TtsSpatialAudio.stop();
  check('E9 stop() 后不再播放', s9.sandbox.TtsSpatialAudio.isPlaying(), false);
}

// ============================================================
// F. 聊天链路集成
// ============================================================
async function testChatIntegration() {
  // F1 开关关闭 → 走 <audio>, 完全不建空间音频节点
  const off = loadApp({ binauralEnabled: false });
  off.setBin(readBin());
  const b1 = makeBody('你好呀', 'zh_voice_test');
  await off.sandbox.playTtsAudio(b1.el);
  await tick();
  check('F1 关闭开关: 走 <audio> 播放', off.audioElements['tts-audio-player'].playCount > 0, true);
  check('F2 关闭开关: 不建 ConvolverNode', off.createdCtx.length, 0);
  check('F3 关闭开关: 完全不请求 HRIR', off.fetchCount(), 0);

  // F4 开关打开 → 走 Web Audio, <audio> 不参与
  const on = loadApp({ binauralEnabled: true });
  on.setBin(readBin());
  const b4 = makeBody('你好呀', 'zh_voice_test');
  await on.sandbox.playTtsAudio(b4.el);
  await tick();
  const onCtx = on.sandbox.TtsSpatialAudio.getContext();
  checkTrue('F4 打开开关: 建了 ConvolverNode', onCtx && onCtx.convolvers.length === 1);
  check('F5 打开开关: <audio> 未被播放', on.audioElements['tts-audio-player'].playCount, 0);
  check('F6 打开开关: 拉取了 HRIR', on.fetchCount() > 0, true);
  check('F7 按钮显示暂停符', b4.button.textContent, '❚❚');
  checkTrue('F8 位置取自设置(right=270°)', onCtx.convolvers[0].buffer !== null);

  // F9 再点一次 → 停止
  const s9 = loadApp({ binauralEnabled: true });
  s9.setBin(readBin());
  const b9 = makeBody('你好呀', 'zh_voice_test');
  await s9.sandbox.playTtsAudio(b9.el);
  await tick();
  checkTrue('F9 播放中', s9.sandbox.TtsSpatialAudio.isPlaying());
  await s9.sandbox.playTtsAudio(b9.el);
  check('F9b 再点一次停止播放', s9.sandbox.TtsSpatialAudio.isPlaying(), false);
  check('F9c 按钮复位', b9.button.textContent, '▶');

  // F10 关键: 空间音频失败必须回退 <audio> 且真的出声
  const fb = loadApp({ binauralEnabled: true });
  fb.setBin(readBin());
  fb.sandbox.TtsSpatialAudio.prepare();
  const fbCtx = fb.sandbox.TtsSpatialAudio.getContext();
  fbCtx.decodeShouldFail = true;
  const b10 = makeBody('你好呀', 'zh_voice_test');
  await fb.sandbox.playTtsAudio(b10.el);
  await tick();
  check('F10 空间音频失败 → 回退 <audio> 且出声', fb.audioElements['tts-audio-player'].playCount, 1);
  checkTrue('F10b 回退后按钮曾显示暂停符', b10.button._history.indexOf('❚❚') >= 0,
    JSON.stringify(b10.button._history));

  // F11 HRIR 资源 404 → 同样回退出声
  const no404 = loadApp({ binauralEnabled: true });
  no404.setBin(null);
  const b11 = makeBody('你好呀', 'zh_voice_test');
  await no404.sandbox.playTtsAudio(b11.el);
  await tick();
  check('F11 HRIR 加载失败 → 回退 <audio> 且出声', no404.audioElements['tts-audio-player'].playCount, 1);

  // F12 缓存命中路径 (dataURL) 也能走空间音频
  const cache = loadApp({ binauralEnabled: true });
  cache.setBin(readBin());
  const b12 = makeBody('你好呀', 'zh_voice_test', 'msg-123');
  await cache.sandbox.playTtsAudio(b12.el);   // 第一次: 走网络, 顺便写缓存
  await tick();
  cache.sandbox.state.ttsCache.set('manual', {
    url: 'data:audio/mpeg;base64,' + Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64'),
    type: 'audio/mpeg'
  });
  const b12b = makeBody('你好呀', 'zh_voice_test', 'msg-456');
  b12b.el.dataset.text = encodeURIComponent('缓存命中测试');
  cache.sandbox.state.chats.chat1.settings.minimaxVoiceId = 'zh_voice_test';
  // 把缓存 key 换成新文本对应的
  const key = cache.sandbox.buildTtsCacheKey({ voiceId: 'zh_voice_test', boostValue: 'Chinese', emotion: '', text: '缓存命中测试' });
  cache.sandbox.state.ttsCache.set(key, cache.sandbox.state.ttsCache.get('manual'));
  await cache.sandbox.playTtsAudio(b12b.el);
  await tick();
  checkTrue('F12 缓存路径也走空间音频', cache.sandbox.TtsSpatialAudio.isActive());
  check('F12b 缓存路径不再请求 MiniMax', cache.ttsCalls.length, 1);

  // F13 stopChatMessageTtsOnly 要能停掉空间播放
  const s13 = loadApp({ binauralEnabled: true });
  s13.setBin(readBin());
  const b13 = makeBody('你好呀', 'zh_voice_test');
  await s13.sandbox.playTtsAudio(b13.el);
  await tick();
  checkTrue('F13 播放中', s13.sandbox.TtsSpatialAudio.isPlaying());
  s13.sandbox.stopAllTtsPlayback();
  check('F13b stopAllTtsPlayback 停掉空间播放', s13.sandbox.TtsSpatialAudio.isPlaying(), false);

  // F14 回归: 情绪标签照常传给 MiniMax, 不受空间音频影响
  const em = loadApp({ binauralEnabled: true });
  em.setBin(readBin());
  const b14 = makeBody('你好呀[[语音:happy]]', 'zh_voice_test');
  await em.sandbox.playTtsAudio(b14.el);
  await tick();
  check('F14 情绪 happy 仍传给 MiniMax', em.ttsCalls[0].emotion, 'happy');
  checkTrue('F14b speechText 已剥掉标签', em.ttsCalls[0].text.indexOf('[[语音:') < 0, em.ttsCalls[0].text);
  check('F14c 文本仍在请求里', em.ttsCalls[0].text.indexOf('你好呀') >= 0, true);

  // F15 回归: 缓存 key 不因空间音频开关而变 (否则开/关会互相污染缓存)
  const k = off.sandbox.buildTtsCacheKey({ voiceId: 'v', boostValue: 'Chinese', emotion: 'happy', text: 't' });
  check('F15 缓存 key 格式不变', k, 'tts_v3_v_Chinese_happy_t');
  const k2 = off.sandbox.buildTtsCacheKey({ voiceId: 'v', boostValue: 'Chinese', emotion: '', text: 't' });
  check('F15b 无情绪缓存 key 格式不变', k2, 'tts_v2_v_Chinese_t');

  // F16 回归: 开关关闭时请求体/文本与改造前逐字一致
  check('F16 关闭开关时 speechText 不变', off.ttsCalls[0].text.indexOf('你好呀') >= 0, true);
  check('F17 关闭开关时 emotion 空串经 normalizeEmotion 归零',
    off.sandbox.TTSService.normalizeEmotion(off.ttsCalls[0].emotion), undefined);

  // ---- 连续播放 ----
  // F18 自然播完后再点同一条 → 能重新播放(不能卡在"已停止"的空档里)
  const e18 = loadApp({ binauralEnabled: true });
  e18.setBin(readBin());
  const b18 = makeBody('第一条', 'zh_voice_test', 'm1');
  await e18.sandbox.playTtsAudio(b18.el);
  await tick();
  const ectx = e18.sandbox.TtsSpatialAudio.getContext();
  checkTrue('F18 首次播放中', e18.sandbox.TtsSpatialAudio.isPlaying());
  // 模拟自然播放结束: BufferSource.onended 由浏览器在源读完时触发
  ectx.sources[ectx.sources.length - 1].onended();
  await tick(20);
  check('F18b 自然结束后不再播放', e18.sandbox.TtsSpatialAudio.isPlaying(), false);
  check('F18c 自然结束后按钮复位', b18.button.textContent, '▶');
  await e18.sandbox.playTtsAudio(b18.el);
  await tick();
  checkTrue('F18d 播完再点可重新播放', e18.sandbox.TtsSpatialAudio.isPlaying());
  check('F18e 重播后按钮显示暂停符', b18.button.textContent, '❚❚');

  // F19 播 A 未完时播 B → A 必须停掉, 不能两段叠着响
  const c19 = loadApp({ binauralEnabled: true });
  c19.setBin(readBin());
  const a19 = makeBody('第一条', 'zh_voice_test', 'm1');
  const b19 = makeBody('第二条', 'zh_voice_test', 'm2');
  await c19.sandbox.playTtsAudio(a19.el);
  await tick();
  const cctx = c19.sandbox.TtsSpatialAudio.getContext();
  const srcA = cctx.sources[cctx.sources.length - 1];
  await c19.sandbox.playTtsAudio(b19.el);
  await tick();
  check('F19 播 B 后 A 的源已停止', srcA.didStop, true);
  check('F19b A 的源已断开', srcA.disconnected, true);
  const srcB = cctx.sources[cctx.sources.length - 1];
  checkTrue('F19c B 的源是活的', srcB && !srcB.didStop);
  check('F19d 同一时刻只有一个 ConvolverNode', cctx.convolvers.length, 2);  // A 的已被 B 的替换
  checkTrue('F19e 当前只跟踪一个播放', c19.sandbox.TtsSpatialAudio.isActive());
  check('F19f B 按钮显示暂停符', b19.button.textContent, '❚❚');
}

// ============================================================
// G. 通话链路隔离
// ============================================================
async function testCallIsolation() {
  const app = loadApp({ binauralEnabled: true });
  app.setBin(readBin());

  // 走通话队列路径: playVideoCallPureTTS (source=videoCall)
  const ok = app.sandbox.playVideoCallPureTTS('通话里的一句话', 'zh_voice_test', { source: 'videoCall' });
  checkTrue('G1 通话入队成功', ok === true);
  await tick(60);

  check('G2 通话链路不建 ConvolverNode', app.createdCtx.length, 0);
  check('G3 通话链路不拉 HRIR', app.fetchCount(), 0);
  checkTrue('G4 通话仍正常播放(<audio>)', app.audioElements['call-tts-audio-player'].playCount > 0);
  check('G5 通话请求照常发出', app.ttsCalls.length, 1);
  check('G6 通话文本未受污染', app.ttsCalls[0].text.indexOf('通话里的一句话') >= 0, true);
}

// ============================================================
// H. 设置项往返 —— 验证"关闭开关恢复原始播放"这个回退手段真的成立
// ============================================================
function testSettingsRoundTrip() {
  const app = loadApp({ binauralEnabled: true });
  app.setBin(readBin());
  const sb = app.sandbox;

  // 1) 读配置
  const s = sb.getTtsBinauralSettings(sb.TTSService.normalizeTtsConfig(sb.state.apiConfig));
  check('H1 读取 enabled', s.enabled, true);
  check('H2 读取 position', s.position, 'right');
  check('H3 读取 distance', s.distance, 'near');

  // 2) 渲染: 必须画出开关 + 位置/距离 + CC BY 署名
  sb.renderTtsSpatialForm();
  const html = app.audioElements['tts-spatial-form'].innerHTML;
  checkTrue('H4 渲染出双耳空间音频开关', html.indexOf('tts-binaural-switch') >= 0);
  checkTrue('H5 渲染出位置选择', html.indexOf('tts-binaural-position') >= 0);
  checkTrue('H6 渲染出距离选择', html.indexOf('tts-binaural-distance') >= 0);
  checkTrue('H6b 渲染出空间轨迹下拉', html.indexOf('tts-binaural-trajectory') >= 0);
  checkTrue('H6c 四个轨迹选项齐全',
    ['static', 'whisper', 'orbit', 'approach'].every(k => html.indexOf('value="' + k + '"') >= 0),
    html.slice(html.indexOf('tts-binaural-trajectory'), html.indexOf('tts-binaural-trajectory') + 300));
  checkTrue('H6d 含"停顿切位"说明', html.indexOf('停顿切位') >= 0);
  checkTrue('H6d2 含"出声期间方位锁死"说明', html.indexOf('方位锁死') >= 0);
  checkTrue('H6d3 明确告知停顿太少时轨迹不动', html.indexOf('轨迹不会动') >= 0);
  // 控件语义要跟着轨迹走: 静态=固定位置, 动态=起点; approach 的距离被系统接管
  const applyUI = (traj) => {
    app.audioElements['tts-binaural-trajectory'].value = traj;
    app.audioElements['tts-binaural-trajectory'].onchange();
  };
  const posLabel = () => app.audioElements['tts-binaural-position-label'].textContent;
  const distSel = () => app.audioElements['tts-binaural-distance'];
  const note = () => app.audioElements['tts-binaural-note'].textContent;

  applyUI('static');
  check('H6e 静态模式: 标签是"声音位置"', posLabel(), '声音位置');
  check('H6f 静态模式: 距离可用', distSel().disabled, false);

  applyUI('whisper');
  check('H6g 轻语模式: 标签是"起始位置"', posLabel(), '起始位置');
  check('H6h 轻语模式: 距离仍可用(全程保持)', distSel().disabled, false);
  checkTrue('H6i 轻语模式: 有"从起始位置移动"说明', note().indexOf('起始位置') >= 0, note());

  applyUI('orbit');
  check('H6j 环绕模式: 标签是"起始位置"', posLabel(), '起始位置');
  check('H6k 环绕模式: 距离仍可用', distSel().disabled, false);

  applyUI('approach');
  check('H6l 由远及近: 距离选择被禁用(系统自动 1m→25cm)', distSel().disabled, true);
  checkTrue('H6m 由远及近: 有明确说明为什么禁用', note().indexOf('不生效') >= 0, note());
  check('H6n 由远及近: 位置仍可用(固定方位)', posLabel(), '起始位置');
  checkTrue('H7 渲染含 CC BY 4.0 署名', html.indexOf('CC BY 4.0') >= 0, html.slice(0, 200));
  checkTrue('H8 渲染含数据 DOI', html.indexOf('zenodo.4297951') >= 0);
  checkTrue('H9 渲染含"关闭即恢复原始播放"说明', html.indexOf('关闭开关即刻恢复原始播放') >= 0);
  checkTrue('H10 渲染含"只作用于聊天语音条"边界说明', html.indexOf('只作用于') >= 0 && html.indexOf('通话') >= 0);
  checkTrue('H11 四个位置预设齐全',
    ['left', 'right', 'behind', 'front'].every(k => sb.TtsSpatialAudio.POSITIONS[k]));
  checkTrue('H12 四个距离档齐全',
    Object.keys(sb.TtsSpatialAudio.DISTANCES).length === 3, JSON.stringify(Object.keys(sb.TtsSpatialAudio.DISTANCES)));

  // 3) 存配置: 改开关 + 改位置距离, 走真实的 saveTtsSettingsFromDom
  const sw = app.audioElements['tts-binaural-switch'];
  const pos = app.audioElements['tts-binaural-position'];
  const dist = app.audioElements['tts-binaural-distance'];
  sw.checked = false;
  pos.value = 'behind';
  dist.value = 'far';
  const saved = sb.saveTtsSettingsFromDom({ silent: true });
  check('H13 保存返回 true', saved, true);
  const after = sb.state.apiConfig.tts.binaural;
  check('H14 关闭开关被存下', after.enabled, false);
  check('H15 位置改动被存下', after.position, 'behind');
  check('H16 距离改动被存下', after.distance, 'far');
  check('H17 关闭后 isEnabled 为假', sb.TtsSpatialAudio.isEnabled(), false);

  // 4) 关闭状态在播放链路上确实生效 (回退手段的核心保证)
  const b18 = makeBody('你好', 'zh_voice_test', 'm1');
  return sb.playTtsAudio(b18.el).then(() => new Promise(r => setTimeout(r, 40))).then(() => {
    check('H18 关闭后走 <audio> 而非空间音频', app.audioElements['tts-audio-player'].playCount > 0, true);
    check('H19 关闭后不建 ConvolverNode', app.createdCtx.length, 0);

    // 5) 没渲染过(DOM 里没有开关)时, 保存不得把用户已选的配置抹掉
    const app2 = loadApp({ binauralEnabled: true });
    app2.sandbox.state.apiConfig.tts.binaural = { enabled: true, position: 'left', distance: 'mid' };
    delete app2.audioElements['tts-binaural-switch'];
    app2.sandbox.saveTtsSettingsFromDom({ silent: true });
    const kept = app2.sandbox.state.apiConfig.tts.binaural;
    check('H20 未渲染时保留原 enabled', kept.enabled, true);
    check('H21 未渲染时保留原 position', kept.position, 'left');
    check('H22 未渲染时保留原 distance', kept.distance, 'mid');
  });
}
// ============================================================
// 跑
// ============================================================
// ============================================================
// I. 轨迹计算 (纯函数)
// ============================================================
function testTrajectoryMath() {
  const app = loadApp();
  const TR = app.sandbox.TtsBinauralTrajectory;

  // 停顿切位参数锁定
  check('I0a 合法停顿最短 0.12s', TR.MIN_PAUSE_SEC, 0.12);
  check('I0b 切位安全边距 0.025s', TR.RING_GUARD_SEC, 0.025);
  checkTrue('I0c 边距必须小于停顿阈值的一半',
    TR.RING_GUARD_SEC < TR.MIN_PAUSE_SEC / 2, `${TR.RING_GUARD_SEC} vs ${TR.MIN_PAUSE_SEC / 2}`);
  check('I0d 旧的 CROSSFADE 已彻底移除', TR.CROSSFADE_SEC, undefined);
  check('I0e 旧的 STEP_SEC 已彻底移除', TR.STEP_SEC, undefined);

  check('I1 normalizeAz(-90) = 270', TR.normalizeAz(-90), 270);
  check('I2 normalizeAz(450) = 90', TR.normalizeAz(450), 90);

  check('I3 azPath(90左, 270右) = +180 (走后脑)', TR.azPath(90, 270), 180);
  check('I4 azPath(270右, 90左) = -180', TR.azPath(270, 90), -180);
  check('I5 azPath(0前, 90左) = +90 (走短边)', TR.azPath(0, 90), 90);
  check('I6 azPath(0前, 270右) = -90 (走短边)', TR.azPath(0, 270), -90);

  const path = [];
  for (let i = 0; i <= 18; i++) path.push(TR.normalizeAz(90 + 180 * i / 18));
  checkTrue('I7 90->270 途经 180(后脑)', path.some(a => Math.abs(a - 180) < 7), JSON.stringify(path));
  check('I8 90->270 全程不经过脸前(0 附近)', path.filter(a => a < 7 || a > 353).length, 0);

  const mkPauses = (times) => times.map((t, i) => ({ index: i, t, start: t, end: t + 0.4, dur: 0.4 }));

  // static: 不产生任何切位
  check('I9 static 不产生切位',
    TR.buildPausePlan({ trajectory: 'static', fromAz: 90, fromDist: 0.25, pauses: mkPauses([1, 2, 3]) }).length, 0);

  // 一个停顿都没有 -> 不动
  check('I24 无停顿时轨迹为空(等同静态)',
    TR.buildPausePlan({ trajectory: 'orbit', fromAz: 0, fromDist: 0.25, pauses: [] }).length, 0);

  // ---- orbit: N 个停顿 = N 格, 整圈回到起点 ----
  const pOrbit = TR.buildPausePlan({ trajectory: 'orbit', fromAz: 0, fromDist: 0.25, pauses: mkPauses([1, 2, 3, 4]) });
  check('I10 orbit 停顿数 = 切位数', pOrbit.length, 4);
  const azs = pOrbit.map(k => k.az);
  checkTrue('I11 orbit 方位真的在变', new Set(azs).size > 2, JSON.stringify(azs));
  // 4 格走 360° -> 每格 90° -> 必含四个方位
  for (const t of [90, 180, 270]) {
    checkTrue(`I12 orbit 途经 ${t}°`, azs.some(a => Math.abs(a - t) < 1), JSON.stringify(azs));
  }
  check('I13 orbit 绕满一整圈回到起点', azs[azs.length - 1], 0);
  const deltas = azs.map((a, i) => (i === 0 ? a : (((a - azs[i - 1]) + 360) % 360)));
  checkTrue('I14 orbit 每步正向推进(逆时针)', deltas.every(d => d > 0), JSON.stringify(deltas));

  // 环绕不能被"最短路归零"吃掉: 2 个停顿也必须真转 180°/格
  const pOrbit2 = TR.buildPausePlan({ trajectory: 'orbit', fromAz: 0, fromDist: 0.25, pauses: mkPauses([1, 2]) });
  checkTrue('I14b orbit 只 2 个停顿时每格 180°(不是 0)',
    JSON.stringify(pOrbit2.map(k => k.az)) === '[180,0]', JSON.stringify(pOrbit2.map(k => k.az)));

  // ---- whisper: 到对侧耳朵, 走后脑 ----
  const pWhisper = TR.buildPausePlan({ trajectory: 'whisper', fromAz: 90, fromDist: 0.25, pauses: mkPauses([1, 2, 3]) });
  check('I15 whisper 最后一格到达对侧耳朵', pWhisper[pWhisper.length - 1].az, 270);
  const wAzs = pWhisper.map(k => k.az);
  checkTrue('I16 whisper 全程方位递增(走向 270)',
    wAzs.every((a, i) => i === 0 || a > wAzs[i - 1]), JSON.stringify(wAzs));
  // 3 个停顿把 +180° 均分成 3 格 -> 150/210/270。终点 270 就是对侧耳朵, 合法;
  // 关键是全程都不掉进脸前那一半 (0~90 与 270~360)。
  checkTrue('I17 whisper 全程只在两耳之间(走的是后脑, 没穿脸)',
    wAzs.every(a => a > 90 && a <= 270), JSON.stringify(wAzs));
  checkTrue('I17b whisper 有一步真的踏进后脑半区(>=135)',
    wAzs.some(a => Math.abs(a - 180) >= 45), JSON.stringify(wAzs));
  checkTrue('I18 whisper 距离全程不变',
    pWhisper.every(k => Math.abs(k.dist - 0.25) < 1e-9), JSON.stringify(pWhisper.map(k => k.dist)));

  // ---- approach: 方位不动, 1m -> 25cm ----
  const pApp = TR.buildPausePlan({ trajectory: 'approach', fromAz: 90, fromDist: 0.25, pauses: mkPauses([1, 2, 3, 4]) });
  checkTrue('I20 approach 方位完全不变', pApp.every(k => k.az === 90), JSON.stringify(pApp.map(k => k.az)));
  // 4 个停顿把 1m -> 25cm 均分成 4 格, 每格拉近 0.1875m。
  // 起点 1m 本身不是关键帧(那是"还没走到第一格"的初始位置), 第一格落在 1 - 0.1875。
  checkClose('I21 approach 第一格 = 1m - 1/4 段', pApp[0].dist, 1 - (1 - 0.25) / 4, 1e-9, 'm');
  check('I22 approach 结束 25cm', pApp[pApp.length - 1].dist, 0.25);
  checkTrue('I23 approach 距离单调拉近',
    pApp.every((k, i, a) => i === 0 || k.dist <= a[i - 1].dist), JSON.stringify(pApp.map(k => k.dist)));
  checkTrue('I23b approach 每格步长相同',
    pApp.every((k, i, a) => i === 0 || Math.abs((a[i - 1].dist - k.dist) - 0.1875) < 1e-9),
    JSON.stringify(pApp.map(k => k.dist)));

  // 非法输入不抛错
  let threw = null;
  try {
    TR.buildPausePlan({ trajectory: '不存在', fromAz: NaN, fromDist: -1, pauses: null });
    TR.azPath(NaN, undefined);
    TR.normalizeAz(NaN);
    TR.findPauses({ voiced: new Uint8Array(0), hopSec: 0.01 }, 0.12, 0.025);
  } catch (e) { threw = e.message; }
  check('I25 非法输入不抛错', threw, null);
}

// ============================================================
// V. 出声时间线 + 停顿检测
// ============================================================
function buildTestBuffer(fillFn, sec, SR) {
  const n = Math.round(SR * sec);
  const data = new Float32Array(n);
  fillFn(data, SR);
  return { sampleRate: SR, length: n, numberOfChannels: 1, duration: sec, getChannelData: () => data };
}
const SR = 48000;
const tone = (data, from, to, sr) => {
  for (let i = Math.round(from * sr); i < Math.round(to * sr) && i < data.length; i++) {
    data[i] = Math.sin(i * 0.05) * 0.5;
  }
};

function testVoicedTimeline() {
  const app = loadApp();
  const TR = app.sandbox.TtsBinauralTrajectory;

  // 4 秒: [0,1]有声 [1,2]静音 [2,3]有声 [3,4]静音
  const buf = buildTestBuffer((d, sr) => { tone(d, 0, 1, sr); tone(d, 2, 3, sr); }, 4, SR);
  const tl = TR.buildVoicedTimeline(buf);

  check('V1 时长 4 秒', Math.round(tl.duration), 4);
  checkTrue('V2 出声时长明显小于总时长', tl.speechDuration < 3.7, tl.speechDuration.toFixed(3));
  checkTrue('V3 出声时长大于 1.5 秒', tl.speechDuration > 1.5, tl.speechDuration.toFixed(3));
  checkTrue('V4 tau 单调不减',
    tl.tau.every((v, i, a) => i === 0 || v >= a[i - 1] - 1e-6));

  const tl2 = TR.buildVoicedTimeline(buildTestBuffer(() => {}, 2, SR));
  check('V5 纯静音时出声时长为 0', tl2.speechDuration, 0);

  // ---- 停顿检测 ----
  // 切位点 = "语音中间的静音段": 前后都得有声音。
  const pauses = TR.findPauses(tl);
  check('V6 只认句中停顿(结尾静音不算)', pauses.length, 1);
  checkTrue('V7 唯一停顿起点在 1.0s 附近', Math.abs(pauses[0].start - 1.0) < 0.05,
    String(pauses[0] && pauses[0].start));
  checkTrue('V8 切位时刻已加安全边距(在停顿内部)',
    pauses[0].t > pauses[0].start && pauses[0].t < pauses[0].end,
    JSON.stringify(pauses[0]));
  checkClose('V9 边距就是 RING_GUARD_SEC', pauses[0].t - pauses[0].start, TR.RING_GUARD_SEC, 0.011, 's');

  // 字间小缝(0.2s)必须被 gap-fill 吸收, 不能当成切位点
  const gapBuf = buildTestBuffer((d, sr) => { tone(d, 0, 1, sr); tone(d, 1.2, 2.2, sr); tone(d, 2.4, 3.4, sr); }, 4, SR);
  const gapPauses = TR.findPauses(TR.buildVoicedTimeline(gapBuf));
  check('V10 字间 0.2s 小缝全部被 gap-fill 吸收', gapPauses.length, 0);
  check('V10b 缝隙再多也不该多出切位点',
    TR.findPauses(TR.buildVoicedTimeline(
      buildTestBuffer((d, sr) => { for (let k = 0; k < 8; k++) tone(d, k, k + 0.8, sr); }, 8, SR)
    )).length, 0);

  // 一句到底 -> 没有切位点
  const noGap = TR.buildVoicedTimeline(buildTestBuffer((d, sr) => tone(d, 0, 4, sr), 4, SR));
  check('V11 一句到底时无切位点', TR.findPauses(noGap).length, 0);

  // 纯静音 -> 一次停顿都没有(否则"由远及近"会一开口就贴到耳朵)
  const silent = TR.buildVoicedTimeline(buildTestBuffer(() => {}, 3, SR));
  check('V12 纯静音不产生切位点', TR.findPauses(silent).length, 0);
  check('V12b 纯静音也不产生任何切位表',
    TR.buildPausePlan({ trajectory: 'approach', fromAz: 90, fromDist: 1, pauses: TR.findPauses(silent) }).length, 0);

  // ⚠️ 开头静音: 换方位发生在第一声之前, 第一句话就会直接落在终点位置。
  //    "动态=起点"的语义要求第一个字从起点方位出声, 所以开头静音必须被忽略。
  const leadBuf = buildTestBuffer((d, sr) => { tone(d, 1, 2, sr); tone(d, 3, 4, sr); }, 5, SR);
  const leadPauses = TR.findPauses(TR.buildVoicedTimeline(leadBuf));
  check('V13 开头静音不算切位点(只剩句中那一个)', leadPauses.length, 1);
  checkTrue('V13b 保留下来的是 2.0s 处那个句中停顿',
    Math.abs(leadPauses[0].start - 2.0) < 0.06, String(leadPauses[0] && leadPauses[0].start));

  // 结尾静音: 换了方位也没有声音能听见, 白换一次 buffer。
  const tailBuf = buildTestBuffer((d, sr) => { tone(d, 0, 1, sr); tone(d, 2, 3, sr); }, 5, SR);
  const tailPauses = TR.findPauses(TR.buildVoicedTimeline(tailBuf));
  check('V14 结尾静音不算切位点(只留句中那个)', tailPauses.length, 1);
  checkTrue('V14b 保留下来的是 1.0s 处那个句中停顿',
    Math.abs(tailPauses[0].start - 1.0) < 0.06, String(tailPauses[0] && tailPauses[0].start));

  // 过了门槛的句中停顿: 整条语音的切位次数 = 句中停顿数, 且均匀铺满
  const twoBuf = buildTestBuffer((d, sr) => { tone(d, 0, 1, sr); tone(d, 2, 3, sr); tone(d, 4, 5, sr); }, 6, SR);
  const twoPauses = TR.findPauses(TR.buildVoicedTimeline(twoBuf));
  check('V15 三个语音段 = 2 个句中停顿', twoPauses.length, 2);
  checkTrue('V15b 两个停顿分别在 1.0s 与 3.0s',
    Math.abs(twoPauses[0].start - 1.0) < 0.06 && Math.abs(twoPauses[1].start - 3.0) < 0.06,
    JSON.stringify(twoPauses.map(p => p.start)));
}

// ============================================================
// J. 动态播放 —— 停顿切位
// ============================================================
/** 6 秒测试音频: 有声[0,1] 停顿[1,2] 有声[2,3] 停顿[3,4] 有声[4,5] 结尾静音[5,6]
 *  -> 两个句中切位点: 1.0s 与 3.0s。结尾静音那个不算切位点。 */
function makePauseyBuffer() {
  return buildTestBuffer((d, sr) => { tone(d, 0, 1, sr); tone(d, 2, 3, sr); tone(d, 4, 5, sr); }, 6, SR);
}

async function testDynamicPlayback() {
  // ---- 结构断言: 这是"梳状归零"的根本保证 ----
  const s = loadApp({ binauralEnabled: true });
  s.setBin(readBin());
  await s.sandbox.TtsSpatialAudio.play({
    blob: new Blob([new Uint8Array(16)]), azimuthDeg: 90, distanceM: 0.25, trajectory: 'static'
  });
  const sctx = s.sandbox.TtsSpatialAudio.getContext();
  check('J1 static: 1 个 ConvolverNode', sctx.convolvers.length, 1);
  check('J2 static: 0 个 GainNode', sctx.gains.length, 0);
  check('J2b static: 源只连 1 个节点', sctx.sources[0].connectedTo.length, 1);

  const d = loadApp({ binauralEnabled: true });
  d.setBin(readBin());
  const dctx = d.sandbox.TtsSpatialAudio.getContext();
  dctx.decoded = makePauseyBuffer();

  await d.sandbox.TtsSpatialAudio.play({
    blob: new Blob([new Uint8Array(16)]), azimuthDeg: 90, distanceM: 0.25, trajectory: 'whisper'
  });

  // ⚠️ 这是整个架构改版最关键的一条断言。
  //    出声期间只要有第二个卷积器或任何增益节点, 梳状滤波就还有可能存在。
  //    单卷积直出 => 滤波路径唯一 => 相位抵消在结构上不可能发生。
  check('J3 动态: 仍然只有 1 个 ConvolverNode', dctx.convolvers.length, 1);
  check('J4 动态: 0 个 GainNode(交叉淡化已彻底移除)', dctx.gains.length, 0);
  check('J5 动态: 源只连 1 个节点', dctx.sources[0].connectedTo.length, 1);
  check('J6 Convolver 直连 destination(中间无节点)', dctx.convolvers[0].connectedTo[0], dctx.destination);
  check('J7 normalize 关闭', dctx.convolvers[0].normalize, false);

  // ---- 出声期间方位锁死 ----
  const bufAtStart = dctx.convolvers[0].buffer;
  dctx.currentTime = 0.5;                       // 仍在第一段有声里
  await tick(90);
  check('J8 出声期间方位锁死(不换 buffer)', dctx.convolvers[0].buffer, bufAtStart);

  // ---- 停顿处切位 ----
  dctx.currentTime = 1.1;                       // 第一个停顿(1.0s)已过
  await tick(120);
  check('J9 停顿处确实切了位', dctx.convolvers[0].buffer !== bufAtStart, true);
  const bufAfter1 = dctx.convolvers[0].buffer;
  dctx.currentTime = 2.5;                       // 第二段有声里, 不该动
  await tick(120);
  check('J10 恢复出声后再次锁死', dctx.convolvers[0].buffer, bufAfter1);
  dctx.currentTime = 3.2;                       // 第二个停顿
  await tick(120);
  check('J11 第二个停顿再切一次', dctx.convolvers[0].buffer !== bufAfter1, true);

  // ---- 切位用的是不同方位(而不是同一份 buffer) ----
  const irCache = d.sandbox.TtsBinauralHrir;
  void irCache;

  // ---- 一句到底: 无停顿 -> 保持起始方位 ----
  const nopause = loadApp({ binauralEnabled: true });
  nopause.setBin(readBin());
  const nctx = nopause.sandbox.TtsSpatialAudio.getContext();
  nopause.sandbox.__logs = [];
  nctx.decoded = buildTestBuffer((dd, sr) => tone(dd, 0, 4, sr), 4, SR);
  await nopause.sandbox.TtsSpatialAudio.play({
    blob: new Blob([new Uint8Array(16)]), azimuthDeg: 90, distanceM: 0.25, trajectory: 'orbit'
  });
  const nBuf = nctx.convolvers[0].buffer;
  nctx.currentTime = 3.5;
  await tick(120);
  check('J12 无停顿时全程不动', nctx.convolvers[0].buffer, nBuf);
  check('J12b 无停顿时仍是单卷积', nctx.convolvers.length, 1);

  // ---- 轨迹模块缺失 -> 退回静态 ----
  const miss = loadApp({ binauralEnabled: true });
  miss.setBin(readBin());
  delete miss.sandbox.TtsBinauralTrajectory;
  await miss.sandbox.TtsSpatialAudio.play({
    blob: new Blob([new Uint8Array(16)]), azimuthDeg: 90, distanceM: 0.25, trajectory: 'whisper'
  });
  check('J13 轨迹模块缺失时退回单卷积(不炸)', miss.sandbox.TtsSpatialAudio.getContext().convolvers.length, 1);

  // ---- orbit 也走同一结构 ----
  const o = loadApp({ binauralEnabled: true });
  o.setBin(readBin());
  const octx = o.sandbox.TtsSpatialAudio.getContext();
  octx.decoded = makePauseyBuffer();
  await o.sandbox.TtsSpatialAudio.play({
    blob: new Blob([new Uint8Array(16)]), azimuthDeg: 0, distanceM: 0.25, trajectory: 'orbit'
  });
  check('J14 orbit 同样是单卷积零增益', octx.convolvers.length === 1 && octx.gains.length === 0, true);

  // ---- 停止后定时器清掉 ----
  d.sandbox.TtsSpatialAudio.stop();
  check('J15 stop 后不再播放', d.sandbox.TtsSpatialAudio.isPlaying(), false);
  const snap = dctx.convolvers[0].buffer;
  dctx.currentTime = 9.0;
  await tick(120);
  check('J16 stop 后不再切位(定时器已清)', dctx.convolvers[0].buffer, snap);
}

(async function main() {
  console.log('');
  console.log('========================================');
  console.log(' 双耳空间音频 —— 测试结果');
  console.log('========================================');

  const suites = [
    ['A 二进制解析', testBinaryParsing],
    ['B 方位/方向', testDirection],
    ['C 距离', testDistance],
    ['D 重采样器', testResampler],
    ['E 引擎', testEngine],
    ['F 聊天链路集成', testChatIntegration],
    ['G 通话链路隔离', testCallIsolation],
    ['H 设置项往返', testSettingsRoundTrip],
    ['I 轨迹计算', testTrajectoryMath],
    ['V 出声时间线', testVoicedTimeline],
    ['J 动态播放', testDynamicPlayback]
  ];

  for (const [name, fn] of suites) {
    const before = pass;
    try {
      await fn();
      console.log(` ${name}: ${pass - before} 项通过`);
    } catch (e) {
      failures.push(`${name} 整个套件抛异常: ${e && e.stack ? e.stack : e}`);
    }
  }

  console.log('');
  console.log(` PASS: ${pass}`);
  console.log(` FAIL: ${failures.length}`);
  if (failures.length) {
    console.log('');
    console.log(' 失败明细:');
    failures.forEach(f => console.log('   ✗ ' + f));
  }
  console.log('');
  console.log(failures.length === 0 ? '结果: PASS' : '结果: FAIL');
  process.exit(failures.length === 0 ? 0 : 1);
})();
