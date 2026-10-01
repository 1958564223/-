// ============================================================
// TTS settings UI
// 根据 provider 动态渲染 MiniMax / Fish Audio / OpenAI Compatible 表单
// ============================================================

(function () {
  const providerLabels = {
    minimax: 'MiniMax（国内版）',
    fishAudio: 'Fish Audio（鱼声）',
    openaiCompatible: '自定义（OpenAI 标准格式）'
  };

  const minimaxModels = [
    { id: 'speech-01-turbo', name: 'Speech-01 Turbo（快速版）' },
    { id: 'speech-01-hd', name: 'Speech-01 HD（高清版）' },
    { id: 'speech-02-turbo', name: 'Speech-02 Turbo' },
    { id: 'speech-02-hd', name: 'Speech-02 HD' },
    { id: 'speech-2.5-hd-preview', name: 'Speech-2.5 HD（高清）' },
    { id: 'speech-2.6-turbo', name: 'Speech-2.6 Turbo' },
    { id: 'speech-2.6-hd', name: 'Speech-2.6 HD' },
    { id: 'speech-2.8-turbo', name: 'Speech-2.8 Turbo' },
    { id: 'speech-2.8-hd', name: 'Speech-2.8 HD' }
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getTtsConfig() {
    if (!window.TTSService || !window.state?.apiConfig) return null;
    return window.TTSService.normalizeTtsConfig(window.state.apiConfig);
  }

  function renderMinimaxForm(config) {
    const modelOptions = minimaxModels.map(model => (
      `<option value="${escapeHtml(model.id)}" ${model.id === config.model ? 'selected' : ''}>${escapeHtml(model.name)}</option>`
    )).join('');

    return `
      <div class="settings-item">
        <label>API Key <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="password" id="tts-minimax-api-key" placeholder="输入 MiniMax API Key" value="${escapeHtml(config.apiKey)}">
        </div>
      </div>
      <div class="settings-item">
        <label>Group ID <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="text" id="tts-minimax-group-id" placeholder="输入 Group ID" value="${escapeHtml(config.groupId)}">
        </div>
      </div>
      <div class="settings-item">
        <label>模型</label>
        <div class="settings-right">
          <select id="tts-minimax-model" class="settings-select">${modelOptions}</select>
        </div>
      </div>
      <p class="settings-description" style="padding: 0 15px 10px; color: #888; font-size: 12px;">
        MiniMax 接口地址已固化为：${escapeHtml(config.endpoint || window.TTSService.MINIMAX_ENDPOINT)}
        <br>音色 ID 请在【角色设置】里按角色分别填写（中文 / 日语 / 英文），全局不再统一指定。
      </p>
    `;
  }

  function renderFishAudioForm(config) {
    return `
      <div class="settings-item">
        <label>API Key <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="password" id="tts-fish-api-key" placeholder="输入 Fish Audio API Key" value="${escapeHtml(config.apiKey)}">
        </div>
      </div>
      <div class="settings-item">
        <label>模型</label>
        <div class="settings-right">
          <input type="text" id="tts-fish-model" placeholder="s2-pro" value="${escapeHtml(config.model || 's2-pro')}">
        </div>
      </div>
      <div class="settings-item">
        <label>音色参数</label>
        <div class="settings-right">
          <input type="text" id="tts-fish-voice" placeholder="reference_id / 鱼声音色模型 ID" value="${escapeHtml(config.voice)}">
        </div>
      </div>
      <p class="settings-description" style="padding: 0 15px 10px; color: #888; font-size: 12px;">
        Fish Audio 接口地址已固化为：https://api.fish.audio/v1/tts。音色参数会作为 reference_id 发送。
      </p>
    `;
  }

  function renderOpenAiCompatibleForm(config) {
    return `
      <div class="settings-item">
        <label>接口地址 <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="text" id="tts-openai-endpoint" placeholder="https://api.siliconflow.cn/v1" value="${escapeHtml(config.endpoint)}">
        </div>
      </div>
      <p class="settings-description" style="padding: 0 15px 6px; color: #888; font-size: 12px;">
        填写到 /v1 即可，系统自动补全端点路径。支持 SiliconFlow、Volink 等兼容 OpenAI TTS 的平台。
      </p>
      <div class="settings-item">
        <label>API Key <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="password" id="tts-openai-api-key" placeholder="输入 API Key" value="${escapeHtml(config.apiKey)}">
        </div>
      </div>
      <div class="settings-item">
        <label>模型名 <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="text" id="tts-openai-model" placeholder="FunAudioLLM/CosyVoice2-0.5B" value="${escapeHtml(config.model)}">
        </div>
      </div>
      <p class="settings-description" style="padding: 0 15px 6px; color: #888; font-size: 12px;">
        请填写平台支持的 TTS 模型名，如 FunAudioLLM/CosyVoice2-0.5B。
      </p>
      <div class="settings-item">
        <label>Voice <span style="color:#ff3b30;">*</span></label>
        <div class="settings-right">
          <input type="text" id="tts-openai-voice" placeholder="平台支持的 voice 参数" value="${escapeHtml(config.voice)}">
        </div>
      </div>
    `;
  }

  function renderProviderForm() {
    const ttsConfig = getTtsConfig();
    if (!ttsConfig) return;

    const form = document.getElementById('tts-provider-form');
    if (!form) return;

    const enabled = document.getElementById('tts-enabled-switch')?.checked;
    form.style.display = enabled ? 'block' : 'none';
    if (!enabled) {
      form.innerHTML = '';
      return;
    }

    const provider = document.getElementById('tts-provider-select')?.value || ttsConfig.currentProvider;
    const config = ttsConfig.providers[provider] || {};

    if (provider === 'minimax') {
      form.innerHTML = renderMinimaxForm(config);
    } else if (provider === 'fishAudio') {
      form.innerHTML = renderFishAudioForm(config);
    } else {
      form.innerHTML = renderOpenAiCompatibleForm(config);
    }
  }

  function renderTtsProviderSettings() {
    const ttsConfig = getTtsConfig();
    if (!ttsConfig) return;

    const enabledSwitch = document.getElementById('tts-enabled-switch');
    const providerSelect = document.getElementById('tts-provider-select');
    const details = document.getElementById('tts-settings-details');

    if (!enabledSwitch || !providerSelect || !details) return;

    enabledSwitch.checked = Boolean(ttsConfig.ttsEnabled);
    providerSelect.value = ttsConfig.currentProvider || 'minimax';
    details.style.display = enabledSwitch.checked ? 'block' : 'none';

    enabledSwitch.onchange = () => {
      details.style.display = enabledSwitch.checked ? 'block' : 'none';
      renderProviderForm();
    };

    providerSelect.onchange = () => {
      ttsConfig.currentProvider = providerSelect.value;
      renderProviderForm();
    };

    renderProviderForm();
  }

  function readInput(id) {
    return document.getElementById(id)?.value.trim() || '';
  }

  function saveTtsSettingsFromDom({ silent = false } = {}) {
    const ttsConfig = getTtsConfig();
    if (!ttsConfig) return true;

    const enabled = Boolean(document.getElementById('tts-enabled-switch')?.checked);
    const provider = document.getElementById('tts-provider-select')?.value || 'minimax';
    ttsConfig.ttsEnabled = enabled;
    ttsConfig.currentProvider = provider;

    if (enabled && provider === 'minimax') {
      const cfg = ttsConfig.providers.minimax;
      cfg.apiKey = readInput('tts-minimax-api-key');
      cfg.groupId = readInput('tts-minimax-group-id');
      cfg.model = readInput('tts-minimax-model') || 'speech-01-hd';
      cfg.endpoint = window.TTSService.MINIMAX_ENDPOINT;
      // 2026-10-01: 不再读全局 voice。音色改为 per-chat (chat.settings.minimaxVoiceId /
      //   ...Ja / ...En), 全局这份从来就没被读到过 —— 聊天与两条通话链路都先用自己的
      //   voiceId 判空, 走不到 index.js 的 `|| providerConfig.voice` 兜底。
      //   存量 users 的 config.voice 原样保留不清理, 万一以后要复活它还在。
      if (!cfg.apiKey) return showTtsValidationError('MiniMax API Key 不能为空', silent);
      if (!cfg.groupId) return showTtsValidationError('MiniMax Group ID 不能为空', silent);
    }

    if (enabled && provider === 'fishAudio') {
      const cfg = ttsConfig.providers.fishAudio;
      cfg.apiKey = readInput('tts-fish-api-key');
      cfg.model = readInput('tts-fish-model') || 's2-pro';
      cfg.voice = readInput('tts-fish-voice');
      cfg.endpoint = window.TTSService.FISH_AUDIO_ENDPOINT;

      if (!cfg.apiKey) return showTtsValidationError('Fish Audio API Key 不能为空', silent);
      if (!cfg.model) return showTtsValidationError('Fish Audio 模型不能为空', silent);
    }

    if (enabled && provider === 'openaiCompatible') {
      const cfg = ttsConfig.providers.openaiCompatible;
      cfg.endpoint = readInput('tts-openai-endpoint');
      cfg.apiKey = readInput('tts-openai-api-key');
      cfg.model = readInput('tts-openai-model');
      cfg.voice = readInput('tts-openai-voice');

      if (!cfg.endpoint) return showTtsValidationError('自定义平台接口地址不能为空', silent);
      if (!cfg.apiKey) return showTtsValidationError('自定义平台 API Key 不能为空', silent);
      if (!cfg.model) return showTtsValidationError('自定义平台模型名不能为空', silent);
      if (!cfg.voice) return showTtsValidationError('自定义平台 Voice 不能为空', silent);
    }

    window.state.apiConfig.tts = ttsConfig;
    return true;
  }

  function showTtsValidationError(message, silent) {
    if (!silent) {
      if (typeof showCustomAlert === 'function') showCustomAlert('语音配置错误', message);
      else alert(message);
    }
    return false;
  }

  window.renderTtsProviderSettings = renderTtsProviderSettings;
  window.renderTtsProviderForm = renderProviderForm;
  window.saveTtsSettingsFromDom = saveTtsSettingsFromDom;
  window.TTS_PROVIDER_LABELS = providerLabels;
})();
