/* ============================================================================
 * 330 视频通话 · iframe 沙盒适配层
 * ----------------------------------------------------------------------------
 * 沙盒页 video-call-sandbox.html 里，除了宿主专有的那些东西，其余全部加载
 * 【和生产完全同一份】模块文件（live2d-loader.js / video-voice-call.js /
 * call-lip-sync.js / tts-audio.js ...）。所以 video-voice-call.js 一行都不用改。
 *
 * 这个文件只做三件事：
 *   1. 补齐【宿主专有的全局】：state / showScreen / 弹窗 / openChat / 记忆总结 …
 *   2. 抄进来几个纯函数（parseAiResponse / toGeminiRequestData / 清理 MiniMax
 *      回复 / getCustomTime / addLongPressListener / getDisplayNameInGroup）——
 *      它们原本散在 ai-response.js(390KB) / chat-input.js / avatar-library.js /
 *      js/time-system.js 里，那几个文件带着大量宿主 DOM 逻辑，不适合塞进沙盒。
 *      ⚠️ 抄的是纯函数，改上游的话这里要跟着同步（见每个函数上方标注的行号）。
 *   3. 和宿主 postMessage 通信（收 chat 数据、回传落库/记忆/提示）。
 *
 * 为什么这些模块能直接加载：
 *   330 的模块几乎都是【经典脚本 + 顶层 function 声明】，不是 IIFE 也不是 ESM，
 *   所以 tts-audio.js 里的 stopTtsQueue、video-optimization.js 里的 stopCamera
 *   天然就是全局的 —— video-voice-call.js 里那些裸调用直接就能通。
 * ========================================================================== */
