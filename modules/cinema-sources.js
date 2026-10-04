// ============================================================================
// cinema-sources.js — Cinema Room 在线片源 (v1.0.0)
//
// 【范围】(用户 2026-10-04 明确)
//   可播:   本地视频 (由 cinema-storage.js 处理)
//           手动直链 / HLS (.m3u8 走 hls.js)
//           B 站可播放直链 (复用 330 现有方案: api.52vmy.cn 返回媒体直链)
//   只展示: 苹果CMS 采集站 —— 它们返回的是【播放页 URL】不是媒体流,
//           塞进 <video> 播不了。所以只做搜索/简介/线路展示 + 站外打开,
//           【不】假装能播。绝不为了"统一"而写一个必然失败的解析层。
//
// 【为什么不重写 B 站方案】
//   330 小手机 (modules/cphone.js:4897) 已经在用这套且跑得通:
//     https://api.52vmy.cn/api/query/bilibili/video?msg=<kw>&n=<i>
//     → 返回 { title, url(媒体直链), user, desc, arcurl }
//     → url 直接进 <video> ⇒ 能拿播放进度、能被 Gemini 抽帧
//   这是"直链"路线, 比 iframe 方案好得多 (iframe 拿不到进度、抽不了帧)。
//
// 【稳定性】
//   依赖第三方免费 API + 公共 CORS 代理, 可能限流或挂。
//   所以: 有超时/重试/限流冷却, 失败给可读提示, 绝不静默卡住。
// ============================================================================

