// ============================================================
// tests/no-duplicate-declarations.test.cjs
// 同作用域重名函数声明扫描 —— 330 Cinema Room 事故的常驻防线
//
// 跑法: node tests/no-duplicate-declarations.test.cjs
//
// 【为什么要有这个检查】2026-10-14 真机事故
//   现象: 家庭影院「本地上传视频」一部都播不了, 连播放都没起, 跟 API 无关。
//   根因: modules/cinema-room.js 里 setVideoSrc 被定义了两次 ——
//           :966  function setVideoSrc(url, film, resumeTime)   ← 播本地影片的完整装配
//           :1343 function setVideoSrc(url)                    ← 2026-10-09 (9277621) 加的短剧 CORS helper
//         同名 + 同作用域 → 函数声明提升, 后者赢 → 前者整体变成【死代码】。
//         于是 playFilm() 只执行了 1 参版本, 而它只干一件事: video.src = url。
//         video.play() / idle.hidden / currentFilmId / 续播 / 进度落盘 全都没执行。
//         表现就是「点了片子, 画面还盖着待机遮罩, 一动不动」。
//
// 【为什么静态检查抓不到】两个声明都完全合法:
//   node --check 绿 / ESLint 默认不报(要开 no-redeclare) / 浏览器不报错 / 测试全过。
//   它不是语法问题, 是语义问题 —— 只有一个名字在真正运行, 另一个静默躺死。
//
// 【判重必须带作用域, 只看名字会误报一堆合法闭包】
//   同一个名字出现在不同 indent, 是各自函数内部的局部闭包, 完全正常:
//     cinema-room.js  sendChat  :1611(indent 2) vs :2839(indent 4)
//     cinema-room.js  settle    :2562(indent 6) vs :2612(indent 6, 不同函数内)
//   所以本脚本按【名字 + 缩进 + 所属作用域行】三重分组。
//
// 【所属作用域怎么算】从声明行往上找, 第一个「缩进更小且以 { 结尾」的行 = 所属作用域。
//   同一个文件里两个同名同缩进的函数, 只有所属作用域也相同才是真冲突。
//
// 【退出码】发现真冲突 → exit 1。CI / 提交前跑一遍就能拦住这类事故。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 要扫的目录 (跳过 lib/ node_modules/ 330--main/ src/ —— 那些是第三方或旧副本)
const SCAN_DIRS = ['modules', 'js'];
// 根目录下的单文件
const SCAN_ROOT_FILES = [
  'couple-space.js',
  'online-chat-manager.js',
  'prompt-manager.js',
  'force-update.js',
  'sticker-vision.js',
  'period-tracker.js',
  'structured-memory.js',
  'vector-memory.js',
  'helper-assistant.js',
  'notification-manager.js',
  'focus-timer.js',
  'update-notification.js',
  'character-generator.js',
  'script.js'
];

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

/** 剥掉整行注释 (只剥「整行都是注释」的行, 不碰行尾注释和字符串里的 //) */
function stripLineComments(src) {
  return src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(l))
    .join('\n');
}

/**
 * 扫一个文件, 返回同作用域重名的函数声明组
 * @returns {Array<{name,indent,scope,lines:number[]}>}
 */
function scanFile(file) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  const lines = src.split(/\r?\n/);
  const decls = [];

  lines.forEach((line, i) => {
    // 跳注释行 —— 注释里写 function xxx() 会误报 (本文件自己的注释就有)
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const m = /^([ \t]*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (!m) return;
    const indent = m[1].replace(/\t/g, '  ').length;

    // 往上找所属作用域行
    let scope = 0;
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j];
      if (t.trim() === '' || /^\s*(\/\/|\*|\/\*)/.test(t)) continue;
      const ti = (t.match(/^[ \t]*/)[0] || '').replace(/\t/g, '  ').length;
      if (ti < indent && /\{\s*$/.test(t)) { scope = j + 1; break; }
      if (ti < indent && /\S/.test(t)) { scope = -1; break; }
    }

    decls.push({ name: m[2], line: i + 1, indent: indent, scope: scope });
  });

  const groups = new Map();
  for (const d of decls) {
    const key = d.name + '|' + d.indent + '|' + d.scope;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const hits = [];
  for (const arr of groups.values()) {
    if (arr.length > 1) {
      hits.push({
        name: arr[0].name,
        indent: arr[0].indent,
        scope: arr[0].scope,
        lines: arr.map(x => x.line)
      });
    }
  }
  return hits;
}

function collectFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
  }
  for (const f of SCAN_ROOT_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  }
  return files;
}

// ------------------------------------------------------------
// 1. 主检查: 扫全仓库, 找同作用域重名函数声明
// ------------------------------------------------------------
console.log('\n=== 1. 同作用域重名函数声明扫描 ===');
const files = collectFiles();
const allHits = [];

for (const f of files) {
  for (const h of scanFile(path.join(ROOT, f))) {
    allHits.push({ file: f, hit: h });
  }
}

if (allHits.length === 0) {
  ok('全仓库无同作用域重名函数声明', '(' + files.length + ' 个文件)');
} else {
  for (const x of allHits) {
    fail(
      x.file + '  同名函数 ' + x.hit.name,
      'indent=' + x.hit.indent + '  所属作用域@第' + x.hit.scope + '行  重复声明在 ' + x.hit.lines.join(', ')
    );
    console.log('         → 后面的声明赢, 前面的整段是死代码。');
    console.log('         → 修法: 保留业务主函数的名字, 把新增/次要的那个改名, 然后逐个核对调用点。');
  }
}