(function () {
  'use strict';

  // ==========================================================================
  // 0. 和宿主通信
  // ==========================================================================
  var IN_IFRAME = !!(window.parent && window.parent !== window);
  var HOST_ORIGIN = '*';           // 同源 iframe；真正的来源校验在宿主那边做
  var booted = false;
  var pendingInit = null;

  function post(msg) {
    if (!IN_IFRAME) return;
    try { window.parent.postMessage(msg, HOST_ORIGIN); } catch (e) { /* noop */ }
  }

  function log() {
    try { console.log.apply(console, ['[call-sandbox]'].concat([].slice.call(arguments))); }
    catch (e) { /* noop */ }
  }

  // ==========================================================================
  // 1. window.state —— 沙盒自己的状态容器
  // --------------------------------------------------------------------------
  // 宿主会 postMessage 把真身传过来（chats / apiConfig / globalSettings /
  // character / worldBooks / qzoneSettings），这里先占位，避免模块加载时读到
  // undefined 直接崩。占位值要"形状正确"，不能给 null —— 很多地方是
  // state.globalSettings.xxx 直接取值。
  // ==========================================================================
  window.state = {
    activeChatId: null,
    chats: {},
    apiConfig: {},
    globalSettings: {},
    character: null,
    worldBooks: [],
    qzoneSettings: { nickname: '' },
    messageWindows: {},
    // 视频通话里用不到、但某些路径会摸一下的字段
    userSettings: {},
    backgrounds: [],
    apiSlots: {}
  };

  // ==========================================================================
  // 2. 宿主里的裸全局常量
  // --------------------------------------------------------------------------
  // ⚠️ video-voice-call.js 里是【裸变量引用】（`chat.settings.aiAvatar || defaultAvatar`），
  //    不是 window.xxx。这些变量在宿主里由 modules/utils.js:663-666 的顶层
  //    const 提供，值都是空字符串（原 postimg URL 已失效，故意留空避免蓝粑粑）。
  //    沙盒里必须补上，否则一进呼叫页就 ReferenceError: defaultAvatar is not defined，
  //    流程断在"正在呼叫…"那一步（videoCallState.isAwaitingResponse 卡在 true）。
  // ==========================================================================
  window.defaultAvatar = '';
  window.defaultMyGroupAvatar = '';
  window.defaultGroupAvatar = '';
  window.defaultGroupMemberAvatar = '';

  // ==========================================================================
  // 3. 抄来的纯函数
  // ==========================================================================

  // ---- 来源 modules/utils.js:492 ------------------- 改上游要同步 ----
  function getRandomValue(str) {
    const s = String(str == null ? '' : str);
    if (s.includes(',')) {
      const arr = s.split(',').map(item => item.trim());
      return arr[Math.floor(Math.random() * arr.length)];
    }
    return s;
  }

  // ---- 来源 modules/ai-response.js:1465 ------------ 改上游要同步 ----
  // 解析 AI 返回的 [{type:'text',content:'...'}, ...] 结构。
  // 通话里每轮拿到的就是这种格式，解析失败会整轮哑火。
  function parseAiResponse(content) {
    if (!content) return [{ type: 'text', content: '(AI返回了空内容)' }];

    let trimmedContent = String(content).trim();

    const markdownRegex = /```json\s*([\s\S]*?)\s*```/;
    const markdownMatch = trimmedContent.match(markdownRegex);
    if (markdownMatch && markdownMatch[1]) {
      trimmedContent = markdownMatch[1].trim();
    }

    if (trimmedContent.startsWith('[') && trimmedContent.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmedContent);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) { /* 继续往下试 */ }
    }

    const startIndex = trimmedContent.indexOf('[');
    const lastBraceIndex = trimmedContent.lastIndexOf('}');
    if (startIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > startIndex) {
      const endIndex = trimmedContent.indexOf(']', lastBraceIndex);
      if (endIndex !== -1) {
        const arrayString = trimmedContent.substring(startIndex, endIndex + 1);
        try {
          const parsed = JSON.parse(arrayString);
          if (Array.isArray(parsed)) return parsed;
        } catch (e) { /* 继续往下试 */ }
      }
    }

    const jsonMatches = trimmedContent.match(/{[^{}]*}/g);
    if (jsonMatches) {
      const results = [];
      for (const match of jsonMatches) {
        try { results.push(JSON.parse(match)); } catch (e) { /* 跳过坏片段 */ }
      }
      if (results.length > 0) return results;
    }

    return [{ type: 'text', content: content }];
  }

  // ---- 来源 modules/ai-response.js:1049 ------------ 改上游要同步 ----
  // 把 OpenAI 格式的 messages 转成 Gemini generateContent 的请求体。
  function toGeminiRequestData(model, apiKey, systemInstruction, messagesForDecision) {
    const gs = (window.state && window.state.globalSettings) || {};
    const apiTemperature = gs.apiTemperature || 0.8;
    const apiTopP = gs.apiTopP !== undefined ? gs.apiTopP : 1.0;
    const apiPresencePenalty = gs.apiPresencePenalty !== undefined ? gs.apiPresencePenalty : 0.0;
    const apiFrequencyPenalty = gs.apiFrequencyPenalty !== undefined ? gs.apiFrequencyPenalty : 0.0;
    const roleType = { user: 'user', assistant: 'model', system: 'user' };

    const contents = [
      { role: 'user', parts: [{ text: systemInstruction }] },
      { role: 'model', parts: [{ text: '好的，我明白了。我会严格遵守以上所有规则和设定。' }] },
      ...messagesForDecision.map((item) => {
        const parts = [];
        if (Array.isArray(item.content)) {
          item.content.forEach(part => {
            if (part.type === 'text') {
              parts.push({ text: part.text });
            } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
              const currentImageData = part.image_url.url;
              const base64Data = currentImageData.split(',')[1];
              const mimeTypeMatch = currentImageData.match(/^data:(.*);base64/);
              if (mimeTypeMatch && base64Data) {
                parts.push({ inline_data: { mime_type: mimeTypeMatch[1], data: base64Data } });
              }
            }
          });
        } else {
          parts.push({ text: String(item.content) });
        }
        return { role: roleType[item.role], parts: parts };
      })
    ];

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      data: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': getRandomValue(apiKey)
        },
        body: JSON.stringify({
          contents: contents,
          generationConfig: {
            temperature: apiTemperature,
            topP: apiTopP,
            presencePenalty: apiPresencePenalty,
            frequencyPenalty: apiFrequencyPenalty
          }
        })
      }
    };
  }

  // ---- 来源 modules/ai-response.js:1548 ------------ 改上游要同步 ----
  function isOfficialMinimaxProviderInfo(providerInfo) {
    const info = providerInfo || {};
    const provider = String(info.provider || info.baseURL || info.baseUrl || info.proxyUrl || info.apiUrl || '').toLowerCase();
    return provider.includes('api.minimaxi.com');
  }

  // ---- 来源 modules/ai-response.js:1553 ------------ 改上游要同步 ----
  function logMinimaxCleanDiagnostic(event, providerInfo, beforeLength, afterLength) {
    try {
      window.runtimeDiag?.log?.(event, {
        provider: providerInfo?.provider || providerInfo?.baseURL || providerInfo?.baseUrl || providerInfo?.proxyUrl || '',
        model: providerInfo?.model || '',
        beforeLength: beforeLength,
        afterLength: afterLength
      });
    } catch (error) { /* 日志失败不影响主流程 */ }
  }

  // ---- 来源 modules/ai-response.js:1566 ------------ 改上游要同步 ----
  // 剥掉 M3 / R1 / QwQ 这类模型的思考过程段。
  function stripMinimaxReasoningSections(text) {
    let output = String(text || '');
    output = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
    output = output.replace(/<think>[\s\S]*$/gi, '');

    const finalAnswerMarker = /(?:^|\n)\s*(?:最终回复|最终回答|最终答案|回复|回答|final answer|final response|answer)\s*[:：]\s*/i;
    if (finalAnswerMarker.test(output)) {
      output = output.replace(/^[\s\S]*?(?:最终回复|最终回答|最终答案|回复|回答|final answer|final response|answer)\s*[:：]\s*/i, '');
    }

    const reasoningLabel = String.raw`(?:思考|思维链|推理|内部推理|reasoning|chain\s+of\s+thought|analysis)`;
    output = output.replace(new RegExp(`(^|\\n)\\s*${reasoningLabel}\\s*[:：][\\s\\S]*?(?=\\n\\s*(?:\\[|\\{|最终回复|最终回答|最终答案|回复|回答|final answer|final response|answer)\\s*[:：]?|$)`, 'gi'), '\n');
    output = output.replace(new RegExp(`(^|\\n)\\s*${reasoningLabel}\\s*[:：][^\\n]*(?=\\n|$)`, 'gi'), '\n');

    return output;
  }

  // ---- 来源 modules/ai-response.js:1584 ------------ 改上游要同步 ----
  // ⚠️ <think> 的剥除是【所有 provider 都跑】的，不只是 MiniMax。
  //    这步放在 provider gate 之前是有原因的：非 Minimax 渠道会原样把思考过程
  //    吐到通话气泡里。
  function cleanMinimaxResponseText(rawText, providerInfo = {}, options = {}) {
    const fallbackText = options.fallbackText || '我在。';
    const before = String(rawText || '');
    const beforeLength = before.length;

    let cleaned = before
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/gi, '')
      .trim();

    if (!options.force && !isOfficialMinimaxProviderInfo(providerInfo)) {
      return cleaned;
    }

    cleaned = stripMinimaxReasoningSections(cleaned)
      .replace(/\(\s*Timestamp\s*:\s*\d+\s*\)/gi, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, '')
      .trim();

    logMinimaxCleanDiagnostic('MINIMAX_CLEAN_APPLIED', providerInfo, beforeLength, cleaned.length);

    if (!cleaned) {
      cleaned = fallbackText;
      logMinimaxCleanDiagnostic('MINIMAX_CLEAN_EMPTY_FALLBACK', providerInfo, beforeLength, cleaned.length);
    }

    return cleaned;
  }

  // ---- 来源 modules/chat-input.js:314 -------------- 改上游要同步 ----
  // 原版里有个 isSelectionMode 提前返回，沙盒没有消息多选模式，固定 false。
  function addLongPressListener(element, callback) {
    if (!element) return;
    let pressTimer;
    const startPress = (e) => {
      e.preventDefault();
      pressTimer = window.setTimeout(() => callback(e), 500);
    };
    const cancelPress = () => clearTimeout(pressTimer);
    element.addEventListener('mousedown', startPress);
    element.addEventListener('mouseup', cancelPress);
    element.addEventListener('mouseleave', cancelPress);
    element.addEventListener('touchstart', startPress, { passive: true });
    element.addEventListener('touchend', cancelPress);
    element.addEventListener('touchmove', cancelPress);
  }

  // ---- 来源 modules/avatar-library.js:729 ---------- 改上游要同步 ----
  function getDisplayNameInGroup(groupChat, originalName) {
    if (!groupChat || !groupChat.isGroup || !originalName) return originalName;
    const userOriginalName = (window.state.qzoneSettings && window.state.qzoneSettings.nickname) || '{{user}}';
    if (originalName === userOriginalName) {
      return (groupChat.settings && groupChat.settings.myNickname) || '我';
    }
    const members = groupChat.members || [];
    const member = members.find(m => m.originalName === originalName);
    return member ? member.groupNickname : originalName;
  }

  // ---- 来源 js/time-system.js:156-210 --------------- 改上游要同步 ----
  // 自定义时间全存在 localStorage 里，同源 iframe 直接读同一份，行为跟宿主一致。
  function calcElapsedCustomTime() {
    const year = localStorage.getItem('custom-time-year');
    const month = localStorage.getItem('custom-time-month');
    const day = localStorage.getItem('custom-time-day');
    const hour = localStorage.getItem('custom-time-hour');
    const minute = localStorage.getItem('custom-time-minute');
    const anchor = localStorage.getItem('custom-time-anchor');

    if (year && month && day && hour !== null && minute !== null && anchor) {
      const baseTime = new Date(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(minute)
      ).getTime();
      const elapsed = Date.now() - parseInt(anchor);
      return new Date(baseTime + elapsed);
    }
    return null;
  }

  function getCustomTime() {
    const customTimeEnabled = localStorage.getItem('custom-time-enabled') === 'true';
    if (customTimeEnabled) {
      const d = calcElapsedCustomTime();
      if (d) {
        const y = d.getFullYear();
        const mo = d.getMonth() + 1;
        const da = d.getDate();
        const h = d.getHours();
        const mi = d.getMinutes();
        return {
          enabled: true, year: y, month: mo, day: da, hour: h, minute: mi, date: d,
          formatted: y + '年' + String(mo).padStart(2, '0') + '月' + String(da).padStart(2, '0') + '日 ' + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
        };
      }
    }
    const now = new Date();
    return {
      enabled: false,
      year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
      hour: now.getHours(), minute: now.getMinutes(), date: now,
      formatted: now.toLocaleString('zh-CN')
    };
  }

  // ---- 来源 modules/ui-loaders.js:235 的等价实现 ---- 改上游要同步 ----
  // 原版按日期算出"早上/上午/中午/下午/傍晚/晚上/深夜"，喂给 prompt 做时间感知。
  function getTimeOfDayGreeting(localizedDate) {
    let d = localizedDate;
    if (!(d instanceof Date) || isNaN(d.getTime())) d = new Date();
    const h = d.getHours();
    if (h < 5) return '凌晨';
    if (h < 9) return '早上';
    if (h < 11) return '上午';
    if (h < 13) return '中午';
    if (h < 17) return '下午';
    if (h < 19) return '傍晚';
    if (h < 23) return '晚上';
    return '深夜';
  }

  // ==========================================================================
  // 4. 主 API 代理（从 ai-response.js:27-184 抄的精简版）
  // --------------------------------------------------------------------------
  // 通话发请求时，若 state.globalSettings.mainApiUseProxy === true 会走这个
  // 函数转发到站点自己的 serverless 代理。沙盒里必须提供，否则用户开了主代理
  // 就通不了话（会误判成"渠道不支持直连"）。
  // ==========================================================================
  const NETLIFY_OPENAI_COMPATIBLE_PROXY_ENDPOINT = '/.netlify/functions/openai-proxy';
  const VERCEL_OPENAI_COMPATIBLE_PROXY_ENDPOINT = '/api/openai-proxy';

  function getOpenAICompatibleProxyEndpoint() {
    let proxyPath = NETLIFY_OPENAI_COMPATIBLE_PROXY_ENDPOINT;
    try {
      const hostname = String((window.location && window.location.hostname) || '').toLowerCase();
      if (hostname.endsWith('.vercel.app') || hostname === 'vercel.app') {
        proxyPath = VERCEL_OPENAI_COMPATIBLE_PROXY_ENDPOINT;
      }
    } catch (e) { /* 用默认 */ }
    return proxyPath;
  }

  function buildOpenAICompatibleTargetUrl(baseUrl, targetPath) {
    const endpointPath = String(targetPath || '').trim().startsWith('/')
      ? String(targetPath || '').trim()
      : '/' + String(targetPath || '').trim();
    if (!endpointPath || (endpointPath !== '/chat/completions' && endpointPath !== '/models')) {
      throw new Error('不支持的 OpenAI compatible 代理目标路径');
    }
    const parsed = new URL(String(baseUrl || '').trim());
    if (parsed.protocol !== 'https:') throw new Error('通用代理只允许 https API 地址');
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    let pathname = parsed.pathname || '/';
    pathname = pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/chat\/completions$/i, '');
    pathname = pathname.replace(/\/models$/i, '');
    parsed.pathname = (pathname + endpointPath).replace(/\/{2,}/g, '/');
    return parsed.toString();
  }

  function isMainApiProxyEnabled() {
    return window.state && window.state.globalSettings && window.state.globalSettings.mainApiUseProxy === true;
  }

  function fetchViaOpenAICompatibleProxy(opts) {
    const o = opts || {};
    buildOpenAICompatibleTargetUrl(o.baseUrl, o.targetPath);   // 只为触发同样的参数校验
    const proxyPath = getOpenAICompatibleProxyEndpoint();
    return fetch(proxyPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: o.baseUrl,
        targetPath: o.targetPath,
        apiKey: o.apiKey,
        payload: o.payload,
        method: o.method || 'POST'
      }),
      signal: o.signal
    });
  }

  // ==========================================================================
  // 5. 切屏 —— 沙盒里只有这 4 个屏
  // ==========================================================================
  const SANDBOX_SCREENS = [
    'live2d-call-prep-screen',
    'outgoing-call-screen',
    'video-call-screen',
    'voice-call-screen'
  ];

  function showScreen(screenId) {
    try {
      SANDBOX_SCREENS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
      });
      if (screenId) {
        const target = document.getElementById(screenId);
        if (target) target.classList.add('active');
      }
      hideBootLayer();
    } catch (e) {
      log('showScreen failed', screenId, e && e.message);
    }
  }

  // ==========================================================================
  // 6. 弹窗（替代宿主的 ui-modals.js）
  // --------------------------------------------------------------------------
  // 返回值必须跟宿主一致，否则调用方判断全部落空：
  //   showCustomConfirm(...) → Promise<boolean>
  //   showCustomPrompt(...)  → Promise<string|null>
  //   showCustomAlert(...)   → Promise<undefined>
  // ==========================================================================
  var activeModal = null;

  function closeSandboxModal() {
    if (activeModal && activeModal.parentNode) activeModal.remove();
    activeModal = null;
  }

  function simpleBox(html, buttons, withInput, inputType, inputValue) {
    return new Promise(function (resolve) {
      closeSandboxModal();
      var ov = document.createElement('div');
      activeModal = ov;
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);' +
        'display:flex;align-items:center;justify-content:center;padding:24px;' +
        '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';

      var box = document.createElement('div');
      box.style.cssText = 'max-width:340px;width:100%;background:#fff;color:#3a2a30;border-radius:18px;' +
        'padding:20px;line-height:1.7;font-size:14px;box-shadow:0 12px 40px rgba(0,0,0,.24);';
      box.innerHTML = html;

      var inputEl = null;
      if (withInput) {
        if (inputType === 'textarea') {
          inputEl = document.createElement('textarea');
          inputEl.rows = 4;
        } else {
          inputEl = document.createElement('input');
          inputEl.type = 'text';
        }
        inputEl.value = inputValue || '';
        inputEl.style.cssText = 'width:100%;box-sizing:border-box;margin-top:10px;padding:10px 12px;' +
          'border:1px solid rgba(255,142,179,.5);border-radius:12px;font:inherit;font-size:14px;' +
          'background:#fff;color:#3a2a30;';
        box.appendChild(inputEl);
      }

      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px;';
      buttons.forEach(function (b) {
        var el = document.createElement('button');
        el.textContent = b.label;
        el.style.cssText = 'padding:9px 18px;border-radius:999px;border:0;font:inherit;font-size:14px;' +
          'background:' + (b.primary ? '#ff6f9c' : '#f0f0f0') + ';color:' + (b.primary ? '#fff' : '#666') + ';';
        el.onclick = function () {
          var v = b.value;
          if (withInput) v = inputEl ? inputEl.value : '';
          closeSandboxModal();
          resolve(v);
        };
        bar.appendChild(el);
      });
      box.appendChild(bar);
      ov.appendChild(box);
      document.body.appendChild(ov);

      if (inputEl) setTimeout(function () { try { inputEl.focus(); } catch (e) { /* noop */ } }, 60);
    });
  }

  function showCustomAlert(title, message) {
    return simpleBox(
      '<div style="font-weight:600;margin-bottom:8px">' + (title || '提示') + '</div>' +
      '<div style="white-space:pre-wrap">' + (message || '') + '</div>',
      [{ label: '知道了', primary: true }]
    );
  }

  function showCustomConfirm(title, message, options) {
    var o = options || {};
    return simpleBox(
      '<div style="font-weight:600;margin-bottom:8px">' + (title || '确认') + '</div>' +
      '<div style="white-space:pre-wrap">' + (message || '') + '</div>',
      [
        { label: o.cancelText || '取消', value: false },
        { label: o.confirmText || '确定', value: true, primary: true }
      ]
    );
  }

  function showCustomPrompt(title, message, initialValue, type) {
    return simpleBox(
      '<div style="font-weight:600;margin-bottom:8px">' + (title || '输入') + '</div>' +
      '<div style="white-space:pre-wrap;color:#8a7480;font-size:13px">' + (message || '') + '</div>',
      [
        { label: '取消', value: null },
        { label: '确定', primary: true }
      ],
      true, type || 'text', initialValue
    ).then(function (v) { return (v === null || v === '') ? null : v; });
  }

  function showToast(message, type, duration) {
    var t = document.createElement('div');
    t.textContent = String(message == null ? '' : message);
    var bg = type === 'error' ? 'rgba(200,50,80,.94)'
      : (type === 'success' ? 'rgba(40,160,90,.94)' : 'rgba(0,0,0,.86)');
    t.style.cssText = 'position:fixed;left:50%;bottom:14%;transform:translateX(-50%);z-index:2147483001;' +
      'background:' + bg + ';color:#fff;padding:10px 16px;border-radius:999px;font-size:13px;max-width:80%;' +
      'text-align:center;pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, Number(duration) > 0 ? Number(duration) : 2600);
  }

  // ==========================================================================
  // 7. 宿主回传桩
  // --------------------------------------------------------------------------
  // 挂断后的落库 / 记忆总结 / 回聊天页 全部【留在宿主做】—— 别把 IDB 写操作
  // 分散到两个文档里，否则宿主内存里的 state 跟库不同步，下次写库就把通话
  // 记录冲掉了。
  //
  // 注意：通话记录、chat.history 那条"通话结束"消息，已经由
  // video-voice-call.js 用 window.db 直接写进 IndexedDB（同源同库，不用转发）。
  // 这里只需要通知宿主"内存该刷新了"。
  // ==========================================================================

  function openChat(chatId) {
    // 沙盒里不做任何切屏 —— 宿主收到消息后自己 openChat + 把 iframe 摘掉
    post({ type: 'vcall:openChat', chatId: chatId || null });
    return Promise.resolve();
  }

  function appendMessage(msg, chat) {
    // 拍一拍这种"追加一条消息"的路径，交给宿主落库 + 渲染
    post({ type: 'vcall:appendMessage', chatId: (chat && chat.id) || null, message: msg || null });
    return Promise.resolve();
  }

  function renderChatList() {
    return Promise.resolve();   // 沙盒里没有聊天列表
  }

  function summarizeCallTranscript(chatId, transcriptText) {
    // 记忆总结要调 AI、要写记忆库，全部留在宿主做。
    // 返回 resolved 让调用方（endVideoCall）不会被卡住或抛错。
    post({ type: 'vcall:summarizeCall', chatId: chatId || null, transcript: transcriptText || '' });
    return Promise.resolve();
  }

  // ---- Gemini 原生 URL / 响应文本提取（来源 modules/utils.js:442 / 529）----
  function isGeminiNativeUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') return false;
    return proxyUrl.indexOf('/v1beta/models') >= 0 && proxyUrl.indexOf('/v1beta/openai') < 0;
  }

  function getGeminiResponseText(data) {
    if (data && data.choices && Array.isArray(data.choices) && data.choices.length > 0
      && data.choices[0].message && data.choices[0].message.content) {
      return data.choices[0].message.content;
    }
    if (data && data.candidates && Array.isArray(data.candidates) && data.candidates.length > 0
      && data.candidates[0].content && data.candidates[0].content.parts) {
      return data.candidates[0].content.parts.map(part => part.text || '').join('');
    }
    return '';
  }

  /**
   * 发起通话时「AI 接不接」的决策。
   *
   * ⚠️ 这是沙盒里唯一需要模拟的 AI 调用。
   *   宿主里这个动作是 doInitiateCall() 末尾的 await triggerAiResponse()，
   *   而 triggerAiResponse 内部检测到"最近一条消息是通话请求"后，会走一条
   *   【独立的、简化的】决策请求（见 modules/ai-response.js:2362-2530），
   *   并不会跑完整的主聊天管线。沙盒只把这一段搬过来，所以既不用加载
   *   390KB 的 ai-response.js，行为和宿主也一致。
   */
  async function handleCallDecision() {
    var s = window.state;
    var chatId = s.activeChatId;
    var chat = s.chats[chatId];
    if (!chat) return;

    var hist = chat.history || [];
    var last = hist.length ? hist[hist.length - 1] : null;
    if (!last || last.role !== 'system') return;

    var content = String(last.content || '');
    var isVideoReq = content.indexOf('视频通话请求') >= 0;
    var isVoiceReq = content.indexOf('语音通话请求') >= 0;
    if (!isVideoReq && !isVoiceReq) return;   // 其它情况沙盒不处理（主聊天归宿主）

    // --- API 配置（优先角色独立配置；主 API 实时引用预设库）---
    var apiConfig = s.apiConfig || {};
    try {
      if (typeof window.resolveApiSlotConfig === 'function') {
        var resolved = await window.resolveApiSlotConfig('main');
        if (resolved && resolved.proxyUrl) apiConfig = resolved;
      }
    } catch (e) { /* 退回 state.apiConfig */ }

    if (chat.apiOverride && chat.apiOverride.enabled) {
      apiConfig = {
        proxyUrl: chat.apiOverride.proxyUrl || apiConfig.proxyUrl,
        apiKey: chat.apiOverride.apiKey || apiConfig.apiKey,
        model: chat.apiOverride.model || apiConfig.model
      };
    }

    var proxyUrl = apiConfig.proxyUrl;
    var apiKey = apiConfig.apiKey;
    var model = apiConfig.model;
    if (!proxyUrl || !apiKey || !model) {
      showCustomAlert('提示', '请先在 API 设置里配置反代地址、密钥并选择模型。');
      post({ type: 'vcall:openChat', chatId: chatId });
      return;
    }

    // --- 组 prompt（照抄宿主措辞，AI 才会稳定吐同一个指令格式）---
    var kind = isVideoReq ? '视频' : '语音';
    var responseType = isVideoReq ? 'video_call_response' : 'voice_call_response';
    var groupResponseType = isVideoReq ? 'group_call_response' : 'group_voice_response';
    var callDecisionPrompt;

    if (chat.isGroup) {
      var members = chat.members || [];
      callDecisionPrompt =
        '\n        # 你的任务\n        群聊中的用户刚刚发起了群' + kind + '通话。请你分别扮演【每一个群成员】，根据他们各自的人设和与用户的关系，来决定是加入(join)还是拒绝(decline)。\n' +
        '        # 核心规则\n' +
        '        - 你的回复【必须】是一个JSON数组，为【每一个AI角色】都包含一个决策对象。\n' +
        '        - 格式: \'[{"type": "' + groupResponseType + '", "name": "角色A的本名", "decision": "join"}, {"type": "' + groupResponseType + '", "name": "角色B的本名", "decision": "decline"}]\'\n' +
        '        # 群成员列表及人设\n' +
        members.map(m => '- ' + m.groupNickname + ' (本名: ' + m.originalName + '): ' + m.persona).join('\n') +
        '\n        现在，请为所有AI角色做出决策。';
    } else {
      callDecisionPrompt =
        '\n        # 你的任务\n        用户刚刚向你发起了' + kind + '通话。请根据你的角色设定，决定是“接受”还是“拒绝”。\n' +
        '        # 你的角色设定\n        ' + (chat.settings && chat.settings.aiPersona || '') + '\n' +
        '        # 核心规则\n' +
        '        你的回复【必须且只能】是以下两种格式之一的JSON数组，绝对不能回复任何其他内容：\n' +
        '        - 接受: \'[{"type": "' + responseType + '", "decision": "accept"}]\'\n' +
        '        - 拒绝: \'[{"type": "' + responseType + '", "decision": "reject"}]\'\n' +
        '        现在，请立即做出决策。';
    }

    var messagesForCallDecision = [{ role: 'user', content: callDecisionPrompt }];

    // --- 发请求 ---
    var response;
    var useGemini = isGeminiNativeUrl(proxyUrl);
    var useMainApiProxy = !useGemini
      && typeof window.fetchViaOpenAICompatibleProxy === 'function'
      && typeof window.isMainApiProxyEnabled === 'function'
      && window.isMainApiProxyEnabled();

    var payload = { model: model, messages: messagesForCallDecision, temperature: 0.7 };

    if (useGemini) {
      var geminiConfig = toGeminiRequestData(model, apiKey, callDecisionPrompt, messagesForCallDecision);
      response = await fetch(geminiConfig.url, geminiConfig.data);
    } else if (useMainApiProxy) {
      response = await window.fetchViaOpenAICompatibleProxy({
        baseUrl: proxyUrl, targetPath: '/chat/completions',
        apiKey: apiKey, payload: payload, method: 'POST'
      });
    } else {
      response = await fetch(String(proxyUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify(payload)
      });
    }

    if (!response.ok) {
      var errMsg = 'HTTP ' + response.status;
      try {
        var errData = await response.json();
        errMsg = (errData && (errData.error && errData.error.message || errData.message || errData.detail)) || JSON.stringify(errData);
      } catch (e) { /* 用状态码 */ }
      throw new Error('API失败: ' + errMsg);
    }

    var data = await response.json();
    var aiResponseContent = getGeminiResponseText(data);
    var responseArray = parseAiResponse(aiResponseContent);

    var vs = window.videoCallState;
    var vcs = window.voiceCallState;
    var callState = isVideoReq ? vs : vcs;
    if (!callState) return;

    var handled = false;
    for (var i = 0; i < responseArray.length; i++) {
      var msgData = responseArray[i] || {};

      // ---- 单人：接 / 拒 ----
      if (msgData.type === responseType) {
        callState.isAwaitingResponse = false;
        if (msgData.decision === 'accept') {
          if (isVideoReq) window.startVideoCall();
          else window.startVoiceCall();
        } else {
          var rejectMsg = {
            role: 'assistant',
            content: '对方拒绝了你的' + kind + '通话请求。',
            timestamp: Date.now()
          };
          (chat.history || []).push(rejectMsg);
          try { await window.db.chats.put(chat); } catch (e) { /* noop */ }
          post({ type: 'vcall:openChat', chatId: chatId });
        }
        handled = true;
        break;
      }

      // ---- 群聊：逐个 join / decline ----
      if (msgData.type === groupResponseType) {
        if (msgData.decision === 'join') {
          var member = (chat.members || []).find(function (m) { return m.originalName === msgData.name; });
          if (member && !callState.participants.some(function (p) { return p.id === member.id; })) {
            callState.participants.push(member);
          }
        }
        handled = true;
      }
    }

    // 群聊收尾：有人接就开，没人接就回聊天页
    if (handled && chat.isGroup && callState.isGroupCall) {
      callState.isAwaitingResponse = false;
      if (callState.participants.length > 0) {
        if (isVideoReq) window.startVideoCall();
        else window.startVoiceCall();
      } else {
        callState.participants = [];
        showCustomAlert('提示', '无人接听群聊邀请。');
        post({ type: 'vcall:openChat', chatId: chatId });
      }
    }

    if (!handled) {
      // AI 没按格式回（比如回了一段闲聊）→ 当作接受，避免永远卡在"正在呼叫…"
      log('AI 未返回通话决策指令, 按接听处理。原始回复:', String(aiResponseContent).slice(0, 200));
      callState.isAwaitingResponse = false;
      if (isVideoReq) window.startVideoCall();
      else window.startVoiceCall();
    }
  }

  function triggerAiResponse() {
    // 沙盒里不跑主聊天 AI 管线（那是宿主 390KB 的 ai-response.js），
    // 只接管「用户发起通话 → AI 接不接」这一个分支。
    handleCallDecision().catch(function (err) {
      log('通话决策失败:', err && err.message);
      // 出错时别让用户卡在"正在呼叫…"，直接按接听处理
      try {
        var s = window.state;
        var chat = s.chats[s.activeChatId];
        var last = chat && chat.history && chat.history[chat.history.length - 1];
        var content = String((last && last.content) || '');
        var isV = content.indexOf('视频通话请求') >= 0;
        var isA = content.indexOf('语音通话请求') >= 0;
        if (isV && window.videoCallState) {
          window.videoCallState.isAwaitingResponse = false;
          if (typeof window.startVideoCall === 'function') window.startVideoCall();
        } else if (isA && window.voiceCallState) {
          window.voiceCallState.isAwaitingResponse = false;
          if (typeof window.startVoiceCall === 'function') window.startVoiceCall();
        }
      } catch (e2) { /* noop */ }
    });
    return Promise.resolve();
  }

  function saveChat() { return Promise.resolve(); }
  function renderChatInterface() { return Promise.resolve(); }
  function scrollToBottom() { /* noop */ }

  // ==========================================================================
  // 8. runtimeDiag 桩
  // --------------------------------------------------------------------------
  // 宿主的 runtime-diagnostics.js 有一堆环形缓冲 + 面板，沙盒不需要。
  // 只要保证 window.runtimeDiag?.log?.() 能调、不抛错就行。
  // ==========================================================================
  if (!window.runtimeDiag) {
    window.runtimeDiag = {
      log: function (event, payload) {
        if (window.__callSandboxDebug) {
          try { console.log('[diag]', event, payload); } catch (e) { /* noop */ }
        }
      },
      getEvents: function () { return []; },
      clear: function () { /* noop */ }
    };
  }

  // ==========================================================================
  // 9. 暴露到全局
  // --------------------------------------------------------------------------
  // ⚠️ 必须显式挂 window —— 这些函数在本 IIFE 内部，video-voice-call.js 里
  //    是【裸调用】（parseAiResponse(...) 而不是 window.parseAiResponse(...)），
  //    只有挂到 window 才能被全局作用域看见。
  // ==========================================================================
  window.getRandomValue = getRandomValue;
  window.parseAiResponse = parseAiResponse;
  window.toGeminiRequestData = toGeminiRequestData;
  window.cleanMinimaxResponseText = cleanMinimaxResponseText;
  window.stripMinimaxReasoningSections = stripMinimaxReasoningSections;
  window.isOfficialMinimaxProviderInfo = isOfficialMinimaxProviderInfo;
  window.addLongPressListener = addLongPressListener;
  window.getDisplayNameInGroup = getDisplayNameInGroup;
  window.getCustomTime = getCustomTime;
  window.getTimeOfDayGreeting = getTimeOfDayGreeting;

  window.showScreen = showScreen;
  window.showToast = showToast;
  window.showCustomAlert = showCustomAlert;
  window.showCustomConfirm = showCustomConfirm;
  window.showCustomPrompt = showCustomPrompt;

  window.openChat = openChat;
  window.appendMessage = appendMessage;
  window.renderChatList = renderChatList;
  window.summarizeCallTranscript = summarizeCallTranscript;
  window.triggerAiResponse = triggerAiResponse;
  window.saveChat = saveChat;
  window.renderChatInterface = renderChatInterface;
  window.scrollToBottom = scrollToBottom;

  window.buildOpenAICompatibleTargetUrl = buildOpenAICompatibleTargetUrl;
  window.fetchViaOpenAICompatibleProxy = fetchViaOpenAICompatibleProxy;
  window.isMainApiProxyEnabled = isMainApiProxyEnabled;

  // ==========================================================================
  // 10. 启动层 + 和宿主握手
  // ==========================================================================

  // --------------------------------------------------------------------------
  // 10a. 通话页按钮绑定
  // --------------------------------------------------------------------------
  // ⚠️ 这些按钮的 click 在宿主里绑在 modules/init-event-bindingsB.js:2586-2610，
  //    那个文件有 4000+ 行、绑的全是宿主各页面的 DOM，沙盒不能加载它。
  //    所以这里照抄通话相关的十几条绑定。
  //    漏一条就是一个按钮点了没反应 —— 挂断按钮漏了会让人以为"卡在通话里出不来"。
  function bindCallButtons() {
    function on(id, handler) {
      var el = document.getElementById(id);
      if (!el || !handler) return;
      if (el.dataset.sandboxBound) return;
      el.dataset.sandboxBound = '1';
      el.addEventListener('click', handler);
    }

    // ---- 视频通话 ----
    on('hang-up-btn', function () { if (typeof window.endVideoCall === 'function') window.endVideoCall(); });
    on('minimize-call-btn', function () { if (typeof window.minimizeVideoCall === 'function') window.minimizeVideoCall(); });
    on('video-call-restore-btn', function () { if (typeof window.restoreVideoCall === 'function') window.restoreVideoCall(); });
    on('join-call-btn', function () { if (typeof window.handleUserJoinCall === 'function') window.handleUserJoinCall(); });
    on('user-speak-btn', function () { if (typeof window.handleVideoCallUserSpeak === 'function') window.handleVideoCallUserSpeak(); });

    // ---- 语音通话 ----
    on('voice-hang-up-btn', function () { if (typeof window.endVoiceCall === 'function') window.endVoiceCall(); });
    on('minimize-voice-call-btn', function () { if (typeof window.minimizeVoiceCall === 'function') window.minimizeVoiceCall(); });
    on('voice-call-restore-btn', function () { if (typeof window.restoreVoiceCall === 'function') window.restoreVoiceCall(); });
    on('voice-join-call-btn', function () { if (typeof window.handleUserJoinVoiceCall === 'function') window.handleUserJoinVoiceCall(); });
    on('voice-user-speak-btn', function () { if (typeof window.handleVoiceCallUserSpeak === 'function') window.handleVoiceCallUserSpeak(); });

    // ---- 取消呼叫（还没接通时挂掉）----
    // 宿主原版最后是 showScreen('chat-interface-screen')，沙盒没有聊天页 → 交给宿主切
    on('cancel-call-btn', function () {
      if (window.videoCallState) window.videoCallState.isAwaitingResponse = false;
      if (window.voiceCallState) window.voiceCallState.isAwaitingResponse = false;
      openChat(window.state.activeChatId);
    });

    // ---- 模型管理面板（表情 / 动作）----
    on('model-manage-btn', function () {
      var panel = document.getElementById('model-management-panel');
      if (panel) panel.classList.add('visible');
      if (typeof window.Live2DUI !== 'undefined' && window.Live2DUI && typeof window.Live2DUI.refreshModelManagementPanel === 'function') {
        try { window.Live2DUI.refreshModelManagementPanel(); } catch (e) { /* noop */ }
      }
    });
    on('model-management-close-btn', function () {
      var panel = document.getElementById('model-management-panel');
      if (panel) panel.classList.remove('visible');
    });

    // ---- 准备页工具按钮（返回 / 上传模型 / 管理模型 / 上传背景 / 管理背景）----
    // 这几个由 Live2DCallPrep 自己绑（它在 open() 里 querySelector 绑），这里不重复。
  }

  function hideBootLayer() {
    var boot = document.getElementById('sandbox-boot');
    if (boot && boot.style.display !== 'none') boot.style.display = 'none';
  }

  function showBootMessage(text) {
    var msg = document.getElementById('sandbox-boot-msg');
    if (msg) msg.textContent = text;
  }

  /**
   * 宿主传来的数据填进沙盒 state。
   * 只填【通话真正会读的字段】—— 见 video-voice-call.js 里 state.xxx 的用法：
   *   state.activeChatId / state.chats[id] / state.apiConfig /
   *   state.globalSettings / state.character / state.worldBooks
   */
  function applyHostState(payload) {
    var s = window.state;
    if (!s) return;

    if (payload.apiConfig) s.apiConfig = payload.apiConfig;
    if (payload.globalSettings) s.globalSettings = payload.globalSettings;
    if (payload.character) s.character = payload.character;
    if (payload.worldBooks) s.worldBooks = payload.worldBooks;
    if (payload.qzoneSettings) s.qzoneSettings = payload.qzoneSettings;
    if (payload.messageWindows) s.messageWindows = payload.messageWindows;

    var chat = payload.chat;
    if (chat && chat.id) {
      s.chats = s.chats || {};
      s.chats[chat.id] = chat;
      s.activeChatId = chat.id;
    }
  }

  /**
   * 沙盒入口：填好 state 后走生产完全相同的入口函数 handleInitiateCall()。
   * 它会自己打开 #live2d-call-prep-screen（准备页），用户在准备页里点
   * 「视频接通」——【这个点击必须发生在 iframe 内】，iOS 才会给
   * getUserMedia / AudioContext 的真实用户手势。
   */
  function boot(payload) {
    if (booted) return;
    booted = true;
    applyHostState(payload || {});
    hideBootLayer();

    var chatId = window.state.activeChatId;
    if (!chatId) {
      showBootMessage('没收到聊天数据，无法开始通话。');
      post({ type: 'vcall:error', reason: 'no-chat' });
      return;
    }

    try {
      if (typeof window.handleInitiateCall === 'function') {
        window.handleInitiateCall();
        post({ type: 'vcall:ready', chatId: chatId });
      } else {
        throw new Error('handleInitiateCall 未加载');
      }
    } catch (e) {
      log('启动通话失败', e && e.message);
      showBootMessage('启动通话失败：' + (e && e.message ? e.message : e));
      post({ type: 'vcall:error', reason: String((e && e.message) || e) });
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'vcall:init' && d.payload) {
      if (booted) return;
      pendingInit = d.payload;
      boot(d.payload);
    } else if (d.type === 'vcall:ping') {
      post({ type: 'vcall:pong', booted: booted });
    }
  });

  // 向宿主要数据。宿主侧收到 needChat 会回一条 vcall:init。
  function requestInit() {
    post({ type: 'vcall:needChat' });
    setTimeout(function () {
      if (!booted) showBootMessage('没收到 330 的聊天数据…可以退出去重试。');
    }, 2500);
  }

  window.__callSandbox = {
    post: post,
    boot: boot,      // 方便本地直接打开沙盒页时手动灌数据调试
    isBooted: function () { return booted; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bindCallButtons();
      requestInit();
    });
  } else {
    bindCallButtons();
    requestInit();
  }
})();
