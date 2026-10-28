// ============================================================
// tests/cinema-heat.test.cjs
// 影院「发烫 / 闪退 / 一句剧情总结都没写」这一轮的回归测试
//
// 跑法: node tests/cinema-heat.test.cjs
//
// 【守什么】用户 2026-10-29 实测三连报：
//   ① 本地视频看的时候越看手机越烫
//   ② 看了十分钟动漫一句剧情总结都没写
//   ③ 最后十五分钟左右浏览器崩溃闪退
//   「以前放这种动漫不会闪退的」
//
// 【这一轮查出来的三个真因】(探针 _reports/pet-test/probe-cinema-heat.cjs 实测)
//   ① 上行 5.3MB/分钟 (15 分钟 79.3MB) → 手机射频持续满载 = 发烫
//      下行 9.1MB 100% 是【用完就丢】的模型音频 (AUDIO 是 3.8-live 唯一 modality)
//   ② 5 分钟摘要请求有 45 秒硬超时 → 服务端 turn 一慢就静默作废
//      对照实测: turn 3s/12s → 写进 2 段; turn 35s/排队堆积 → 0 段
//   ③ 每帧画面都是 image token (官方: 258 tokens/tile), 900 帧 = 232k~1.4M token,
//      而 Live 会话输入预算 131,072 → 8~14 分钟必爆 → 重连还带 resume handle
//      继承爆掉的上下文 → 重连风暴 → 狂热 + 闪退
//
// 【修法】
//   帧率 1→0.2 FPS / 长边 768→512 / 质量 0.6→0.5 / 每会话 80 帧就换干净会话 /
//   摘要超时 45→90s / 摘要失败告诉用户 + 60s 重试 / 实况 30→120s /
//   抽帧前先问背压 / 诊断日志写 localStorage
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
const CLIENT = read('modules/live-client.js');

function numOf(src, name) {
  // ⚠️ 右值可能带运算 (比如 `120 * 1000`) —— 只抓数字会把 "120 * 1000" 读成 120。
  const m = new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) return null;
  try {
    // eslint-disable-next-line no-new-func
    return Function('return (' + m[1] + ')')();
  } catch (e) {
    return null;
  }
}

(async function () {
  // -------------------------------------------------------------------------
  section('1. 参数锁死（别被人不小心调回去）');
  // -------------------------------------------------------------------------
  const frameInterval = numOf(LIVE, 'FRAME_INTERVAL_MS');
  const frameMaxDim = numOf(LIVE, 'FRAME_MAX_DIM');
  const jpegQuality = numOf(LIVE, 'JPEG_QUALITY');
  const budget = numOf(LIVE, 'SESSION_FRAME_BUDGET');
  const sumTimeout = numOf(LIVE, 'SUMMARY_REQUEST_TIMEOUT_MS');
  const liveNow = numOf(LIVE, 'LIVE_NOW_INTERVAL_MS');

  check('帧率不快于 0.2 FPS (每帧 ≥ 5 秒)', frameInterval !== null && frameInterval >= 5000,
    frameInterval + 'ms');
  check('抽帧长边不超过 512', frameMaxDim !== null && frameMaxDim <= 512, frameMaxDim + 'px');
  check('JPEG 质量不超过 0.5', jpegQuality !== null && jpegQuality <= 0.5, String(jpegQuality));
  check('每会话帧预算不超过 100 帧', budget !== null && budget <= 100, budget + ' 帧');
  check('摘要超时不少于 90 秒', sumTimeout !== null && sumTimeout >= 90000, sumTimeout + 'ms');
  check('实况通道间隔不少于 120 秒', liveNow !== null && liveNow >= 120000, liveNow + 'ms');

  check('live-client 有 canSendFrame() (抽帧前先问背压)', /prototype\.canSendFrame\s*=/.test(CLIENT));
  check('live-client 有 resetSession() (换干净会话)', /prototype\.resetSession\s*=/.test(CLIENT));
  check('摘要失败会告诉用户 (聊天框里说得出来)',
    /appendSystemLine\('⚠️ 这一段剧情没写进去/.test(LIVE) &&
    /appendSystemLine\('⚠️ 这一段剧情没总结出来/.test(LIVE));
  check('摘要失败 60 秒后会重试', /SUMMARY_RETRY_DELAY_MS/.test(LIVE) && /scheduleStageSummary\(SUMMARY_RETRY_DELAY_MS\)/.test(LIVE));
  check('有诊断日志写 localStorage', /cinema_live_diag_v1/.test(LIVE));
  check('Live 的事件推进了【影院设置面板里已有的】诊断框 (用户截图就能给我)',
    /global\.__cinemaDiagPush = diagLogPush/.test(read('modules/cinema-room.js')) &&
    /__cinemaDiagPush/.test(LIVE));

  // -------------------------------------------------------------------------
  section('2. 15 分钟模拟：流量必须降下来');
  // -------------------------------------------------------------------------
  const fast = await runScenario({ label: '服务端快', turnLatencyMs: 3000 });

  check('帧数 ≤ 200 (原来 902)', fast.frames <= 200, fast.frames + ' 帧');
  check('上行 ≤ 10MB (原来 79.3MB)', fast.outMB <= 10, fast.outMB + 'MB');
  check('下行废音频 ≤ 4MB (原来 9.1MB)', fast.audioMB <= 4, fast.audioMB + 'MB');
  check('turn 数 ≤ 12 (原来 30)', fast.turns <= 12, fast.turns + ' 个');
  check('到预算会换干净会话 (原来 1 个会话撑到底)', fast.sessions >= 2, fast.sessions + ' 个会话');

  // -------------------------------------------------------------------------
  section('3. 服务端慢的时候，剧情总结照样要写进去');
  // -------------------------------------------------------------------------
  const slow = await runScenario({ label: '服务端慢', turnLatencyMs: 35000 });
  check('turn 35 秒: 剧情写进去了 (修前是 0 段)', slow.segCount >= 1, slow.segCount + ' 段');

  const queued = await runScenario({
    label: '服务端慢 + 排队堆积', turnLatencyMs: 12000, queuePenaltyMs: 8000
  });
  check('turn 排队堆积: 剧情写进去了 (修前是 0 段)', queued.segCount >= 1, queued.segCount + ' 段');

  // -------------------------------------------------------------------------
  section('4. 写不进去的时候要告诉用户（不能静默）');
  // -------------------------------------------------------------------------
  // 造一个"模型只写了 18 个字"的场景 → 低于 80 字下限 → 这一段写不进去
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
