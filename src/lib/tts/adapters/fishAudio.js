// ============================================================
// Fish Audio TTS adapter
// 前端不再直连 https://api.fish.audio/v1/tts，避免浏览器 CORS。
// 改为调用 Netlify Function 代理：/.netlify/functions/fish-audio-tts
// - 前端发送 text / voice / apiKey
// - 代理函数在服务端组装 Fish Audio OpenAPI 请求
// - 响应为音频二进制流
// ============================================================

(function () {
  window.TTSAdapters = window.TTSAdapters || {};

  async function readErrorResponse(response) {
    try {
      const data = await response.clone().json();
      return data.message || data.error?.message || JSON.stringify(data);
    } catch (e) {
      try {
        return await response.text();
      } catch (err) {
        return '';
      }
    }
  }

  // 2026-09-29: 接住 languageBoost (与 minimax 适配器同签名)。
  //   Fish Audio 的语种字段名与 MiniMax 不同, 且请求要先过 netlify/functions/fish-audio-tts
  //   这层自有代理才能到上游, 所以这里**只声明不发送** —— 避免猜错字段名把请求打挂。
  //   若将来要启用: 在 requestBody 里加字段, 同时改 netlify/functions/fish-audio-tts.js 透传。
  async function synthesize({ text, voice, config, signal, languageBoost }) {
    if (!config.apiKey) throw new Error('Fish Audio API Key 不能为空');
    if (languageBoost) {
      console.debug('[TTS:fishAudio] 收到 languageBoost, 当前适配器不发送:', languageBoost);
    }

    const endpoint =
      config.proxyUrl ||
      window.API_CONFIG?.fishAudioProxyUrl ||
      '/.netlify/functions/fish-audio-tts';
    const model = config.model || 's2-pro';
    const referenceId = voice || config.voice || '';

    const requestBody = {
      text,
      voice: referenceId,
      apiKey: config.apiKey,
      model
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const details = await readErrorResponse(response);
      throw new Error(`Fish Audio API 失败: ${response.status}${details ? ` - ${details}` : ''}`);
    }

    const audioBlob = await response.blob();
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('Fish Audio API 未返回音频数据');
    }

    return {
      blob: audioBlob.type ? audioBlob : new Blob([audioBlob], { type: 'audio/mpeg' }),
      mimeType: audioBlob.type || 'audio/mpeg',
      provider: 'fishAudio'
    };
  }

  window.TTSAdapters.fishAudio = { synthesize };
})();