(function (global) {
  'use strict';

  // ---- B 站 (复用 cphone.js 的可用方案) ----
  const BILI_API = 'https://api.52vmy.cn/api/query/bilibili/video';
  const CORS_PROXY = 'https://corsproxy.io/?';
  const BILI_PAGES = 15;          // 拉 15 条(每页 1 条)
  const BILI_MAX_RETRY = 3;
  const BILI_PAGE_DELAY_MS = 800;
  const REQUEST_TIMEOUT_MS = 12000;

  // ---- 苹果CMS 采集站 (与 init-features.js:5079-5105 一致, 只读配置) ----
  const CMS_SOURCES = [
    { name: '最大资源', url: 'https://api.apibdzy.com/api/php/provide/vod/', params: { ac: 'detail' } },
    { name: 'OK资源', url: 'https://cj.okzy.tv/inc/apijson_vod.php', params: {} },
    { name: '量子资源', url: 'https://cj.lziapi.com/api/php/provide/vod/', params: { ac: 'detail' } },
    { name: '非凡资源', url: 'https://cj.ffzyapi.com/api/php/provide/vod/', params: { ac: 'detail' } },
    { name: '红牛资源', url: 'https://www.hongniuzy2.com/api/php/provide/vod/', params: { ac: 'detail' } }
  ];

  function log(msg, extra) {
    console.log('[Cinema-Sources] ' + msg, extra === undefined ? '' : extra);
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** fetch + 超时 */
  function fetchWithTimeout(url, ms) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('请求超时 (' + ms / 1000 + 's)'));
      }, ms);
      fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } })
        .then(function (res) {
          if (done) return;
          if (!res.ok) { done = true; clearTimeout(timer); reject(new Error('HTTP ' + res.status)); return; }
          return res.text();
        })
        .then(function (text) {
          if (done) return;
          done = true; clearTimeout(timer); resolve(text);
        })
        .catch(function (e) {
          if (done) return;
          done = true; clearTimeout(timer); reject(e);
        });
    });
  }

  // ===================================================================
  // B 站 —— 返回媒体直链, 可直接播
  // ===================================================================
  async function searchBilibili(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const out = [];
    const seen = new Set();

    for (let i = 1; i <= BILI_PAGES; i++) {
      const target = BILI_API + '?msg=' + encodeURIComponent(kw) + '&n=' + i;
      const url = CORS_PROXY + encodeURIComponent(target);

      let got = false;
      for (let retry = 0; retry < BILI_MAX_RETRY && !got; retry++) {
        try {
          const text = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
          // 该 API 限流时返回的是纯文本提示, 不是 JSON
          if (/访问过快|频繁|Too Many Requests/.test(text)) {
            log('B站触发限流, 冷却后重试 (' + (retry + 1) + ')');
            await delay(1500 + retry * 1000);
            continue;
          }
          let json;
          try { json = JSON.parse(text); }
          catch (e) { log('B站第 ' + i + ' 页返回非 JSON'); break; }

          const items = Array.isArray(json.data) ? json.data
                      : (json.data ? [json.data] : (json.title ? [json] : []));
          for (const v of items) {
            const mediaUrl = v.url || v.arcurl;
            if (!mediaUrl || seen.has(mediaUrl)) continue;
            seen.add(mediaUrl);
            out.push({
              title: v.title || ('B站视频 ' + (out.length + 1)),
              url: mediaUrl,                 // 媒体直链, 可直接进 <video>
              user: v.user || '',
              desc: v.desc || '',
              arcurl: v.arcurl || ''
            });
          }
          got = true;
        } catch (e) {
          log('B站第 ' + i + ' 页失败: ' + e.message);
          await delay(600);
        }
      }
      await delay(BILI_PAGE_DELAY_MS);
    }
    log('B站搜索 "' + kw + '" → ' + out.length + ' 条');
    return out;
  }

  // ===================================================================
  // 苹果CMS —— 只做搜索/展示, 返回播放页地址但标记不可直接播
  // ===================================================================
  function parseCmsPlayUrl(playUrlStr) {
    // 苹果CMS 标准格式: 播放组$名称$URL#名称$URL$$$播放组2$...
    if (!playUrlStr) return [];
    const groups = [];
    String(playUrlStr).split('$$$').forEach(function (group) {
      const eps = group.split('#').filter(function (e) { return e.trim(); });
      if (!eps.length) return;
      const episodes = [];
      eps.forEach(function (ep) {
        const parts = ep.split('$');
        const name = parts[0] || '播放';
        const url = parts[1] || parts[0];
        if (url) episodes.push({ name: name, url: url });
      });
      if (episodes.length) groups.push({ episodes: episodes });
    });
    return groups;
  }

  async function searchCms(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const out = [];
    let okCount = 0;

    await Promise.all(CMS_SOURCES.map(async function (src) {
      try {
        const params = new URLSearchParams(Object.assign({}, src.params, { wd: kw }));
        const text = await fetchWithTimeout(src.url + '?' + params.toString(), REQUEST_TIMEOUT_MS);
        const json = JSON.parse(text);
        const list = Array.isArray(json.list) ? json.list
                   : (Array.isArray(json.data) ? json.data : []);
        okCount++;
        list.forEach(function (m) {
          out.push({
            name: m.vod_name || m.name || '未知影片',
            desc: m.vod_content || m.vod_blurb || m.content || '',
            year: m.vod_year || '',
            source: src.name,
            groups: parseCmsPlayUrl(m.vod_play_url || m.play_url || m.vod_url || ''),
            // ⚠️ 这些是播放页地址, 不是媒体流 —— 只供站外打开/复制
            playableInline: false
          });
        });
      } catch (e) {
        log('采集站 ' + src.name + ' 失败: ' + e.message);
      }
    }));

    log('苹果CMS搜索 "' + kw + '" → ' + out.length + ' 条 (' + okCount + '/' + CMS_SOURCES.length + ' 站可用)');
    return out;
  }

  // ===================================================================
  // 直链判定
  // ===================================================================
  /** 判断一个 URL 是不是我们可能能直接播的 */
  function probeKind(url) {
    const u = String(url || '').trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) return null;
    if (/\.(m3u8)(\?|$)/i.test(u)) return 'hls';
    if (/\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(u)) return 'file';
    // B 站直链常见形态 (api.52vmy 给出的一般就是 mp4)
    return 'unknown';
  }

  global.CinemaSources = {
    searchBilibili: searchBilibili,
    searchCms: searchCms,
    probeKind: probeKind,
    CMS_SOURCE_NAMES: CMS_SOURCES.map(function (s) { return s.name; })
  };

  log('cinema-sources.js 已加载 (B站直链可播 / 苹果CMS 只展示)');
})(window);
