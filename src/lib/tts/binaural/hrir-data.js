// ============================================================
// binaural/hrir-data.js — KU100 近场 HRIR 二进制的解析与取用
// ------------------------------------------------------------
// 定位: 纯数据层。不碰 AudioContext 生命周期, 不碰播放, 不写任何全局状态。
//       只负责"给我一个方位角 + 距离, 给我一个可直接喂 ConvolverNode 的双耳 AudioBuffer"。
//
// 数据来源与许可 (CC BY 4.0 —— 必须署名, 见 ATTRIBUTION):
//   J. M. Arend, A. Neidhardt, C. Pörschmann.
//   "Spherical Near-Field (NF) HRIR Compilation of the Neumann KU100",
//   Zenodo, 2020. doi:10.5281/zenodo.4297951  —— CC BY 4.0
//   本项目只做格式转换 (SOFA -> int16 定长二进制, 方位 1°->5° 抽样) 并按数据集官方
//   增益表还原距离衰减, **测量数据本身未做任何修改**。
//
// 坐标系约定 (已用数据实证, 不是照抄注释, 见 tools/verify_hrir.py):
//   方位角 = 逆时针, 0=正前, 90=左, 180=正后, 270=右
//   耳道   = 通道 0 = 左耳, 通道 1 = 右耳
//   判据   az=90 处左耳通道能量是右耳的 ~161 倍; az=270 处反过来 (~177 倍)
// ============================================================

