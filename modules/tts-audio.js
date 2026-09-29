// ============================================================
// tts-audio.js — TTS 语音播放、真实录音播放、双语翻译
// 来源：script.js 第 53313 ~ 53978 行
// ============================================================

  function playSilentAudio() {
    const silentPlayer = document.getElementById('silent-audio-player');
    if (silentPlayer) {

      const playPromise = silentPlayer.play();
      if (playPromise !== undefined) {
        playPromise.then(_ => {
          console.log("静音音频已启动，用于后台活动保活。");
        }).catch(error => {


          console.warn("无法自动播放静音音频（这在iOS首次加载时是正常现象）:", error);
        });
      }
    }
  }


  function stopSilentAudio() {
    const silentPlayer = document.getElementById('silent-audio-player');
    if (silentPlayer && !silentPlayer.paused) {
      silentPlayer.pause();
      silentPlayer.currentTime = 0;
      console.log("静音音频已停止。");
    }
  }


  function hexToUint8Array(hexString) {
    if (!hexString) return new Uint8Array();
    const arrayBuffer = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      arrayBuffer[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return arrayBuffer;
  }

  // --- 2026-09-29 语言收口 ---
  // UI 下拉框的 locale code → MiniMax language_boost 取值
  const TTS_LANGUAGE_MAP = {
    'zh-CN': 'Chinese',
    'zh-HK': 'Chinese,Yue',   // 粤语特殊处理
    'en-US': 'English',
    'ja-JP': 'Japanese',
    'ko-KR': 'Korean',
    'de-DE': 'German',
    'fr-FR': 'French',
    'es-ES': 'Spanish',
    'it-IT': 'Italian',
    'ru-RU': 'Russian',
    'pt-BR': 'Portuguese',
    'nl-NL': 'Dutch',
    'pl-PL': 'Polish',
    'sv-SE': 'Swedish',
    'tr-TR': 'Turkish',
    'id-ID': 'Indonesian',
    'ms-MY': 'Malay',
    'vi-VN': 'Vietnamese',
    'th-TH': 'Thai',
    'hi-IN': 'Hindi',
    'ar-SA': 'Arabic'
  };

  /**
   * 把 "UI 语言 / 未指定" 解析成最终要发给 MiniMax 的 language_boost。
   * - 有具体语言 → 用用户的 (resolveLanguageBoost 会原样返回)
   * - 空串 / 'auto' / undefined → 按文本自动识别 (假名→Japanese / 汉字→Chinese)
   * 聊天与通话两条路径都用它, 保证缓存 key 和实际请求用的是同一个判定结果。
   */
  function resolveTtsLanguageBoost(text, language) {
    // 优先用 TTSService 的实现, 保证与真实请求同一套规则
    if (window.TTSService && typeof window.TTSService.resolveLanguageBoost === 'function') {
      try {
        return window.TTSService.resolveLanguageBoost(text, language);
      } catch (e) {
        console.warn('[TTS] resolveLanguageBoost 异常, 退回本地检测:', e);
      }
    }
    // 兜底: TTSService 还没就绪时本地判定 (本函数会在算缓存 key 的阶段被调用, 不能抛错)
    const boost = String(language == null ? '' : language).trim();
    if (boost && boost !== 'auto') return boost;
    const s = String(text == null ? '' : text);
    if (!s.trim()) return 'auto';
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'Japanese';
    if (/[\u4e00-\u9fa5\u3400-\u4dbf]/.test(s)) return 'Chinese';
    return 'auto';
  }

  // --- TTS 播放队列（修复：前一条没读完就跳到最后一条的问题） ---
  const ttsQueue = [];
  // 2026-09-26: 取消 TTS 硬超时限制
  //   - 旧值 30000 (30 秒) 把 200-500 字的小故事朗读到一半就截断,
  //     实际场景朗读就要 30-75 秒, 边界上全被掐
  //   - MiniMax T2A v2 单次请求上限 10000 字符, API 完全够用
  //   - 改成 600000 (10 分钟) 兜底: 正常情况根本不会触发,
  //     万一 fetch 真挂死 / 网络断, 兜底触发跳到下一句, 不会无限卡死
  const CALL_TTS_SYNTHESIS_TIMEOUT_MS = 600000;
  const CALL_TTS_PLAYBACK_TIMEOUT_MS = 600000;
  let isTtsPlaying = false;

  function stopTtsQueue() {
    ttsQueue.length = 0;
    isTtsPlaying = false;
    const callPlayer = document.getElementById('call-tts-audio-player');
    if (callPlayer) {
      callPlayer.onended = null;
      callPlayer.onerror = null;
      callPlayer.pause();
      callPlayer.src = '';
    }
  }

  // v0.5.0 P26: 暴露给外部 — video-voice-call.js endVideoCall 时调用,
  //   真正停止当前段播放 + 清队列 + 重置 isTtsPlaying (避免 TTS 完成回调继续触发 finishVideoCallTurn)
  //   旧 stopTtsQueue 函数内部已经做了这些事, 直接复用, 改名只是为了语义更明确
  window.stopCurrentTts = stopTtsQueue;

  // 单条语音消息播放状态（用于同一条点两次=暂停/取消，退出聊天=停播）
  let currentTtsMessageKey = '';
  let currentTtsLoading = false;
  let ttsAbortController = null;

  /** 只停聊天语音条播放，不清通话 TTS 队列（打着电话切到别人聊天时用） */
  function stopChatMessageTtsOnly() {
    if (ttsAbortController) {
      ttsAbortController.abort();
      ttsAbortController = null;
    }
    currentTtsMessageKey = '';
    currentTtsLoading = false;
    const ttsPlayer = document.getElementById('tts-audio-player');
    if (ttsPlayer) {
      ttsPlayer.onended = null;
      ttsPlayer.onpause = null;
      ttsPlayer.pause();
      ttsPlayer.src = '';
      delete ttsPlayer.dataset.currentText;
      delete ttsPlayer.dataset.currentVoiceId;
      delete ttsPlayer.dataset.currentMessageKey;
    }
    document.querySelectorAll('.voice-play-btn').forEach(btn => { btn.textContent = '▶'; });
    document.querySelectorAll('.voice-message-body .loading-spinner').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('.voice-message-body .voice-play-btn').forEach(btn => { btn.style.display = 'flex'; });
  }

  function stopAllTtsPlayback() {
    stopTtsQueue();
    stopChatMessageTtsOnly();
  }

  function isCallTtsSource(source) {
    return source === 'videoCall' || source === 'voiceCall';
  }

  function logCallTtsDiag(event, source, text, errorType = '') {
    if (!isCallTtsSource(source)) return;
    try {
      window.runtimeDiag?.log?.(event, {
        callType: source === 'voiceCall' ? 'voice' : 'video',
        errorType,
        textLength: String(text || '').length
      });
    } catch (error) {
      console.warn('[通话TTS诊断日志失败]', event, error);
    }
  }

  function logVoiceCallTtsDiag(event, details = {}) {
    try {
      window.runtimeDiag?.log?.(event, {
        textLength: typeof details.textLength === 'number' ? details.textLength : undefined,
        skipReason: details.skipReason || undefined,
        durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
        queueLength: typeof details.queueLength === 'number' ? details.queueLength : ttsQueue.length,
        isTtsPlaying,
        hasVoiceId: Boolean(details.hasVoiceId)
      });
    } catch (error) {
      console.warn('[语音通话TTS诊断日志失败]', event, error);
    }
  }

  function createCallTtsTimeoutError(message, name) {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  // 2026-09-29: 新增 languageBoost 形参。
  //   旧版只传 text/voice/signal, 请求体里根本没有 language_boost 字段,
  //   MiniMax 按 null 处理 → 模型自行猜语种 → 日语音色念中文 (即"日语音色念出中文"的直接原因)。
  async function synthesizeCallTtsWithTimeout(text, voiceId, source, languageBoost) {
    let requestAbortController = null;
    let requestTimeoutId = null;
    const requestStartedAt = Date.now();

    if (source === 'voiceCall') {
      logVoiceCallTtsDiag('VOICE_CALL_TTS_REQUEST_START', {
        textLength: String(text || '').length,
        queueLength: ttsQueue.length,
        hasVoiceId: Boolean(voiceId)
      });
    }

    try {
      requestAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const synthesizePromise = window.TTSService.synthesize({
        text,
        voice: voiceId,
        signal: requestAbortController ? requestAbortController.signal : undefined,
        languageBoost
      });

      const timeoutPromise = new Promise((_, reject) => {
        requestTimeoutId = setTimeout(() => {
          if (requestAbortController) {
            try {
              requestAbortController.abort();
            } catch (error) {
              console.warn('通话TTS合成请求中止失败:', error);
            }
          }
          reject(createCallTtsTimeoutError('tts_synthesis_timeout', 'CallTtsSynthesisTimeoutError'));
        }, CALL_TTS_SYNTHESIS_TIMEOUT_MS);
      });

      const result = await Promise.race([synthesizePromise, timeoutPromise]);

      if (source === 'voiceCall') {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_REQUEST_DONE', {
          textLength: String(text || '').length,
          durationMs: Date.now() - requestStartedAt,
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(voiceId)
        });
      }

      return result;
    } catch (error) {
      if (source === 'voiceCall' && error?.name === 'CallTtsSynthesisTimeoutError') {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_REQUEST_TIMEOUT', {
          textLength: String(text || '').length,
          durationMs: Date.now() - requestStartedAt,
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(voiceId)
        });
      }
      throw error;
    } finally {
      if (requestTimeoutId) {
        clearTimeout(requestTimeoutId);
      }
    }
  }

  function finishCallTtsQueueBySource(source, reason = '') {
    if (source === 'videoCall' && typeof window.onVideoCallTtsQueueFinished === 'function') {
      isTtsPlaying = false;
      window.onVideoCallTtsQueueFinished(reason);
      return true;
    }
    if (source === 'voiceCall' && typeof window.onVoiceCallTtsQueueFinished === 'function') {
      isTtsPlaying = false;
      window.onVoiceCallTtsQueueFinished(reason);
      return true;
    }
    return false;
  }

  // v0.5.0 P12: 视频通话口型 — 让 <audio> 元素旁路接上分析器。
  // attachElement 内部走 captureStream() 拷一份流做分析, 刻意不接管 <audio> 的原生输出,
  // 所以即使 AudioContext 被挂起通话也绝不会没声音。iOS/Safari 内部直接返回 false。
  // 只有 source === 'videoCall' 会走到这里, 语音通话与聊天 TTS 完全不受影响。
  function bindLipSyncToCallPlayer(source, player) {
    if (source !== 'videoCall' || !player) return;
    if (!window.CallLipSync || typeof window.CallLipSync.attachElement !== 'function') return;
    try { window.CallLipSync.attachElement(player); } catch (e) { /* 口型失败不影响声音 */ }
  }

  async function processNextTts() {
    if (ttsQueue.length === 0) {
      isTtsPlaying = false;
      return;
    }

    isTtsPlaying = true;
    const { text, voiceId, source, languageBoost } = ttsQueue.shift();
    const isCallTts = isCallTtsSource(source);
    let audioUrl = '';
    let callPlayer = null;
    let timeoutId = null;
    let failed = false;
    let errorType = '';
    let playStartedAt = 0;
    // [iOS 授权] 彩铃点击时已建共享 AudioContext 并 resume. 通话 TTS 优先走 Web Audio
    // (BufferSourceNode 不受 user gesture 链限制), 失败时回退到 <audio> 元素
    let useWebAudio = false;
    let webAudioSource = null;

    try {
      if (!window.TTSService || !window.TTSService.isEnabled() || !voiceId) {
        throw new Error('tts_unavailable');
      }

      logCallTtsDiag('CALL_TTS_START', source, text);

      console.log(`[TTS队列] 正在朗读 (剩余${ttsQueue.length}条, 语种: ${languageBoost || 'auto'}): ${text}`);

      const result = await synthesizeCallTtsWithTimeout(text, voiceId, source, languageBoost);
      if (!result || !result.blob || result.blob.size === 0) {
        throw new Error('empty_audio');
      }

      audioUrl = URL.createObjectURL(result.blob);

      callPlayer = document.getElementById('call-tts-audio-player');
      if (!callPlayer) {
        throw new Error('audio_player_missing');
      }

      callPlayer.pause();
      callPlayer.onended = null;
      callPlayer.onerror = null;
      callPlayer.src = audioUrl;
      callPlayer.dataset.currentText = text;

      // v0.5.0 P12: 视频通话 AI 说话口型 — 通知口型模块"AI 开始念这句"。
      // 只有 source === 'videoCall' 会拿到通知; 语音通话(voiceCall)与聊天 TTS 完全不受影响。
      if (source === 'videoCall' && window.CallLipSync) {
        try { window.CallLipSync.notifySpeaking(true); } catch (e) {}
      }

      playStartedAt = Date.now();
      if (source === 'voiceCall') {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_PLAY_START', {
          textLength: String(text || '').length,
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(voiceId),
          useWebAudio: (() => {
            const sharedCtx = window.voiceCallSharedAudioContext;
            return !!(sharedCtx && sharedCtx.state === 'running' && typeof sharedCtx.decodeAudioData === 'function');
          })()
        });
      }

      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          fn(value);
        };

        timeoutId = setTimeout(() => {
          const timeoutError = new Error('tts_playback_timeout');
          timeoutError.name = 'CallTtsPlaybackTimeoutError';
          settle(reject, timeoutError);
        }, CALL_TTS_PLAYBACK_TIMEOUT_MS);

        // [iOS 授权] 优先用 Web Audio API 播放(解决 iOS user gesture 链过期导致的玄学无声)
        const sharedCtx = window.voiceCallSharedAudioContext;
        useWebAudio = isCallTts
          && !!(sharedCtx && sharedCtx.state === 'running' && typeof sharedCtx.decodeAudioData === 'function');

        if (useWebAudio) {
          // Web Audio 路径: blob → arrayBuffer → decodeAudioData → BufferSource.start
          (async () => {
            try {
              const arrayBuffer = await result.blob.arrayBuffer();
              const audioBuffer = await sharedCtx.decodeAudioData(arrayBuffer);
              webAudioSource = sharedCtx.createBufferSource();
              webAudioSource.buffer = audioBuffer;
              // v0.5.0 P12: 视频通话口型 — 把分析器插进音频链。
              // AnalyserNode 是直通节点(输入原样输出), 只旁路采样, 不改声音;
              // 拿到 null (iOS / 创建失败 / 非 videoCall) 时照旧直连 destination。
              var lipTapNode = (source === 'videoCall' && window.CallLipSync
                && typeof window.CallLipSync.getTapNode === 'function')
                ? window.CallLipSync.getTapNode(sharedCtx)
                : null;
              webAudioSource.connect(lipTapNode || sharedCtx.destination);
              // BufferSourceNode 没有 onerror, 只能靠 onended + timeout 兜底
              webAudioSource.onended = () => settle(resolve);
              webAudioSource.start();
            } catch (webAudioErr) {
              console.warn('[TTS队列] Web Audio 播放失败, 回退到 <audio> 路径:', webAudioErr);
              useWebAudio = false;
              // 失败时回退到 audio 路径
              // v0.5.0 P12: 回退后同样给视频通话挂上旁路分析器
              bindLipSyncToCallPlayer(source, callPlayer);
              callPlayer.onended = () => settle(resolve);
              callPlayer.onerror = () => settle(reject, new Error('audio_playback_error'));
              const playPromise = callPlayer.play();
              if (playPromise !== undefined) {
                playPromise.catch(error => settle(reject, error || new Error('audio_play_failed')));
              }
            }
          })();
        } else {
          // 原 <audio> 路径 (非通话场景 / 共享 AudioContext 不可用时)
          // v0.5.0 P12: 视频通话口型 — 旁路挂分析器 (不接管声音)
          bindLipSyncToCallPlayer(source, callPlayer);
          callPlayer.onended = () => settle(resolve);
          callPlayer.onerror = () => settle(reject, new Error('audio_playback_error'));

          const playPromise = callPlayer.play();
          if (playPromise !== undefined) {
            playPromise.catch(error => settle(reject, error || new Error('audio_play_failed')));
          }
        }
      });

      if (source === 'voiceCall') {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_PLAY_DONE', {
          textLength: String(text || '').length,
          durationMs: Date.now() - playStartedAt,
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(voiceId),
          useWebAudio
        });
      }
      logCallTtsDiag('CALL_TTS_DONE', source, text);
    } catch (error) {
      failed = true;
      errorType = error?.name === 'CallTtsPlaybackTimeoutError' ? 'playback_timeout' : (error?.name === 'CallTtsSynthesisTimeoutError' ? 'synthesis_timeout' : (error?.message || error?.name || 'unknown'));
      console.error("通话TTS播放失败，已跳过本句:", error);
      if (error?.name === 'CallTtsPlaybackTimeoutError') {
        if (source === 'voiceCall') {
          logVoiceCallTtsDiag('VOICE_CALL_TTS_PLAY_TIMEOUT', {
            textLength: String(text || '').length,
            durationMs: playStartedAt ? Date.now() - playStartedAt : undefined,
            queueLength: ttsQueue.length,
            hasVoiceId: Boolean(voiceId)
          });
        }
        logCallTtsDiag('CALL_TTS_TIMEOUT', source, text, errorType);
      } else {
        logCallTtsDiag('CALL_TTS_ERROR', source, text, errorType);
      }
      logCallTtsDiag('CALL_TTS_FALLBACK_SKIP', source, text, errorType);
    } finally {
      // v0.5.0 P12: 视频通话口型 — 本句播完/失败都收口, 让嘴停下
      if (source === 'videoCall' && window.CallLipSync) {
        try { window.CallLipSync.notifySpeaking(false); } catch (e) {}
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // [iOS 授权] 清理 Web Audio BufferSource (stop + disconnect)
      if (webAudioSource) {
        try {
          try { webAudioSource.onended = null; } catch (e) { /* ignore */ }
          try { webAudioSource.stop(); } catch (e) { /* ignore - 可能已自然结束 */ }
          try { webAudioSource.disconnect(); } catch (e) { /* ignore */ }
        } catch (cleanupErr) {
          console.warn('[TTS队列] 清理 Web Audio Source 失败:', cleanupErr);
        }
        webAudioSource = null;
      }
      if (callPlayer) {
        callPlayer.onended = null;
        callPlayer.onerror = null;
        try {
          callPlayer.pause();
        } catch (error) {
          console.warn('停止通话TTS播放器失败:', error);
        }
        callPlayer.removeAttribute('src');
        callPlayer.src = '';
        delete callPlayer.dataset.currentText;
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }

      const finishReason = failed ? (errorType || 'error') : '';
      if (ttsQueue.length === 0 && finishCallTtsQueueBySource(source, finishReason)) {
        return;
      }
      processNextTts();
    }
  }

  // --- 视频/语音通话专用 TTS 播放函数（队列版） ---
  // P6: 视频通话 AI 改为纯对白输出, 不再有旁白, 删除 videoCall 路径的 ttsDialogueOnly 过滤
  //   - source === 'videoCall': 走"去除括号及括号内"清洗 (保留旧兼容), 不再读 chat.videoOptimization.ttsDialogueOnly
  //   - source === 'voiceCall': 走纯 trim 路径 (旧行为, 不读 ttsDialogueOnly)
  function playVideoCallPureTTS(text, voiceId, options = {}) {
    const source = options && options.source ? options.source : '';
    const isVoiceCallTts = source === 'voiceCall';
    // 2026-09-29: 新增 languageBoost 透传 (用户选的具体语言, 空/undefined = 自动识别)
    const requestedLanguageBoost = options && options.languageBoost ? options.languageBoost : '';

    let cleanText = '';
    if (isVoiceCallTts) {
      cleanText = String(text || '').trim();
    } else {
      // 视频通话: AI 返回纯对白, 仅做"去除括号及括号内"清洗 (沿用旧清洗逻辑, 防止残留旁白包裹)
      // P6: 删除 ttsDialogueOnly / extractDialogueOnly 过滤 (旧数据残留也不影响 — 视频通话统一纯对白)
      cleanText = String(text || '').replace(/(\[.*?\]|\(.*?\)|（.*?）|【.*?】)/g, '').trim();
    }

    if (!cleanText) {
      if (isVoiceCallTts) {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
          textLength: 0,
          skipReason: 'emptyDisplayText',
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(voiceId)
        });
      }
      return false;
    }

    // 2. 检查全局 TTS 开关与配置
    if (!window.TTSService || !window.TTSService.isEnabled() || !voiceId) {
      const errorType = !voiceId ? 'voice_id_missing' : 'tts_unavailable';
      logCallTtsDiag('CALL_TTS_START', source, cleanText);
      logCallTtsDiag('CALL_TTS_ERROR', source, cleanText, errorType);
      logCallTtsDiag('CALL_TTS_FALLBACK_SKIP', source, cleanText, errorType);
      if (isVoiceCallTts) {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
          textLength: cleanText.length,
          skipReason: errorType,
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(voiceId)
        });
      }
      return false;
    }

    // 3. 推入队列，串行处理
    //    2026-09-29: 用清洗后的 cleanText 判定语种, 并随任务一起入队,
    //    这样 processNextTts 才能把它送到 TTSService。
    ttsQueue.push({
      text: cleanText,
      voiceId,
      source,
      languageBoost: resolveTtsLanguageBoost(cleanText, requestedLanguageBoost)
    });

    if (isVoiceCallTts) {
      logVoiceCallTtsDiag('VOICE_CALL_TTS_ENQUEUE_SUCCESS', {
        textLength: cleanText.length,
        queueLength: ttsQueue.length,
        hasVoiceId: Boolean(voiceId)
      });
    }

    if (!isTtsPlaying) {
      processNextTts();
    }

    return true;
  }
  // 播放真实录音
  async function playRealAudio(bodyElement) {
    const audioData = bodyElement.dataset.audio;
    const audioMime = bodyElement.dataset.audioMime || 'audio/webm';

    if (!audioData) {
      console.error('没有找到音频数据');
      return;
    }

    try {
      const audioDataDecoded = decodeURIComponent(audioData);

      // 创建音频播放器
      let realAudioPlayer = document.getElementById('real-audio-player');
      if (!realAudioPlayer) {
        realAudioPlayer = document.createElement('audio');
        realAudioPlayer.id = 'real-audio-player';
        realAudioPlayer.style.display = 'none';
        document.body.appendChild(realAudioPlayer);
      }

      // 如果正在播放同一条语音，暂停
      if (!realAudioPlayer.paused && realAudioPlayer.dataset.currentAudio === audioData) {
        realAudioPlayer.pause();
        return;
      }

      // 停止之前的播放
      realAudioPlayer.pause();

      // 设置新的音频源
      realAudioPlayer.src = audioDataDecoded;
      realAudioPlayer.dataset.currentAudio = audioData;

      // 播放音频
      await realAudioPlayer.play();
      console.log('播放真实录音');

    } catch (error) {
      console.error('播放录音失败:', error);
      alert('播放录音失败');
    }
  }

  async function playTtsAudio(bodyElement) {
    const bubble = bodyElement.closest('.message-bubble');
    const messageKey = (state.activeChatId || '') + '_' + (bubble?.dataset?.timestamp || '');

    let text = decodeURIComponent(bodyElement.dataset.text);

    // 1. 获取 Voice ID
    let voiceId = bodyElement.dataset.voiceId;
    // 2026-09-29: 默认改为空串 (而不是 'zh-CN')。
    //   空串 = 未指定 = 交给 TTSService 按文本自动识别 (假名→Japanese / 汉字→Chinese)。
    //   旧值 'zh-CN' 会让"自动识别 (Auto)"这个选项形同虚设 ——
    //   UI 里 Auto 的 value 是空串, 旧代码用 truthy 判断, 空串被吞掉, ttsLanguage
    //   永远停在 'zh-CN', 最终 language_boost 恒为 "Chinese", 日语必被念成中文。
    let ttsLanguage = '';

    if (state.activeChatId && state.chats[state.activeChatId]) {
      const chat = state.chats[state.activeChatId];
      if (!chat.isGroup && chat.settings.enableTts !== false) {
        // 优先使用标签上的ID，如果没有则用设置里的
        if (!voiceId) voiceId = chat.settings.minimaxVoiceId;
        // 2026-09-29: 必须判 undefined 而不是 truthy, 否则 "自动识别" (value="") 会被忽略
        if (chat.settings.ttsLanguage !== undefined) ttsLanguage = chat.settings.ttsLanguage;
      }

      // 处理"仅读取对话"功能
      if (chat.videoOptimization && chat.videoOptimization.ttsDialogueOnly) {
        // extractDialogueOnly 会返回引号内容或原文，不会返回空
        text = extractDialogueOnly(text);
        console.log('TTS仅读取对话模式：', text);
      }
    }

    // 2026-09-29: 统一解析最终 language_boost。
    //   必须在上面 ttsDialogueOnly 改写 text 之后算, 否则检测的是旧文本。
    //   空串 / 'auto' → 按文本自动识别; 具体语言 → 尊重用户选择。
    const boostValue = resolveTtsLanguageBoost(text, TTS_LANGUAGE_MAP[ttsLanguage] || 'auto');

    if (!voiceId) {
      alert("错误：无法获取 Voice ID。请检查角色设置。");
      return;
    }

    const button = bodyElement.querySelector('.voice-play-btn');
    const spinner = bodyElement.querySelector('.loading-spinner');
    const ttsPlayer = document.getElementById('tts-audio-player');

    // 同一条消息点第二次：正在播放则暂停，正在请求则取消
    if (messageKey && messageKey === currentTtsMessageKey) {
      if (!ttsPlayer.paused && ttsPlayer.dataset.currentMessageKey === messageKey) {
        ttsPlayer.pause();
        currentTtsMessageKey = '';
        if (button) button.textContent = '▶';
        return;
      }
      if (currentTtsLoading && ttsAbortController) {
        ttsAbortController.abort();
        currentTtsMessageKey = '';
        currentTtsLoading = false;
        spinner.style.display = 'none';
        if (button) button.style.display = 'flex';
        return;
      }
    }

    ttsPlayer.pause();
    document.querySelectorAll('.voice-play-btn').forEach(btn => btn.textContent = '▶');

    // 2. 检查缓存 (Key加入语言区分，防止切换方言后读到旧缓存)
    //    2026-09-29: 用最终生效的 boostValue 而不是 ttsLanguage ——
    //    自动识别模式下 ttsLanguage 是空串, 用它做 key 会让不同语言的同文本互相串味。
    const cacheKey = `tts_v2_${voiceId}_${boostValue}_${text}`;
    let cachedAudio = state.ttsCache.get(cacheKey);
    if (cachedAudio) {
      console.log("从缓存播放 TTS...");
      currentTtsMessageKey = messageKey;
      await playAudioFromData(cachedAudio.url, cachedAudio.type, text, voiceId, bodyElement, messageKey, () => { currentTtsMessageKey = ''; });
      return;
    }

    currentTtsMessageKey = messageKey;
    currentTtsLoading = true;
    ttsAbortController = new AbortController();
    const signal = ttsAbortController.signal;

    console.log(`请求 TTS... VoiceID: ${voiceId}, Language: ${ttsLanguage || 'auto'}, Boost: ${boostValue}`);
    if (button) button.style.display = 'none';
    spinner.style.display = 'block';

    // 2. 发送请求；MiniMax 适配器会使用 language_boost，其他平台会自动忽略
    //    (2026-09-29: boostValue 已在上面统一解析, 这里直接用;
    //     languageMap 已提到模块级 TTS_LANGUAGE_MAP, 供聊天与通话两条路径共用)
    try {
      if (!window.TTSService || !window.TTSService.isEnabled()) {
        throw new Error('语音播报未启用或 TTS 服务未加载');
      }

      const result = await window.TTSService.synthesize({
        text,
        voice: voiceId,
        signal,
        languageBoost: boostValue
      });

      if (!result || !result.blob) {
        throw new Error('TTS 未返回音频数据');
      }

      const audioBlob = result.blob;
      const audioType = result.mimeType || audioBlob.type || 'audio/mpeg';
      const audioUrl = URL.createObjectURL(audioBlob);

      await playAudioFromData(audioUrl, audioType, text, voiceId, bodyElement, messageKey, () => { currentTtsMessageKey = ''; });

      // 写入缓存
      const reader = new FileReader();
      reader.onloadend = function () {
        state.ttsCache.set(cacheKey, {
          url: reader.result,
          type: audioType
        });
      }
      reader.readAsDataURL(audioBlob);

    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error("TTS 生成失败:", error);
      await showCustomAlert("语音生成失败", `错误: ${error.message}`);
    } finally {
      currentTtsLoading = false;
      ttsAbortController = null;
      spinner.style.display = 'none';
      if (button) button.style.display = 'flex';
    }
  }


  function playAudioFromData(audioSrc, audioType, text, voiceId, bodyElement, messageKey, onEndedCallback) {
    return new Promise((resolve, reject) => {
      const ttsPlayer = document.getElementById('tts-audio-player');

      ttsPlayer.src = audioSrc;
      ttsPlayer.type = audioType;
      ttsPlayer.dataset.currentText = text;
      ttsPlayer.dataset.currentVoiceId = voiceId;
      if (messageKey) ttsPlayer.dataset.currentMessageKey = messageKey;

      const playPromise = ttsPlayer.play();

      if (playPromise !== undefined) {
        playPromise.then(() => {
          const button = bodyElement.querySelector('.voice-play-btn');
          if (button) button.textContent = '❚❚';


          resolve();
        }).catch(error => {
          console.error("音频播放失败:", error);
          reject(error);
        });
      }

      ttsPlayer.onended = () => {
        const button = bodyElement.querySelector('.voice-play-btn');
        if (button) button.textContent = '▶';
        if (typeof onEndedCallback === 'function') onEndedCallback();
      };
      ttsPlayer.onpause = () => {
        const button = bodyElement.querySelector('.voice-play-btn');
        if (button) button.textContent = '▶';
      };
    });
  }




  function toggleVoiceTranscript(bodyElement) {
    const bubble = bodyElement.closest('.message-bubble');
    if (!bubble) return;

    const transcriptEl = bubble.querySelector('.voice-transcript');
    const text = decodeURIComponent(bodyElement.dataset.text);

    if (transcriptEl.style.display === 'block') {

      transcriptEl.style.display = 'none';
    } else {
      // 【双语模式】检查是否有原始双语内容
      const originalContent = bodyElement.dataset.originalContent;
      
      if (originalContent) {
        // 有双语内容：显示外语 + 中文翻译
        const decodedOriginal = decodeURIComponent(originalContent);
        
        // 提取外语部分（去掉〖〗中的内容）
        const foreignText = decodedOriginal.replace(/[〖【][^〗】]*[〗】]/g, '').trim();
        
        // 提取中文翻译
        const translationMatches = decodedOriginal.match(/[〖【]\s*([^〗】]+?)\s*[〗】]/g);
        let translation = '';
        if (translationMatches && translationMatches.length > 0) {
          translation = translationMatches
            .map(m => m.replace(/[〖【〗】]/g, '').trim())
            .filter(t => t.length > 0)
            .join(' ');
        }
        
        // 构建显示内容：外语 + 换行 + 中文翻译
        if (translation) {
          transcriptEl.innerHTML = `
            <div style="margin-bottom: 6px;">${foreignText}</div>
            <div style="color: var(--text-secondary); font-size: 0.92em; opacity: 0.85; border-top: 1px solid rgba(0,0,0,0.06); padding-top: 6px; margin-top: 6px;">${translation}</div>
          `;
        } else {
          // 没有找到翻译，只显示外语
          transcriptEl.textContent = foreignText;
        }
      } else {
        // 没有双语内容，正常显示
        transcriptEl.textContent = text;
      }
      
      transcriptEl.style.display = 'block';
    }
  }

  // 双语翻译切换函数
  function toggleBilingualTranslation(bubble, chat) {
    const originalContent = bubble.dataset.originalContent;
    if (!originalContent) return; // 没有双语内容
    
    const isShowingTranslation = bubble.dataset.showingTranslation === 'true';
    const contentEl = bubble.querySelector('.content');
    const displayMode = chat.settings.bilingualDisplayMode || 'outside';
    
    // 检查是否是语音消息
    const isVoiceMessage = bubble.classList.contains('is-voice-message');
    
    if (isShowingTranslation) {
      // 隐藏翻译
      if (isVoiceMessage) {
        // 语音消息：在 voice-transcript 区域隐藏翻译
        const transcriptEl = bubble.querySelector('.voice-transcript');
        if (transcriptEl) {
          transcriptEl.textContent = '';
          transcriptEl.style.display = 'none';
        }
      } else {
        // 文本消息：原有逻辑
        if (displayMode === 'inside') {
          // 内部模式：恢复只显示外语
          const englishOnly = originalContent.replace(/[〖【][^〗】]*[〗】]/g, '');
          contentEl.innerHTML = parseMarkdown(englishOnly).replace(/\n/g, '<br>');
        } else {
          // 外部模式：移除翻译元素（从wrapper中移除）
          const contentRow = bubble.closest('.message-content-row');
          const wrapper = contentRow ? contentRow.parentElement : null;
          if (wrapper) {
            const transEl = wrapper.querySelector('.translation-bubble');
            if (transEl) transEl.remove();
          }
        }
      }
      bubble.dataset.showingTranslation = 'false';
    } else {
      // 显示翻译
      const translation = extractBilingualTranslation(originalContent, bubble);
      if (!translation) {
        console.warn('[双语模式] 未找到翻译内容，AI可能未按格式输出');
        return;
      }
      
      if (isVoiceMessage) {
        // 语音消息：在 voice-transcript 区域显示翻译
        const transcriptEl = bubble.querySelector('.voice-transcript');
        if (transcriptEl) {
          transcriptEl.textContent = `翻译：${translation}`;
          transcriptEl.style.display = 'block';
          transcriptEl.style.marginTop = '8px';
          transcriptEl.style.fontSize = '13px';
          transcriptEl.style.color = 'var(--text-secondary)';
          transcriptEl.style.opacity = '0.85';
        }
      } else {
        // 文本消息：原有逻辑
        if (displayMode === 'inside') {
          // 内部模式：外语 + 翻译（用换行分隔）
          const englishOnly = originalContent.replace(/[〖【][^〗】]*[〗】]/g, '');
          contentEl.innerHTML = parseMarkdown(englishOnly).replace(/\n/g, '<br>') + 
            '<br><span style="color: var(--text-secondary); font-size: 0.95em;">' + 
            translation + '</span>';
        } else {
          // 外部模式：在wrapper中添加翻译气泡（作为contentRow的兄弟元素）
          const contentRow = bubble.closest('.message-content-row');
          const wrapper = contentRow ? contentRow.parentElement : null;
          if (wrapper) {
            const transEl = document.createElement('div');
            transEl.className = 'translation-bubble';
            transEl.textContent = translation;
            transEl.dataset.linkedBubble = bubble.dataset.timestamp || Date.now();
            
            // 添加到wrapper的末尾（contentRow下方）
            wrapper.appendChild(transEl);
          }
        }
      }
      bubble.dataset.showingTranslation = 'true';
    }
  }

  // 提取双语翻译内容
  function extractBilingualTranslation(content, bubble) {
    // 检查缓存
    if (bubble.dataset.cachedTranslation) {
      return bubble.dataset.cachedTranslation;
    }
    
    // 【调试日志】
    console.log('[双语调试] 原始内容:', content);
    console.log('[双语调试] 内容长度:', content.length);
    console.log('[双语调试] 包含〖:', content.includes('〖'));
    console.log('[双语调试] 包含〗:', content.includes('〗'));
    
    // 【预处理】清理可能的隐藏字符和统一符号
    let cleanedContent = content
      // 清理零宽字符
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      // 统一全角括号为〖〗
      .replace(/【/g, '〖')
      .replace(/】/g, '〗')
      // 清理可能的多余空格
      .trim();
    
    console.log('[双语调试] 清理后内容:', cleanedContent);
    
    // 【增强正则】支持多种格式
    // 1. 标准格式：〖中文〗
    // 2. 带空格：〖 中文 〗
    // 3. 换行格式：\n〖中文〗
    const matches = cleanedContent.match(/[〖【]\s*([^〗】]+?)\s*[〗】]/g);
    
    console.log('[双语调试] 匹配结果:', matches);
    
    if (!matches || matches.length === 0) {
      console.warn('[双语调试] 未匹配到翻译内容！');
      return null;
    }
    
    // 提取括号内的内容
    const translation = matches
      .map(m => m.replace(/[〖【〗】]/g, '').trim())
      .filter(t => t.length > 0)
      .join(' ');
    
    console.log('[双语调试] 提取的翻译:', translation);
    
    // 缓存结果
    bubble.dataset.cachedTranslation = translation;
    
    return translation;
  }

  // ========== 全局暴露 ==========
  window.playTtsAudio = playTtsAudio;
  window.playRealAudio = playRealAudio;
  window.playSilentAudio = playSilentAudio;
  window.getCallTtsQueueLength = () => ttsQueue.length;
  window.isCallTtsPlaying = () => isTtsPlaying;
