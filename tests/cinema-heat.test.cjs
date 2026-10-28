// ============================================================
// tests/cinema-heat.test.cjs
// 影院「发烫 / 一句剧情总结都没写 / 十五分钟闪退」这一轮的回归测试
//
// 跑法: node tests/cinema-heat.test.cjs
//
// 【守什么】用户 2026-10-29 实测三连报：
//   ① 本地视频看的时候越看手机越烫
//   ② 看了十分钟动漫一句剧情总结都没写
//   ③ 最后十五分钟左右浏览器崩溃闪退
//   「以前放这种动漫不会闪退的」
//
// 【根因】(对照探针 _reports/pet-test/probe-cinema-before-after.cjs 实测, 非猜测)
//   2026-10-23 d0f41e1 引入的「此刻画面」实况通道：
//     · Live 的 turn 是【串行队列】, 实况每 30 秒占一个 turn
//     · 每个 turn 都要重读会话里累积的全部帧 (官方: 视频输入 258 token/帧)
//     → 实况把摘要挤到后面 → 摘要 turn 排队 141~173 秒 → 撞 90 秒超时
//     → 【一句剧情总结都没写】
//     → 累积帧涨到 899 帧 = 单 turn 输入 232K token, 远超 128,000 的窗口
//     → 重连还带 resume handle 继承爆掉的上下文 → 重连风暴 → 狂热 + 闪退
//
//   ⚠️ 帧率【不是】差异变量: before/after 两边帧数 902、上行 79.3MB 完全一样。
//      用户原话「从一开始就是一秒一帧没变过」是对的 → 降帧方案作废, 帧率保持 1 FPS。
//
// 【这一轮的修法】(用户 2026-10-29 定方案)
//   ① 取消「此刻画面」实况通道        → Live 的 turn 队列只留给摘要
//   ② 长剧摘要 5 分钟 → 2 分钟一段    → 摘要更细, 主 API 答得更准
//   ③ 内容下限 80 字 → 50 字          → 2 分钟一段写不出 80 字
//   ④ 每次摘要截一张图给主 API, 阅后即焚 (不落库/不进备份/不进导出/不进草稿)
//   ⑤ 【每次摘要尝试之后】换干净会话 (成功失败都换)
//      → 单个 turn 的输入永远只有这一段的量 (2 分钟 @ 1 FPS = 120 帧 = 31K token)
//   ⑥ 帧率画质一律不动: 1 FPS / 长边 768 / JPEG q0.6
//
// 【实测对照】(同一份代码, 只切实况通道开关)
//                        帧数   上行    turn   摘要写进   单turn最多帧  输入token累计
//   BEFORE 线上版        902  79.3MB   28       0 段        899 帧      3351K
//   AFTER  现在版        902  79.3MB    7       7 段        119 帧       165K
// ============================================================

const fs = require('fs');
const path = require('path');
const { runScenario } = require('./_harness/cinema-live-harness.cjs');

const ROOT = path.resolve(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, detail) {
  passed++;
  console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''));
}
function fail(name, detail) {
  failed++;
  console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''));
}
function check(name, cond, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

const LIVE = read('modules/cinema-live.js');
const CHAT = read('modules/cinema-chat.js');
const CLIENT = read('modules/live-client.js');

function numOf(src, name) {
  // ⚠️ 右值可能带运算 (比如 `2 * 60 * 1000`) —— 只抓数字会把 "2 * 60 * 1000" 读成 2。
  const m = new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) return null;
  try {
    // eslint-disable-next-line no-new-func
    return Function('return (' + m[1] + ')')();
  } catch (e) {
    return null;
  }
}

