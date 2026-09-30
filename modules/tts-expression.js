// ============================================================
// tts-expression.js — AI → TTS 语音表达层解析器 (第一阶段)
// ------------------------------------------------------------
// 定位: TTS 业务规则的【唯一集中地】。调用方 (tts-audio.js) 只负责接线,
//       不得在本文件之外重复实现标签规则, 避免三条链路各写一套后逐渐分叉。
//
// 职责:
//   1. 解析 [[语音:<emotion>]] 控制标签 → emotion
//   2. 校验 emotion 白名单 (MiniMax speech-2.8-hd 官方 7 值)
//   3. 识别 MiniMax 2.8-HD 官方 19 个 interjection 标签, 清洗时予以保留
//   4. 非白名单括号内容按需删除 (MiniMax 不识别的括号不能进 TTS)
//   5. 剥离控制标签, 输出 displayText / speechText
//
// 严格边界 (第一阶段):
//   - 本阶段【不让 AI 主动生成】任何标签, 仅供手工注入测试。
//   - 只认「语音」一个词, 绝不匹配 [[舞台:]] / [[表情:]] —— Live2D 指令原样透传。
//   - 括号内容 trim 后必须【完全等于】白名单项, 不做前缀/模糊/包含匹配。
//     原因: MiniMax 的半角括号同时是 inline pronunciation 语法
//     (官方示例 "This is (he2)平, not (huo4)面."), 形态与 (inhale) 无法靠正则区分,
//     只能靠"白名单全等"这一层收敛。
//   - 不做 speed / vol / pitch, 不做 <#x#> 停顿, 不碰 [[舞台]] / [[表情]]。
// ============================================================

