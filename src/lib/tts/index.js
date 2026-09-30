// ============================================================
// TTS unified entry
// 数据结构：
// state.apiConfig.tts = {
//   ttsEnabled: boolean,
//   currentProvider: 'minimax' | 'fishAudio' | 'openaiCompatible',
//   providers: {
//     minimax: { provider, apiKey, model, voice, groupId, endpoint },
//     fishAudio: { provider, apiKey, model, voice, endpoint },
//     openaiCompatible: { provider, apiKey, model, voice, endpoint }
//   }
// }
// ============================================================

(function () {
  const PROVIDERS = {
    MINIMAX: 'minimax',
    FISH_AUDIO: 'fishAudio',
    OPENAI_COMPATIBLE: 'openaiCompatible'
  };

  const MINIMAX_ENDPOINT = 'https://api.minimax.chat/v1/t2a_v2';
  const FISH_AUDIO_ENDPOINT = 'https://api.fish.audio/v1/tts';

  function getDefaultTtsConfig() {
    return {
      ttsEnabled: false,
      currentProvider: PROVIDERS.MINIMAX,
      providers: {
        [PROVIDERS.MINIMAX]: {
          provider: PROVIDERS.MINIMAX,
          apiKey: '',
          // 2026-09-29: speech-01-hd → speech-2.6-hd。
          //   01/02 系列是逐语言专训音色, 跨语言切换能力弱; 2.5+ 才支持 40 语种自由切换,
          //   这是"一个音色同时读中日"能成立的前提。
          //   注意: deepMerge 会保留用户已存的旧 model, 老配置需在设置页手动切换。
          model: 'speech-2.6-hd',
          voice: '',
          groupId: '',
          endpoint: MINIMAX_ENDPOINT
        },
        [PROVIDERS.FISH_AUDIO]: {
          provider: PROVIDERS.FISH_AUDIO,
          apiKey: '',
          model: 's2-pro',
          voice: '',
          endpoint: FISH_AUDIO_ENDPOINT
        },
        [PROVIDERS.OPENAI_COMPATIBLE]: {
          provider: PROVIDERS.OPENAI_COMPATIBLE,
          apiKey: '',
          model: '',
          voice: '',
          endpoint: ''
        }
      }
    };
  }

  function deepMerge(defaults, value) {
    const result = Array.isArray(defaults) ? [] : { ...defaults };
    if (!value || typeof value !== 'object') return result;

    Object.keys(value).forEach(key => {
      if (
        defaults[key] &&
        typeof defaults[key] === 'object' &&
        !Array.isArray(defaults[key]) &&
        value[key] &&
        typeof value[key] === 'object' &&
        !Array.isArray(value[key])
      ) {
        result[key] = deepMerge(defaults[key], value[key]);
      } else {
        result[key] = value[key];
      }
    });

    return result;
  }

  function hasLegacyMinimaxConfig(apiConfig) {
    return Boolean(
      apiConfig &&
      (
        apiConfig.minimaxGroupId ||
        apiConfig.minimaxApiKey ||
        apiConfig.minimaxModel ||
        apiConfig.minimaxDomain ||
        localStorage.getItem('minimax-group-id') ||
        localStorage.getItem('minimax-api-key') ||
        localStorage.getItem('minimax-model') ||
        localStorage.getItem('minimax-domain')
      )
    );
  }

  function migrateLegacyMinimaxConfig(apiConfig, ttsConfig) {
    if (!hasLegacyMinimaxConfig(apiConfig)) return false;

    const groupId = apiConfig.minimaxGroupId || localStorage.getItem('minimax-group-id') || '';
    const apiKey = apiConfig.minimaxApiKey || localStorage.getItem('minimax-api-key') || '';
    const model = apiConfig.minimaxModel || localStorage.getItem('minimax-model') || 'speech-2.6-hd';
    const legacyDomain = apiConfig.minimaxDomain || localStorage.getItem('minimax-domain') || 'https://api.minimax.chat';
    const endpoint = /\/v1\/t2a_v2\/?$/i.test(legacyDomain)
      ? legacyDomain.replace(/\/$/, '')
      : legacyDomain.replace(/\/$/, '') + '/v1/t2a_v2';

    ttsConfig.providers.minimax = {
      ...ttsConfig.providers.minimax,
      provider: PROVIDERS.MINIMAX,
      apiKey,
      model,
      groupId,
      endpoint
    };
    ttsConfig.currentProvider = PROVIDERS.MINIMAX;
    ttsConfig.ttsEnabled = Boolean(apiKey && groupId);

    delete apiConfig.minimaxGroupId;
    delete apiConfig.minimaxApiKey;
    delete apiConfig.minimaxModel;
    delete apiConfig.minimaxDomain;

    ['minimax-group-id', 'minimax-api-key', 'minimax-model', 'minimax-domain'].forEach(key => {
      try { localStorage.removeItem(key); } catch (e) { }
    });

    console.log('[TTS迁移] 已将旧版 MiniMax 配置迁移到通用 TTS 结构。');
    return true;
  }

  function normalizeTtsConfig(apiConfig) {
    if (!apiConfig) return getDefaultTtsConfig();

    const defaults = getDefaultTtsConfig();
    const merged = deepMerge(defaults, apiConfig.tts || {});

    if (!merged.providers) merged.providers = defaults.providers;
    Object.keys(defaults.providers).forEach(provider => {
      merged.providers[provider] = {
        ...defaults.providers[provider],
        ...(merged.providers[provider] || {}),
        provider
      };
    });

    if (!merged.currentProvider || !merged.providers[merged.currentProvider]) {
      merged.currentProvider = PROVIDERS.MINIMAX;
    }

    try {
      migrateLegacyMinimaxConfig(apiConfig, merged);
    } catch (error) {
      console.error('[TTS迁移] 旧配置迁移失败，请重新配置语音服务：', error);
      if (typeof showToast === 'function') showToast('旧语音配置迁移失败，请重新配置');
    }

    apiConfig.tts = merged;
    return merged;
  }

  function getActiveConfig() {
    if (!window.state || !window.state.apiConfig) {
      throw new Error('应用状态未初始化');
    }

    const ttsConfig = normalizeTtsConfig(window.state.apiConfig);
    if (!ttsConfig.ttsEnabled) return null;

    const provider = ttsConfig.currentProvider || PROVIDERS.MINIMAX;
    const providerConfig = ttsConfig.providers?.[provider];
    if (!providerConfig) {
      throw new Error(`未知 TTS 服务商：${provider}`);
    }

    return {
      provider,
      providerConfig,
      ttsConfig
    };
  }

  function isEnabled() {
    const ttsConfig = normalizeTtsConfig(window.state?.apiConfig || {});
    return Boolean(ttsConfig.ttsEnabled);
  }

  // --- 语言识别 (2026-09-29) ---
  // 背景: MiniMax 系统音色是按语言分前缀的 (Japanese_* / Chinese (Mandarin)_* / English_*)。
  //   同一音色跨语言朗读**必须**靠 language_boost 显式指定, 不传的话模型只能猜,
  //   中文音色的表现就是"日语文本被念成中文"。
  //
  // ⚠️ 假名必须优先于汉字: 日语大量使用汉字, 若先判汉字会把日文整句误判成中文。
  //    (注意: modules/message-actions.js 里那个 detectLanguage 是"汉字优先", 那是给
  //     消息翻译用的源语言判断, 语义不同, 不可直接复用)
  function detectBoostFromText(text) {
    const s = String(text == null ? '' : text);
    if (!s.trim()) return 'auto';
    // 平假名 / 片假名 → 日语
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'Japanese';
    // 汉字 (CJK 统一表意文字) → 中文
    if (/[\u4e00-\u9fa5\u3400-\u4dbf]/.test(s)) return 'Chinese';
    return 'auto';
  }

  // 优先级: 显式指定的语言 > 文本自动识别。
  //   传 'auto' / 空 / undefined 都视为"没指定", 交给自动识别。
  function resolveLanguageBoost(text, languageBoost) {
    const boost = String(languageBoost == null ? '' : languageBoost).trim();
    if (boost && boost !== 'auto') return boost;
    return detectBoostFromText(text);
  }

  // --- 情绪 (2026-09-30) ---
  // 依据官方 OpenAPI T2AVoiceSetting.emotion.description:
  //   "Option `fluent`, `whisper` is only available for models:
  //    `speech-2.6-turbo`, `speech-2.6-hd`."
  // 故 speech-2.8-hd 实际生效的只有下面 7 个; fluent / whisper 属 2.6 系列, 不纳入。
  // 校验放在这一层 (三条 TTS 链路的唯一收口), adapter 保持"只做协议转换"。
  const SUPPORTED_EMOTIONS = new Set([
    'happy',
    'sad',
    'angry',
    'fearful',
    'disgusted',
    'surprised',
    'calm'
  ]);

  function normalizeEmotion(emotion) {
    const key = String(emotion == null ? '' : emotion).trim().toLowerCase();
    if (!key) return undefined;
    if (!SUPPORTED_EMOTIONS.has(key)) {
      console.warn('[TTS] 非法 emotion 已丢弃, 不会传给服务端:', emotion);
      return undefined;
    }
    return key;
  }

  async function synthesize({ text, voice, signal, languageBoost, emotion } = {}) {
    if (!text || !String(text).trim()) {
      throw new Error('TTS 文本不能为空');
    }

    const active = getActiveConfig();
    if (!active) {
      return null;
    }

    const adapter = window.TTSAdapters?.[active.provider];
    if (!adapter || typeof adapter.synthesize !== 'function') {
      throw new Error(`TTS 适配器未加载：${active.provider}`);
    }

    const finalVoice = voice || active.providerConfig.voice || '';
    // 三条路径 (聊天 / 视频通话 / 语音通话) 都在这里收口:
    //   传了具体语言就用用户的, 没传 (或传 auto) 就按文本自动识别。
    const resolvedLanguageBoost = resolveLanguageBoost(text, languageBoost);
    // 情绪同理: 空白名单直接丢, 不污染下游请求体 (改造前的行为保持不变)。
    const resolvedEmotion = normalizeEmotion(emotion);
    return adapter.synthesize({
      text,
      voice: finalVoice,
      config: active.providerConfig,
      signal,
      languageBoost: resolvedLanguageBoost,
      emotion: resolvedEmotion
    });
  }

  async function persistConfig() {
    if (window.db && window.state?.apiConfig) {
      await window.db.apiConfig.put(window.state.apiConfig);
    }
  }

  window.TTSService = {
    PROVIDERS,
    MINIMAX_ENDPOINT,
    FISH_AUDIO_ENDPOINT,
    getDefaultTtsConfig,
    normalizeTtsConfig,
    detectBoostFromText,
    resolveLanguageBoost,
    normalizeEmotion,
    SUPPORTED_EMOTIONS,
    synthesize,
    isEnabled,
    persistConfig
  };
})();