// ------------------------------------------------------------
// 2. 回归锁定: cinema-room.js 那次事故的具体不变量
//    (通用扫描过了, 这几条钉死具体事故, 改名改错了会立刻报)
// ------------------------------------------------------------
console.log('\n=== 2. cinema-room.js setVideoSrc 事故回归锁定 ===');
const roomPath = path.join(ROOT, 'modules', 'cinema-room.js');

if (!fs.existsSync(roomPath)) {
  fail('modules/cinema-room.js 存在', '文件不见了');
} else {
  // ⚠️ 源码级正则必须先剥掉整行注释, 否则会【匹配到自己的注释】——
  //    下面的注释里就写着 'setVideoSrc(url)' 这几个字, 不剥必然误报。
  //    (这是本项目的老坑: 在注释里解释 bug 曾长什么样, 正则把它当成代码扫出来了。)
  const roomSrc = stripLineComments(fs.readFileSync(roomPath, 'utf8'));

  // 2.1 setVideoSrc 全文只能声明一次
  const declCount = (roomSrc.match(/^\s*(?:async\s+)?function\s+setVideoSrc\s*\(/gm) || []).length;
  if (declCount === 1) {
    ok('setVideoSrc 只声明 1 次');
  } else {
    fail('setVideoSrc 声明次数 = ' + declCount, '必须恰好 1 次, 否则整条播放装配会变死代码');
  }

  // 2.2 存活的必须是 3 参那个(带 film/resumeTime 的完整装配)
  if (/function\s+setVideoSrc\s*\(\s*url\s*,\s*film\s*,\s*resumeTime\s*\)/.test(roomSrc)) {
    ok('存活的是 3 参版 setVideoSrc(url, film, resumeTime)');
  } else {
    fail('存活的不是 3 参版 setVideoSrc', '必须是 (url, film, resumeTime), 否则本地影片播放装配丢失');
  }

  // 2.3 完整装配里必须有 play() —— 这正是当初一起消失的东西
  const wrapper = /function\s+setVideoSrc\s*\(\s*url\s*,\s*film\s*,\s*resumeTime\s*\)\s*\{([\s\S]*?)\n  \}/.exec(roomSrc);
  if (!wrapper) {
    fail('抠得出 3 参版函数体');
  } else {
    const body = wrapper[1];
    // 8 个必须活着的副作用 —— 少一个就是功能缺失
    const mustHave = [
      'els.video.play',            // 不播 = 用户看到「连播放都没起」
      'currentFilmId',             // 不设 = 进度存不下来 + 片单不高亮当前
      'pendingResumeTime',         // 不设 = 续播永远从头开始
      'destroyHls',                // 不调 = 换片不销毁 HLS 实例
      'onVideoSourceChanged',      // 不调 = Gemini 不知道换了片, 摘要会串
      'els.idle.hidden',           // 不撤 = 待机遮罩盖住画面, 用户以为没反应
      'currentObjectUrl',          // 不记 = blob 永不回收, 内存泄漏
      'updateAmbient'              // 不调 = 房间环境光不随画面变
    ];
    const missing = mustHave.filter(k => body.indexOf(k) === -1);
    if (missing.length === 0) {
      ok('完整装配 8 个关键副作用齐全', mustHave.length + '/' + mustHave.length);
    } else {
      fail('完整装配缺 ' + missing.length + ' 个副作用', missing.join(', '));
    }
  }

  // 2.4 短剧 CORS helper 必须叫 applyVideoSrc, 且不许叫回 setVideoSrc
  const helperCalls = (roomSrc.match(/\bsetVideoSrc\s*\(\s*url\s*\)/g) || []).length;
  if (helperCalls === 0) {
    ok('没有残留的 setVideoSrc(url) 单参调用', '(短剧/CORS 走 applyVideoSrc)');
  } else {
    fail('还有 ' + helperCalls + ' 处 setVideoSrc(url) 单参调用', '这些会绑到 3 参版, 参数 film/resumeTime 变 undefined');
  }

  if (/function\s+applyVideoSrc\s*\(/.test(roomSrc) && /crossorigin/.test(roomSrc)) {
    ok('applyVideoSrc 存在且带 crossorigin 回退逻辑');
  } else {
    fail('applyVideoSrc / crossorigin 回退逻辑不见了', '短剧跨源抽帧会退化成 Gemini 看不到画面');
  }

  // 2.5 影片上传入口必须先 slice 再清 value (iOS 会作废已取出的 File)
  const fileHandler = /els\.fileInput\.addEventListener\('change'[\s\S]*?\n {4}\}\);/.exec(roomSrc);
  if (!fileHandler) {
    fail('找得到 fileInput change 处理器');
  } else {
    const h = fileHandler[0];
    const sliceAt = h.indexOf('.slice(');
    const clearAt = h.indexOf('.value =');
    if (sliceAt !== -1 && clearAt !== -1 && sliceAt < clearAt) {
      ok('影片上传先 slice 再清 value', '(iOS File 作废隐患已防)');
    } else {
      fail('影片上传是「先清 value 再用 File」', 'iOS 上 File 会当场作废, 存不进 IndexedDB, 用户看着就是点了没反应');
    }
  }
}

// ------------------------------------------------------------
console.log('\n--------------------------------------------');
console.log('  通过 ' + passed + ' / 失败 ' + failed);
console.log('--------------------------------------------\n');

process.exit(failed > 0 ? 1 : 0);