function countOf(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

(async function () {
  // -------------------------------------------------------------------------
  section('1. 参数锁死（帧率画质不许再动，摘要节奏锁 2 分钟）');
  // -------------------------------------------------------------------------
  const frameInterval = numOf(LIVE, 'FRAME_INTERVAL_MS');
  const frameMaxDim = numOf(LIVE, 'FRAME_MAX_DIM');
  const jpegQuality = numOf(LIVE, 'JPEG_QUALITY');
  const sumInterval = numOf(LIVE, 'WATCH_SUMMARY_INTERVAL_MS');
  const minChars = numOf(LIVE, 'MIN_SUMMARY_CHARS');
  const sumTimeout = numOf(LIVE, 'SUMMARY_REQUEST_TIMEOUT_MS');
  const retryDelay = numOf(LIVE, 'SUMMARY_RETRY_DELAY_MS');

  // 🔴 帧率必须【正好】1 FPS —— 用户反证过「从一开始就是一秒一帧」, 降帧碰不到差异变量
  check('帧率就是 1 FPS (1000ms) —— 降帧方案已作废, 不许再降',
    frameInterval === 1000, frameInterval + 'ms');
  check('抽帧长边就是 768 (不许降)', frameMaxDim === 768, frameMaxDim + 'px');
  check('JPEG 质量就是 0.6 (不许降)', jpegQuality === 0.6, String(jpegQuality));
  check('长剧摘要间隔 = 2 分钟', sumInterval === 120000, sumInterval + 'ms');
  check('剧情内容下限 = 50 字 (2 分钟一段写不出 80 字)', minChars === 50, String(minChars));
  check('摘要超时不少于 90 秒', sumTimeout !== null && sumTimeout >= 90000, sumTimeout + 'ms');
  check('摘要失败 60 秒后重试', retryDelay === 60000, retryDelay + 'ms');

  // -------------------------------------------------------------------------
  section('2. 「此刻画面」实况通道必须【彻底没有】');
  // -------------------------------------------------------------------------
  check('没有 LIVE_NOW_INTERVAL_MS', !/LIVE_NOW_INTERVAL_MS/.test(LIVE));
  check('没有 startLiveNowLoop / stopLiveNowLoop',
    !/startLiveNowLoop|stopLiveNowLoop/.test(LIVE));
  check('没有「此刻屏幕」那种 Live turn 指令',
    !/此刻屏幕/.test(LIVE),
    LIVE.indexOf('此刻屏幕') >= 0 ? '还剩 ' + countOf(LIVE, '此刻屏幕') + ' 处' : '');
  check('没有每会话帧预算那套 (80 帧就换会话)',
    !/SESSION_FRAME_BUDGET/.test(LIVE));

  // -------------------------------------------------------------------------
  section('3. 换干净会话（每次摘要尝试之后都换，成功失败都换）');
  // -------------------------------------------------------------------------
  const markAll = countOf(LIVE, 'S._needFreshSession = true;');
  check('换会话标记全文件只有一处', markAll === 1, markAll + ' 处');

  const rsIdx = LIVE.indexOf('function runStageSummary(opts)');
  const rsBody = rsIdx >= 0 ? LIVE.slice(rsIdx) : '';
  const catchIdx = rsBody.indexOf('.catch(function (err) {');
  const markIdx = rsBody.indexOf('S._needFreshSession = true;');
  check('标记在 .catch 之后 —— 失败也会换 (不然会恶性循环)',
    catchIdx >= 0 && markIdx > catchIdx,
    'catch@' + catchIdx + ' mark@' + markIdx);

  const okIdx = rsBody.indexOf(".then(function (text) {");
  check('成功分支里【没有】标记 (只能在收尾钩子里)',
    okIdx >= 0 && markIdx > okIdx &&
    rsBody.slice(okIdx, catchIdx).indexOf('S._needFreshSession = true;') === -1);

  // ⚠️ 这两条必须【在换会话那一块里】找 —— 线上版 cinema-live.js 的别处
  //    也有 saveHandle(null) (连不上时清废 handle), 全文件搜会误判成绿。
  const freshIdx = LIVE.indexOf('if (S._needFreshSession && !watchSession.pendingSummary');
  const freshEnd = freshIdx >= 0 ? LIVE.indexOf('\n      }', freshIdx) : -1;
  const freshBlock = (freshIdx >= 0 && freshEnd > freshIdx) ? LIVE.slice(freshIdx, freshEnd) : '';
  check('换会话时会清 resume handle (在换会话那一块里)',
    freshBlock.indexOf('saveHandle(null)') >= 0,
    freshBlock ? '' : '没找到换会话块');
  check('换会话时会 resetSession (丢掉撑爆的上下文, 在换会话那一块里)',
    freshBlock.indexOf('resetSession()') >= 0);
  check('换会话会等「没有在途的摘要」才做',
    /_needFreshSession\s*&&\s*!watchSession\.pendingSummary\s*&&\s*!watchSession\.summaryBusy/.test(LIVE));
  check('live-client 有 resetSession()', /prototype\.resetSession\s*=/.test(CLIENT));
  check('live-client 有 canSendFrame() (抽帧前先问背压)',
    /prototype\.canSendFrame\s*=/.test(CLIENT));

  // -------------------------------------------------------------------------
  section('4. 每次摘要附一张图给主 API + 阅后即焚');
  // -------------------------------------------------------------------------
  check('摘要成功后截一张图存进 liveNow.image',
    /liveNow\s*=\s*\{[\s\S]{0,200}?image:\s*shot/.test(LIVE));
  check('burnLiveNowImage 已导出给 cinema-chat.js',
    /burnLiveNowImage:\s*function/.test(LIVE));
  check('主 API 请求会带上那张图',
    /image_url:\s*\{\s*url:\s*'data:image\/jpeg;base64,'\s*\+\s*shot/.test(CHAT));
  check('请求发完立刻烧掉图 (finally 里烧)',
    /finally\s*\{[\s\S]{0,400}?burnLiveNowImage\(\)/.test(CHAT));
  check('主 API 不支持识图 → 自动重试一次不带图的',
    /带图请求失败/.test(CHAT) &&
    /messages\.filter\(function \(m\)/.test(CHAT));
  check('图不落库: 段落记忆只存文字',
    /return addFilmSegment\(parts\.segment\)/.test(LIVE));
  check('图不进草稿/导出: liveNow 只有内存里这一张',
    /liveNow:\s*watchSession\.liveNow/.test(LIVE) &&
    countOf(LIVE, 'watchSession.liveNow = {') >= 1);

  // -------------------------------------------------------------------------
  section('5. 诊断（用户截图就能给我）');
  // -------------------------------------------------------------------------
  check('摘要失败会告诉用户 (聊天框里说得出来)',
    /appendSystemLine\('⚠️ 这一段剧情没写进去/.test(LIVE) &&
    /appendSystemLine\('⚠️ 这一段剧情没总结出来/.test(LIVE));
  check('有诊断日志写 localStorage', /cinema_live_diag_v1/.test(LIVE));
  check('Live 的事件推进了【影院设置面板里已有的】诊断框',
    /global\.__cinemaDiagPush = diagLogPush/.test(read('modules/cinema-room.js')) &&
    /__cinemaDiagPush/.test(LIVE));

  // -------------------------------------------------------------------------
  section('6. 15 分钟模拟：单 turn 的上下文不能爆');
  // -------------------------------------------------------------------------
  const slow = await runScenario({ label: '服务端慢', turnLatencyMs: 35000 });
  const maxFrames = slow.turnLog.reduce((m, r) => Math.max(m, r.framesAtSend), 0);
  const maxTokenK = Math.round(maxFrames * 258 / 1000);

  check('服务端慢(35s) 剧情照样写进去 (修前是 0 段)', slow.segCount >= 1, slow.segCount + ' 段');
  check('Live turn 数 ≤ 12 (修前 28~29)', slow.turns <= 12, slow.turns + ' 个');
  check('换过干净会话 (修前 1 个会话撑到底)', slow.sessions >= 2, slow.sessions + ' 个会话');
  check('单个 turn 最多累积 ≤ 130 帧 (2 分钟 @ 1 FPS + 余量)',
    maxFrames <= 130, maxFrames + ' 帧');
  check('单个 turn 最多输入 ≤ 35K token (预算 128K 的 27%)',
    maxTokenK <= 35, maxTokenK + 'K');
  check('输入 token 累计 ≤ 500K (修前 3351K)', slow.inputTokenK <= 500, slow.inputTokenK + 'K');

  const queued = await runScenario({
    label: '服务端慢 + 排队堆积', turnLatencyMs: 12000, queuePenaltyMs: 8000
  });
  const queuedMaxFrames = queued.turnLog.reduce((m, r) => Math.max(m, r.framesAtSend), 0);
  // ⚠️ 光看 segCount 咬不住人 —— 线上版在这个场景【也】写得进 (turn 没超 45s 超时)。
  //    必须连着"单 turn 上下文有没有爆"一起看, 才咬得住。
  check('turn 排队堆积: 剧情写得进去, 而且单 turn 上下文没爆',
    queued.segCount >= 1 && queuedMaxFrames <= 130,
    queued.segCount + ' 段 / 最多 ' + queuedMaxFrames + ' 帧');

  // -------------------------------------------------------------------------
  section('7. 写不进去的时候要告诉用户（不能静默）');
  // -------------------------------------------------------------------------
  // 造一个"模型只写了 18 个字"的场景 → 低于 50 字下限 → 这一段写不进去
  const tooShort = await runScenario({
    label: '模型写太短', turnLatencyMs: 3000, summaryText: '就写了一句。'
  });
  check('写太短时确实没写进去 (前提成立)', tooShort.segCount === 0, tooShort.segCount + ' 段');
  const warned = tooShort.chatLines.some(l => /没写进去|没总结出来/.test(l));
  check('聊天框里给出了提示 (修前是完全静默)', warned,
    warned ? '' : '聊天框内容: ' + JSON.stringify(tooShort.chatLines.slice(-3)));

  // -------------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过: ' + passed + '   失败: ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
})().catch(function (e) {
  console.error('\n测试崩了:', e && e.stack ? e.stack : e);
  process.exit(1);
});