(function () {
  // MiniMax speech-2.8-hd voice_setting.emotion 官方允许值
  // 依据官方 OpenAPI T2AVoiceSetting.emotion.description:
  //   "Option `fluent`, `whisper` is only available for models:
  //    `speech-2.6-turbo`, `speech-2.6-hd`."
  // 因此 2.8-hd 实际生效的是下面 7 个; fluent / whisper 属 2.6 系列, 不纳入。
  const VALID_EMOTIONS = new Set([
    'happy',
    'sad',
    'angry',
    'fearful',
    'disgusted',
    'surprised',
    'calm'
  ]);

  // MiniMax T2A HTTP 【同步】接口官方 interjection 列表 (19 项)
  //   官方原文: "Interjection tags: Only supported when using
  //   `speech-2.8-hd` or `speech-2.8-turbo` models."
  // 有意不纳入 (whistles) / (crying) / (applause):
  //   官方【异步】接口与【音色克隆】接口列了 21 项, 但同步接口只列 19 项,
  //   330 走的是同步 /v1/t2a_v2, 未实测前不冒进。
  const MINIMAX_INTERJECTIONS = new Set([
    'laughs',
    'chuckle',
    'coughs',
    'clear-throat',
    'groans',
    'breath',
    'pant',
    'inhale',
    'exhale',
    'gasps',
    'sniffs',
    'sighs',
    'snorts',
    'burps',
    'lip-smacking',
    'humming',
    'hissing',
    'emm',
    'sneezes'
  ]);

  // [[语音:xxx]] / [语音:xxx]
  // 词锚定在「语音」二字上 —— Live2D 的 [[舞台:]] / [[表情:]] 匹配不到这里, 两套系统互不吞。
  // 刻意不加 Live2D 那条"缺右括号剥到行尾"的兜底 (video-voice-call.js:788):
  //   那种宽松写法会吃掉正常台词, 本阶段收益不抵风险。
  const TTS_DIRECTIVE_RE = /\[{1,2}[ \t]*语音[ \t]*[:：][ \t]*([^\]\n]*?)[ \t]*\]{1,2}/g;

  // 半角括号: MiniMax 的 interjection 与 inline pronunciation 共用此形态
  const HALF_PAREN_RE = /\(([^()\n]*)\)/g;

  // MiniMax 不识别的括号 (沿用改造前 tts-audio.js:509 的行为, 不放宽也不收紧)
  // 写成 \[+\[? ... \]+\] 而不是原先的 \[.*?\]: 改造用的非贪婪写法会把 "[[表情:x]]"
  // 匹配成 "[[表情:x]" 留下一个孤零零的 "]" 被念出去; 这里一并消掉。
  const OTHER_BRACKET_RE = /(\[+[^\[\]]*\]+|（.*?）|【.*?】)/g;

  /**
   * 送 MiniMax 前的文本清洗。
   * 与改造前唯一的差别: 半角括号内容命中 interjection 白名单时【保留】,
   * 其余 (含 inline pronunciation 等非官方标签) 仍然删除 —— 后者维持原行为, 不扩大范围。
   * @param {string} text
   * @returns {string}
   */
  function sanitizeForMiniMax(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return '';

    // 1) 半角括号逐个判定: 命中白名单原样保留, 否则删除 (不用宽泛正则一锅端)
    //    ⚠️ 判定用【原文全等】, 不 trim。MiniMax 只认精确的 "(laughs)",
    //    "( laughs )" / "(laughs2)" 送过去它不认, 反而会被当内联注音念出来。
    let out = raw.replace(HALF_PAREN_RE, function (match, inner) {
      const key = String(inner == null ? '' : inner);
      if (MINIMAX_INTERJECTIONS.has(key)) return match;
      return '';
    });

    // 2) 其余括号: MiniMax 不识别, 维持原删除逻辑
    out = out.replace(OTHER_BRACKET_RE, '');
    return out.trim();
  }

  // ============================================================
  // 第三阶段: 双层停顿
  // ------------------------------------------------------------
  // 底层(代码自动): 按标点无条件补基础停顿, AI 不用管。
  // 顶层(AI 手写)  : AI 只在情绪节点额外加重, 代码负责合并与封顶。
  // 两者共用同一套合并/封顶逻辑, 所以 AI 写 <#1.0#> 也不会越界。
  // ============================================================

  // 单次停顿封顶。官方允许 [0.01, 99.99], 这里收得比官方狠很多,
  // 目的是防止"整段都是长停顿"听起来像坏掉的导航在念稿 (糯米机同款取舍)。
  const MAX_PAUSE_SECONDS = 0.6;

  // 已存在的暂停标记 (无论 AI 手写还是本函数刚插的)
  const PAUSE_MARKER_RE = /<#\s*(\d+(?:\.\d+)?)\s*#>/g;

  // 相邻连续出现的停顿标记 (官方硬约束: 不可连续使用)
  const PAUSE_RUN_RE = /(<#[\d.]+#>[\s]*){2,}/g;

  function formatPause(seconds) {
    return '<#' + Math.min(Math.max(seconds, 0), MAX_PAUSE_SECONDS).toFixed(2) + '#>';
  }

  /**
   * 插入 MiniMax 原生停顿标记 <#x#>。
   * 设计照搬糯米机 utils/minimaxTts.ts:207-232 的 insertSpeechBreaks, 两处差异:
   *   1) 先做一次【全局封顶】, 连 AI 手写的 <#1.0#> 也会被压到 0.6
   *      (糯米机只封顶相邻合并的那一批, AI 单独写的长停顿漏网)
   *   2) 其余 (标点表 / 相邻合并取最长 / trim) 与糯米机一致
   * @param {string} text
   * @returns {string}
   */
  function insertSpeechBreaks(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return '';

    // 0) 全局封顶: AI 手写的超长停顿在这里被压回安全范围
    let out = raw.replace(PAUSE_MARKER_RE, function (match, value) {
      const seconds = parseFloat(value);
      if (!isFinite(seconds)) return '';
      return formatPause(seconds);
    });

    // 1) 标点表 (糯米机同款)
    //    ⚠️ 省略号必须【一次替换搞定】。糯米机用两条 replace 串行
    //    ([…]{2,} 先替成 "……<#0.45#>", 再跑单 […] 规则), 结果刚生成的 "……"
    //    会被第二条规则再劈成 "…<#0.35#>…", 同一个省略号插出两个标记。
    //    这里合成一条带回调的正则, 保证只处理一遍。
    out = out
      .replace(/[…]{2,}|\.{3,}|[…]/g, function (m) {
        if (m === '…') return '…' + formatPause(0.35);       // 单个省略号
        if (m.charAt(0) === '.') return '...' + formatPause(0.35); // 英文省略号
        return '……' + formatPause(0.45);                     // 多个省略号连用, 更长
      })
      .replace(/——/g, '——' + formatPause(0.22))          // 破折号: 话题转折
      .replace(/--/g, '--' + formatPause(0.22))           // 英文破折号
      .replace(/。/g, '。' + formatPause(0.22))           // 句末呼吸
      .replace(/([！？!?])/g, '$1' + formatPause(0.26))   // 感叹/疑问更明显
      .replace(/([，,])/g, '$1' + formatPause(0.10))      // 句内换气
      .replace(/([、；：;])/g, '$1' + formatPause(0.07))   // 微停
      .replace(/\n/g, '\n' + formatPause(0.30));          // 段落换气

    // 2) 相邻连续标记合并成一个 (取最长, 再封顶) —— 官方硬约束的直接实现
    out = out.replace(PAUSE_RUN_RE, function (match) {
      const times = [];
      let m;
      PAUSE_MARKER_RE.lastIndex = 0;
      while ((m = PAUSE_MARKER_RE.exec(match)) !== null) {
        times.push(parseFloat(m[1]));
      }
      PAUSE_MARKER_RE.lastIndex = 0;
      if (!times.length) return '';
      return formatPause(Math.max.apply(null, times));
    });

    return out.trim();
  }

  /**
   * 从【显示文本】里去掉暂停标记。
   * <#x#> 是纯 TTS 控制标记, 漏给用户看到一堆 "<#0.4#>" 很难看;
   * 但它【只影响显示】—— 原文 / data-text / callHistory 一律不动,
   * TTS 仍会拿到带停顿的 speechText。
   * 注意: 本函数【不碰】 [[语音:x]] 和 (chuckle) —— 那两个按第二阶段规则必须显示。
   * @param {string} text
   * @returns {string}
   */
  function stripPauseMarkers(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return '';
    return raw
      .replace(PAUSE_MARKER_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
      .replace(/([，、；：,])\s*\1+/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /**
   * 解析一条 AI 文本, 生成【只用于发往 MiniMax 的】speechText, 并抽出情绪参数。
   *
   * ⚠️ 本函数【不产出任何"给用户看的"文本】。这是有意为之:
   *   [[语音:x]] 标签必须原样留在 AI 原始文本 / 气泡 / callHistory 里,
   *   speechText 只在真正调用 MiniMax 的那一刻临时生成, 用完即弃。
   *   所以这里【不要】返回 displayText 之类的字段 —— 命名会诱导后来者
   *   拿它去渲染, 从而把标签从用户可见文本里删掉, 那是需求错误。
   *
   * 处理顺序 (与阶段二一致, 末尾追加停顿层):
   *   1. 剥 [[语音:x]] → emotion
   *   2. (可选) 剥离非官方括号
   *   3. insertSpeechBreaks: AI 手写停顿保留 + 代码按标点补基础停顿 + 合并封顶
   *
   * @param {string} rawText 带标签的原始文本
   * @param {{filterBrackets?: boolean}} [options]
   *   filterBrackets=true  → speechText 额外剥离非官方括号 (视频通话旧行为)
   *   filterBrackets=false → 只剥语音标签, 其余原样 (聊天 / 语音通话旧行为)
   * @returns {{
   *   speechText: string,
   *   emotion: string|null,
   *   hasTtsDirective: boolean,
   *   strippedTags: string[]
   * }}
   */
  function parseTtsExpression(rawText, options) {
    const raw = String(rawText == null ? '' : rawText);
    const shouldFilterBrackets = !!(options && options.filterBrackets);

    let emotion = null;
    let hasTtsDirective = false;
    const strippedTags = [];

    // emotion 标签只从【送 TTS 的那一份】里剥离。
    // 一轮出现多个时, 与 Live2D 一致取【最后一条】(一次请求只能带一个 emotion)。
    const withoutDirectives = raw.replace(TTS_DIRECTIVE_RE, function (match, value) {
      hasTtsDirective = true;
      strippedTags.push(match);
      const candidate = String(value == null ? '' : value).trim().toLowerCase();
      if (VALID_EMOTIONS.has(candidate)) {
        emotion = candidate;
      } else {
        // 非法值只丢弃, 绝不把任意字符串当 emotion 往下传
        console.warn('[TTS表达层] 非法 emotion 已丢弃:', value);
      }
      return '';
    });

    const baseText = shouldFilterBrackets
      ? sanitizeForMiniMax(withoutDirectives)
      : withoutDirectives.trim();

    // 第三阶段: 双层停顿收口。
    //   AI 手写的 <#x#> 已在上面随原文带进来, 这里连同代码按标点补的基础停顿
    //   一起做合并 + 封顶, 保证最终 speechText 绝不会出现连续标记或超 0.6s 的值。
    const speechText = insertSpeechBreaks(baseText);

    return {
      speechText: speechText,
      emotion: emotion,
      hasTtsDirective: hasTtsDirective,
      strippedTags: strippedTags
    };
  }

  window.TTSExpression = {
    parseTtsExpression: parseTtsExpression,
    sanitizeForMiniMax: sanitizeForMiniMax,
    insertSpeechBreaks: insertSpeechBreaks,
    stripPauseMarkers: stripPauseMarkers,
    MAX_PAUSE_SECONDS: MAX_PAUSE_SECONDS,
    VALID_EMOTIONS: VALID_EMOTIONS,
    MINIMAX_INTERJECTIONS: MINIMAX_INTERJECTIONS
  };
})();