(function () {
  'use strict';

  var MAGIC = 'KU1F';
  var SUPPORTED_VERSION = 1;
  var PAYLOAD_FORMAT_INT16 = 1;

  // 资源版本号: 换二进制内容时同步改, 走 ?v= 破浏览器 HTTP 缓存
  var DATA_URL = 'assets/audio/hrir-ku100-nf.bin?v=1';

  var ATTRIBUTION = {
    dataset: 'Neumann KU100 近场 HRIR (NFHRIR_CIRC360_SOFA)',
    authors: 'J. M. Arend, A. Neidhardt, C. Pörschmann',
    source: 'Spherical Near-Field (NF) HRIR Compilation of the Neumann KU100, Zenodo, 2020',
    doi: '10.5281/zenodo.4297951',
    license: 'CC BY 4.0',
    url: 'https://doi.org/10.5281/zenodo.4297951',
    note: '仅格式转换与距离增益还原, 测量数据未改动。'
  };

  // ------------------------------------------------------------
  // FNV-1a 32 —— 与 tools/build_hrir_bin.py 完全同算法, 用于校验传输完整性
  // ------------------------------------------------------------
  function fnv1a32(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      // h *= 16777619, 用移位避免浮点误差
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // ------------------------------------------------------------
  // 解析二进制头 + payload
  // ------------------------------------------------------------
  function parseBinary(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 48) {
      throw new Error('hrir_truncated_header');
    }
    var view = new DataView(arrayBuffer);

    var magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
    );
    if (magic !== MAGIC) throw new Error('hrir_bad_magic:' + magic);

    var version = view.getUint16(4, true);
    if (version !== SUPPORTED_VERSION) throw new Error('hrir_bad_version:' + version);

    var headerSize = view.getUint16(6, true);
    var sampleRate = view.getUint32(8, true);
    var nDist = view.getUint16(12, true);
    var nAz = view.getUint16(14, true);
    var nEar = view.getUint16(16, true);
    var taps = view.getUint16(18, true);
    var azStepMilliDeg = view.getUint16(20, true);
    var payloadFormat = view.getUint16(22, true);
    var payloadBytes = view.getUint32(24, true);
    var checksum = view.getUint32(28, true);

    if (payloadFormat !== PAYLOAD_FORMAT_INT16) throw new Error('hrir_bad_format:' + payloadFormat);
    if (nEar !== 2) throw new Error('hrir_not_binaural:' + nEar);
    if (!sampleRate || !nDist || !nAz || !taps) throw new Error('hrir_bad_dims');

    var expectBytes = nDist * nAz * nEar * taps * 2;
    if (payloadBytes !== expectBytes) {
      throw new Error('hrir_size_mismatch:' + payloadBytes + '!=' + expectBytes);
    }

    var distsOffset = 48;
    var gainsOffset = distsOffset + nDist * 8;
    if (headerSize < gainsOffset + nDist * 8) throw new Error('hrir_bad_header');
    if (headerSize + payloadBytes > arrayBuffer.byteLength) throw new Error('hrir_truncated_payload');

    var distances = [];
    var gains = [];
    for (var i = 0; i < nDist; i++) {
      distances.push(view.getFloat64(distsOffset + i * 8, true));
      gains.push(view.getFloat64(gainsOffset + i * 8, true));
    }

    var payloadBytesView = new Uint8Array(arrayBuffer, headerSize, payloadBytes);
    if (fnv1a32(payloadBytesView) !== checksum) throw new Error('hrir_checksum_mismatch');

    // Int16Array 要求起始偏移 2 字节对齐; slice 出来的 buffer 不保证, 不对齐就复制一份
    var int16;
    if ((headerSize % 2) === 0) {
      int16 = new Int16Array(arrayBuffer, headerSize, payloadBytes / 2);
    } else {
      var copy = new Uint8Array(payloadBytesView);
      int16 = new Int16Array(copy.buffer);
    }

    return {
      sampleRate: sampleRate,
      nDist: nDist,
      nAz: nAz,
      nEar: nEar,
      taps: taps,
      azStepDeg: azStepMilliDeg / 1000,
      distances: distances,
      gains: gains,
      int16: int16
    };
  }

  // ------------------------------------------------------------
  // 采样率转换 (窗函数 sinc)
  // ------------------------------------------------------------
  // 只在 ctx.sampleRate !== HRIR 原生采样率时走, 且结果按目标采样率缓存,
  // 所以每个 IR 最多算一次, 128 抽头 x 32 抽头核 = 4096 次乘加, 可忽略。
  function sinc(x) {
    if (Math.abs(x) < 1e-9) return 1;
    var pix = Math.PI * x;
    return Math.sin(pix) / pix;
  }

  function resampleIr(src, fromRate, toRate) {
    if (fromRate === toRate || !fromRate || !toRate) return Float32Array.from(src);

    var ratio = toRate / fromRate;          // >1 = 上采样
    var cutoff = ratio > 1 ? 1 / ratio : 1; // 上采样时压窄, 防镜像
    var halfTaps = Math.ceil(16 / cutoff);  // 核半宽(输入样点)
    var outLen = Math.max(1, Math.round(src.length * ratio));
    var out = new Float32Array(outLen);
    var norm = 1 / cutoff;                  // 直流增益补偿

    for (var i = 0; i < outLen; i++) {
      var center = i / ratio;
      var i0 = Math.floor(center);
      var lo = Math.max(0, i0 - halfTaps + 1);
      var hi = Math.min(src.length - 1, i0 + halfTaps);
      var sum = 0;
      var wsum = 0;
      for (var k = lo; k <= hi; k++) {
        var x = center - k;
        var w = 0.5 + 0.5 * Math.cos(Math.PI * x / halfTaps); // Hann, ±halfTaps 处归零
        var c = norm * sinc(cutoff * x) * w;
        sum += src[k] * c;
        wsum += c;
      }
      out[i] = wsum !== 0 ? sum / wsum : 0;
    }
    return out;
  }

  // ------------------------------------------------------------
  // 取 HRIR 行
  // ------------------------------------------------------------
  function readIrRow(set, k, a, e) {
    var base = (((k * set.nAz) + a) * set.nEar + e) * set.taps;
    var out = new Float32Array(set.taps);
    for (var n = 0; n < set.taps; n++) {
      out[n] = set.int16[base + n] / 32768;
    }
    return out;
  }

  function distanceBracket(set, d) {
    var ds = set.distances;
    var last = ds.length - 1;
    if (!(d > ds[0])) return [0, 0, 0];
    if (d >= ds[last]) return [last, last, 0];
    for (var i = 0; i < last; i++) {
      if (d >= ds[i] && d <= ds[i + 1]) {
        var span = ds[i + 1] - ds[i];
        return [i, i + 1, span > 0 ? (d - ds[i]) / span : 0];
      }
    }
    return [0, 0, 0];
  }

  // ------------------------------------------------------------
  // 双耳 IR AudioBuffer 缓存 (键含 ctx.sampleRate, 换 ctx 不会串味)
  // ------------------------------------------------------------
  var irCache = Object.create(null);

  function cacheKey(ctxRate, azDeg, distM) {
    // 量化到 0.5° / 1cm: 量化误差远低于听阈, 但同一位置能稳定命中缓存
    var az = Math.round(azDeg * 2) / 2;
    var d = Math.round(distM * 100) / 100;
    return ctxRate + '|' + az + '|' + d;
  }

  /**
   * 取指定方位/距离的双耳 HRIR, 缓存为 ConvolverNode 可直接用的 AudioBuffer。
   *
   * 响度对齐: 卷积后每耳功率 ≈ 输入功率 × Σh²。要让"渲染后的总功率"等于
   * "正中单声道同时灌两耳"的 2×输入功率(听起来一样响), 需 gain = sqrt(2 / E)。
   * E 越小(离得越远/越偏)增益越大, 故 clamp 防爆。
   *
   * @param {object} set    parseBinary 的结果
   * @param {AudioContext} ctx
   * @param {number} azDeg  方位角, 逆时针 0=前 90=左 180=后 270=右
   * @param {number} distM  距离(米), 超出数据范围自动 clamp 到最近/最远档
   * @returns {AudioBuffer} 2 声道, 采样率 = ctx.sampleRate
   */
  function getStereoIr(set, ctx, azDeg, distM) {
    if (!set || !ctx) throw new Error('hrir_no_set');
    var ctxRate = ctx.sampleRate;
    var key = cacheKey(ctxRate, azDeg, distM);
    var hit = irCache[key];
    if (hit) return hit;

    var az = ((Number(azDeg) || 0) % 360 + 360) % 360;
    var dist = Number(distM);
    if (!isFinite(dist) || dist <= 0) dist = set.distances[0];

    // 方位: 环形插值 (0.5° 是最后一步的最后一度, 必须绕回 0)
    var pos = az / set.azStepDeg;
    var i0 = Math.floor(pos);
    var fa = pos - i0;
    var a0 = ((i0 % set.nAz) + set.nAz) % set.nAz;
    var a1 = (a0 + 1) % set.nAz;

    // 距离: 相邻档线性插值
    var bk = distanceBracket(set, dist);
    var k0 = bk[0], k1 = bk[1], fd = bk[2];

    var left = new Float32Array(set.taps);
    var right = new Float32Array(set.taps);

    for (var e = 0; e < 2; e++) {
      var dst = e === 0 ? left : right;
      // 四角双线性: 方位 x 距离
      var r00 = readIrRow(set, k0, a0, e);
      var r01 = readIrRow(set, k0, a1, e);
      var r10 = readIrRow(set, k1, a0, e);
      var r11 = readIrRow(set, k1, a1, e);
      for (var n = 0; n < set.taps; n++) {
        var near = (1 - fa) * r00[n] + fa * r01[n];
        var far = (1 - fa) * r10[n] + fa * r11[n];
        dst[n] = (1 - fd) * near + fd * far;
      }
    }

    // 采样率对齐 (HRIR 原生 48k, ctx 未必是)
    if (set.sampleRate !== ctxRate) {
      left = resampleIr(left, set.sampleRate, ctxRate);
      right = resampleIr(right, set.sampleRate, ctxRate);
    }

    // 响度补偿 (见上方注释)
    var energy = 0;
    for (var i = 0; i < left.length; i++) energy += left[i] * left[i] + right[i] * right[i];
    var gain = energy > 1e-12 ? Math.sqrt(2 / energy) : 1;
    if (!isFinite(gain) || gain <= 0) gain = 1;
    if (gain < 0.05) gain = 0.05;
    if (gain > 8) gain = 8;

    var outLen = left.length;
    var buffer = ctx.createBuffer(2, outLen, ctxRate);
    var lch = buffer.getChannelData(0);
    var rch = buffer.getChannelData(1);
    for (var j = 0; j < outLen; j++) {
      lch[j] = left[j] * gain;
      rch[j] = right[j] * gain;
    }

    irCache[key] = buffer;
    return buffer;
  }

  // ------------------------------------------------------------
  // 加载
  // ------------------------------------------------------------
  var cachedSet = null;
  var loadPromise = null;

  function load() {
    if (cachedSet) return Promise.resolve(cachedSet);
    if (loadPromise) return loadPromise;

    loadPromise = fetch(DATA_URL, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('hrir_http_' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        cachedSet = parseBinary(buf);
        return cachedSet;
      })
      .catch(function (err) {
        loadPromise = null;   // 允许下次重试
        throw err;
      });

    return loadPromise;
  }

  // 预热: 只下载不建 ctx, 可以在任意时机调
  function preload() {
    return load().catch(function () { return null; });
  }

  window.TtsBinauralHrir = {
    DATA_URL: DATA_URL,
    ATTRIBUTION: ATTRIBUTION,
    parseBinary: parseBinary,
    resampleIr: resampleIr,
    getStereoIr: getStereoIr,
    cacheKey: cacheKey,
    load: load,
    preload: preload,
    // 供测试用
    _resetCache: function () {
      irCache = Object.create(null);
      cachedSet = null;
      loadPromise = null;
    }
  };
})();
