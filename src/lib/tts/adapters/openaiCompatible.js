// ============================================================
// OpenAI Compatible TTS adapter
// 兼容 SiliconFlow、Volink 以及其他 /v1/audio/speech 标准接口
// 配置 endpoint 存用户原值（到 /v1），调用时补全 /audio/speech
// ============================================================

(function () {
  window.TTSAdapters = window.TTSAdapters || {};

  function buildSpeechEndpoint(endpoint) {
    const base = (endpoint || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('自定义 OpenAI 兼容接口地址不能为空');
    if (/\/audio\/speech$/i.test(base)) return base;
    return `${base}/audio/speech`;
  }

  async function readErrorResponse(response) {
    try {
      const data = await response.clone().json();
      return data.error?.message || data.message || JSON.stringify(data);
    } catch (e) {
      try {
        return await response.text();
      } catch (err) {
        return '';
      }
    }
  }

  // 2026-09-29: 接住 languageBoost (与 minimax 适配器同签名)。
  //   OpenAI 标准的 /v1/audio/speech 没有语种字段, 各家自建网关的叫法也不统一
  //   (有的用 language, 有的用 language_boost, 多数直接忽略未知字段)。
  //   猜字段名有把请求打挂的风险, 所以这里**只声明不发送**。
  //   若目标平台确认支持: 在下方 body 里加 `language: languageBoost` 即可。
  async function synthesize({ text, voice, config, signal, languageBoost }) {
    if (!config.endpoint) throw new Error('接口地址不能为空，请填写到 /v1');
    if (!config.apiKey) throw new Error('API Key 不能为空');
    if (!config.model) throw new Error('模型名不能为空');
    if (!voice) throw new Error('Voice 不能为空');
    if (languageBoost) {
      console.debug('[TTS:openaiCompatible] 收到 languageBoost, 当前适配器不发送:', languageBoost);
    }

    const url = buildSpeechEndpoint(config.endpoint);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice
      }),
      signal
    });

    if (!response.ok) {
      const details = await readErrorResponse(response);
      throw new Error(`OpenAI 兼容 TTS API 失败: ${response.status}${details ? ` - ${details}` : ''}`);
    }

    const audioBlob = await response.blob();
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('OpenAI 兼容 TTS API 未返回音频数据');
    }

    return {
      blob: audioBlob,
      mimeType: audioBlob.type || 'audio/mpeg',
      provider: 'openaiCompatible',
      resolvedEndpoint: url
    };
  }

  window.TTSAdapters.openaiCompatible = {
    synthesize,
    buildSpeechEndpoint
  };
})();
