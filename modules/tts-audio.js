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

  // ============================================================
  // 音色选择收口 (2026-10-01)
  // ------------------------------------------------------------
  // 三条链路 (聊天 / 语音通话 / 视频通话) 全部走这里, 保证同一个 speechText
  // 永远解析出同一个 voice_id。语言判定本体在 src/lib/tts/index.js 的
  // resolveVoiceId, 本文件只负责"把当前会话的三个音色配置喂进去"。
  // ============================================================

  /**
   * 从会话设置里取出本角色的三个音色配置。
   * zh = 中文/默认音色 (兼容旧配置 chat.settings.minimaxVoiceId)
   * @param {object} chat
   * @param {string} [fallbackZh] 气泡 data-voice-id 上的值, 供 settings 为空时兜底
   */
  function getChatVoiceConfig(chat, fallbackZh) {
    const settings = (chat && chat.settings) || {};
    return {
      zh: settings.minimaxVoiceId || fallbackZh || '',
      ja: settings.minimaxVoiceIdJa || '',
      en: settings.minimaxVoiceIdEn || ''
    };
  }

  /**
   * 解析本次请求要用的 voice_id。纯函数, 不写任何全局/设置。
   * TTSService 未就绪时退回传入的 zh —— 保持改造前行为, 不阻断 TTS。
   */
  function resolveTtsVoiceId(text, voices) {
    if (window.TTSService && typeof window.TTSService.resolveVoiceId === 'function') {
      try {
        return window.TTSService.resolveVoiceId(text, voices);
      } catch (e) {
        console.warn('[TTS] resolveVoiceId 异常, 退回中文音色:', e);
      }
    }
    return (voices && voices.zh) || '';
  }

  /**
   * TTS 缓存 key。规则与改造前逐字符一致 (v2 无 emotion / v3 带 emotion),
   * 抽成独立函数只是为了让"中日同文本不能共用缓存"这条能被测试直接覆盖。
   * 唯一的外部变化: voiceId 由调用方传入【已解析好的】音色, 而不是旧的单一 voice。
   */
  function buildTtsCacheKey({ voiceId, boostValue, emotion, text }) {
    return emotion
      ? `tts_v3_${voiceId}_${boostValue}_${emotion}_${text}`
      : `tts_v2_${voiceId}_${boostValue}_${text}`;
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
    // 2026-10-09: 空间音频播放也属于"聊天语音条", 必须一起停,
    //   否则切走聊天后声音还在响。注意不要动 stopTtsQueue —— 那是通话队列。
    stopSpatialTts();
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

  // ============================================================
  // TTS 表达层接线 (2026-09-30 第一阶段)
  // ------------------------------------------------------------
  // 业务规则全部集中在 modules/tts-expression.js, 本文件只负责接线。
  // 解析器若未加载 (加载顺序/缓存问题), 退回改造前的行为, 绝不阻断 TTS。
  // ============================================================
  function parseTtsExpressionSafe(rawText, filterBrackets) {
    const fallback = {
      speechText: String(rawText == null ? '' : rawText).trim(),
      emotion: null,
      hasTtsDirective: false,
      strippedTags: []
    };
    try {
      if (window.TTSExpression && typeof window.TTSExpression.parseTtsExpression === 'function') {
        return window.TTSExpression.parseTtsExpression(rawText, { filterBrackets: !!filterBrackets });
      }
    } catch (e) {
      console.warn('[TTS] 表达层解析失败, 退回原始文本:', e);
    }
    return fallback;
  }

  // ============================================================
  // TTS 控制标记的显示层过滤 (第三 / 四阶段)
  // ------------------------------------------------------------
  // <#x#> 停顿标记和 (chuckle) 语气声都是纯 TTS 控制标记: 漏给用户看到
  // 一堆 "<#0.4#>" / "(sighs)" 很粗糙, 但它们【要照常发声】。
  // 所以只做【显示层】过滤: 原文 / data-text / callHistory 一律不动,
  // TTS 仍拿到带停顿和语气声的 speechText。
  // ⚠️ 只有渲染前能调这个, 拿去发 MiniMax 会让语气声失效。
  // ============================================================
  function stripTtsTagsSafe(rawText) {
    const raw = String(rawText == null ? '' : rawText);
    try {
      if (window.TTSExpression && typeof window.TTSExpression.stripTtsTagsForDisplay === 'function') {
        return window.TTSExpression.stripTtsTagsForDisplay(raw);
      }
    } catch (e) {
      console.warn('[TTS] 控制标记显示过滤失败, 退回原文:', e);
    }
    return raw.trim();
  }

  // 语音通话 / 通话记录弹窗这些文件也要用同一套过滤, 它们不认识
  // TTSExpression 内部细节, 这里给一个带兜底的全局入口。
  // 解析器没加载时原样返回, 宁可多显示几个标签, 也不能让界面空掉。
  window.stripTtsTagsForDisplay = stripTtsTagsSafe;

  // 2026-09-29: 新增 languageBoost 形参。
  //   旧版只传 text/voice/signal, 请求体里根本没有 language_boost 字段,
  //   MiniMax 按 null 处理 → 模型自行猜语种 → 日语音色念中文 (即"日语音色念出中文"的直接原因)。
  async function synthesizeCallTtsWithTimeout(text, voiceId, source, languageBoost, emotion) {
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
        languageBoost,
        // 2026-09-30: 情绪透传。为空时 index.js 的 normalizeEmotion 返回 undefined,
        // adapter 不写入请求体 —— 与改造前完全一致。
        emotion
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
    const { text, voiceId, source, languageBoost, emotion } = ttsQueue.shift();
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

      const result = await synthesizeCallTtsWithTimeout(text, voiceId, source, languageBoost, emotion);
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
    // 2026-10-01 起通话链路也先过 TTS_LANGUAGE_MAP, 与聊天链路口径一致。
    //   修正前的行为: video-voice-call.js 传的是 UI 的 locale code ('ja-JP'),
    //   resolveLanguageBoost 对非空值原样返回, 于是发给 MiniMax 的 language_boost
    //   就是 "ja-JP" 而不是 "Japanese" —— 用户在设置里选了日语, 通话实际没生效。
    //   调用方仍然传 locale code, 这里只补映射, 不动聊天侧 (tts-audio.js:715) 的逻辑。
    const requestedLanguage = options && options.languageBoost ? options.languageBoost : '';
    const requestedLanguageBoost = TTS_LANGUAGE_MAP[requestedLanguage] || 'auto';

    // 2026-09-30: 括号清洗改走 tts-expression.js 的白名单策略。
    //   改造前 videoCall 用一条 /(\[.*?\]|\(.*?\)|（.*?）|【.*?】)/g 把所有括号连内容一起删光,
    //   连 MiniMax 2.8-HD 官方的 (laughs)/(chuckle) 等 19 个 interjection 也一起误删,
    //   标签根本活不到 API。
    //   现在: 半角括号逐个判定 —— 命中官方白名单原样保留, 其余仍然删除。
    //   其余三种括号 (方头/全角圆/方头括号) 维持原删除逻辑, 不放宽也不收紧。
    //   ⚠️ filterBrackets 保持两条链路原有的差异, 本阶段不顺手统一:
    //     videoCall = true  (原本就删括号)
    //     voiceCall = false (原本只 trim, 不动括号)
    const shouldFilterBrackets = !isVoiceCallTts;
    // ⚠️ 唯一剥离点: 标签保留在 AI 原文 / 气泡 / callHistory 里, 只在这里
    //   ——真正要把文本发给 MiniMax 的那一刻——临时生成 speechText。
    const parsed = parseTtsExpressionSafe(text, shouldFilterBrackets);
    const cleanText = parsed.speechText;
    const emotion = parsed.emotion || '';

    if (parsed.hasTtsDirective) {
      console.log('[TTS队列] 解析到语音控制标签:', parsed.strippedTags, '→ emotion:', emotion);
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

    // 2. 按 speechText 解析本次请求要用的音色 (2026-10-01)
    //    日语/英文音色可配, 没配就回落中文。调用方没传 options.voices 时按改造前行为处理:
    //    只有一个 voice, 三种语言都用它 —— 保证旧配置与未升级的调用方完全不受影响。
    const voiceConfig = (options && options.voices)
      ? options.voices
      : { zh: voiceId, ja: '', en: '' };
    const resolvedVoiceId = resolveTtsVoiceId(cleanText, voiceConfig) || '';

    // 3. 检查全局 TTS 开关与配置
    if (!window.TTSService || !window.TTSService.isEnabled() || !resolvedVoiceId) {
      const errorType = !resolvedVoiceId ? 'voice_id_missing' : 'tts_unavailable';
      logCallTtsDiag('CALL_TTS_START', source, cleanText);
      logCallTtsDiag('CALL_TTS_ERROR', source, cleanText, errorType);
      logCallTtsDiag('CALL_TTS_FALLBACK_SKIP', source, cleanText, errorType);
      if (isVoiceCallTts) {
        logVoiceCallTtsDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
          textLength: cleanText.length,
          skipReason: errorType,
          queueLength: ttsQueue.length,
          hasVoiceId: Boolean(resolvedVoiceId)
        });
      }
      return false;
    }

    // 4. 推入队列，串行处理
    //    2026-09-29: 用清洗后的 cleanText 判定语种, 并随任务一起入队,
    //    这样 processNextTts 才能把它送到 TTSService。
    ttsQueue.push({
      text: cleanText,
      // 关键: 入队的是【已按语言解析好的】音色, 队列里不再做任何 voice 决策。
      voiceId: resolvedVoiceId,
      source,
      languageBoost: resolveTtsLanguageBoost(cleanText, requestedLanguageBoost),
      // 2026-09-30: 情绪随任务入队, 空串 = 不传, 保持改造前行为
      emotion
    });

    if (isVoiceCallTts) {
      logVoiceCallTtsDiag('VOICE_CALL_TTS_ENQUEUE_SUCCESS', {
        textLength: cleanText.length,
        queueLength: ttsQueue.length,
        hasVoiceId: Boolean(resolvedVoiceId)
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

  // ============================================================
  // 双耳空间音频 (2026-10-09) —— 只作用于聊天语音条
  // ------------------------------------------------------------
  // 边界 (刻意与通话链路完全隔离):
  //   - 通话队列 processNextTts() 不经过本段任何一行, 视频/语音通话的播放、
  //     队列推进、call-lip-sync 口型分析链一律不受影响。
  //   - 聊天原本是纯 <audio>, 空间音频才引入 Web Audio; 引擎建/借的节点都是
  //     本模块自己 create 的, 结束即 disconnect, 从不碰别人的 ctx。
  //   - 任何一步失败一律回退 <audio> 原路径, 绝不出现"既没空间音频也没声音"。
  // ============================================================
  var spatialTtsHandle = null;      // TtsSpatialAudio.play() 返回的句柄
  var spatialTtsMessageKey = '';    // 当前空间播放对应的消息 key

  function spatialAvailable() {
    return typeof window.TtsSpatialAudio !== 'undefined'
      && typeof window.TtsSpatialAudio.isEnabled === 'function'
      && typeof window.TtsSpatialAudio.play === 'function'
      && window.TtsSpatialAudio.isSupported()
      && window.TtsSpatialAudio.isEnabled();
  }

  function stopSpatialTts() {
    if (typeof window.TtsSpatialAudio !== 'undefined'
      && typeof window.TtsSpatialAudio.stop === 'function') {
      try { window.TtsSpatialAudio.stop(); } catch (e) { /* ignore */ }
    }
    spatialTtsHandle = null;
    spatialTtsMessageKey = '';
  }

  /** 把 dataURL / blobURL / Blob 统一变成 Blob。dataURL 手工拆, 不依赖 fetch 对 data: 的支持。 */
  function sourceToBlob(src) {
    if (src instanceof Blob) return Promise.resolve(src);
    var s = String(src == null ? '' : src);
    if (s.slice(0, 5) === 'data:') {
      var comma = s.indexOf(',');
      if (comma < 0) return Promise.reject(new Error('spatial_bad_data_url'));
      var head = s.slice(5, comma);
      var isBase64 = /;base64/i.test(head);
      var mime = head.replace(/;base64/i, '').trim() || 'application/octet-stream';
      var body = s.slice(comma + 1);
      try {
        if (isBase64) {
          var bin = atob(body);
          var buf = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          return Promise.resolve(new Blob([buf], { type: mime }));
        }
        return Promise.resolve(new Blob([decodeURIComponent(body)], { type: mime }));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return fetch(s).then(function (res) {
      if (!res.ok) throw new Error('spatial_src_http_' + res.status);
      return res.blob();
    });
  }

  /**
   * 空间音频播放。resolve 语义与 <audio> 分支一致 —— "已经开始放" 就 resolve,
   * 播完走 onended, 这样上层的 spinner/按钮/缓存写入时序完全不变。
   */
  function playAudioSpatially(audioSrc, bodyElement, messageKey, onEndedCallback, sourceBlob) {
    var button = bodyElement.querySelector('.voice-play-btn');
    var settings = window.TtsSpatialAudio.getSettings();

    return sourceToBlob(sourceBlob || audioSrc)
      .then(function (blob) {
        return window.TtsSpatialAudio.play({
          blob: blob,
          azimuthDeg: settings.azimuthDeg,
          distanceM: settings.distanceM,
          // 2026-10-10: 动态轨迹。'static' 时引擎走原来的单卷积路径,
          //   行为与改造前逐字一致; 其余值才启用 A/B 双卷积交叉淡化。
          trajectory: settings.trajectory || 'static',
          onended: function () {
            if (button) button.textContent = '▶';
            if (typeof onEndedCallback === 'function') onEndedCallback();
          }
        });
      })
      .then(function (handle) {
        spatialTtsHandle = handle;
        spatialTtsMessageKey = messageKey || '';
        if (button) button.textContent = '❚❚';
        return handle;
      });
  }

  async function playTtsAudio(bodyElement) {
    // ⚠️ 必须放在函数最开头、同步执行: iOS/Safari 要求 AudioContext 在 user gesture
    //   内创建并 resume。后面要 await 网络 + decodeAudioData, 等那时手势早就过了,
    //   ctx 会被系统挂起 -> 有缓存有接口但就是没声音 (tts-audio.js 通话链路的同款教训)。
    //   prepare() 本身不吃 await, 只是建 ctx 并发起 resume。
    var spatialOn = spatialAvailable();
    if (spatialOn) {
      try { window.TtsSpatialAudio.prepare(); } catch (e) { /* 后续 play() 会兜底 */ }
    }

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
    // 2026-10-01: 本次请求的三个音色配置 (zh = 中文/默认, ja/en 可选)
    let voiceConfig = { zh: voiceId || '', ja: '', en: '' };

    if (state.activeChatId && state.chats[state.activeChatId]) {
      const chat = state.chats[state.activeChatId];
      if (!chat.isGroup && chat.settings.enableTts !== false) {
        // 优先使用标签上的ID，如果没有则用设置里的
        if (!voiceId) voiceId = chat.settings.minimaxVoiceId;
        // 2026-09-29: 必须判 undefined 而不是 truthy, 否则 "自动识别" (value="") 会被忽略
        if (chat.settings.ttsLanguage !== undefined) ttsLanguage = chat.settings.ttsLanguage;
        voiceConfig = getChatVoiceConfig(chat, voiceId);
      }

      // 处理"仅读取对话"功能
      if (chat.videoOptimization && chat.videoOptimization.ttsDialogueOnly) {
        // extractDialogueOnly 会返回引号内容或原文，不会返回空
        text = extractDialogueOnly(text);
        console.log('TTS仅读取对话模式：', text);
      }
    }

    // 2026-09-30: 接 TTS 表达层。
    //   聊天链路原本【没有任何括号清洗】, 所以 filterBrackets=false —— 维持现状,
    //   本阶段不借机给聊天加清洗 (那属于行为变更, 不是本阶段范围)。
    //   聊天要拿到的是: 剥掉 [[语音:x]] 标签 + 抽出 emotion。
    const parsed = parseTtsExpressionSafe(text, false);
    text = parsed.speechText;
    const emotion = parsed.emotion || '';
    if (parsed.hasTtsDirective) {
      console.log('[聊天TTS] 解析到语音控制标签:', parsed.strippedTags, '→ emotion:', emotion);
    }

    // 2026-09-29: 统一解析最终 language_boost。
    //   必须在上面 ttsDialogueOnly 改写 text 之后算, 否则检测的是旧文本。
    //   空串 / 'auto' → 按文本自动识别; 具体语言 → 尊重用户选择。
    const boostValue = resolveTtsLanguageBoost(text, TTS_LANGUAGE_MAP[ttsLanguage] || 'auto');

    // 2026-10-01: 按 speechText 解析本次请求要用的音色。
    //   与 boostValue 用的是同一份 text, 所以"念哪种语言"和"用哪个音色"必然一致。
    const resolvedVoiceId = resolveTtsVoiceId(text, voiceConfig) || '';

    if (!resolvedVoiceId) {
      alert("错误：无法获取 Voice ID。请检查角色设置。");
      return;
    }

    const button = bodyElement.querySelector('.voice-play-btn');
    const spinner = bodyElement.querySelector('.loading-spinner');
    const ttsPlayer = document.getElementById('tts-audio-player');

    // 同一条消息点第二次：正在播放则暂停，正在请求则取消
    if (messageKey && messageKey === currentTtsMessageKey) {
      // 空间音频分支: <audio> 元素全程 paused, 上面的判断对它恒不成立,
      // 所以必须单独判。语义与 <audio> 分支保持一致 —— 再点一次是"停止",
      // 而不是"继续"; 第三次点击重新走完整路径(命中缓存, 瞬间重播)。
      if (spatialOn && messageKey === spatialTtsMessageKey && spatialTtsHandle) {
        stopSpatialTts();
        currentTtsMessageKey = '';
        if (button) button.textContent = '▶';
        return;
      }
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
    //    2026-09-30: emotion 存在时也进 key ——
    //    否则"你好+happy"先缓存, 之后"你好+sad"会直接命中 happy 的音频, 情绪参数完全失效。
    //    emotion 为空时 key 与改造前逐字符一致, 不影响任何既有缓存条目。
    //    2026-10-01: 音色也进 key, 且用的是【按语言解析后】的 resolvedVoiceId。
    //    这是中日缓存隔离的唯一保证 —— 若这里仍用旧的单一 voiceId, "こんにちは"
    //    的日语音色请求会去命中中文音色缓存, 表现为"配了日语音色却还是中文嗓子"。
    const cacheKey = buildTtsCacheKey({
      voiceId: resolvedVoiceId,
      boostValue,
      emotion,
      text
    });
    let cachedAudio = state.ttsCache.get(cacheKey);
    if (cachedAudio) {
      console.log("从缓存播放 TTS...");
      currentTtsMessageKey = messageKey;
      await playAudioFromData(cachedAudio.url, cachedAudio.type, text, resolvedVoiceId, bodyElement, messageKey, () => { currentTtsMessageKey = ''; });
      return;
    }

    currentTtsMessageKey = messageKey;
    currentTtsLoading = true;
    ttsAbortController = new AbortController();
    const signal = ttsAbortController.signal;

    console.log(`请求 TTS... VoiceID: ${resolvedVoiceId}, Language: ${ttsLanguage || 'auto'}, Boost: ${boostValue}`);
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
        // 与 cache key 用的是同一个变量, 不存在"缓存算一套 / 请求发另一套"
        voice: resolvedVoiceId,
        signal,
        languageBoost: boostValue,
        // 2026-09-30: 情绪透传。为空则不进请求体, 与改造前完全一致。
        emotion
      });

      if (!result || !result.blob) {
        throw new Error('TTS 未返回音频数据');
      }

      const audioBlob = result.blob;
      const audioType = result.mimeType || audioBlob.type || 'audio/mpeg';
      const audioUrl = URL.createObjectURL(audioBlob);

      // 2026-10-09: 末尾多传 audioBlob —— 空间音频分支直接吃 Blob,
      //   不用再把 blobURL fetch 回来一遍。走 <audio> 分支时这个参数被忽略。
      await playAudioFromData(audioUrl, audioType, text, resolvedVoiceId, bodyElement, messageKey, () => { currentTtsMessageKey = ''; }, audioBlob);

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


  /**
   * 播放分发器 (2026-10-09)。
   * 开关关闭 → 原样走 <audio>; 开关打开 → 先试空间音频, 任何失败都落回 <audio>。
   * 两边的 resolve 语义都是"已开始播放", onEnded 语义都是"播完了", 上层无感。
   */
  function playAudioFromData(audioSrc, audioType, text, voiceId, bodyElement, messageKey, onEndedCallback, sourceBlob) {
    if (spatialAvailable()) {
      return playAudioSpatially(audioSrc, bodyElement, messageKey, onEndedCallback, sourceBlob)
        .catch(function (error) {
          console.warn('[聊天TTS] 空间音频不可用, 已回退原播放器:', error);
          if (typeof window.TtsSpatialAudio?._setLastError === 'function') {
            window.TtsSpatialAudio._setLastError(String((error && error.message) || error));
          }
          // 关键: 先把可能已经半启动的空间播放彻底拆干净, 再走 <audio>,
          // 否则会出现两段音频同时响, 或空间音频吞掉却不出声。
          stopSpatialTts();
          return playAudioViaElement(audioSrc, audioType, text, voiceId, bodyElement, messageKey, onEndedCallback);
        });
    }
    return playAudioViaElement(audioSrc, audioType, text, voiceId, bodyElement, messageKey, onEndedCallback);
  }

  function playAudioViaElement(audioSrc, audioType, text, voiceId, bodyElement, messageKey, onEndedCallback) {
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
    // 显示时摘掉 <#x#> 停顿标记和 (chuckle) 语气声
    // (只影响显示, data-text 原文不动, TTS 照常拿到停顿和语气声)
    const text = stripTtsTagsSafe(decodeURIComponent(bodyElement.dataset.text));

    if (transcriptEl.style.display === 'block') {

      transcriptEl.style.display = 'none';
    } else {
      // 【双语模式】检查是否有原始双语内容
      const originalContent = bodyElement.dataset.originalContent;
      
      if (originalContent) {
        // 有双语内容：显示外语 + 中文翻译
        const decodedOriginal = decodeURIComponent(originalContent);
        
        // 提取外语部分（去掉〖〗中的内容）
        // 语气声 / 停顿标记同样要摘掉, 否则双语模式下又露出来了
        const foreignText = stripTtsTagsSafe(
          decodedOriginal.replace(/[〖【][^〗】]*[〗】]/g, '').trim()
        );
        
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
  // 2026-10-01: 暴露纯函数, 供测试直接覆盖"中日同文本不共用缓存"与三链路口径一致。
  window.buildTtsCacheKey = buildTtsCacheKey;
  window.getChatVoiceConfig = getChatVoiceConfig;
  window.resolveTtsVoiceId = resolveTtsVoiceId;
