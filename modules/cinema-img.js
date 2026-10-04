// ============================================================================
// cinema-img.js — Cinema Room 图片压缩 (v1.0.0, 2026-10-05)
//
// 【为什么需要】
//   iPhone 拍一张照片 3~5MB。直接存进 IndexedDB:
//     · 影片已经占了不少配额, 背景再吃掉 4MB, 换手机/清缓存就容易丢
//     · 更要紧的是【解码】: 4000×3000 的图在 Safari 里要占 ~48MB 内存
//     · 房间背景是 cover 铺满, 手机屏才 390px 宽, 原图多出来的像素全是浪费
//
// 【压缩到什么程度】
//   长边 1080 / WebP 质量 0.82 → 一张 3~5MB 的 iPhone 照片压到 80~150KB
//   视觉上跟原图几乎没差 (房间背景还要被 cover 裁一圈), 但体积差 30~50 倍。
//
// 【为什么用 WebP 不是 JPEG】
//   同样 1080 宽:
//     JPEG q0.82 ≈ 120~180KB,  WebP q0.82 ≈ 80~150KB
//   WebP 还支持透明 (万一以后哪个道具要用), JPEG 不行。
//   ⚠️ 极老的 WebView 不认 WebP —— 背景走 <img>/object URL 而不是 CSS
//      background-image, 老浏览器解不出就是空白。所以这里【不依赖】WebP:
//      转不了就退回 JPEG 再压一次, 保证任何设备都能显示。
//
// 【为什么必须先转 Blob 再谈尺寸】
//   iOS 上 file.type 对 HEIC 经常是空字符串, 名字也不一定有扩展名。
//   所以判图不能只看 type/名字, 要用 createImageBitmap / Image 真解码。
// ============================================================================

(function (global) {
  'use strict';

  // 长边上限。1080 是"再大也看不出差别"的临界点 (3x 屏才需要 1170)。
  const MAX_EDGE = 1080;
  const WEBP_QUALITY = 0.82;

  // 理想比例 9:16。偏离超过这个值就提醒用户 —— cover 铺满会裁掉一大块,
  // 人物和沙发就错位了。这是【提醒】不是【拦截】, 她坚持要传也放行。
  const IDEAL_RATIO = 9 / 16;
  const RATIO_TOLERANCE = 0.22;   // 约 ±22%, 超过才算"明显不对"

  // ⚠️ 曾经有过一个 fileLooksLikeImage(file) —— 看 type / 扩展名判是不是图片。
  //    已删 (2026-10-05): iOS 上 file.type 常是空串、file.name 常是 undefined,
  //    这个判断会把正常图片全拒掉。判真假一律走 compress() 里的真解码。

  /** 解码成 HTMLImageElement (iOS 全兼容; createImageBitmap 在旧 Safari 上不稳) */
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解不开（可能格式浏览器不支持）')); };
      img.src = url;
    });
  }

  /**
   * 压缩一张图。
   * @returns {Promise<{blob: Blob, width: number, height: number,
   *                    srcW: number, srcH: number, ratio: number,
   *                    ratioWarn: boolean, format: string, savedKB: number}>}
   */
  async function compress(blob, opts) {
    opts = opts || {};
    const maxEdge = opts.maxEdge || MAX_EDGE;
    // 房间背景要铺满, 铺一层底色更好看; 立绘必须【保留透明】, 否则透明 PNG
    // 会被填成一块底色, 人物就变成一个方块贴在沙发上。
    const keepAlpha = !!opts.keepAlpha;

    const img = await loadImage(blob);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) throw new Error('图片尺寸读不出来');

    // 等比缩小 —— 绝不拉伸变形
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!keepAlpha) {
      ctx.fillStyle = '#1a1210';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);

    // 透明图优先 WebP —— 它【支持 alpha】且比 PNG 小 5~8 倍
    // (立绘就是透明 PNG, 走这条路 400KB → 80KB)。
    // WebP 不支持时才退 PNG (保住透明), 绝不退 JPEG (JPEG 8-bit 会把透明变黑)。
    let out = null, format = 'image/webp';
    try {
      out = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
    } catch (e) { out = null; }
    if (out && out.type.indexOf('webp') !== -1) {
      format = 'image/webp';
    } else {
      out = null;
      format = 'image/png';
      out = await canvasToBlob(canvas, 'image/png');
    }
    if (!out) throw new Error('图片压缩失败（浏览器不支持导出）');

    const ratio = srcW / srcH;
    return {
      blob: out,
      width: w, height: h,
      srcW, srcH,
      ratio,
      // 横向图 (ratio >> 0.5625) 裁得最狠, 所以往横着放宽一点
      ratioWarn: Math.abs(ratio - IDEAL_RATIO) / IDEAL_RATIO > RATIO_TOLERANCE,
      format,
      savedKB: Math.max(0, Math.round((blob.size - out.size) / 1024))
    };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob(b => {
          if (b) resolve(b); else reject(new Error('toBlob 返回空'));
        }, type, quality);
      } catch (e) { reject(e); }
    });
  }

  /**
   * 只验"这个 Blob 是不是能解开的图片", 【不改数据】。
   * 给 cinema-room.js 的立绘上传做判图用 —— 立绘要求原样存储, 不能走 compress。
   * 同一套解码逻辑, 跟 compress 里第一步完全一致。
   */
  async function probe(blob) {
    if (!blob) return false;
    try {
      const img = await loadImage(blob);
      return !!(img.naturalWidth || img.width);
    } catch (e) { return false; }
  }

  global.CinemaImage = {
    compress: compress,
    probe: probe,
    // ⚠️ 刻意【不导出】fileLooksLikeImage —— iOS 上 file.type / file.name
    //    经常都是空的, 拿它们预判会把正常图片全拒掉 (2026-10-05 真机踩到)。
    //    判真假只有一个可靠办法: 真解码 (probe / compress)。
    MAX_EDGE: MAX_EDGE,
    IDEAL_RATIO: IDEAL_RATIO
  };

})(window);
