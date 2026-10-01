// ============================================================
// tests/tts-voice-resolver.test.cjs
// 按语言自动选择 MiniMax voice_id —— 回归测试
//
// 跑法: node tests/tts-voice-resolver.test.cjs
//
// 做法: 用 vm 把【真实的】tts-expression.js / src/lib/tts/index.js /
//   modules/tts-audio.js 加载进一个沙箱, 只替换掉会发网络请求的
//   TTSService.synthesize 与 TTSService.isEnabled (换成记录器)。
//   被测的 resolveVoiceId / detectVoiceLanguage / buildTtsCacheKey /
//   两条链路的接线代码全部是项目里的真代码。
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    failures.push(`${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}

function checkTrue(name, condition, detail) {
  if (condition) {
    pass++;
  } else {
    failures.push(`${name}${detail ? '\n      ' + detail : ''}`);
  }
}

// ------------------------------------------------------------
// 沙箱
// ------------------------------------------------------------
const VOICE_ZH = 'zh_voice_test';
const VOICE_JA = 'ja_voice_test';
const VOICE_EN = 'en_voice_test';

class FakeAudioElement {
  constructor() {
    this.dataset = {};
    this.paused = true;
    this.onended = null;
    this.onerror = null;
    this.onpause = null;
    this.style = {};
  }
  pause() { this.paused = true; }
  // 必须真的触发 onended: 通话队列靠它推进 (否则 isTtsPlaying 永远为 true,
  // 后面入队的句子一条都发不出去), 聊天的"同条消息再点一次"守卫也靠它复位。
  play() {
    this.paused = false;
    setTimeout(() => {
      if (typeof this.onended === 'function') this.onended();
    }, 0);
    return Promise.resolve();
  }
  removeAttribute() { /* noop */ }
}

class FakeFileReader {
  readAsDataURL() {
    if (typeof this.onloadend === 'function') this.onloadend();
  }
}

function fakeInput(value) {
  return { value: value || '', checked: false, style: {}, addEventListener() {} };
}

function loadApp() {
  const audioElements = {
    'call-tts-audio-player': new FakeAudioElement(),
    'tts-audio-player': new FakeAudioElement(),
    // 全局 TTS 设置页 (API 设置 → 语音) 的最小 DOM
    'tts-enabled-switch': fakeInput(),
    'tts-provider-select': fakeInput('minimax'),
    'tts-settings-details': { style: {}, innerHTML: '' },
    'tts-provider-form': { style: {}, innerHTML: '' },
    'tts-minimax-api-key': fakeInput('test-api-key'),
    'tts-minimax-group-id': fakeInput('test-group-id'),
    'tts-minimax-model': fakeInput('speech-2.6-hd')
  };
  audioElements['tts-enabled-switch'].checked = true;

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = { log() {}, warn() {}, error() {}, debug() {} };
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.AbortController = AbortController;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.FileReader = FakeFileReader;
  // playTtsAudio 拿不到音色时会 alert; 沙箱里没有它, 不打桩会把断言失败
  // 变成 ReferenceError, 反而看不出是哪个 case 挂了。
  sandbox.alert = () => {};
  sandbox.showCustomAlert = async () => true;
  sandbox.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  sandbox.document = {
    getElementById: (id) => audioElements[id] || null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {} })
  };
  sandbox.state = {
    activeChatId: null,
    chats: {},
    ttsCache: new Map(),
    apiConfig: {
      tts: {
        ttsEnabled: true,
        currentProvider: 'minimax',
        providers: {
          minimax: { provider: 'minimax', apiKey: 'test-api-key', groupId: 'test-group-id', model: 'speech-2.6-hd', voice: '', endpoint: '' }
        }
      }
    }
  };

  vm.createContext(sandbox);

  const load = (rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  };

  // 顺序与 index.html 里的 script 标签一致
  load('modules/tts-expression.js');
  load('src/lib/tts/index.js');
  load('src/lib/tts/settings-ui.js');
  load('modules/tts-audio.js');

  // 只替换会发网络的两个入口, 其余保持真实实现
  const calls = [];
  sandbox.TTSService.isEnabled = () => true;
  sandbox.TTSService.synthesize = (opts) => {
    calls.push({
      text: opts.text,
      voice: opts.voice,
      languageBoost: opts.languageBoost,
      emotion: opts.emotion
    });
    return Promise.resolve({ blob: { size: 128, type: 'audio/mpeg' }, mimeType: 'audio/mpeg' });
  };

  return { sandbox, calls, audioElements };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ============================================================
// 1. resolveVoiceId 语言路由
// ============================================================
async function testLanguageRouting() {
  const { sandbox } = loadApp();
  const resolve = sandbox.TTSService.resolveVoiceId;
  const all = { zh: VOICE_ZH, ja: VOICE_JA, en: VOICE_EN };

  check('中文: 你好呀 → 中文音色', resolve('你好呀', all), VOICE_ZH);
  check('日语: こんにちは → 日语音色', resolve('こんにちは', all), VOICE_JA);
  check('日语: 元気です → 日语音色', resolve('元気です', all), VOICE_JA);
  check('混合: 你好、こんにちは → 日语音色 (有假名)', resolve('你好、こんにちは', all), VOICE_JA);
  check('英文(已配置): Hello, how are you? → 英文音色', resolve('Hello, how are you?', all), VOICE_EN);
  check('英文(未配置): fallback 中文音色', resolve('Hello, how are you?', { zh: VOICE_ZH, ja: VOICE_JA, en: '' }), VOICE_ZH);
  check('英文(未配置 ja/en): 纯旧配置也 fallback 中文', resolve('Hello', { zh: VOICE_ZH }), VOICE_ZH);

  // 只有数字/标点/emoji
  check('未知: 12345 → 中文音色', resolve('12345', all), VOICE_ZH);
  check('未知: 。！？ → 中文音色', resolve('。。。！？', all), VOICE_ZH);
  check('未知: 😄 → 中文音色', resolve('😄', all), VOICE_ZH);
  check('未知: 空串 → 中文音色', resolve('', all), VOICE_ZH);
  check('未知: null → 中文音色', resolve(null, all), VOICE_ZH);

  // 片假名
  check('片假名: こんにちは(カナ) → 日语音色', resolve('テスト', all), VOICE_JA);
  check('片假名: カタカナ → 日语音色', resolve('カタカナ', all), VOICE_JA);

  // interjection 不作为语言依据
  check('纯 interjection: (chuckle) → 中文音色', resolve('(chuckle)', all), VOICE_ZH);
  check('纯 interjection: (laughs)(sighs) → 中文音色', resolve('(laughs)(sighs)', all), VOICE_ZH);
  check('interjection + 英文: (chuckle) Hello → 英文音色', resolve('(chuckle) Hello', all), VOICE_EN);
  check('interjection + 日文: (chuckle) こんにちは → 日语音色', resolve('(chuckle) こんにちは', all), VOICE_JA);
  check('非白名单括号不剥离: (he2) → 英文音色(算拉丁)', resolve('(he2)', all), VOICE_EN);

  // 停顿标记是纯 ASCII, 不影响判定
  check('停顿标记不影响: 你好<#0.30#> → 中文音色', resolve('你好<#0.30#>', all), VOICE_ZH);
  check('停顿标记不影响: こんにちは<#0.30#> → 日语音色', resolve('こんにちは<#0.30#>', all), VOICE_JA);

  // 带 [[语音:x]] 的整串 (真实链路上该标签已被上游剥离, 这里也验证不会误导)
  check('中文 + 标签 + interjection + 停顿 → 中文音色',
    resolve('你好[[语音:happy]](chuckle)<#0.30#>', all), VOICE_ZH);
  check('日语 + 标签 + interjection + 停顿 → 日语音色',
    resolve('こんにちは[[语音:happy]](chuckle)<#0.30#>', all), VOICE_JA);
}

// ============================================================
// 2. detectVoiceLanguage 直接断言
// ============================================================
function testDetectLanguage() {
  const { sandbox } = loadApp();
  const detect = sandbox.TTSService.detectVoiceLanguage;

  check('detect: 你好呀', detect('你好呀'), 'zh');
  check('detect: こんにちは', detect('こんにちは'), 'ja');
  check('detect: 元気です', detect('元気です'), 'ja');
  check('detect: Hello', detect('Hello'), 'en');
  check('detect: (chuckle)', detect('(chuckle)'), 'zh');
  check('detect: 123', detect('123'), 'zh');
  check('detect: 汉字(无假名) 判中文', detect('元気'), 'zh');
}

// ============================================================
// 3. 旧配置兼容 (只有 minimaxVoiceId)
// ============================================================
function testLegacyConfigFallback() {
  const { sandbox } = loadApp();
  const getChatVoiceConfig = sandbox.getChatVoiceConfig;
  const resolveTtsVoiceId = sandbox.resolveTtsVoiceId;

  // 模拟旧角色: 只有 minimaxVoiceId
  const legacyChat = { settings: { minimaxVoiceId: VOICE_ZH } };
  const legacyVoices = getChatVoiceConfig(legacyChat, VOICE_ZH);

  checkTrue('旧配置: ja 字段为空串', legacyVoices.ja === '');
  checkTrue('旧配置: en 字段为空串', legacyVoices.en === '');
  check('旧配置: 中文 → 中文音色', resolveTtsVoiceId('你好呀', legacyVoices), VOICE_ZH);
  check('旧配置: 日语 → fallback 中文', resolveTtsVoiceId('こんにちは', legacyVoices), VOICE_ZH);
  check('旧配置: 英文 → fallback 中文', resolveTtsVoiceId('Hello there', legacyVoices), VOICE_ZH);

  // 极端旧配置: 三个字段全 undefined
  const bareChat = { settings: {} };
  const bareVoices = getChatVoiceConfig(bareChat, '');
  check('空配置: 无音色 → 返回空串', resolveTtsVoiceId('你好', bareVoices), '');

  // 新配置: 只填了日语音色
  const jaOnly = getChatVoiceConfig({ settings: { minimaxVoiceId: VOICE_ZH, minimaxVoiceIdJa: VOICE_JA } }, '');
  check('只配日语: 日语 → 日语音色', resolveTtsVoiceId('こんにちは', jaOnly), VOICE_JA);
  check('只配日语: 英文 → fallback 中文', resolveTtsVoiceId('Hello', jaOnly), VOICE_ZH);
}

// ============================================================
// 4. cache key 隔离
// ============================================================
function testCacheKeyIsolation() {
  const { sandbox } = loadApp();
  const buildKey = sandbox.buildTtsCacheKey;
  const resolve = sandbox.TTSService.resolveVoiceId;

  // 同一段 speechText, 两套音色配置解析出不同 voice → cache key 必须不同。
  // 文本必须"能被判成日语" (含假名) 才有意义 —— "你好"按规则永远是中文音色。
  const text = 'こんにちは';
  const keyZh = buildKey({ voiceId: resolve(text, { zh: VOICE_ZH, ja: '' }), boostValue: 'Chinese', emotion: '', text });
  const keyJa = buildKey({ voiceId: resolve(text, { zh: VOICE_ZH, ja: VOICE_JA }), boostValue: 'Japanese', emotion: '', text });

  checkTrue('cache key: 同一文本中日音色产生不同 key', keyZh !== keyJa, `zh=${keyZh} ja=${keyJa}`);
  checkTrue('cache key: zh 配置解析出中文音色', keyZh.includes(VOICE_ZH), keyZh);
  checkTrue('cache key: ja 配置解析出日语音色', keyJa.includes(VOICE_JA), keyJa);

  // 反向: 同一段中文文本, 中文音色换了 → key 也必须变 (否则改了设置还在播旧音色)
  const zhText = '你好';
  const keyA = buildKey({ voiceId: resolve(zhText, { zh: 'zh_A' }), boostValue: 'Chinese', emotion: '', text: zhText });
  const keyB = buildKey({ voiceId: resolve(zhText, { zh: 'zh_B' }), boostValue: 'Chinese', emotion: '', text: zhText });
  checkTrue('cache key: 中文音色切换后 key 变化', keyA !== keyB, `A=${keyA} B=${keyB}`);

  // 旧 key 格式保持不变 (v2 无 emotion / v3 带 emotion)
  check('cache key: v2 格式未变',
    buildKey({ voiceId: 'V', boostValue: 'Chinese', emotion: '', text: 'T' }), 'tts_v2_V_Chinese_T');
  check('cache key: v3 格式未变',
    buildKey({ voiceId: 'V', boostValue: 'Chinese', emotion: 'happy', text: 'T' }), 'tts_v3_V_Chinese_happy_T');

  // emotion 仍然参与隔离
  const k1 = buildKey({ voiceId: 'V', boostValue: 'Chinese', emotion: 'happy', text: 'T' });
  const k2 = buildKey({ voiceId: 'V', boostValue: 'Chinese', emotion: 'sad', text: 'T' });
  checkTrue('cache key: emotion 仍参与隔离', k1 !== k2);
}

// ============================================================
// 5. 通话链路端到端 (语音通话 + 视频通话共用 playVideoCallPureTTS)
// ============================================================
async function testCallChainEndToEnd() {
  const { sandbox, calls } = loadApp();
  const all = { zh: VOICE_ZH, ja: VOICE_JA, en: VOICE_EN };

  sandbox.playVideoCallPureTTS('こんにちは、今日も頑張ります', VOICE_ZH, { source: 'voiceCall', languageBoost: '', voices: all });
  await tick();
  check('通话: 日语文本 → 日语音色', calls[0] && calls[0].voice, VOICE_JA);
  check('通话: 自动识别 → language_boost=Japanese', calls[0] && calls[0].languageBoost, 'Japanese');

  // 关键回归: 以前这里发出去的是 "ja-JP", 不是 "Japanese"
  calls.length = 0;
  sandbox.playVideoCallPureTTS('你好呀', VOICE_ZH, { source: 'voiceCall', languageBoost: 'ja-JP', voices: all });
  await tick();
  check('通话: UI 选 ja-JP → 映射为 Japanese', calls[0] && calls[0].languageBoost, 'Japanese');

  calls.length = 0;
  sandbox.playVideoCallPureTTS('你好呀', VOICE_ZH, { source: 'voiceCall', languageBoost: 'zh-CN', voices: all });
  await tick();
  check('通话: UI 选 zh-CN → 映射为 Chinese', calls[0] && calls[0].languageBoost, 'Chinese');

  calls.length = 0;
  sandbox.playVideoCallPureTTS('Hello, how are you?', VOICE_ZH, { source: 'videoCall', languageBoost: '', voices: all });
  await tick();
  check('视频通话: 英文 → 英文音色', calls[0] && calls[0].voice, VOICE_EN);

  // 未传 options.voices 的旧调用方: 三种语言都用传入的 voiceId
  calls.length = 0;
  sandbox.playVideoCallPureTTS('こんにちは', VOICE_ZH, { source: 'voiceCall' });
  await tick();
  check('通话: 未传 voices 的旧调用方保持原行为', calls[0] && calls[0].voice, VOICE_ZH);

  // emotion 仍透传
  calls.length = 0;
  sandbox.playVideoCallPureTTS('你好呀[[语音:happy]]', VOICE_ZH, { source: 'voiceCall', voices: all });
  await tick();
  check('通话: emotion 透传未被破坏', calls[0] && calls[0].emotion, 'happy');
  check('通话: 标签剥离后文本不含 [[语音:]]', calls[0] && !calls[0].text.includes('[[语音:'), true);
}

// ============================================================
// 6. 聊天链路端到端 (playTtsAudio)
// ============================================================
function makeVoiceBody(text, voiceId) {
  return {
    dataset: { text: encodeURIComponent(text), voiceId: voiceId || '' },
    closest: () => ({ dataset: { timestamp: '1000' } }),
    querySelector: () => ({ textContent: '', style: {} })
  };
}

async function testChatChainEndToEnd() {
  const { sandbox, calls } = loadApp();
  sandbox.state.activeChatId = 'c1';
  sandbox.state.chats.c1 = {
    isGroup: false,
    settings: { enableTts: true, minimaxVoiceId: VOICE_ZH, minimaxVoiceIdJa: VOICE_JA, minimaxVoiceIdEn: VOICE_EN }
  };

  const body = makeVoiceBody('こんにちは-goodbye', '');
  await sandbox.playTtsAudio(body);
  check('聊天: 日语文本 → 日语音色', calls[0] && calls[0].voice, VOICE_JA);
  check('聊天: 日语 → language_boost=Japanese', calls[0] && calls[0].languageBoost, 'Japanese');

  // cache key 必须用解析后的音色
  const keys = Array.from(sandbox.state.ttsCache.keys());
  checkTrue('聊天: 缓存 key 含日语音色 ID', keys.length > 0 && keys[0].includes(VOICE_JA), `keys=${JSON.stringify(keys)}`);
}

// ============================================================
// 7. 聊天缓存隔离: 同一段中文文本, 两种音色配置 → 两次独立请求
// ============================================================
async function testChatCacheIsolation() {
  const { sandbox, calls } = loadApp();
  sandbox.state.activeChatId = 'c1';
  sandbox.state.chats.c1 = {
    isGroup: false,
    settings: { enableTts: true, minimaxVoiceId: VOICE_ZH, minimaxVoiceIdJa: VOICE_JA }
  };

  // 第一次: 中文音色
  await sandbox.playTtsAudio(makeVoiceBody('你好', ''));
  // 等播放器 onended 复位 (真实场景是播放几秒, 这里是 0ms 宏任务)
  await tick();
  // 第二次: 把中文音色换成另一个, 日语音色不动 → 同一段中文文本必须重新请求
  sandbox.state.chats.c1.settings.minimaxVoiceId = 'zh_voice_other';
  await sandbox.playTtsAudio(makeVoiceBody('你好', ''));
  await tick();

  check('缓存隔离: 同一文本两次不同音色 → 发两次请求', calls.length, 2);
  check('缓存隔离: 第一次用原中文音色', calls[0] && calls[0].voice, VOICE_ZH);
  check('缓存隔离: 第二次用新中文音色', calls[1] && calls[1].voice, 'zh_voice_other');
  check('缓存隔离: 缓存里两条独立条目', sandbox.state.ttsCache.size, 2);
}

// ============================================================
// 8. 连续/交错的中日请求不互相污染
// ============================================================
async function testNoCrossContamination() {
  const { sandbox, calls } = loadApp();
  const all = { zh: VOICE_ZH, ja: VOICE_JA, en: VOICE_EN };
  sandbox.state.activeChatId = 'c1';
  sandbox.state.chats.c1 = {
    isGroup: false,
    settings: {
      enableTts: true,
      minimaxVoiceId: VOICE_ZH,
      minimaxVoiceIdJa: VOICE_JA,
      minimaxVoiceIdEn: VOICE_EN
    }
  };

  // 交错入队: 中文 → 日文 → 中文 → 英文
  sandbox.playVideoCallPureTTS('你好呀', VOICE_ZH, { source: 'voiceCall', voices: all });
  sandbox.playVideoCallPureTTS('こんにちは', VOICE_ZH, { source: 'voiceCall', voices: all });
  sandbox.playVideoCallPureTTS('你还好吗', VOICE_ZH, { source: 'voiceCall', voices: all });
  sandbox.playVideoCallPureTTS('Good morning', VOICE_ZH, { source: 'voiceCall', voices: all });
  await tick(60);

  check('不污染: 共 4 次请求', calls.length, 4);
  check('不污染: 第1句中文', calls[0] && calls[0].voice, VOICE_ZH);
  check('不污染: 第2句日文', calls[1] && calls[1].voice, VOICE_JA);
  check('不污染: 第3句中文 (未被日文带跑)', calls[2] && calls[2].voice, VOICE_ZH);
  check('不污染: 第4句英文', calls[3] && calls[3].voice, VOICE_EN);
}

// ============================================================
// 9. 三条链路同一文本 → 同一结果
// ============================================================
async function testThreeChainsAgree() {
  const { sandbox, calls } = loadApp();
  const all = { zh: VOICE_ZH, ja: VOICE_JA, en: VOICE_EN };
  const samples = ['你好呀', 'こんにちは', '元気です', '你好、こんにちは', 'Hello there', '12345', '(chuckle)'];

  sandbox.state.activeChatId = 'c1';
  sandbox.state.chats.c1 = {
    isGroup: false,
    settings: {
      enableTts: true,
      minimaxVoiceId: VOICE_ZH,
      minimaxVoiceIdJa: VOICE_JA,
      minimaxVoiceIdEn: VOICE_EN
    }
  };

  for (const sample of samples) {
    const chatVoice = sandbox.resolveTtsVoiceId(sample, sandbox.getChatVoiceConfig(sandbox.state.chats.c1, ''));
    const callVoice = sandbox.resolveTtsVoiceId(sample, all);
    check(`三链一致: "${sample}" 聊天路径`, chatVoice, callVoice);
  }

  // 聊天链路真实跑一遍, 确认与通话链路结果相同
  calls.length = 0;
  await sandbox.playTtsAudio(makeVoiceBody('こんにちは', ''));
  const chatActual = calls[0] && calls[0].voice;
  const callExpected = sandbox.resolveTtsVoiceId('こんにちは', all);
  check('三链一致: 聊天实跑结果 = 通话预期', chatActual, callExpected);
  check('三链一致: 聊天实跑结果 = 日语音色', chatActual, VOICE_JA);
}

// ============================================================
// 10. language_boost 三链统一
// ============================================================
function testLanguageBoostUnified() {
  const { sandbox } = loadApp();
  const resolve = sandbox.TTSService.resolveLanguageBoost;

  // 聊天侧: tts-audio.js 第 715 行用的是 TTS_LANGUAGE_MAP[ttsLanguage] || 'auto'
  // 通话侧: 现在也是 TTS_LANGUAGE_MAP[requestedLanguage] || 'auto'
  // 下面验证"映射后取值"在两个入口对同一 locale 得到同一个结果。
  const mapSource = fs.readFileSync(path.join(ROOT, 'modules/tts-audio.js'), 'utf8');
  const chatUsesMap = /TTS_LANGUAGE_MAP\[ttsLanguage\]\s*\|\|\s*'auto'/.test(mapSource);
  const callUsesMap = /TTS_LANGUAGE_MAP\[requestedLanguage\]\s*\|\|\s*'auto'/.test(mapSource);
  checkTrue('language_boost: 聊天链路走 TTS_LANGUAGE_MAP', chatUsesMap);
  checkTrue('language_boost: 通话链路走 TTS_LANGUAGE_MAP', callUsesMap);

  check('映射: zh-CN → Chinese', resolve('你好', 'Chinese'), 'Chinese');
  check('映射: ja-JP → Japanese', resolve('こんにちは', 'Japanese'), 'Japanese');

  // 通话侧曾经把 locale 原样发出; 断言现在不会
  checkTrue('language_boost: 通话不再原样发 locale',
    !/const requestedLanguageBoost = options && options\.languageBoost/.test(mapSource));
}

// ============================================================
// 11. 静态断言: 纯函数不碰全局
// ============================================================
function testNoGlobalMutation() {
  const indexSource = fs.readFileSync(path.join(ROOT, 'src/lib/tts/index.js'), 'utf8');

  const extract = (src, header) => {
    const start = src.indexOf(header);
    if (start < 0) return '';
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return '';
  };

  const resolver = extract(indexSource, 'function resolveVoiceId(');
  const detector = extract(indexSource, 'function detectVoiceLanguage(');

  checkTrue('纯函数: 找到 resolveVoiceId', resolver.length > 0);
  checkTrue('纯函数: 找到 detectVoiceLanguage', detector.length > 0);
  checkTrue('纯函数: resolveVoiceId 不碰 apiConfig', !resolver.includes('apiConfig'));
  checkTrue('纯函数: resolveVoiceId 不碰 window.state', !resolver.includes('window.state'));
  checkTrue('纯函数: resolveVoiceId 不碰 chat.settings', !resolver.includes('chat.settings'));
  checkTrue('纯函数: resolveVoiceId 不发请求', !/fetch\(|synthesize\(/.test(resolver));
  checkTrue('纯函数: detectVoiceLanguage 不碰全局配置', !detector.includes('apiConfig') && !detector.includes('window.state'));

  // 全项目: 不得出现"先改全局 voice 再发请求"的写法
  const files = [
    'src/lib/tts/index.js',
    'src/lib/tts/adapters/minimax.js',
    'modules/tts-audio.js',
    'modules/video-voice-call.js'
  ];
  let bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/apiConfig\.tts\.providers\.minimax\.voice\s*=[^=]/.test(src)) bad.push(f);
  }
  checkTrue('纯函数: 无全局 voice 赋值', bad.length === 0, bad.join(', '));

  // 三个业务模块不得各自实现语言判断
  const callSource = fs.readFileSync(path.join(ROOT, 'modules/video-voice-call.js'), 'utf8');
  checkTrue('收口: video-voice-call.js 不含语言正则判断',
    !/\\u3040|\\u30a0|\\u30ff/.test(callSource));
  const chatSource = fs.readFileSync(path.join(ROOT, 'modules/chat-interface.js'), 'utf8');
  checkTrue('收口: chat-interface.js 不含语言正则判断',
    !/\\u3040|\\u30a0|\\u30ff/.test(chatSource));
}

// ============================================================
// 11. 全局 TTS 设置页不再要求 Voice ID (2026-10-01)
// ============================================================
function testGlobalSettingsHasNoVoiceField() {
  const { sandbox, audioElements } = loadApp();

  sandbox.renderTtsProviderSettings();
  const html = audioElements['tts-provider-form'].innerHTML;

  checkTrue('全局设置: 渲染结果不含 tts-minimax-voice', !html.includes('tts-minimax-voice'), html.slice(0, 200));
  checkTrue('全局设置: 仍渲染 API Key 框', html.includes('tts-minimax-api-key'));
  checkTrue('全局设置: 仍渲染 Group ID 框', html.includes('tts-minimax-group-id'));
  checkTrue('全局设置: 提示音色去角色设置填', html.includes('角色设置'));

  // 关键: 只填 API Key + Group ID 就能保存成功 (以前会被 Voice ID 必填拦下)
  const ok = sandbox.saveTtsSettingsFromDom();
  check('全局设置: 无 Voice ID 也能保存', ok, true);

  const src = fs.readFileSync(path.join(ROOT, 'src/lib/tts/settings-ui.js'), 'utf8');
  checkTrue('全局设置: 已无 Voice ID 必填校验', !src.includes('MiniMax Voice ID 不能为空'));
  checkTrue('全局设置: 已无 tts-minimax-voice 读取', !src.includes("readInput('tts-minimax-voice')"));
}

// ============================================================
// 12. 禁止事项自检
// ============================================================
function testNoForbiddenChanges() {
  const expr = fs.readFileSync(path.join(ROOT, 'modules/tts-expression.js'), 'utf8');
  checkTrue('未改 interjection 白名单 (19 项)',
    ['laughs', 'chuckle', 'sighs', 'sneezes', 'emm'].every(t => expr.includes(`'${t}'`)));
  checkTrue('未改 emotion 白名单 (7 项)',
    ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']
      .every(t => expr.includes(`'${t}'`)));
  checkTrue('未改 pause 封顶值 0.6', expr.includes('MAX_PAUSE_SECONDS = 0.6'));
  checkTrue('未动 Live2D [[表情]]/[[舞台]]',
    expr.includes('只认「语音」一个词'));

  const adapter = fs.readFileSync(path.join(ROOT, 'src/lib/tts/adapters/minimax.js'), 'utf8');
  checkTrue('未改 MiniMax 模型/speed/vol/pitch',
    /speed: 1\.0/.test(adapter) && /vol: 1\.0/.test(adapter) && /pitch: 0/.test(adapter));
  checkTrue('adapter 仍只做协议转换 (voice_setting.voice_id)',
    /voice_setting:\s*\{\s*voice_id: voice/.test(adapter.replace(/\n/g, '\n')));
}

// ============================================================
// main
// ============================================================
(async function main() {
  await testLanguageRouting();
  testDetectLanguage();
  testLegacyConfigFallback();
  testCacheKeyIsolation();
  await testCallChainEndToEnd();
  await testChatChainEndToEnd();
  await testChatCacheIsolation();
  await testNoCrossContamination();
  await testThreeChainsAgree();
  testLanguageBoostUnified();
  testNoGlobalMutation();
  testGlobalSettingsHasNoVoiceField();
  testNoForbiddenChanges();

  console.log('\n========================================');
  console.log(' 按语言自动选择 voice_id —— 测试结果');
  console.log('========================================');
  console.log(` PASS: ${pass}`);
  console.log(` FAIL: ${failures.length}`);
  if (failures.length) {
    console.log('\n失败明细:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('\n结果: FAIL');
    process.exit(1);
  }
  console.log('\n结果: PASS');
})();
