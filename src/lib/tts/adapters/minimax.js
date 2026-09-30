// ============================================================
// MiniMax TTS adapter
// 专属接口：/v1/t2a_v2?GroupId=...
// ============================================================

(function () {
  window.TTSAdapters = window.TTSAdapters || {};

  function hexToUint8Array(hexString) {
    if (!hexString) return new Uint8Array();
    const arrayBuffer = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      arrayBuffer[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return arrayBuffer;
  }

  function getEndpoint(config) {
    const saved = config.endpoint || 'https://api.minimax.chat/v1/t2a_v2';
    if (/\/v1\/t2a_v2\/?$/i.test(saved)) return saved.replace(/\/$/, '');
    return saved.replace(/\/$/, '') + '/v1/t2a_v2';
  }

  async function synthesize({ text, voice, config, signal, languageBoost, emotion }) {
    if (!config.apiKey) throw new Error('MiniMax API Key 不能为空');
    if (!config.groupId) throw new Error('MiniMax Group ID 不能为空');
    if (!voice) throw new Error('MiniMax Voice ID 不能为空');

    const endpoint = getEndpoint(config);
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${endpoint}${separator}GroupId=${encodeURIComponent(config.groupId)}`;
    const modelId = config.model || 'speech-01-hd';

    const requestBody = {
      model: modelId,
      text,
      stream: false,
      voice_setting: {
        voice_id: voice,
        speed: 1.0,
        vol: 1.0,
        pitch: 0
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1
      }
    };

    // 情绪: 只在有合法值时才写进 voice_setting。
    //   undefined / 空 / 非法值一律不写 —— 改造前的请求体保持逐字节一致。
    if (emotion) {
      requestBody.voice_setting.emotion = emotion;
    }

    if (languageBoost) {
      requestBody.language_boost = languageBoost;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      let errorMsg = `MiniMax API 失败: ${response.status}`;
      try {
        const errJson = await response.json();
        errorMsg += ` - ${errJson.base_resp?.status_msg || JSON.stringify(errJson)}`;
      } catch (e) { }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax API 错误: ${data.base_resp.status_msg}`);
    }

    const audioHex = data.data?.audio;
    if (!audioHex) throw new Error('MiniMax API 未返回音频数据');

    const audioBytes = hexToUint8Array(audioHex);
    return {
      blob: new Blob([audioBytes], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      provider: 'minimax'
    };
  }

  window.TTSAdapters.minimax = { synthesize };
})();
