/**
 * Cinema Room · iOS 卡顿自测探针 (cinema-perf-probe.js)
 *
 * 干什么用的:
 *   之前两次判断都只靠「机制推理 + 桌面 Chromium 实测」, 真机还是卡,
 *   说明桌面量到的代价不等于 iPhone 的代价。这次不再猜 ——
 *   让手机自己跑一次对照实验, 把结果直接写出来。
 *
 * 核心是一个 A/B 对比:
 *   ① 先在「现状」下连续采样帧间隔, 记录最长卡顿 (maxGap) 与超 100ms 帧数
 *   ② 再把影院里所有 backdrop-filter 关掉, 用同样的方法再采一次
 *   两次一比, 就知道"模糊"到底吃掉了多少毫秒 —— 不需要我猜。
 *
 * 怎么用: 进 Cinema Room → 屏幕左上角会出现一个小黑条 →
 *   点「开始测试」→ 照常点一下聊天输入框(键盘弹出的那一下最卡) →
 *   5 秒后点「复制结果」→ 把文字发给我。
 *
 * 安全: 只是加了一个读性能指标的浮层 + 临时改 CSS, 不碰任何业务逻辑。
 *       刷新页面即恢复原状。
 */
(function () {
  'use strict';
  if (window.__cinemaPerfProbe) return;

  var g = window;
  var PANEL_ID = '__cinema_perf_panel';

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ---------- 采样器: 连续跑 rAF, 记录帧间隔 ----------
  function sample(ms) {
    return new Promise(function (resolve) {
      var gaps = [], last = performance.now(), t0 = last;
      var kbSeen = 0, kbTicks = 0, focusSeen = '(未聚焦任何输入框)';
      function tick(now) {
        gaps.push(now - last);
        last = now;
        kbTicks++;
        var room = document.getElementById('cinema-room');
        if (room && room.classList.contains('kb-open')) kbSeen++;
        var a = document.activeElement;
        if (a && a.tagName === 'INPUT') focusSeen = a.id || 'input';
        if (now - t0 < ms) { requestAnimationFrame(tick); return; }
        gaps.sort(function (a, b) { return a - b; });
        var sum = 0, over = 0;
        for (var i = 0; i < gaps.length; i++) { sum += gaps[i]; if (gaps[i] > 100) over++; }
        resolve({
          frames: gaps.length,
          maxGap: Math.round(gaps[gaps.length - 1] || 0),
          p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] || 0),
          median: Math.round(gaps[Math.floor(gaps.length / 2)] || 0),
          over100: over,
          busyMs: Math.round(sum),
          kbSeen: kbSeen, kbTicks: kbTicks, focusSeen: focusSeen
        });
      }
      requestAnimationFrame(tick);
    });
  }

  // ---------- 此刻房间里还有哪些元素挂着毛玻璃 ----------
  function blurCensus() {
    var room = document.getElementById('cinema-room');
    if (!room) return ['(房间不在)'];
    var out = [], all = room.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var cs = getComputedStyle(all[i]);
      var bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (bf && bf !== 'none') {
        out.push((all[i].className || all[i].tagName).toString().split(' ')[0] + ' → ' + bf);
      }
    }
    if (!out.length) out.push('(一个都没有)');
    return out;
  }

  // ---------- 把影院里所有 backdrop-filter 摘掉 ----------
  var KILL = 'none';
  function killBlur(on) {
    var v = on ? KILL : '';
    if (on) {
      var st = document.createElement('style');
      st.id = '__perf_noblur';
      st.textContent = '.cinema-room,.cinema-room *{backdrop-filter:none!important;' +
                       '-webkit-backdrop-filter:none!important;}';
      document.head.appendChild(st);
    } else {
      var s = document.getElementById('__perf_noblur');
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }
    void v;
  }

  // ---------- 面板 ----------
  var panel, out, btnRun, btnCopy;

  function ensurePanel() {
    if (panel && panel.parentNode) return panel;
    var room = document.getElementById('cinema-room');
    if (!room) return null;

    panel = el('div');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;left:6px;top:calc(env(safe-area-inset-top,0px) + 66px);' +
      'z-index:2147483647;background:rgba(0,0,0,.92);color:#cfe;' +
      'font:11px/1.45 ui-monospace,Menlo,monospace;padding:8px;border-radius:9px;' +
      'max-width:calc(100vw - 12px);box-shadow:0 6px 24px rgba(0,0,0,.6)';

    var title = el('b', null, '🎬 影院性能探针 v1');
    title.style.cssText = 'display:block;margin-bottom:5px;font-size:11px';

    btnRun = el('button', null, '▶ 开始测试（5 秒）');
    btnRun.style.cssText = 'display:block;width:100%;margin:3px 0;padding:7px;font:inherit;' +
      'background:#1c6b3a;color:#fff;border:0;border-radius:6px';
    btnRun.onclick = run;

    btnCopy = el('button', null, '📋 复制结果');
    btnCopy.style.cssText = 'display:block;width:100%;padding:7px;font:inherit;' +
      'background:#2a4a7c;color:#fff;border:0;border-radius:6px';
    btnCopy.onclick = copy;

    out = el('div');
    out.style.cssText = 'margin-top:5px;white-space:pre-wrap;max-height:38vh;overflow:auto';

    panel.appendChild(title);
    panel.appendChild(btnRun);
    panel.appendChild(btnCopy);
    panel.appendChild(out);
    room.appendChild(panel);
    say('点「开始测试」，然后去点聊天输入框，弹键盘那一下最卡。\n5 秒后回来点「复制结果」。');
    return panel;
  }

  function say(s) { if (out) out.textContent = s; }

  function info() {
    var v = g.__cinemaVVDiag || { events: 0, writes: 0 };
    return '代码版本: ' + (g.__CINEMA_VER || '旧代码(!)') +
      '\nvv 事件 / 写入: ' + v.events + ' / ' + v.writes;
  }

  function fmt(tag, r) {
    return tag + ': 最长卡顿=' + r.maxGap + 'ms  p95=' + r.p95 + 'ms' +
      '  中位=' + r.median + 'ms  >100ms帧数=' + r.over100 + '  帧数=' + r.frames +
      '\n        kb-open 命中 ' + r.kbSeen + '/' + r.kbTicks + ' 帧, 焦点元素=' + r.focusSeen;
  }

  var busy = false;
  async function run() {
    if (busy) return;
    busy = true;
    btnRun.disabled = true;
    try {
      say(info() + '\n\n① 采样中（现状，5 秒）…\n现在去点聊天输入框！');
      var a = await sample(5000);
      var censusA = blurCensus();

      say(info() + '\n\n① 现状: ' + fmt('', a) +
        '\n② 关掉所有模糊，采样中（5 秒）…\n再点一次聊天输入框');
      killBlur(true);
      await new Promise(function (r) { setTimeout(r, 400); });
      var b = await sample(5000);
      killBlur(false);

      var d = a.maxGap - b.maxGap;
      var verdict = (a.maxGap > 100 && b.maxGap < a.maxGap * 0.6)
        ? '→ 模糊就是主因（关掉后卡顿降到 ' + Math.round((1 - b.maxGap / a.maxGap) * 100) + '%）'
        : (a.maxGap < 60 ? '→ 本机本来就不卡, 问题在 iOS 特有环节'
                          : '→ 模糊不是主因, 差距不够大');

      say(info() + '\n\n' + fmt('① 现状', a) + '\n' + fmt('② 无模糊', b) +
        '\n\n最长卡顿差 ' + d + 'ms\n' + verdict +
        '\n\n① 采样时房间里还挂着的毛玻璃: ' + censusA.join(' / ') +
        '\n（kb-open 命中 0 帧 = 键盘态那个 class 压根没挂上）' +
        '\n\n（把这个全部复制给我）');
    } catch (e) {
      say('出错了: ' + e.message);
    } finally {
      busy = false;
      btnRun.disabled = false;
    }
  }

  function copy() {
    var txt = say.txt || (out ? out.textContent : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        function () { say.txt = '已复制 ✓ 发给 Mavis 就行'; },
        function () { fallbackCopy(txt); }
      );
    } else { fallbackCopy(txt); }
  }

  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); say.txt = '已复制 ✓ 发给 Mavis 就行'; }
    catch (e) { say.txt = '复制失败，长按上面文字手动选吧'; }
    document.body.removeChild(ta);
  }

  // 房间一开就挂面板
  var timer = setInterval(function () {
    if (document.getElementById('cinema-room') && document.getElementById('cinema-room').classList.contains('open')) {
      if (ensurePanel()) clearInterval(timer);
    }
  }, 500);
  setTimeout(function () { clearInterval(timer); }, 120000);

  g.__cinemaPerf = { sample: sample, killBlur: killBlur };
})();