// ============================================================================
// cinema-room.js — 330 Cinema Room 房间模块 (v0.1.0, 第一阶段最小闭环)
//
// 本阶段范围 (只跑通这一条链路, 不接 Gemini 3.8 Live, 不动旧观影):
//   本地视频 -> 保存 -> 片单 -> 播放 -> 进度 -> 刷新后继续播
//
// 【与旧观影的关系】
// 旧观影模块 (index.html:6908 watch-together-modal / init-features.js:4288+)
// 完全保留, 本模块是并列的新房间, 两个入口各自独立。Gemini Live 桥接
// (watch-together-live.js) 也原样不动 —— 第一阶段不接。
//
// 【人物层说明】
// 房间里 .cinema-char-slot 是左右两个空人物位, 故意留空:
// 人物以后独立配置 (糖糖 / 屌哥 / 音音 / 琪琪), 绝不画死在房间背景里。
// 房间背景自身只负责 背景 + 大屏 + 沙发 + 环境装饰。
// ============================================================================

(function (global) {
  'use strict';

  const S = global.CinemaStorage;

  // 进度节流间隔。太小会频繁写 IDB, 太大会丢进度。
  const PROGRESS_THROTTLE = 1500;
  // 距离片尾这么近就不再续播 (片尾彩蛋跳过去没意义)
  const RESUME_TAIL_GUARD = 8;

  let currentObjectUrl = null;   // 当前 blob URL, 换片/关房时必须 revoke
  let hlsInstance = null;       // hls.js 实例 (只有 .m3u8 才有)
  let currentFilmId = null;
  let lastSavedAt = 0;
  let progressTimer = null;
  let pendingResumeTime = 0;
  let drawerOpen = false;
  let chatOpen = false;
  let els = {};

  // --------------------------------------------------------------------------
  // DOM
  // --------------------------------------------------------------------------

  // 图标: 24x24 线性描边, 和 330 现有图标 (index.html 里那一批) 同一套风格。
  // KI-CO 用的是 lucide-react 组件, 330 是原生 JS 没有构建, 所以这里手写等价的 path。
  // ⚠️ 原则: 图标永远配中文文字标签, 不做纯图标按钮 (KI-CO 也是这么做的)。
  const CINEMA_ICON = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="M17 6l3 3"/><path d="M14 9l3 3"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    // 2026-10-04: 顶栏「设置」按钮换成齿轮 (原来借用了 key 的钥匙图标, 语义不对)
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
  };

  const ROOM_HTML = [
    // ⚠️ 顺序 = flex 列的上下顺序, 必须是 顶栏 → 视频区 → 聊天区。
    //    2026-10-04 踩过: bg 写在 topbar 前面, 结果大屏飘到顶栏上面去了,
    //    视频和聊天之间还凭空多出一段空隙。
    '<div class="cinema-room" id="cinema-room" aria-hidden="true">',
    '  <div class="cinema-room-topbar">',
    '    <div class="cinema-room-titles">',
    '      <div class="cinema-room-title">Cinema Room</div>',
    // 片名: 用户 2026-10-04 反馈"上方多了一个文件名, 其实可以不要显示"。
    //   元素保留 (旧代码/测试还在引用), 但默认隐藏 —— 现在没有任何调用点会打开它。
    '      <div class="cinema-room-now" id="cinema-now-playing" hidden></div>',
    // 状态条占位: cinema-live.js 会把 #cinema-live-status 塞进这里,
    //   它是标题行的【最后一个 flex 子项】—— 不再是 absolute 浮层,
    //   所以绝不会盖到下面的视频画面 (2026-10-04 用户反馈"绿点已连接放到视频框里了")。
    '      <div class="cinema-topbar-status" id="cinema-topbar-status"></div>',
    '    </div>',
    '    <div class="cinema-room-topbar-actions">',
    '      <button class="cinema-room-icon-btn cinema-stop-btn" id="cinema-stop-btn" title="停止播放" aria-label="停止播放" hidden>',
    CINEMA_ICON.stop, '<span>停止</span></button>',
    '      <button class="cinema-room-icon-btn" id="cinema-settings-btn" title="设置" aria-label="打开设置">',
    CINEMA_ICON.gear, '<span>设置</span></button>',
    '      <button class="cinema-room-icon-btn" id="cinema-chat-toggle" title="聊天" aria-label="打开聊天面板">',
    CINEMA_ICON.chat, '<span>聊天</span></button>',
    '      <button class="cinema-room-icon-btn" id="cinema-drawer-toggle" title="片单" aria-label="打开片单">',
    CINEMA_ICON.list, '<span>片单</span></button>',
    '      <button class="cinema-room-icon-btn" id="cinema-room-close" title="退出房间" aria-label="退出 Cinema Room">',
    CINEMA_ICON.close, '<span>退出</span></button>',
    '    </div>',
    '  </div>',

    '  <div class="cinema-room-bg">',
    // 自定义背景层 (2026-10-05): 用户传自己的房间背景。
    // ⚠️ 刻意用 <img> 而不是 CSS background-image:
    //   自传图经过压缩可能是 WebP, 极老的 WebView 不认 → CSS 的话整面墙空白;
    //   <img> 解不出来最多是这张图不显示, 底下的默认 CSS 背景还在, 不会白屏。
    //   z-index: 0 压在 ambient / 道具 下面, 当它就是"墙"。
    '    <img class="cinema-room-custom-bg" id="cinema-room-custom-bg" alt="" hidden>',
    // 环境光层: 在大屏下面, 用视频当前帧的平均色给房间打光。
    // 屏幕亮起后它就是房间的主要光源 —— 这是 v0.3.0 房间氛围的核心。
    '    <div class="cinema-ambient" id="cinema-ambient"></div>',
    '    <div class="cinema-room-screen" id="cinema-screen">',
    '      <video id="cinema-video" playsinline webkit-playsinline preload="metadata" controls></video>',
    '      <div class="cinema-room-idle" id="cinema-room-idle">',
    '        <div class="cinema-room-idle-title">Cinema Room</div>',
    '        <div class="cinema-room-idle-hint">从片单选一部，或者添加本地影片</div>',
    '        <button class="cinema-room-add-btn" id="cinema-add-btn">添加本地影片</button>',
    '      </div>',
    '    </div>',
    // ⚠️ DOM 顺序 = 层级 (都是 position:absolute, 后面的盖前面的)。
    //   茶几写在【人物前面】→ 它的 z-index 实际更高, 能挡住人物的下半身,
    //   看起来就像人真的坐在茶几后面的沙发上。这是这张无茶几背景图的关键。
    //   (背景图在 .cinema-room-bg 上, 是它们共同的父层, 永远在最底下。)
    '    <div class="cinema-char-slot left" id="cinema-char-left" data-empty="true"></div>',
    '    <div class="cinema-char-slot right" id="cinema-char-right" data-empty="true"></div>',
    '    <div class="cinema-char-slot table" id="cinema-char-table" data-empty="true"></div>',
    '  </div>',

    // ---- 聊天面板 (flex 子项: 打开时占满视频区下面的全部空间) ----
    '  <div class="cinema-chat-panel" id="cinema-chat-panel">',
    '    <div class="cinema-chat-head">',
    '      <span class="cinema-chat-head-title">陪你看</span>',
    '      <div class="cinema-chat-head-actions">',
    '        <button class="cinema-chat-hbtn" id="cinema-chat-close" title="收起聊天" aria-label="收起聊天面板">',
    CINEMA_ICON.collapse, '<span>收起</span></button>',
    '      </div>',
    '    </div>',
    // ⚠️ 这里原来有「密钥」+「剧情」两个按钮和整个 key-box, 2026-10-04 全部删掉:
    //    密钥搬进房间右上角「设置」面板, 剧情记忆改成聊天面板内常驻的折叠条
    //    (cinema-live.js ensurePlotPanel 自己往这儿插, 不再靠按钮触发)。
    '    <div class="cinema-chat-messages" id="cinema-chat-messages"></div>',
    '    <div class="cinema-chat-input-row">',
    '      <input type="text" id="cinema-chat-input" placeholder="说点什么…" autocomplete="off">',
    '      <button class="cinema-chat-send" id="cinema-chat-send">发送</button>',
    '    </div>',
    '  </div>',

    '  <div class="cinema-room-drawer" id="cinema-drawer">',
    '    <div class="cinema-drawer-head">',
    '      <span>片单</span>',
    '      <button class="cinema-room-add-btn small" id="cinema-drawer-add">+ 添加</button>',
    '    </div>',
    '    <div class="cinema-drawer-warn" id="cinema-capacity-warn" hidden></div>',
    '    <div class="cinema-drawer-list" id="cinema-film-list"></div>',
    '    <div class="cinema-drawer-foot" id="cinema-usage"></div>',
    '  </div>',
    '  <div class="cinema-drawer-scrim" id="cinema-drawer-scrim" hidden></div>',

    // ---- 片源入口 ----
    // 2026-10-04 用户决定: B站 / 直链 / 片库 三个渠道全部撤掉。
    //   B站: 用的 api.52vmy.cn 实测 522 + corsproxy.io 403, API 已经死了
    //   直链/片库: 实测拿不到能直接播的媒体流 (苹果CMS 返回的是播放页URL)
    // 现在只保留本地视频 —— 这是唯一实测能播、能存进度、能给 Live 抽帧的渠道。
    // 以后找到能用的接口再加回来, 存储层(S.addFilm 的 sourceType:'url')已经预留好了。
    '  <div class="cinema-source-sheet" id="cinema-source-sheet">',
    '    <div class="cinema-source-head">',
    '      <span class="cinema-chat-head-title">添加影片</span>',
    '      <button class="cinema-chat-hbtn" id="cinema-source-close" title="关闭" aria-label="关闭添加影片面板">',
    CINEMA_ICON.close, '<span>关闭</span></button>',
    '    </div>',
    '    <div class="cinema-source-pane" data-src-pane="local">',
    '      <div class="cinema-source-desc">从手机里选一个视频文件，存进本地片单。选完就能播，进度会自动记住。</div>',
    '      <button class="cinema-source-go" id="cinema-src-local">选择本地视频</button>',
    '    </div>',
    // ---- 短剧库 (2026-10-07) ----
    // 电脑上的短剧下载目录, 经自建 https 服务读出。一集一条, 能选集连着看。
    '    <div class="cinema-source-pane" data-src-pane="series">',
    '      <div class="cinema-source-desc">读你电脑上的短剧库（需电脑开着、连同一个 WiFi）。支持选集连着看，一集一集自动记剧情。填一次地址就会记住。</div>',
    '      <div class="cinema-series-addr">',
    // 🔴 2026-10-07 iOS 键盘卡顿修复: type="url" → type="text" + inputmode="url"
//
// 现象: 只在这个地址框里打字就整个页面/iOS 键盘卡死, 影院聊天框(type="text")
//       完全正常 —— 唯一差别就是这个 input 的 type。
//
// 原因: iOS 对 type="url" 唤起的是【带域名联想的专用键盘】, 它挂了一个候选弹层,
//       每敲一个字符就要重算候选 + 重绘弹层。而这个输入框的父容器
//       .cinema-source-sheet 有 backdrop-filter: blur(22px) (iOS 上最贵的合成操作,
//       要采样背后全部内容) —— 键盘弹层每重绘一次, 那个 82vh 的毛玻璃层就重采样一次。
//       两者叠加 = 每敲一个字符全页面重算。
//
// inputmode="url" 保留移动端键盘的 URL 布局(斜杠/冒号/点号都在),
// 但不触发 iOS 的域名联想与候选栏。
'        <input type="text" inputmode="url" id="cinema-series-url" placeholder="" aria-label="短剧库地址" autocapitalize="off" autocorrect="off" spellcheck="false">',
    '        <button class="cinema-set-save" id="cinema-series-connect">连接</button>',
    '      </div>',
    '      <div class="cinema-set-state" id="cinema-series-state"></div>',
    '      <div class="cinema-series-list" id="cinema-series-list" hidden></div>',
    '    </div>',
    // 选集面板: 点某部剧 → 打开这里
    '  <div class="cinema-episode-sheet" id="cinema-episode-sheet">',
    '    <div class="cinema-source-head">',
    '      <span class="cinema-chat-head-title" id="cinema-episode-title">选择集数</span>',
    '      <button class="cinema-chat-hbtn" id="cinema-episode-close" title="关闭" aria-label="关闭选集面板">',
    CINEMA_ICON.close, '<span>关闭</span></button>',
    '    </div>',
    '    <div class="cinema-episode-meta" id="cinema-episode-meta"></div>',
    '    <div class="cinema-episode-grid" id="cinema-episode-grid"></div>',
    '  </div>',
    '  </div>',

    // ---- 设置面板 (2026-10-04 新增) ----
    // 房间右上角齿轮进来。收编原来散在聊天头部的「密钥」, 再加人物立绘上传。
    // 样式刻意抄 .cinema-source-sheet —— 两个都是底部上滑的半屏面板, 手感一致。
    '  <div class="cinema-settings-sheet" id="cinema-settings-sheet">',
    '    <div class="cinema-source-head">',
    '      <span class="cinema-chat-head-title">设置</span>',
    '      <button class="cinema-chat-hbtn" id="cinema-settings-close" title="关闭" aria-label="关闭设置面板">',
    CINEMA_ICON.close, '<span>关闭</span></button>',
    '    </div>',
    '    <div class="cinema-settings-pane">',
    // --- Gemini 密钥 ---
    '      <div class="cinema-set-group">',
    '        <div class="cinema-set-title">Gemini Live API Key</div>',
    '        <div class="cinema-set-desc">存在本机浏览器，各人填各人的。填了才能边看边让 Gemini 陪聊。</div>',
    '        <div class="cinema-set-keyrow">',
    '          <input type="password" id="cinema-key-input" placeholder="粘贴你的 Gemini API Key" autocomplete="off">',
    '          <button class="cinema-set-save" id="cinema-key-save">保存</button>',
    '        </div>',
    '        <div class="cinema-set-state" id="cinema-key-state"></div>',
    '      </div>',
    // --- 人物立绘 ---
    '      <div class="cinema-set-group">',
    '        <div class="cinema-set-title">沙发上的人</div>',
    '        <div class="cinema-set-desc">上传【透明背景】的坐姿图。推荐 768×1280（3:5）WebP，约 60–120KB。<b>大小和位置你可以自己拖</b>，调一次就记住了。</div>',
    '        <div class="cinema-char-edit-row">',
    '          <div class="cinema-char-edit" data-slot="left">',
    '            <div class="cinema-char-edit-prev" id="cinema-char-prev-left"><span class="cinema-char-edit-empty">左边</span></div>',
    '            <div class="cinema-char-edit-btns">',
    '              <button class="cinema-set-pick" data-char-pick="left">选择图片</button>',
    '            </div>',
    '            <div class="cinema-char-edit-btns">',
    '              <button class="cinema-set-pick ghost" data-char-adjust="left" hidden>调位置</button>',
    '              <button class="cinema-set-del" data-char-del="left" hidden>删除</button>',
    '            </div>',
    '          </div>',
    '          <div class="cinema-char-edit" data-slot="right">',
    '            <div class="cinema-char-edit-prev" id="cinema-char-prev-right"><span class="cinema-char-edit-empty">右边</span></div>',
    '            <div class="cinema-char-edit-btns">',
    '              <button class="cinema-set-pick" data-char-pick="right">选择图片</button>',
    '            </div>',
    '            <div class="cinema-char-edit-btns">',
    '              <button class="cinema-set-pick ghost" data-char-adjust="right" hidden>调位置</button>',
    '              <button class="cinema-set-del" data-char-del="right" hidden>删除</button>',
    '            </div>',
    '          </div>',
    '        </div>',
    '        <button class="cinema-set-reset" id="cinema-char-reset">全部恢复默认位置</button>',
    '      </div>',
    // --- 茶几 (2026-10-04 背景图去掉了茶几, 改成用户自己传) ---
    '      <div class="cinema-set-group">',
    '        <div class="cinema-set-title">茶几（可选）</div>',
    '        <div class="cinema-set-desc">背景图自带的是没有茶几的版本。想要茶几就传一张<b>透明背景</b>的，它会挡在人物前面，遮住脚。<b>大小和位置同样可以自己拖</b>。</div>',
    '        <div class="cinema-char-edit wide" data-slot="table">',
    '          <div class="cinema-char-edit-prev" id="cinema-char-prev-table"><span class="cinema-char-edit-empty">茶几</span></div>',
    '          <div class="cinema-char-edit-btns">',
    '            <button class="cinema-set-pick" data-char-pick="table">选择图片</button>',
    '            <button class="cinema-set-pick ghost" data-char-adjust="table" hidden>调位置</button>',
    '            <button class="cinema-set-del" data-char-del="table" hidden>删除</button>',
    '          </div>',
    '        </div>',
    '      </div>',
    // --- 房间背景 (2026-10-05 用户需求: 自己换房间背景) ---
    '      <div class="cinema-set-group">',
    '        <div class="cinema-set-title">房间背景</div>',
    '        <div class="cinema-set-desc">默认是暖调客厅。<b>推荐 9:16 竖图</b>（1080×1920 最理想，不用透明背景）。<b>上传会自动压缩</b>到 1080 长边，一张 iPhone 照片从 3MB 压到约 100KB。</div>',
    '        <div class="cinema-char-edit wide" data-slot="bg">',
    '          <div class="cinema-char-edit-prev" id="cinema-room-bg-prev"><span class="cinema-char-edit-empty">默认房间</span></div>',
    '          <div class="cinema-char-edit-btns">',
    '            <button class="cinema-set-pick" data-roombg-pick>选择图片</button>',
    '            <button class="cinema-set-reset" data-roombg-del hidden>恢复默认</button>',
    '          </div>',
    '        </div>',
    '      </div>',
    // --- 诊断 (平时收着, 出事时点开看) ---
    // 2026-10-04: "上传要点两次"查了四轮都查不出来, 每次都要问用户看 console。
    //   iPhone 上看 console 很麻烦, 所以这里留一个折叠区, 平时完全不打扰。
    '      <div class="cinema-set-group cinema-diag-group">',
    '        <button class="cinema-set-reset" id="cinema-diag-toggle">诊断（出问题时展开）</button>',
    '        <pre class="cinema-diag-box" id="cinema-diag-box" hidden>（暂无记录）</pre>',
    '      </div>',
    '    </div>',
    '  </div>',

    // ---- 调整工具条 (2026-10-04) ----
    // 人物位置/大小改由用户自己拖。设置面板点「调位置」进来, 调完点「完成」出去。
    // 做成浮在房间底部的条, 不占视频区, 也不挡人物。
    '  <div class="cinema-adjust-bar" id="cinema-adjust-bar" hidden>',
    '    <div class="cinema-adjust-hint" id="cinema-adjust-hint">拖动移动 · 双指捏合缩放 · 松手自动记住</div>',
    '    <button class="cinema-adjust-done" id="cinema-adjust-done">完成</button>',
    '  </div>',
    '</div>',
    '<input type="file" id="cinema-file-input" accept="video/*" hidden>',
    // 人物图选择框: 一次只给一个 slot, 靠 data-slot 记这次是给左还是右
    // ⚠️ accept 用 image/* 而不是白名单 (png/webp/jpeg):
    //    iOS 上写死三种格式会让 HEIC 等格式【根本选不出来】(选择器里直接不显示),
    //    用户看到的就是"点开相册找不到图"。放宽后交给 saveCharImage 去判。
    '<input type="file" id="cinema-char-file-input" accept="image/*" hidden>',
    // 房间背景选择框 (2026-10-05)。accept 写 image/* 不写白名单 ——
    //   iOS 上写死 png/jpeg 会让 HEIC 等格式在相册里【直接选不出来】。
    '<input type="file" id="cinema-roombg-file-input" accept="image/*" hidden>'
  ].join('\n');

  function ensureDom() {
    if (els.root) return els;
    const holder = document.createElement('div');
    holder.innerHTML = ROOM_HTML;
    while (holder.firstChild) document.body.appendChild(holder.firstChild);

    els = {
      root: document.getElementById('cinema-room'),
      screen: document.getElementById('cinema-screen'),
      ambient: document.getElementById('cinema-ambient'),
      customBg: document.getElementById('cinema-room-custom-bg'),
      video: document.getElementById('cinema-video'),
      idle: document.getElementById('cinema-room-idle'),
      addBtn: document.getElementById('cinema-add-btn'),
      drawerAdd: document.getElementById('cinema-drawer-add'),
      fileInput: document.getElementById('cinema-file-input'),
      diagBox: document.getElementById('cinema-diag-box'),
      diagToggle: document.getElementById('cinema-diag-toggle'),
      closeBtn: document.getElementById('cinema-room-close'),
      stopBtn: document.getElementById('cinema-stop-btn'),
      chatToggle: document.getElementById('cinema-chat-toggle'),
      chatPanel: document.getElementById('cinema-chat-panel'),
      chatClose: document.getElementById('cinema-chat-close'),
      chatInput: document.getElementById('cinema-chat-input'),
      chatSend: document.getElementById('cinema-chat-send'),
      keyInput: document.getElementById('cinema-key-input'),
      keySave: document.getElementById('cinema-key-save'),
      keyState: document.getElementById('cinema-key-state'),
      // 设置面板
      settingsBtn: document.getElementById('cinema-settings-btn'),
      settingsSheet: document.getElementById('cinema-settings-sheet'),
      settingsClose: document.getElementById('cinema-settings-close'),
      charFileInput: document.getElementById('cinema-char-file-input'),
      charPrev: {
        left: document.getElementById('cinema-char-prev-left'),
        right: document.getElementById('cinema-char-prev-right'),
        table: document.getElementById('cinema-char-prev-table')
      },
      charSlot: {
        left: document.getElementById('cinema-char-left'),
        right: document.getElementById('cinema-char-right'),
        table: document.getElementById('cinema-char-table')
      },
      srcSheet: document.getElementById('cinema-source-sheet'),
      srcClose: document.getElementById('cinema-source-close'),
      srcLocal: document.getElementById('cinema-src-local'),
      // 短剧库 (2026-10-07)
      seriesUrl: document.getElementById('cinema-series-url'),
      seriesConnect: document.getElementById('cinema-series-connect'),
      seriesState: document.getElementById('cinema-series-state'),
      seriesList: document.getElementById('cinema-series-list'),
      episodeSheet: document.getElementById('cinema-episode-sheet'),
      episodeTitle: document.getElementById('cinema-episode-title'),
      episodeClose: document.getElementById('cinema-episode-close'),
      episodeMeta: document.getElementById('cinema-episode-meta'),
      episodeGrid: document.getElementById('cinema-episode-grid'),
      drawerToggle: document.getElementById('cinema-drawer-toggle'),
      drawer: document.getElementById('cinema-drawer'),
      scrim: document.getElementById('cinema-drawer-scrim'),
      list: document.getElementById('cinema-film-list'),
      warn: document.getElementById('cinema-capacity-warn'),
      usage: document.getElementById('cinema-usage'),
      nowPlaying: document.getElementById('cinema-now-playing')
    };
    bindEvents();
    initKeyboardMode();
    startPerfWatchdog();
    return els;
  }

  // --------------------------------------------------------------------------
  // 键盘态: 只在键盘弹起期间关掉影院的 backdrop-filter
  //
  // 背景 (2026-10-07 用户真机实测):
  //   影院里【聊天输入框】和【短剧地址框】两个都卡, 一个 type=text 一个 type=text,
  //   输入类型已经排除了 → 说明瓶颈不在输入框本身, 而在它们共用的那条路:
  //   【键盘弹出 → 可视视口变矮 → .cinema-room 整体 resize】。
  //
  //   而 .cinema-room 里挂着好几层【常驻】的 backdrop-filter:
  //     .cinema-chat-panel   blur(22px) saturate(1.2)  ← 聊天面板本体
  //     .cinema-room-drawer  blur(22px)                ← 片单抽屉(只是 translateX 移出屏幕)
  //     .cinema-source-sheet blur(22px)                ← 添加影片面板
  //     .cinema-settings-sheet blur(22px)              ← 设置面板
  //   后三个都不是 display:none, 只是被 transform 移出可视区, 所以它们一直参与合成。
  //   iOS 上 backdrop-filter 每次都要重新采样背后的全部内容 —— 房间一变高,
  //   这几层就得全部重采样一遍, 而键盘动画期间房间要变几十次。
  //
  // 为什么不直接把毛玻璃删了:
  //   那是影院视觉的一部分, 平时看着挺舒服。所以这里只在【键盘弹起时】关掉,
  //   键盘一收起立刻恢复 —— 打字时本来也看不清背后, 关掉反而更清爽、更不瞎眼。
  //
  // 用 focusin/focusout 而不是 visualViewport 高度来判断:
  //   高度判断要猜阈值(多少 px 算键盘弹了), 遇到第三方键盘/横竖屏切换就失效。
  //   focus 是确定信号。
  // --------------------------------------------------------------------------
  let kbOpen = false;

  function setKeyboardMode(on) {
    if (kbOpen === on) return;
    kbOpen = on;
    if (els && els.root) els.root.classList.toggle('kb-open', !!on);
  }

  function isTextField(node) {
    if (!node) return false;
    var tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable === true;
  }

  function initKeyboardMode() {
    if (!els || !els.root || els.root.__kbBound) return;
    els.root.__kbBound = true;
    els.root.addEventListener('focusin', function (e) {
      if (isTextField(e.target)) setKeyboardMode(true);
    });
    els.root.addEventListener('focusout', function () {
      // iOS 是先 blur 再收键盘, 这里等一下再判断, 免得中途把模糊关早了
      setTimeout(function () {
        if (!isTextField(document.activeElement)) setKeyboardMode(false);
      }, 350);
    });
  }

  // --------------------------------------------------------------------------
  // 低性能看门狗: 掉帧就把面板底色压实, 缓过来自动还原
  //
  // 背景 (2026-10-07):
  //   全屋 backdrop-filter 已经删干净了(真机实测那 6 层模糊 = 4509ms 的唯一元凶)。
  //   这里保留一个更轻的兜底: 设备吃力时把几个面板的底色再压实一点,
  //   没有模糊兜着的时候字更清楚, 相当于弱机版的"可读性保险"。
  //
  //   阈值刻意保守: 120ms 算一次"卡", 累计 250ms 才降级。
  //   宁可晚点降级, 也不要因为偶发一下就牺牲观感。
  // --------------------------------------------------------------------------
  function startPerfWatchdog() {
    if (!els || !els.root || els.root.__perfWatch) return;
    els.root.__perfWatch = true;

    var low = false;
    var gapSum = 0;      // 累计卡顿
    var last = 0;        // 上一次心跳

    function tick() {
      var now = performance.now();
      if (last) {
        var gap = now - last - 1000;   // 减去 1 秒的正常等待
        if (gap > 120) gapSum += gap;
        else gapSum = Math.max(0, gapSum * 0.6);   // 流畅了就快速回落
      }
      last = now;

      if (!low && gapSum > 250) {
        low = true;
        els.root.classList.add('perf-low');
      } else if (low && gapSum < 40) {
        low = false;
        els.root.classList.remove('perf-low');
      }
      setTimeout(tick, 1000);
    }
    setTimeout(tick, 1000);
  }

  // --------------------------------------------------------------------------
  // 事件绑定
  // --------------------------------------------------------------------------

  function bindEvents() {
    // addBtn / drawerAdd 的点击绑定在下面「片源」段 (走片源面板, 不是直接选文件)
    els.closeBtn.addEventListener('click', close);
    els.stopBtn.addEventListener('click', function () { stopPlayback(); });

    // ---- 短剧库 (2026-10-07) ----
    if (els.seriesConnect) {
      els.seriesConnect.addEventListener('click', function () {
        setSeriesAddress(els.seriesUrl ? els.seriesUrl.value : '');
        connectSeriesLibrary();
      });
    }
    if (els.seriesList) {
      els.seriesList.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-key]') : null;
        if (btn) openEpisodeSheet(btn.getAttribute('data-key'));
      });
    }
    if (els.episodeClose) els.episodeClose.addEventListener('click', closeEpisodeSheet);
    if (els.episodeGrid) {
      els.episodeGrid.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-ep]') : null;
        if (!btn) return;
        var ep = parseInt(btn.getAttribute('data-ep'), 10);
        if (ep > 0) playSeriesEpisode(ep);
      });
    }
    // 打开片源面板时, 把上次填的地址带出来并顺手连一次
    if (els.seriesUrl) {
      els.seriesUrl.value = getSeriesAddress();
      if (getSeriesAddress()) setTimeout(function () { connectSeriesLibrary(); }, 260);
    }

    // ---- 聊天 ----
    els.chatToggle.addEventListener('click', function () { setChatPanel(!chatOpen); });
    els.chatClose.addEventListener('click', function () { setChatPanel(false); });
    els.chatSend.addEventListener('click', sendChat);
    els.chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    // 聚焦输入框 = 键盘要弹了, 先把可视视口钉住, 否则 iOS 会把页面顶飞
    els.chatInput.addEventListener('focus', function () { setTimeout(keepViewportPinned, 60); });
    els.keyInput.addEventListener('focus', function () { setTimeout(keepViewportPinned, 60); });

    // ---- 设置面板 (密钥 + 人物立绘) ----
    // 2026-10-04: 原来聊天头部那个「密钥」按钮和 key-box 一起删了, 收进这里。
    els.settingsBtn.addEventListener('click', function () { setSettingsSheet(true); });
    els.settingsClose.addEventListener('click', function () { setSettingsSheet(false); });
    els.keySave.addEventListener('click', saveApiKey);
    // 人物图: 事件委托 (两个 slot 结构一样, 不逐个绑)
    els.settingsSheet.addEventListener('click', function (e) {
      var pick = e.target.getAttribute && e.target.getAttribute('data-char-pick');
      if (pick) { pickCharImage(pick); return; }
      var adj = e.target.getAttribute && e.target.getAttribute('data-char-adjust');
      if (adj) {
        setSettingsSheet(false);   // 先收起设置面板, 否则盖着房间没法拖
        setAdjusting(true);
        return;
      }
      var del = e.target.getAttribute && e.target.getAttribute('data-char-del');
      if (del) { removeCharImage(del); return; }
      // 房间背景 (2026-10-05)
      // ⚠️⚠️ 必须用 hasAttribute, 不能用 getAttribute 判真假!
      //   data-roombg-pick / data-roombg-del 是【无值属性】(HTML 里就写了个名字),
      //   getAttribute 返回空字符串 "" —— falsy —— `if (getAttribute(...))` 永远不进,
      //   结果两个按钮点了完全没反应 (2026-10-05 测试实测)。
      if (e.target.hasAttribute && e.target.hasAttribute('data-roombg-pick')) {
        pickRoomBg();
        return;
      }
      if (e.target.hasAttribute && e.target.hasAttribute('data-roombg-del')) {
        removeRoomBgImage();
      }
    });

    // 房间背景的 change: 先拷字节再清 value (iOS 会 invalidate 已取出的 File)
    const bgInput = document.getElementById('cinema-roombg-file-input');
    if (bgInput) {
      bgInput.addEventListener('change', function (e) {
        const file = e.target.files && e.target.files[0];
        if (!file) { try { e.target.value = ''; } catch (x) {} return; }
        var safe = file;
        try { safe = file.slice(0, file.size, file.type || 'image/png'); } catch (x) { safe = file; }
        try { e.target.value = ''; } catch (x) { /* noop */ }
        saveRoomBgImage(safe);
      });
    }
    document.getElementById('cinema-char-reset').addEventListener('click', resetCharLayouts);
    // 诊断区: 平时收起, 出事时点开看最近发生了什么
    if (els.diagToggle && els.diagBox) {
      els.diagToggle.addEventListener('click', function () {
        els.diagBox.hidden = !els.diagBox.hidden;
        els.diagToggle.textContent = els.diagBox.hidden
          ? '诊断（出问题时展开）'
          : '诊断（点此收起）';
        if (!els.diagBox.hidden) renderDiagBox();
      });
    }
    document.getElementById('cinema-adjust-done').addEventListener('click', function () {
      setAdjusting(false);
    });
    bindCharGestures();
    els.charFileInput.addEventListener('change', function (e) {
      clearCharPickWatchdog();
      var file = e.target.files && e.target.files[0];
      var slot = charPickingSlot;
      charPickingSlot = null;
      diagLogPush('收到文件: ' + (file ? (file.name + ' ' + file.size + 'B') : '(空)') + ' / slot=' + slot);
      if (!file || !slot) {
        try { e.target.value = ''; } catch (x) {}
        diagLogPush('✗ 没拿到文件 —— 请再点一次「选择图片」');
        return;
      }

      // ⚠️⚠️ 这里有个 iOS 的大坑, 修了两次才对 (2026-10-04 用户连续反馈"要点两次"):
      //
      //   直觉写法是 "取完 file 立刻 e.target.value = ''", 然后调 saveCharImage。
      //   错在 saveCharImage 是【async】的 —— 它内部第一件事就是 await ensureCharTable()。
      //   iOS 上把 input.value 置空会【立刻 invalidate】刚取出的 File 对象,
      //   于是 await 恢复后往 Dexie 写的是一个已经死掉的 File, 抛 InvalidStateError
      //   (被 catch 吞掉, 用户看到的就是"点了没反应")。
      //   第二次点之所以能成, 是因为 value 已经是空的, 不会再去 invalidate。
      //
      //   解法: 在清 value 之前先把字节【拷出来】做成一个独立的 Blob。
      //   之后就算 File 死了, 手里这份数据是安全的。
      var safeBlob = null;
      try { safeBlob = file.slice(0, file.size, file.type || 'image/png'); } catch (x) { safeBlob = file; }
      var safeName = file.name || 'image.png';
      var safeSize = file.size || 0;

      try { e.target.value = ''; } catch (x) { /* 某些环境不允许写 value */ }

      // 伪造成一个 File 让下游判图逻辑照常工作 (名字/类型/大小都从原文件抄)
      var payload = safeBlob;
      try {
        payload = new File([safeBlob], safeName, { type: safeBlob.type || 'image/png' });
      } catch (x) {
        payload = safeBlob;
        payload.__name = safeName;
      }
      saveCharImage(slot, payload, safeName, safeSize);
    });

    els.addBtn.addEventListener('click', function () { openSourceSheet(); });
    els.drawerAdd.addEventListener('click', function () { openSourceSheet(); });
    els.srcClose.addEventListener('click', function () { closeSourceSheet(); });
    els.srcLocal.addEventListener('click', function () { closeSourceSheet(); pickFile(); });
    els.drawerToggle.addEventListener('click', function () { setDrawer(!drawerOpen); });
    els.scrim.addEventListener('click', function () { setDrawer(false); });

    els.fileInput.addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      // 重置 value, 否则连续选同一个文件不会触发 change
      e.target.value = '';
      if (file) addLocalFilm(file);
    });

    els.list.addEventListener('click', function (e) {
      const playId = e.target.getAttribute && e.target.getAttribute('data-play');
      const delId = e.target.getAttribute && e.target.getAttribute('data-del');
      if (playId) {
        playFilm(playId).catch(function (err) {
          reportError('播放失败', (err && err.message) || String(err));
        });
        return;
      }
      if (delId) {
        deleteFilm(delId);
      }
    });

    // 关键: 关房时必须把进度落盘, 否则用户中途退出就丢
    els.video.addEventListener('timeupdate', onTimeUpdate);
    els.video.addEventListener('pause', function () { flushProgress(true); });
    els.video.addEventListener('ended', function () {
      flushProgress(true);
      // 自然播完: 不退出房间, 不关 Live, 用户还能继续跟 Gemini 聊
      if (global.CinemaLive) global.CinemaLive.onVideoEnded();
    });
    // 暂停状态下拖进度条不会持续触发 timeupdate, 拖完那一刻必须强制落盘,
    // 否则"拖了进度条就退出应用"会把进度丢掉 (2026-10-04 实测踩到)
    els.video.addEventListener('seeked', function () { flushProgress(true); });
    els.video.addEventListener('loadedmetadata', onLoadedMetadata);

    // 页面被切走 / 关闭前落盘 (iOS 尤其重要)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushProgress(true);
    });
    global.addEventListener('pagehide', function () { flushProgress(true); });

    // 转屏 / 窗口尺寸变化: 顶栏高度会变, 重新量一次
    global.addEventListener('resize', function () {
      if (els.root && els.root.classList.contains('open')) syncTopbarHeight();
    });
    global.addEventListener('orientationchange', function () {
      setTimeout(syncTopbarHeight, 220);   // 等转屏动画结束再量
    });

    // ---- Gemini 3.8 Live 钩子 (cinema-live.js) ----
    // 视频开始播 → 自动连 (没 key 会静默跳过)
    els.video.addEventListener('play', function () {
      if (global.CinemaLive) global.CinemaLive.autoConnect('video play');
    });
    els.video.addEventListener('pause', function () {
      if (global.CinemaLive && global.CinemaLive.isEnabled()) global.CinemaLive.pauseFrames('video pause');
    });
  }

  function pickFile() {
    ensureDom();
    els.fileInput.click();
  }

  function setDrawer(open) {
    ensureDom();
    drawerOpen = open;
    els.drawer.classList.toggle('open', open);
    els.scrim.hidden = !open;
  }

  // --------------------------------------------------------------------------
  // 加入本地影片
  // --------------------------------------------------------------------------

  async function addLocalFilm(file) {
    ensureDom();
    if (!file) return;

    // 软警告: 超 300MB 提示但不阻止 (2026-10-04 决策)
    let softWarn = null;
    try {
      softWarn = await S.checkSoftWarn(file.size);
    } catch (e) { /* 拿不到配额就跳过检查 */ }

    let record;
    try {
      record = await S.addFilm(file, { name: stripExt(file.name) });
    } catch (e) {
      reportError('保存失败', describeSaveError(e));
      return;
    }

    await refreshList();
    if (softWarn && softWarn.warn) {
      showCapacityWarn(
        '本地影片已 ' + S.formatBytes(softWarn.total) + '，超过 300MB 提醒线。' +
        '可以继续添加，但手机存储吃紧时影片可能被系统清理，建议删掉不常看的。'
      );
    }
    await playFilm(record.id);
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[^/.]+$/, '');
  }

  function describeSaveError(e) {
    const msg = (e && e.message) || String(e);
    if (/quota/i.test(msg)) {
      return '手机存储空间不够，影片没能存下来。可以在片单里删掉几部旧影片腾出空间再试。';
    }
    // schema 类错误: 存储层已经自愈过一次还是失败, 那就是真的没救了, 只能刷新
    if (/v6[56]|schema|数据表缺失/i.test(msg)) {
      return msg + '\n\n刷新一下页面再试一次，还是不行就是版本没更新对。';
    }
    return '影片没能存进本地数据库：' + msg;
  }

  // --------------------------------------------------------------------------
  // 播放
  // --------------------------------------------------------------------------

  /** 浏览器能否原生播 HLS (iOS Safari / Safari 桌面: 能; Chrome: 不能) */
  function canPlayNativeHls() {
    try {
      const v = document.createElement('video');
      return !!(v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl'));
    } catch (e) { return false; }
  }

  function destroyHls() {
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) { /* noop */ }
      hlsInstance = null;
    }
  }

  async function playFilm(id) {
    ensureDom();
    flushProgress(true);

    const film = await S.getFilm(id);
    if (!film) return;

    // 进度在 cinemaProgress 表, 不在 cinemaFilms 里 —— getFilm 不做 join,
    // 必须单独读, 否则续播永远是 0 (2026-10-04 实测踩到过这个坑)
    const saved = await S.getProgress(id);
    const resumeTime = saved && saved.currentTime ? saved.currentTime : 0;

    // 先把旧片当前进度记住, 别被新片覆盖
    if (currentFilmId && currentFilmId !== id) {
      await S.saveProgress(currentFilmId, els.video.currentTime, els.video.duration || 0);
    }

    if (film.sourceType === 'url') {
      if (!film.url) { reportError('无法播放', '这部片子的链接已经没了。'); return; }
      setVideoSrc(film.url, film, resumeTime);
      return;
    }

    const file = await S.getFilmFile(id);

    // 关键路径: File 对象 -> createObjectURL 只是引用, 堆占用 O(1)
    // 取不到 / 取坏了 (iOS 长期不用会清掉站点数据, Blob 可能已被驱逐) 都归到这一支,
    // 给可读的提示, 而不是让 createObjectURL 抛 "Overload resolution failed"。
    if (!file || !file.size || typeof URL.createObjectURL !== 'function') {
      stopPlayback();
      reportError('影片本体不在了',
        '《' + film.name + '》的文件读不出来了（可能是手机系统清理了长期没用的数据，或存储已损坏）。' +
        '请重新添加一次这部影片，片单条目和播放进度会保留。');
      return;
    }

    setVideoSrc(URL.createObjectURL(file), film, resumeTime);
  }

  function setVideoSrc(url, film, resumeTime) {
    // 换片前 revoke 旧的, 否则 blob 一直挂着不释放
    destroyHls();
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    if (url.indexOf('blob:') === 0) currentObjectUrl = url;

    // Gemini: 换片 = 旧 watch session 作废, 重开一轮
    // (旧 session 的剧情摘要是临时记忆, 不会写长期记忆, 直接丢弃)
    if (global.CinemaLive) global.CinemaLive.onVideoSourceChanged();

    currentFilmId = film.id;
    pendingResumeTime = resumeTime || 0;
    lastSavedAt = 0;

    // HLS: iOS Safari 原生支持 .m3u8; Android / 桌面 Chrome 需要 hls.js
    // (330 主页面已经加载了 hls.js, 这里直接复用, 不重复引)
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && global.Hls && global.Hls.isSupported() && !canPlayNativeHls()) {
      try {
        hlsInstance = new global.Hls({ enableWorker: true });
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(els.video);
        hlsInstance.on(global.Hls.Events.ERROR, function (_evt, data) {
          if (data && data.fatal) reportError('播放失败', 'HLS 流打不开：' + (data.details || data.type || ''));
        });
      } catch (e) {
        reportError('播放失败', 'HLS 初始化失败：' + ((e && e.message) || e));
        return;
      }
    } else {
      els.video.src = url;
    }
    els.idle.hidden = true;
    // 片名: 用户 2026-10-04 反馈"上方多了一个文件名, 其实可以不要显示" → 永久隐藏。
    //   文本照旧写进去 (调试/测试还能读到), 但 hidden 不解除。
    els.nowPlaying.textContent = film.name;
    els.nowPlaying.hidden = true;
    els.stopBtn.hidden = false;
    syncTopbarHeight();
    setDrawer(false);

    const p = els.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () { /* 自动播放被拦是正常的, 用户点一下播放 */ });
    }
    // 换片后立刻重打一次光; 之后由 timeupdate 跟着视频颜色持续更新
    updateAmbient(true);
    // 大屏尺寸切换有 .32s 过渡, 过渡结束再对一次位置
    setTimeout(function () { updateAmbient(true); }, 360);
  }

  // 元数据就绪后才能 seek, 否则赋值会被忽略
  function onLoadedMetadata() {
    applyScreenAspect();
    const d = els.video.duration || 0;
    const t = pendingResumeTime;
    pendingResumeTime = 0;
    if (t > 0 && (!d || t < d - RESUME_TAIL_GUARD)) {
      try {
        els.video.currentTime = t;
        if (global.console) console.log('[CinemaRoom] 续播到', t.toFixed(1) + 's /', d.toFixed(1) + 's');
      } catch (e) { /* seek 失败不致命 */ }
    }
  }

  // 大屏随视频比例换向: 16:9 横屏片 -> 横向大屏, 9:16 竖屏短剧 -> 竖向大屏。
  // 竖屏大屏会盖住沙发和人物位 —— 这是有意的, 竖屏短剧就该看满, 不为背景缩视频。
  function applyScreenAspect() {
    if (!els.screen) return;
    const w = els.video.videoWidth;
    const h = els.video.videoHeight;
    els.screen.classList.remove('is-landscape', 'is-portrait', 'is-square');
    if (!w || !h) { els.screen.classList.add('is-landscape'); return; }
    const r = w / h;
    if (r >= 1.15) els.screen.classList.add('is-landscape');
    else if (r <= 0.87) els.screen.classList.add('is-portrait');
    else els.screen.classList.add('is-square');
    if (global.console) console.log('[CinemaRoom] 大屏方向 ' + w + 'x' + h + ' ratio=' + r.toFixed(2));
  }

  // --------------------------------------------------------------------------
  // 进度
  // --------------------------------------------------------------------------

  function onTimeUpdate() {
    // 时间轴用 <video> 原生 controls 显示, 不再自绘覆盖层 ——
    // 自绘那条压在画面底部, 正好盖住视频自带的字幕 (2026-10-04 手机实测发现)
    flushProgress(false);
    updateAmbient(false);
  }

  function flushProgress(force) {
    if (!currentFilmId) return;
    const now = Date.now();
    if (!force && now - lastSavedAt < PROGRESS_THROTTLE) return;
    lastSavedAt = now;
    S.saveProgress(currentFilmId, els.video.currentTime, els.video.duration || 0);
  }

  // --------------------------------------------------------------------------
  // 片单
  // --------------------------------------------------------------------------

  async function refreshList() {
    ensureDom();
    let films = [];
    let usage = null;
    try {
      films = await S.listFilms();
      usage = await S.getUsage();
    } catch (e) {
      els.list.innerHTML = '<div class="cinema-drawer-empty">片单读不出来：' +
        ((e && e.message) || e) + '</div>';
      return;
    }

    if (films.length === 0) {
      els.list.innerHTML = '<div class="cinema-drawer-empty">片单还是空的<br>点上面「+ 添加」选一个本地视频</div>';
    } else {
      els.list.innerHTML = films.map(function (f) {
        const resumed = f.currentTime > 0 && (!f.duration || f.currentTime < f.duration - RESUME_TAIL_GUARD);
        const pct = f.duration > 0 ? Math.min(100, (f.currentTime / f.duration) * 100) : 0;
        return [
          '<div class="cinema-film-item' + (f.id === currentFilmId ? ' active' : '') + '" data-id="' + f.id + '">',
          '  <div class="cinema-film-main">',
          '    <div class="cinema-film-name">' + escapeHtml(f.name) + '</div>',
          '    <div class="cinema-film-meta">' + escapeHtml(f.sourceType === 'url' ? '在线片源' : S.formatBytes(f.size)) +
                 (resumed ? ' · 看到 ' + S.formatTime(f.currentTime) : '') + '</div>',
          '  </div>',
          '  <div class="cinema-film-actions">',
          '    <button class="cinema-film-play" data-play="' + f.id + '">播放</button>',
          '    <button class="cinema-film-del" data-del="' + f.id + '">删</button>',
          '  </div>',
          '  <div class="cinema-film-progress"><div class="cinema-film-progress-fill" style="width:' + pct.toFixed(2) + '%"></div></div>',
          '</div>'
        ].join('');
      }).join('');
    }

    if (usage) {
      let txt = '已存 ' + usage.filmCount + ' 部 · ' + S.formatBytes(usage.filmBytes);
      if (usage.quota) txt += ' / 可用 ' + S.formatBytes(usage.quota);
      els.usage.textContent = txt;
      if (usage.overSoftWarn) {
        showCapacityWarn('本地影片已占 ' + S.formatBytes(usage.filmBytes) + '，超过 300MB 提醒线。手机存储吃紧时影片可能被系统清理，建议删掉不常看的。');
      } else {
        els.warn.hidden = true;
      }
    }
  }

  async function deleteFilm(id) {
    ensureDom();
    const film = await S.getFilm(id);
    if (!film) return;

    const sizeTxt = S.formatBytes(film.size || 0);
    let ok = true;
    if (global.showCustomConfirm) {
      ok = await global.showCustomConfirm('删除影片',
        '确定要从片单删掉《' + film.name + '》吗？\n会一并删除影片本体（约 ' + sizeTxt + '）和它的播放进度，删了就找不回来了。');
    } else if (global.confirm) {
      ok = global.confirm('确定要从片单删掉《' + film.name + '》吗？');
    }
    if (!ok) return;

    // 正在播这部就先停掉, 否则 blob 一直挂在 video 上
    if (currentFilmId === id) stopPlayback();
    await S.removeFilm(id);
    await refreshList();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showCapacityWarn(text) {
    ensureDom();
    els.warn.textContent = text;
    els.warn.hidden = false;
  }

  // --------------------------------------------------------------------------
  // 屏幕环境光 (v0.3.0)
  // 把当前帧缩到 8x8 取平均色, 铺成大屏后面的一层柔光。
  // 效果: 屏幕亮起时房间被屏幕的颜色照亮, 屏幕成为房间的主要视觉光源。
  // blob URL 是同源的, 所以 drawImage 不会被跨域污染挡住。
  // --------------------------------------------------------------------------

  const AMBIENT_INTERVAL = 1800;
  let ambientCanvas = null;
  let lastAmbientAt = 0;
  let ambientFallbackRgb = null;

  function updateAmbient(force) {
    if (!els.ambient) return;
    const now = Date.now();
    if (!force && now - lastAmbientAt < AMBIENT_INTERVAL) return;
    lastAmbientAt = now;

    const v = els.video;
    if (!v || !v.videoWidth || v.readyState < 2) {
      // 还没出画面: 待机暖光
      if (!ambientFallbackRgb) ambientFallbackRgb = ambientRgbToCss(255, 214, 168);
      paintAmbient(ambientFallbackRgb, 0.26);
      els.ambient.classList.add('is-on');
      return;
    }

    try {
      if (!ambientCanvas) ambientCanvas = document.createElement('canvas');
      if (ambientCanvas.width !== 8) { ambientCanvas.width = 8; ambientCanvas.height = 8; }
      const ctx = ambientCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, 8, 8);
      const data = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      paintAmbient(ambientRgbToCss(r / n, g / n, b / n), 0.30);
      els.ambient.classList.add('is-on');
    } catch (e) {
      // 某些浏览器对跨域视频会抛 SecurityError, 退回暖光即可, 不影响播放
      if (!ambientFallbackRgb) ambientFallbackRgb = ambientRgbToCss(255, 214, 168);
      paintAmbient(ambientFallbackRgb, 0.22);
      els.ambient.classList.add('is-on');
    }
  }

  function ambientRgbToCss(r, g, b) {
    return [
      Math.max(0, Math.min(255, Math.round(r))),
      Math.max(0, Math.min(255, Math.round(g))),
      Math.max(0, Math.min(255, Math.round(b)))
    ];
  }

  function paintAmbient(rgb, alpha) {
    if (!els.ambient) return;
    const s = els.screen.getBoundingClientRect();
    const host = els.ambient.parentElement.getBoundingClientRect();
    if (!s.width || !host.width) return;
    const w = s.width * 2.5;
    const h = Math.max(s.height * 2.2, 190);
    els.ambient.style.width = w + 'px';
    els.ambient.style.height = h + 'px';
    els.ambient.style.top = (s.top - host.top - (h - s.height) / 2) + 'px';
    els.ambient.style.background =
        'radial-gradient(closest-side, rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + '),' +
        ' rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (alpha * 0.34).toFixed(3) + ') 55%,' +
        ' rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0) 100%)';
  }

  function stopAmbient() {
    if (els.ambient) els.ambient.classList.remove('is-on');
  }

  // --------------------------------------------------------------------------
  // 停止播放
  // 只停片, 不退房间 —— 右上角 ✕ 才是退房间。两者分开是 2026-10-04 用户明确要求的。
  // 进度会先落盘, 之后从片单点"播放"能接着看。
  //
  // ⚠️ 2026-10-07 修正: 这里原来调的是 onVideoSourceChanged() (那是"换片"的钩子),
  // 而那函数内部会 disable() 掉整个 Gemini Live + 清空 currentPlotSummary。
  // 后果: 用户点【停止】再点【退出】, 退出流程在 runFinalSummaryFlow 的守卫
  // (if (!S.enabled || ...)) 处直接短路 —— 观影记忆一个字都存不下来,
  // 连已经攒好的 5 分钟摘要也被一起清了。
  //
  // 现在【停止】只做它该做的: 停视频元素 + 停视频帧。
  // Live 会话和摘要原样保留, 退出时还能正常精炼并写入长期记忆。
  // --------------------------------------------------------------------------

  function stopPlayback() {
    ensureDom();
    flushProgress(true);
    if (global.CinemaLive) global.CinemaLive.pauseFrames('用户停止播放');
    destroyHls();
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    els.video.removeAttribute('src');
    els.video.load();
    currentFilmId = null;
    pendingResumeTime = 0;
    els.idle.hidden = false;
    els.nowPlaying.textContent = '';
    els.stopBtn.hidden = true;
    stopAmbient();
    Promise.resolve(refreshList()).catch(function () { /* 片单刷新失败不影响停止 */ });
  }

  // --------------------------------------------------------------------------
  // 在线片源 (本地 / 直链 / B站 / 片库)
  // --------------------------------------------------------------------------

  function openSourceSheet() {
    ensureDom();
    setDrawer(false);
    setChatPanel(false);
    els.srcSheet.classList.add('open');
  }

  function closeSourceSheet() {
    ensureDom();
    els.srcSheet.classList.remove('open');
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ==========================================================================
  // 短剧库 (2026-10-07)
  //
  // 电脑上的短剧下载目录 → 通过自建 https 服务读出 → 手机上选集连着看。
  //
  // 为什么不用短剧库自己的播放接口:
  //   它的 /api/ui/playback/* 要占播放名额(全机 4 个)、断线要重连、已下好的文件
  //   也照样走流式会话。这里直接读磁盘上完整的 NNN.mp4, 原生支持 Range,
  //   不占名额、不占手机空间、电脑下完新一集刷新就有。
  //
  // ⚠️ 地址存哪: localStorage。不是 IndexedDB —— 换设备/清缓存丢了就再填一次,
  //    不值得占一张表。
  // ==========================================================================

  const SERIES_ADDR_KEY = 'cinema-series-address';
  let seriesLibrary = null;        // { dramas: [...] } —— 拉的片单
  let seriesPicked = null;         // 当前选中的剧
  let seriesLastEp = 0;            // 已看到第几集 (决定播完记第几集)

  function getSeriesAddress() {
    try { return (localStorage.getItem(SERIES_ADDR_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setSeriesAddress(v) {
    try { localStorage.setItem(SERIES_ADDR_KEY, String(v || '').trim()); } catch (e) { /* 无痕模式 */ }
  }

  /** 归一化: 去掉尾部 / , 拼出 api 路径 */
  function seriesApi(path) {
    var base = getSeriesAddress().replace(/\/+$/, '');
    if (!base) return '';
    return base + path;
  }

  function mediaUrl(key, ep) {
    // ⚠️ 必须补齐 3 位: 磁盘文件名是 001.mp4, 而片单里的集号是数字 1。
    //    直接拼 "1.mp4" 服务端 stat 不到 → 404 (踩过: 前 99 集全 404, 100 集往后正常)
    var n = Number(ep);
    var name = (n >= 0 && n <= 9999) ? String(n).padStart(3, '0') + '.mp4' : '0.mp4';
    return seriesApi('/media/' + encodeURIComponent(key) + '/' + name);
  }

  function setSeriesState(text, kind) {
    if (!els.seriesState) return;
    els.seriesState.textContent = text || '';
    els.seriesState.className = 'cinema-set-state' + (kind ? ' is-' + kind : '');
  }

  /** 连服务 + 拉片单 */
  function connectSeriesLibrary() {
    var url = getSeriesAddress();
    if (!url) { setSeriesState('还没填地址。先在电脑上跑起来，然后填上面的地址。', 'warn'); return Promise.resolve(false); }

    setSeriesState('连接中…');

    // 🔴 2026-10-07 用户实测「一直显示连接中, 也不连, 也不结束让人重新连」。
    //
    //   原因: fetch 没有超时。iOS 18+ 的私有网络访问预检被卡住时,
    //   浏览器【既不 resolve 也不 reject】—— 它就在那儿挂着。
    //   于是 setSeriesState('连接中…') 永远不变, 用户既等不到结果,
    //   也点不了「重试」。这不是加载慢, 是请求永远不会结束。
    //
    //   修法: AbortController + 12 秒超时。超了就明确报错, 让用户能重来。
    //   (服务端侧还补了 Access-Control-Allow-Private-Network, 见 server.mjs)
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;

    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(seriesApi('/api/library'), opts)
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        seriesLibrary = data;
        var n = (data.dramas || []).length;
        setSeriesState('已连接 · ' + n + ' 部剧 / ' +
          (data.dramas || []).reduce(function (a, d) { return a + d.count; }, 0) + ' 集', 'ok');
        renderSeriesList();
        return true;
      })
      .catch(function (err) {
        seriesLibrary = null;
        if (timer) clearTimeout(timer);
        // 超时和网络失败要分开说 —— iOS 弹过「允许访问本地网络」被拒绝时
        // 也表现为连不上, 但那是权限问题, 让人重试没用, 得让他去设置里开。
        var msg = (err && err.name === 'AbortError')
          ? '连接超时（12 秒没回应）。'
            + '\n如果是第一次用，iOS 可能弹过「允许访问本地网络」—— 没看到或点了拒绝的话，'
            + '去 设置 → 无线局域网 → 找到这个 WiFi 旁边的小字，点「允许」。'
            + '顺便确认：电脑开着、短剧服务窗口没关、手机连的是同一个 WiFi。'
          : '连不上：' + (err && err.message || err) +
            '\n确认电脑开着、短剧服务窗口没关、手机连同一个 WiFi、地址对。'
            + '\n（iOS 第一次访问局域网设备会问「允许访问本地网络」，要选允许。）';
        setSeriesState(msg, 'err');
        return false;
      });
  }

  function renderSeriesList() {
    if (!els.seriesList) return;
    if (!seriesLibrary || !(seriesLibrary.dramas || []).length) {
      els.seriesList.innerHTML = '<div class="cinema-series-empty">电脑上还没有下好的剧</div>';
      els.seriesList.hidden = false;
      return;
    }
    els.seriesList.innerHTML = seriesLibrary.dramas.map(function (d) {
      return '<button class="cinema-series-item" data-key="' + escHtml(d.key) + '">' +
        '<span class="cinema-series-name">' + escHtml(d.title) + '</span>' +
        '<span class="cinema-series-count">' + d.count + ' 集</span>' +
        '</button>';
    }).join('');
    els.seriesList.hidden = false;
  }

  /** 打开选集面板 */
  function openEpisodeSheet(key) {
    if (!seriesLibrary) return;
    seriesPicked = null;
    for (var i = 0; i < seriesLibrary.dramas.length; i++) {
      if (seriesLibrary.dramas[i].key === key) { seriesPicked = seriesLibrary.dramas[i]; break; }
    }
    if (!seriesPicked) return;

    if (els.episodeTitle) els.episodeTitle.textContent = seriesPicked.title;
    // 从哪一集接着看: 读本地记录, 没记过就第 1 集
    var saved = readSeriesProgress(key);
    var resume = saved > 0 ? saved + 1 : 1;
    if (resume > seriesPicked.last) resume = seriesPicked.first;
    seriesLastEp = saved;

    if (els.episodeMeta) {
      els.episodeMeta.textContent = '共 ' + seriesPicked.count + ' 集（第 ' +
        seriesPicked.first + '–' + seriesPicked.last + ' 集）' +
        (saved > 0 ? ' · 上次看到第 ' + saved + ' 集' : '');
    }
    renderEpisodeGrid();
    if (els.episodeSheet) els.episodeSheet.classList.add('open');
    closeSourceSheet();
  }

  function renderEpisodeGrid() {
    if (!els.episodeGrid || !seriesPicked) return;
    var eps = seriesPicked.episodes || [];
    var html = eps.map(function (ep) {
      var watched = ep <= seriesLastEp;
      var next = (seriesLastEp > 0 && ep === seriesLastEp + 1);
      return '<button class="cinema-ep' + (watched ? ' watched' : '') + (next ? ' next' : '') +
        '" data-ep="' + ep + '">' + ep + '</button>';
    }).join('');
    els.episodeGrid.innerHTML = html;
  }

  function closeEpisodeSheet() {
    if (els.episodeSheet) els.episodeSheet.classList.remove('open');
  }

  /** 本地记"看到第几集" */
  function readSeriesProgress(key) {
    try {
      var raw = localStorage.getItem('cinema-series-progress');
      if (!raw) return 0;
      var map = JSON.parse(raw) || {};
      return Number(map[key]) || 0;
    } catch (e) { return 0; }
  }
  function writeSeriesProgress(key, ep) {
    try {
      var raw = localStorage.getItem('cinema-series-progress');
      var map = {};
      try { map = raw ? (JSON.parse(raw) || {}) : {}; } catch (e) { map = {}; }
      map[key] = ep;
      // 只留最近 20 部, 别无限长
      var keys = Object.keys(map);
      if (keys.length > 20) {
        keys.sort(function (a, b) { return (map[b] || 0) - (map[a] || 0); });
        keys.slice(20).forEach(function (k) { delete map[k]; });
      }
      localStorage.setItem('cinema-series-progress', JSON.stringify(map));
    } catch (e) { /* 无痕模式 */ }
  }

  /**
   * 播一集。
   * ⚠️ 关键: 不走 S.addFilm / setVideoSrc 那条路 —— 那条路会把内容当【本地影片】
   * 存进 IndexedDB, 而短剧是远程的, 存不得也存不下。这里直接给 video.src。
   */
  function playSeriesEpisode(ep) {
    if (!seriesPicked) return;
    var url = mediaUrl(seriesPicked.key, ep);
    seriesLastEp = ep - 1;          // 还没看完这一集, 上一集才算看过
    writeSeriesProgress(seriesPicked.key, ep);

    closeEpisodeSheet();

    // 告诉 Gemini: 这是短剧模式, 后面按集总结
    if (global.CinemaLive) {
      global.CinemaLive.setSeries(seriesPicked.key, seriesPicked.title);
      var st = global.CinemaLive.getSeriesState();
      global.CinemaLive.setSeriesProgress(seriesPicked.key, seriesPicked.title,
        Math.max(0, st.lastEp || 0), st.outline || '');
    }

    // ⚠️ 换集【不清场、不重连】—— 只把这次的播放时长结掉, 让下一集重新起 5 分钟。
    if (global.CinemaLive) global.CinemaLive.onSeriesEpisodeChanged();

    destroyHls();
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }

    currentFilmId = null;           // 不是本地影片 → 不参与本地进度
    pendingResumeTime = 0;
    lastSavedAt = 0;

    els.video.src = url;
    els.idle.hidden = true;
    els.stopBtn.hidden = false;
    syncTopbarHeight();
    setDrawer(false);

    var p = els.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () { /* 自动播放被拦是正常的, 用户点一下播放 */ });
    }
    updateAmbient(true);
    setTimeout(function () { updateAmbient(true); }, 360);
  }

    
  // --------------------------------------------------------------------------
  // 聊天面板 (Cinema Room 自己的 UI)
  //
  // 布局对齐 KI-CO (styles.css:7710-7716 手机端 media query):
  //   它的做法是 video 缩成顶部一条 220px 的横条, 面板在下方 —— 视频和面板同时可见。
  //   ⚠️ 2026-10-04 用户指出: 我之前做成了右侧全高抽屉直接盖住视频, 看剧不能聊、聊不能看剧。
  //   现在改成: 聊天打开时视频缩到顶部, 聊天面板在下半屏 (半透明), 两者同时可见。
  // --------------------------------------------------------------------------

  function setChatPanel(open) {
    ensureDom();
    chatOpen = !!open;
    els.chatPanel.classList.toggle('open', chatOpen);
    // 房间加一个状态类: 视频缩到刚好, 聊天吃满剩下的 (KI-CO 的做法)
    els.root.classList.toggle('is-chatting', chatOpen);
    // 聊天区高度变了, 视频可用高度也变了 -> 重新量
    setTimeout(function () { syncTopbarHeight(); syncVisualViewport(); }, 320);
    if (chatOpen) {
      setDrawer(false);
      // 剧情条常驻在聊天面板顶上, 打开时主动刷一次
      if (global.CinemaLive) global.CinemaLive.renderPlotPanel();

      // 🔴 2026-10-06 修复: 原来这里是「没填 key 就直接把设置面板推出来」。
      //
      //   症状: 点 Cinema 聊天按钮 → 一个标题写着「设置」的整屏面板从底部滑上来,
      //         盖住整个房间 (z-index 99995, 比聊天面板 6 高三个数量级),
      //         退出按钮点不到; 而且 sendChat() 每次发送都会再调一次
      //         setChatPanel(true), 于是面板反复弹回来 —— 表现为「卡住、关不掉」。
      //         用户第一反应是「330 的 Settings 自己冒出来了」, 其实这是 Cinema
      //         自己的 #cinema-settings-sheet, 全局 showScreen 一次都没被调用
      //         (取证: showScreen 调用次数 = 0)。
      //
      //   为什么原来会走到这个分支: hasKey() 读的是【当前活跃聊天】的
      //   watchTogetherSettings.geminiApiKey (cinema-live.js:1408)。从首页直接
      //   进影院、或者切过角色, 这个字段可能就是空的 —— 于是每次开聊天都判定
      //   「没填」, 每次都强推面板。
      //
      //   现在: 聊天照常打开, 只给一条 3 秒自动消失、不遮挡任何东西的提示条。
      //   真要填 key 仍然点房间右上角的齿轮 —— 那条路径一行都没改。
      //   sendChat() 里本来就还有一条「Gemini 还没连上」的友好提示, 没删。
      if (global.CinemaLive && !global.CinemaLive.hasKey() && typeof global.showToast === 'function') {
        global.showToast('还没填 Gemini Live 密钥, 这轮 Gemini 不会接话。要填点右上角齿轮。');
      }
    } else {
      keepViewportPinned();
    }
  }

  function sendChat() {
    ensureDom();
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = '';
    setChatPanel(true);   // ← 原来写成 if (!setChatPanel(true)) return;
                         //   setChatPanel 没有 return, 恒返回 undefined,
                         //   !undefined 恒为 true —— 消息在这被静默吞掉, 一次都发不出去。

    // Live 已接管 → 走 Live; 否则提示需要先连
    if (global.CinemaLive && global.CinemaLive.handleUserMessage(text)) return;
    if (global.showCustomAlert) {
      global.showCustomAlert('Gemini 还没连上',
        '先在房间右上角「设置」里填 Gemini Live API Key，然后播放视频，Gemini 就会连进来陪你一起看。');
    } else {
      alert('先在设置里填 Gemini Live API Key 再聊天');
    }
  }

  // --------------------------------------------------------------------------
  // 设置面板
  // --------------------------------------------------------------------------

  async function setSettingsSheet(open) {
    ensureDom();
    const on = open !== false;
    els.settingsSheet.classList.toggle('open', on);
    if (on) {
      setDrawer(false);
      closeSourceSheet();
      if (global.CinemaLive) els.keyInput.value = global.CinemaLive.getGeminiKey() || '';
      renderKeyState();
      await refreshCharEditor();   // async: 直接从 IDB 读, 保证缩略图立刻是准的
    } else {
      keepViewportPinned();
    }
  }

  function renderKeyState() {
    const has = !!(global.CinemaLive && global.CinemaLive.hasKey());
    els.keyState.textContent = has ? '已填写，播放视频时会自动连进来。' : '还没填，Gemini 不会连进来。';
    els.keyState.classList.toggle('ok', has);
  }

  function saveApiKey() {
    ensureDom();
    if (!global.CinemaLive) return;
    const key = els.keyInput.value.trim();
    global.CinemaLive.setGeminiKey(key).then(function (ok) {
      if (!ok) {
        if (global.showCustomAlert) global.showCustomAlert('保存失败', '没找到当前的聊天记录，key 存不进去。');
        return;
      }
      renderKeyState();
      if (global.showCustomAlert) {
        global.showCustomAlert('已保存', key
          ? 'Gemini Live API Key 已存到本机。现在播放视频就会自动连进来。'
          : '已清空，Gemini 不会再自动连接。');
      }
    });
  }

  // --------------------------------------------------------------------------
  // 人物立绘 (沙发上那两个人)
  //
  // 图片【直接存 Blob 进 IndexedDB】, 绝不转 base64 —— 跟影片一个道理。
  // 房间背景只负责背景/大屏/沙发, 人物是独立 HTML 层, 这样才敢做互动。
  //
  // 【位置和大小由用户拖, 不由代码猜】2026-10-04 真机效果:
  //   两张立绘的留白/人物占比完全不同, 我在 CSS 里写死位置的结果是
  //   "左边坐太高 + 两边大小不一致"。用户原话: "图片大小形象不一样,
  //   你很难具体框定范围, 可以搞成用户自己用手长按人物图片移动缩放吗?"
  //   —— 采纳。所以下面有一套完整的拖动 + 捏合手势, 调完存进 IDB。
  // --------------------------------------------------------------------------

  // 当前正在为哪个 slot 选图 (共用一个 file input)
  let charPickingSlot = null;
  // 房间里的 object URL, 换图/退房要 revoke
  const charUrls = { left: null, right: null, table: null };
  // 各个 slot 的中文名。UI 上不要再写 slot === 'left' ? '左边' : '右边' 这种
  // 二选一的表达式 —— 加了茶几之后它会错 (茶几会被显示成"右边")。
  const SLOT_LABEL = { left: '左边', right: '右边', table: '茶几' };
  // 每个 slot 的位置/缩放。x/y 是相对房间背景层的百分比, scale 是倍数。
  // 内存里这份是"正在拖的当前值", 拖完才写回 IDB (别每帧都写盘)。
  // ⚠️ 默认值统一从存储层取 (S.defaultLayoutFor), 别在这儿再写一份 ——
  //    两边不一致会导致"存图写 50/50、渲染写 26/74", 人物一进房就跳到中间 (踩过)。
  const charLayout = {
    left: S.defaultLayoutFor('left'),
    right: S.defaultLayoutFor('right'),
    table: S.defaultLayoutFor('table')
  };

  // ---- 调整模式 ----
  let adjusting = false;
  // 当前正在拖的 slot + 手势状态
  let drag = null;

  function setAdjusting(on) {
    ensureDom();
    adjusting = !!on;
    els.root.classList.toggle('is-adjusting', adjusting);
    const bar = document.getElementById('cinema-adjust-bar');
    if (bar) bar.hidden = !adjusting;
    // 待机遮罩是 z-index 更高的一整块, 会把人物完全盖住 —— 调位置时必须藏掉,
    // 否则用户明明看到人却点不到 (2026-10-04 测试撞到: elementFromPoint 返回 idle 层)。
    if (els.idle) els.idle.style.pointerEvents = adjusting ? 'none' : '';
    if (!adjusting) {
      drag = null;
      // 退房/点完成都要落盘, 不能只在"刚才正在拖"时才存 ——
      // 用户调完就退房间是很常见的用法。
      saveAllCharLayouts();
    }
    updateDragHint();
  }

  async function saveAllCharLayouts() {
    for (const slot of S.CHAR_SLOTS) {
      if (!charUrls[slot]) continue;   // 没图的 slot 不建记录
      try { await S.setCharLayout(slot, charLayout[slot]); }
      catch (e) { /* 存不上也先别打断用户 */ }
    }
  }

  /** 房间坐标 → 百分比。房间层是人物定位的参照系, 不是视口。 */
  function roomRect() {
    const bg = els.root.querySelector('.cinema-room-bg') || els.root;
    return bg.getBoundingClientRect();
  }

  function pointerCenter() {
    const pts = Array.from(drag.pointers.values());
    return {
      cx: pts.reduce(function (s, p) { return s + p.x; }, 0) / pts.length,
      cy: pts.reduce(function (s, p) { return s + p.y; }, 0) / pts.length
    };
  }

  function pointerDist() {
    const pts = Array.from(drag.pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /** 双指快照: 中点 + 距离。缩放和整体平移都基于它。 */
  function pinchSnapshot(touches) {
    if (!touches || touches.length < 2) return { cx: 0, cy: 0, dist: 0 };
    const a = touches[0], b = touches[1];
    return {
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    };
  }

  function bindCharGestures() {
    S.CHAR_SLOTS.forEach(function (slot) {
      const node = els.charSlot[slot];
      if (!node) return;

      // ------------------------------------------------------------------
      // 双指捏合走 touch 事件, 单指拖动走 pointer 事件。
      //
      // 【为什么分开】iOS Safari 上多指捏合用 pointer 事件时, 第二根手指的
      // pointerdown 经常【不落在同一个元素上】(系统把它派给了父容器), 于是
      // pointers 里永远只有一个, 捏合没反应。touch 事件的 touches 数组是
      // 【整屏级别】的, 不管落在哪个元素上都能收到 —— 捏合必须走它。
      // 单指则反过来: touch 在某些 WebView 里会被浏览器自己滚走抢走, pointer
      // 更稳。所以两条路并存, 各管各的。
      // ------------------------------------------------------------------
      node.addEventListener('touchstart', function (e) {
        if (!adjusting) return;
        if (e.touches.length < 2) return;    // 单指交给 pointer 那条路
        e.preventDefault();
        if (!drag || drag.slot !== slot) {
          // pointer 那边可能没建 drag (比如第二根手指先落), 这里补一个
          const L = charLayout[slot];
          drag = { slot: slot, pointers: new Map(), startLayout: { x: L.x, y: L.y, scale: L.scale } };
        }
        drag.pinchStart = pinchSnapshot(e.touches);
        drag.pinchBaseScale = charLayout[slot].scale;
        drag.pinchBaseLayout = { x: charLayout[slot].x, y: charLayout[slot].y };
        drag.moved = true;
        updateDragHint();
      }, { passive: false });

      node.addEventListener('touchmove', function (e) {
        if (!adjusting || !drag || drag.slot !== slot) return;
        if (e.touches.length < 2) return;
        e.preventDefault();
        const s = pinchSnapshot(e.touches);
        if (drag.pinchStart && drag.pinchStart.dist > 8) {
          const L = charLayout[slot];
          L.scale = clamp(drag.pinchBaseScale * (s.dist / drag.pinchStart.dist), 0.35, 2.6);
          // 捏合同时允许整体平移 (双指中点移动)
          const rect = roomRect();
          if (rect.width && rect.height) {
            L.x = clamp(drag.pinchBaseLayout.x + (s.cx - drag.pinchStart.cx) / rect.width * 100, -15, 115);
            L.y = clamp(drag.pinchBaseLayout.y + (s.cy - drag.pinchStart.cy) / rect.height * 100, -15, 115);
          }
          applyCharTransform(slot);
          updateDragHint();
        }
      }, { passive: false });

      node.addEventListener('touchend', function (e) {
        if (!drag || drag.slot !== slot) return;
        if (e.touches.length === 0 && drag.pinchStart) {
          drag.pinchStart = null;
          S.setCharLayout(slot, charLayout[slot]).catch(function () {});
        }
      }, { passive: false });

      // ---------- 单指拖动 (pointer) ----------
      node.addEventListener('pointerdown', function (e) {
        if (!adjusting) return;
        e.preventDefault();
        try { node.setPointerCapture(e.pointerId); } catch (err) { /* 某些环境不支持 */ }
        node.classList.add('is-dragging');

        const L = charLayout[slot];
        drag = {
          slot: slot,
          pointers: new Map(),
          startLayout: { x: L.x, y: L.y, scale: L.scale }
        };
        drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        const c = pointerCenter();
        drag.startCx = c.cx;
        drag.startCy = c.cy;
        drag.startDist = pointerDist();
        updateDragHint();
      });

      node.addEventListener('pointermove', function (e) {
        if (!drag || drag.slot !== slot) return;
        // 只认已经 down 过的 pointer —— Safari 会把没按下的移动也派发过来
        if (!drag.pointers.has(e.pointerId)) return;
        e.preventDefault();
        drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        applyDrag();
      });

      function endPointer(e) {
        if (!drag || drag.slot !== slot) return;
        drag.pointers.delete(e.pointerId);
        if (drag.pointers.size === 0) {
          drag = null;
          node.classList.remove('is-dragging');
          updateDragHint();
          S.setCharLayout(slot, charLayout[slot]).catch(function () {});
        } else {
          // 从双指回到单指: 重新锚定, 否则会跳一下
          const c = pointerCenter();
          drag.startCx = c.cx;
          drag.startCy = c.cy;
          drag.startDist = 0;
          drag.startLayout = { x: charLayout[slot].x, y: charLayout[slot].y, scale: charLayout[slot].scale };
        }
      }
      node.addEventListener('pointerup', endPointer);
      node.addEventListener('pointercancel', endPointer);
    });
  }

  function applyDrag() {
    if (!drag) return;
    const rect = roomRect();
    if (!rect.width || !rect.height) return;
    const L = charLayout[drag.slot];

    // 位置: 手指中点的位移量 → 房间百分比
    const c = pointerCenter();
    L.x = clamp(drag.startLayout.x + (c.cx - drag.startCx) / rect.width * 100, -15, 115);
    L.y = clamp(drag.startLayout.y + (c.cy - drag.startCy) / rect.height * 100, -15, 115);

    // 缩放: 双指距离比 (单指不动 scale)
    const dist = pointerDist();
    if (drag.pointers.size >= 2) {
      if (drag.startDist > 6) {
        L.scale = clamp(drag.startLayout.scale * (dist / drag.startDist), 0.35, 2.6);
      }
    }
    applyCharTransform(drag.slot);
    updateDragHint();
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  /** 恢复默认位置 (图还在, 只是把人放回沙发上) */
  function resetCharLayouts() {
    ensureDom();
    charLayout.left = Object.assign({}, S.defaultLayoutFor('left'));
    charLayout.right = Object.assign({}, S.defaultLayoutFor('right'));
    applyCharTransform('left');
    applyCharTransform('right');
    saveAllCharLayouts();
  }

  function updateDragHint() {
    const bar = document.getElementById('cinema-adjust-hint');
    if (!bar) return;
    if (!drag) {
      bar.textContent = '拖动移动 · 双指捏合缩放 · 松手自动记住';
      return;
    }
    const L = charLayout[drag.slot];
    bar.textContent = SLOT_LABEL[drag.slot] + '  ' + Math.round(L.scale * 100) + '%';
  }

  function pickCharImage(slot) {
    ensureDom();
    charPickingSlot = slot;
    diagLogPush('点了「选择图片」… slot=' + slot);
    // ⚠️ 必须在 click() 之前清 value (2026-10-04 用户反馈: 第一次选传不上去, 第二次才行)
    //    iOS 的坑: 同一个 file input 连续选【同一个文件】时, 如果上次没清空 value,
    //    第二次 change 根本不触发 —— 表现就是"第一次没反应, 再点一次才生效"。
    //    清完再 click, 每次都是干净的选择会话。
    //    ⚠️ 注意: iOS 上 Chrome/Safari 用的都是 WebKit 内核, 这些坑两个都有。
    try { els.charFileInput.value = ''; } catch (e) { /* 某些浏览器不允许, 无所谓 */ }
    armCharPickWatchdog(slot);
    els.charFileInput.click();
  }

  // --------------------------------------------------------------------------
  // 诊断日志 (2026-10-04 21:04)
  //
  // 【为什么留着】用户 iPhone 上看 console 很难受, 但 2026-10-04 那天"上传要点两次"
  // 查了四轮都查不出来 —— 每次都只能靠"要不要加个日志"来回问。所以这里留一个
  // 轻量收集器: 平时不打扰, 出事时用户点开设置面板底部的「诊断」就能看到经过。
  //
  // 【约束】不写进 localStorage (IndexedDB 会被影片占满), 只在内存里, 刷新即清。
  // 最多留 40 条, 防止长时间开着房间把它撑爆。
  // --------------------------------------------------------------------------
  const diagLog = [];
  const DIAG_MAX = 40;
  function diagLogPush(text) {
    try {
      var d = new Date();
      var t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      diagLog.push(t + '  ' + text);
      while (diagLog.length > DIAG_MAX) diagLog.shift();
      renderDiagBox();
    } catch (e) { /* 诊断本身绝不能影响主流程 */ }
    console.log('[CinemaRoom]', text);
  }

  function renderDiagBox() {
    if (!els.diagBox) return;
    if (!diagLog.length) { els.diagBox.textContent = '（暂无记录）'; return; }
    // 顶上带一行环境信息 —— 出问题时第一眼就能知道是什么浏览器在跑
    var ua = '';
    try {
      var m = navigator.userAgent.match(/(CriOS|FxiOS|Chrome|Safari)\/[\d.]+/);
      ua = m ? m[0] : (navigator.userAgent.slice(0, 40) || '?');
    } catch (e) { ua = '?'; }
    var head = '浏览器: ' + ua + '  ·  ' + (global.CinemaStorage ? '存储层已就绪' : '存储层未加载');
    els.diagBox.textContent = head + '\n' + '─'.repeat(20) + '\n' + diagLog.join('\n');
  }

  // 看门狗: iOS 上偶尔 change 就是不来 (选择器弹了又关 / 系统弹窗抢焦点 /
  // 用户在"照片"里滑了一下没选就返回)。没有这层的话用户只能干瞪眼再点一次,
  // 而且我们连"到底有没有派发 change"都无从知道。
  let charPickTimer = null;
  function clearCharPickWatchdog() {
    if (charPickTimer) { clearTimeout(charPickTimer); charPickTimer = null; }
  }
  function armCharPickWatchdog(slot) {
    clearCharPickWatchdog();
    charPickTimer = setTimeout(function () {
      charPickTimer = null;
      // change 已经到了就把状态清掉了, 不提示
      if (charPickingSlot !== slot) return;
      diagLogPush('选图超时: 60 秒没收到文件, slot=' + slot);
      const prev = els.charPrev[slot];
      if (prev) prev.classList.remove('is-saving');
      reportError('刚才那张图没选上',
        '系统相册可能没有真正选中文件。\n\n再点一次「选择图片」，选好后右下角会显示「保存中…」。\n' +
        '如果一直不行，可以在设置面板最底部展开「诊断」看看停在哪一步。');
    }, 60000);   // 60s: 用户在相册里挑图本来就要时间
  }

  /**
   * 验证一个 Blob 是不是"能解开的图片"。
   *
   * ⚠️⚠️ 为什么不用 file.type / 扩展名判 (2026-10-05 真机踩到):
   *   iOS 从相册选图时, file.name 常常是 undefined、file.type 常是空字符串
   *   (HEIC / Safari 转码前更是两个都空)。任何"看名字/类型"的判断都会把
   *   正常图片全拒掉 —— 用户看到的就是"选什么图都弹『看起来不是图片』"。
   *
   * 唯一的可靠判据是【真解码】。这里两条路:
   *   ① 压缩模块在 → 用它的 loadImage (顺带能拿到尺寸做比例检查)
   *   ② 压缩模块没加载 → createImageBitmap 兜底 (iOS 15+ / Chrome 都支持)
   * ⚠️ 只验"能不能解开", 【不改数据】—— 调用方自己决定要不要压缩。
   */
  async function verifyImageBlob(blob) {
    if (!blob) return false;
    // ① 有压缩模块就用它
    if (global.CinemaImage && typeof global.CinemaImage.probe === 'function') {
      try { return await global.CinemaImage.probe(blob); } catch (e) { return false; }
    }
    // ② createImageBitmap 兜底
    if (typeof createImageBitmap === 'function') {
      try { await createImageBitmap(blob); return true; } catch (e) { /* 继续试下一条 */ }
    }
    // ③ 最后的兜底: <img> (最老的实现也能走通)
    return new Promise(function (resolve) {
      try {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(true); };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(false); };
        img.src = url;
      } catch (e) { resolve(false); }
    });
  }

  async function saveCharImage(slot, file, nameHint, sizeHint) {
    ensureDom();
    const name = nameHint || (file && file.name) || '';
    const size = sizeHint || (file && file.size) || 0;

    // ⚠️ 判图【不看 file.type / 扩展名】(2026-10-05 真机踩到):
    //   iOS 从相册选图时 file.name 常常是 undefined、file.type 常是空字符串,
    //   所以"看名字/类型"的判断会把正常图片全拒掉 —— 症状是"选什么图都弹不是图片"。
    //
    //   判真假只有一个可靠办法: 真解码。压缩模块没加载时用 createImageBitmap
    //   兜底 (iOS 15+ / Chrome 都支持), 它只验"是不是能解开的图片", 不改数据 ——
    //   立绘仍然【原样存储】, 不做任何压缩 (2026-10-05 用户明确要求别动人物)。
    if (!await verifyImageBlob(file)) {
      diagLogPush('✗ 立绘解不开 slot=' + slot + ' type=' + (file.type || '(空)') + ' name=' + (name || '(空)'));
      reportError('这张图打不开',
        '浏览器没能把这张图解开，所以没法显示在房间里。\n\n' +
        '可以试试：在相册里「分享 → 存储为文件」，或直接截图另存一张再传。');
      return;
    }

    const warn = size > 3 * 1024 * 1024
      ? '这张 ' + S.formatBytes(size) + '，偏大，手机上可能会卡。' : null;

    // 立刻给反馈。保存要走 await ensureCharTable() → db.open(),
    // 手机上可能要一两秒; 没有这个提示用户会以为没点上, 于是又点一次
    // ——"要点两次才能传上去"就是这么来的。
    const prevEl = els.charPrev[slot];
    if (prevEl) prevEl.classList.add('is-saving');
    diagLogPush('保存中… slot=' + slot);

    try {
      await S.saveChar(slot, file);   // 立绘原样存储, 不压缩
    } catch (e) {
      if (prevEl) prevEl.classList.remove('is-saving');
      console.error('[CinemaRoom] 存人物图失败', (e && e.name) || '', (e && e.message) || e);
      diagLogPush('✗ 存盘失败 slot=' + slot + ': ' + ((e && e.message) || e));
      reportError('存不下', describeSaveError(e));
      return;
    }
    if (prevEl) prevEl.classList.remove('is-saving');
    // 换图 = 新图尺寸/构图都不同, 旧位置没意义 -> 回到默认 (存盘时已重置)
    charLayout[slot] = S.defaultLayoutFor(slot);
    // ⚠️⚠️ 必须 await —— applyCharToSlot 是 async, 要从 IDB 读 Blob 才能建 object URL。
    //    原来没 await, 于是 refreshCharEditor 先跑了, 那时 charUrls[slot] 还是 null
    //    -> 缩略图渲染成"空", 房间里的立绘也是空。诊断显示"✓ 存好了"但没图,
    //    2026-10-20:52 用户报的就是这个。
    await applyCharToSlot(slot);
    await refreshCharEditor();
    diagLogPush('✓ 存好了 slot=' + slot);
    if (warn) showCapacityWarn(warn);
  }

  async function removeCharImage(slot) {
    ensureDom();
    await S.removeChar(slot);
    charLayout[slot] = S.defaultLayoutFor(slot);
    // 同样要 await (同 saveCharImage: applyCharToSlot 是 async, 不等它
    // refreshCharEditor 会先跑, 用的是过期的 charUrls)
    await applyCharToSlot(slot);
    await refreshCharEditor();
  }

  /**
   * 把某个 slot 的图片 + 位置画到房间里。
   *
   * ⚠️ 为什么位置从 CSS 搬到了这里 (2026-10-04 真机效果):
   *   两张立绘的留白和人物占比完全不同, 我在 CSS 里写死 bottom/width,
   *   结果左边那张坐得老高、右边那张偏小 —— 用户原话"图片大小形象不一样,
   *   你很难具体框定范围"。确实猜不出来, 所以改成用户自己拖, 拖完记住。
   */
  async function applyCharToSlot(slot) {
    ensureDom();
    const node = els.charSlot[slot];
    if (!node) return;
    const row = await S.getCharRow(slot);
    if (charUrls[slot]) { URL.revokeObjectURL(charUrls[slot]); charUrls[slot] = null; }
    if (!row || !row.image) {
      node.style.backgroundImage = '';
      node.setAttribute('data-empty', 'true');
      return;
    }
    charUrls[slot] = URL.createObjectURL(row.image);
    node.style.backgroundImage = 'url("' + charUrls[slot] + '")';
    node.setAttribute('data-empty', 'false');
    charLayout[slot] = { x: row.x, y: row.y, scale: row.scale };
    applyCharTransform(slot);
  }

  /**
   * 把 charLayout[slot] 写进 CSS 变量 + transform。
   *
   * ⚠️ 踩过的坑: 一开始写成
   *      transform: translate(calc(26% - 50%), calc(60% - 100%)) scale(1)
   *    结果人物跑到屏幕左上角外面 (rect.x = -26px)。
   *    原因: **transform 里的百分比是相对【元素自身尺寸】**, 不是相对房间。
   *    26% 只等于 26% × 109px ≈ 28px, 不是房间宽度的 26%。
   *
   * 正确做法: 房间坐标走 left/top (那里的百分比才是相对房间), transform 只做
   *    锚点偏移 + 缩放 —— translate(-50%, -100%) 把"脚底中心"对到 left/top 上。
   *    这样 left/top 随视口自动更新, transform 只负责视觉偏移, 两者互不干扰。
   */
  function applyCharTransform(slot) {
    const node = els.charSlot[slot];
    if (!node) return;
    const L = charLayout[slot] || S.defaultLayoutFor(slot);
    node.style.setProperty('--char-x', L.x + '%');
    node.style.setProperty('--char-y', L.y + '%');
    node.style.setProperty('--char-scale', String(L.scale));
    node.style.left = L.x + '%';
    node.style.top = L.y + '%';
    // 锚点: 脚底中心对到 (left, top) 这个点
    node.style.transform = 'translate(-50%, -100%) scale(' + L.scale + ')';
  }

  /**
   * 设置面板里各 slot 的缩略图 + 删除/调位置按钮的显隐。
   *
   * ⚠️ 原来读的是内存里的 charUrls[slot], 而 charUrls 由 applyCharToSlot 异步填。
   *    只要调用方忘了 await applyCharToSlot (或者它还没 resolve), 这里就会用
   *    过期状态渲染 —— 症状是"提示存好了, 但缩略图和房间里都没图"
   *    (2026-10-04 20:52 用户实测)。
   *
   *    现在改成【直接从 IndexedDB 查】, 跟 UI 显示的唯一真值源对齐,
   *    调用方爱 await 不 await 都不会错。
   */
  async function refreshCharEditor() {
    if (!els.charPrev) return;
    for (const slot of S.CHAR_SLOTS) {
      const prev = els.charPrev[slot];
      if (!prev) continue;
      let has = false, url = null;
      try {
        const row = await S.getCharRow(slot);
        if (row && row.image) {
          if (charUrls[slot]) { URL.revokeObjectURL(charUrls[slot]); charUrls[slot] = null; }
          url = URL.createObjectURL(row.image);
          charUrls[slot] = url;
          has = true;
        }
      } catch (e) { /* 查不到就当没图 */ }

      prev.innerHTML = has
        ? '<img src="' + url + '" alt="">'
        : '<span class="cinema-char-edit-empty">' + SLOT_LABEL[slot] + '</span>';
      const del = els.settingsSheet.querySelector('[data-char-del="' + slot + '"]');
      if (del) del.hidden = !has;
      const adj = els.settingsSheet.querySelector('[data-char-adjust="' + slot + '"]');
      if (adj) adj.hidden = !has;
    }
  }

  /** 进房间时把两个人读出来 */
  async function loadChars() {
    ensureDom();
    await Promise.all(S.CHAR_SLOTS.map(function (slot) { return applyCharToSlot(slot); }));
  }

  function releaseCharUrls() {
    S.CHAR_SLOTS.forEach(function (slot) {
      if (charUrls[slot]) { URL.revokeObjectURL(charUrls[slot]); charUrls[slot] = null; }
    });
  }

  // --------------------------------------------------------------------------
  // 房间背景 (2026-10-05 用户需求: 自己换房间背景)
  //
  // 【存在哪】IndexedDB cinemaChars 表, slot='bg'。跟着【这台手机】走 ——
  //   IndexedDB 不联网, 你和琪琪各存各的, 谁也看不到谁的 (跟人物/茶几一样)。
  //
  // 【怎么显示】盖一层 <img> 在 .cinema-room-bg 里 (z-index:0), 不是改 CSS。
  //   自传图压缩后可能是 WebP, 老 WebView 不认的话 CSS 背景会整面空白;
  //   <img> 解不出来只是这张不显示, 底下默认 CSS 背景还在。
  //
  // 【比例】cover 铺满。9:16 最合适; 比例差太多会裁掉一大块, 人物/沙发位置就偏了
  //   —— 传的时候提醒她, 但不拦。
  // --------------------------------------------------------------------------
  let roomBgUrl = null;

  function pickRoomBg() {
    ensureDom();
    const input = document.getElementById('cinema-roombg-file-input');
    if (!input) return;
    // click() 前先清 value: iOS 上连续选同一个文件时, 不清就不会触发 change
    try { input.value = ''; } catch (e) { /* noop */ }
    diagLogPush('选了「更换房间背景」…');
    input.click();
  }

  async function loadRoomBg() {
    ensureDom();
    await applyRoomBg();
  }

  async function applyRoomBg() {
    ensureDom();
    const blob = await S.getRoomBg();
    if (roomBgUrl) { URL.revokeObjectURL(roomBgUrl); roomBgUrl = null; }
    if (!blob) {
      els.customBg.hidden = true;
      els.customBg.removeAttribute('src');
      refreshRoomBgEditor();
      return;
    }
    roomBgUrl = URL.createObjectURL(blob);
    els.customBg.src = roomBgUrl;
    els.customBg.hidden = false;
    refreshRoomBgEditor();
  }

  async function saveRoomBgImage(file) {
    ensureDom();

    // 复制字节再清 value (iOS 会 invalidate 已取出的 File, 同人物上传那套)
    var safeBlob;
    try { safeBlob = file.slice(0, file.size, file.type || 'image/png'); }
    catch (e) { safeBlob = file; }
    var origKB = Math.round(safeBlob.size / 1024);
    diagLogPush('背景: 收到 ' + origKB + 'KB, name=' + ((file && file.name) || '(空)') +
                ' type=' + ((file && file.type) || '(空)'));

    // ⚠️ 压缩模块可能没加载 (2026-10-05 用户真机遇到过: cinema-img.js 是新文件,
    //   Service Worker 还没缓存它 → window.CinemaImage 是 undefined → 整个功能报
    //   "图片压缩模块没加载上" 就罢工了)。
    //   压缩是【锦上添花】不是【必需】: 没它就直接存原图, 功能照样能用。
    const prev = document.getElementById('cinema-room-bg-prev');
    if (prev) prev.classList.add('is-saving');

    let payload = safeBlob, out = null;
    if (global.CinemaImage && typeof global.CinemaImage.compress === 'function') {
      try {
        out = await global.CinemaImage.compress(safeBlob);
        payload = out.blob;
        diagLogPush('背景已压缩: ' + origKB + 'KB → ' + Math.round(out.blob.size / 1024) + 'KB (' + out.format + ')');
      } catch (e) {
        if (prev) prev.classList.remove('is-saving');
        diagLogPush('✗ 背景压缩失败: ' + ((e && e.message) || e));
        reportError('这张图打不开',
          '浏览器没能把这张图解开，所以没法当房间背景。\n\n' +
          '可以试试：在相册里「分享 → 存储为文件」，或直接截图另存一张再传。');
        return;
      }
    } else {
      // 压缩模块没加载 —— 先验一下确实是图片, 再原样存, 别直接罢工
      diagLogPush('背景: 压缩模块未加载, 改为原样存储');
      if (!await verifyImageBlob(safeBlob)) {
        if (prev) prev.classList.remove('is-saving');
        diagLogPush('✗ 背景解不开, 且压缩模块不可用');
        reportError('这张图打不开',
          '浏览器没能把这张图解开。\n\n刷新一下页面再试 —— 刷新后压缩模块就会加载上，' +
          '也顺便能自动压缩省空间。');
        return;
      }
    }
    if (prev) prev.classList.remove('is-saving');

    const outKB = Math.round(payload.size / 1024);
    try {
      await S.saveRoomBg(payload);
    } catch (e) {
      diagLogPush('✗ 背景存盘失败: ' + ((e && e.message) || e));
      reportError('存不下', describeSaveError(e));
      return;
    }
    await applyRoomBg();
    diagLogPush('背景已换: ' + outKB + 'KB' + (out ? ' (压缩后)' : ' (原样)'));

    if (out && out.ratioWarn) {
      // 提醒但已经存好了 —— 不拦她, 只是让她知道可能会裁边
      reportError('已经换上了, 但比例有点怪',
        '这张是 ' + out.srcW + '×' + out.srcH + '（比例 ' + out.ratio.toFixed(2) + '），' +
        '理想是 9:16（0.56）。\n\n' +
        '房间背景是铺满裁切的，比例差太多会裁掉一部分，人物坐的位置可能会偏。' +
        '不用重传也行，看着不对就把人物拖一下。');
    }
  }

  async function removeRoomBgImage() {
    ensureDom();
    await S.removeRoomBg();
    await applyRoomBg();
    diagLogPush('背景已恢复默认');
  }

  /** 设置面板里背景那一栏的显隐 */
  function refreshRoomBgEditor() {
    const prev = document.getElementById('cinema-room-bg-prev');
    const del = document.querySelector('[data-roombg-del]');
    const reset = document.getElementById('cinema-roombg-reset');
    const has = roomBgUrl != null;
    if (prev) {
      prev.innerHTML = has
        ? '<img src="' + roomBgUrl + '" alt="">'
        : '<span class="cinema-char-edit-empty">默认房间</span>';
    }
    if (del) del.hidden = !has;
    if (reset) reset.hidden = !has;
  }

  // --------------------------------------------------------------------------
  // 开关房间
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // visualViewport → CSS 变量 (iOS 键盘适配)
  //
  // 作用 (2026-10-04 用户反馈: 一输入文字页面就变大遮住视频, 收起后回不来):
  //   iOS Safari 里 position:fixed 是相对【布局视口】定位的, 不是可视视口。
  //   键盘弹出时布局视口一点没变, 可视视口却上移了一大截 → 固定元素被顶到屏幕外,
  //   键盘收起后浏览器也不一定把它滚回来。
  //   监听 visualViewport 的 resize/scroll, 把可视视口尺寸喂给 .cinema-room,
  //   房间就跟着可视视口走 —— 键盘弹多高房间缩多高, 视频永远露在外面。
  //
  // 🔴 2026-10-06 iOS 严重卡顿修复 (只动这三处, 不碰 Gemini/播放/记忆):
  //   症状: 完整 330 里点聊天输入框、键盘刚弹出的瞬间主线程严重阻塞,
  //         standalone Cinema 完全正常, 视频连续播 30 分钟也不卡。
  //   原因: 变量原本写在 documentElement(:root) 上。自定义属性挂在 :root 会让
  //         WebKit 对【整篇文档】做样式失效; 而完整 330 有 54 个 .screen 全屏 flex
  //         面板 (visibility:hidden 不是 display:none, 仍完整参与布局), 于是每个
  //         visualViewport 事件都要重排这一大片。键盘弹出动画期间 iOS 会连续抛
  //         几十上百个事件 → 事件风暴。standalone 没有 .screen, 所以毫发无损。
  //   修法 (三条都在这里):
  //     ① 变量写到 .cinema-room 自己身上 (els.root), 作用域从「整篇文档」缩到
  //        「房间这一棵子树」。--cinema-vv-* 全项目只有 .cinema-room 自己用
  //        (css 第 31/34 行), 缩作用域不影响任何外部样式。
  //     ② 事件回调走 requestAnimationFrame 合帧: 一帧最多写一次, 把「按事件次数」
  //        变成「按帧数」, 上限锁死 60 次/秒。
  //     ③ 值去重: height/top 没变就一个字节都不写。iOS 键盘动画里绝大多数事件
  //        带的值和上一帧完全一样, 去重后实际写入次数是个位数。
  // --------------------------------------------------------------------------

  let vvFrame = 0;          // 待执行的 rAF id, 0 = 当前没有排队的帧
  let vvFrameAt = 0;        // 排队时刻, 用来判断这一帧是不是已经"卡住"了
  let lastVvHeight = -1;    // 上次真正写进 DOM 的值 (去重用)
  let lastVvTop = -1;

  // 🧪 2026-10-08 诊断实验 B 总开关 (临时)
  //   true  = 断开 visualViewport → CSS 变量 → .cinema-room height 这条链
  //   false = 恢复原逻辑
  //   测完请告诉我结论, 我按结论决定恢复还是换方案。
  const VV_DIAG_DISABLE_HEIGHT_SYNC = true;

  // 只读诊断计数, 给「键盘还卡不卡」做实测用。不影响任何行为。
  const vvDiag = { events: 0, writes: 0 };
  global.__cinemaVVDiag = vvDiag;
  global.__cinemaVVDiagReset = function () { vvDiag.events = 0; vvDiag.writes = 0; };

  // 真正写 DOM 的那一步。rAF 合帧和值去重都收敛在这里。
  function applyVisualViewport() {
    // 🧪 2026-10-08 诊断实验 B —— 临时总开关【不要删, 测完要恢复】
    //
    //   要验证的假设: 「Cinema Room 高度跟着 visualViewport 实时变化」是不是根因。
    //   现象: 键盘弹出要等 4~5 秒; 收键盘时影院整体被带下去、露出半截主聊天框。
    //   上一轮实验(去掉 .cinema-chat-panel 的 height 过渡)完全无改善, 说明不是动画。
    //
    //   这里把【所有】写入 --cinema-vv-height / --cinema-vv-top 的入口一刀切掉:
    //   visualViewport 监听、首帧同步、keepViewportPinned 全部从这里过, 一行就断干净。
    //   initVisualViewport 里的 addEventListener 也一并注释, 免得事件还在空跑 rAF 排队。
    //
    //   ⚠️ 诊断用, 不是最终方案。恢复 = 删掉这一个 if。
    if (VV_DIAG_DISABLE_HEIGHT_SYNC) return;

    const vv = global.visualViewport;
    const root = els && els.root;
    if (!vv || !root) return;
    const h = Math.round(vv.height);
    const t = Math.max(0, Math.round(vv.offsetTop));
    if (h === lastVvHeight && t === lastVvTop) return;  // 没变 → 不碰 DOM
    lastVvHeight = h;
    lastVvTop = t;
    root.style.setProperty('--cinema-vv-height', h + 'px');
    root.style.setProperty('--cinema-vv-top', t + 'px');
    vvDiag.writes++;
  }

  // 给 visualViewport 的 resize/scroll 用: 同一帧里的几十个事件只跑一次。
  //
  // ⚠️ vvFrameAt 那个陈旧帧判断不是多余的: iOS Safari 在页面切后台/来电时会
  // 【丢弃】还没执行的 rAF 回调, 于是 vvFrame 永远停在非 0, 之后所有事件都被
  // 这个 if 吞掉 → 键盘弹出时房间不再跟随 → 用户看到"键盘一弹房间就不动了"。
  // 所以超过 250ms 还没执行就认为那一帧废了, 重新排一帧。
  function syncVisualViewport() {
    if (vvFrame && Date.now() - vvFrameAt < 250) return;   // 本帧已排过, 吞掉
    vvFrame = global.requestAnimationFrame(function () {
      vvFrame = 0;
      applyVisualViewport();
    });
    vvFrameAt = Date.now();
    vvDiag.events++;
  }

  function initVisualViewport() {
    const vv = global.visualViewport;
    if (!vv) return;
    vvFrame = 0;   // 进房间先清一次排队状态, 防止上次残留的陈旧帧挡住首次同步

    // 🧪 2026-10-08 诊断实验 B: 临时不挂 visualViewport 监听, 也不做首帧同步。
    //    恢复 = 删掉这个 if 块。(下面的代码就是原来的逻辑, 一行没改)
    if (VV_DIAG_DISABLE_HEIGHT_SYNC) return;

    if (vv.__cinemaBound) { applyVisualViewport(); return; }
    vv.__cinemaBound = true;
    vv.addEventListener('resize', syncVisualViewport);
    vv.addEventListener('scroll', syncVisualViewport);
    applyVisualViewport();   // 首帧同步执行一次, 不等 rAF (避免房间先按 100dvh 闪一下)
  }

  /**
   * 输入框聚焦后的「钉住视口」。
   *
   * ⚠️ 2026-10-06: 原来的 window.scrollTo(0, 0) 已经删掉了, 它就是卡顿振荡的源头:
   *   iOS 聚焦输入框会自己把文档滚动到让输入框可见 (scroll-into-view)。
   *   我们 scrollTo(0,0) 强行把滚动归零 → iOS 判定输入框又被挡住 → 再滚回来 →
   *   visualViewport 再次抛 scroll → syncVisualViewport 写变量 → 房间整体位移 →
   *   iOS 再次调整 → …… 来回振荡, 每圈还附带一次整篇文档重排。
   *
   * 现在为什么不用再 scrollTo:
   *   房间是 position:fixed + top: var(--cinema-vv-top), 而 --cinema-vv-top 就是
   *   vv.offsetTop。iOS 把文档滚了 N px, 我们就把房间往下挪 N px, 两者抵消 ——
   *   输入框在【可视视口坐标里】原地不动, iOS 立刻认为「已经可见」, 不会再来回滚。
   *   所以正确做法是顺着 iOS 的滚动补偿, 不是跟它对着干。
   *
   * 保留这个函数: 它保证「聚焦后立刻同步一次」, 不必等下一个 visualViewport 事件。
   */
  function keepViewportPinned() {
    syncVisualViewport();
  }

  /**
   * 顶栏实际高度是变的 (有片名时两行、没片名时一行, 还叠加刘海安全区),
   * 写死百分比会在某些机型上被压住。打开房间和转屏时实测一次, 写进 CSS 变量。
   */
  function syncTopbarHeight() {
    const bar = document.querySelector('.cinema-room-topbar');
    if (!bar) return;
    const h = Math.ceil(bar.getBoundingClientRect().height);
    if (h > 0) els.root.style.setProperty('--cinema-topbar-h', h + 'px');
  }

  async function open() {
    ensureDom();
    initVisualViewport();
    els.root.classList.add('open');
    els.root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('cinema-room-active');
    syncTopbarHeight();
    // 人设绑定: 用当前正在用的那个角色 (跟旧观影一致: 打开时绑定 activeChat)
    if (global.CinemaLive) {
      let cid = null;
      try {
        if (typeof state !== 'undefined' && state) cid = state.activeChatId || null;
      } catch (e) { /* noop */ }
      if (cid) global.CinemaLive.setChat(cid);
    }
    setDrawer(true);
    diagLogPush('进入房间');
    await refreshList();
    // 沙发上那两个人 (第一次进房或换过图才读 IDB, 很快)
    await loadChars();
    // 房间背景 (2026-10-05): 用户可能自己传过
    await loadRoomBg();
    diagLogPush('道具已加载: ' + S.CHAR_SLOTS.map(function (s) {
      return s + '=' + (charUrls[s] ? '有' : '空');
    }).join(' '));
    // 剧情条一进房就建好并常驻 (不必等用户先点开聊天面板)
    if (global.CinemaLive) global.CinemaLive.renderPlotPanel();
  }

  /**
   * 退出房间。
   * ⚠️ 严格顺序(与旧观影已验证的一致, 用户明确要求):
   *    先 await CinemaLive.onLeaveCinema()
   *      → 内部: 整理记忆 → 写 longTermMemory → await db.chats.put → 确认成功 → 才关 Live
   *    只有它 resolve 了才真正关房间。
   *    它失败时【不关 Live、不关房间】, 保持当前会话让用户重试。
   */
  async function close() {
    ensureDom();
    flushProgress(true);
    if (global.CinemaLive && global.CinemaLive.isEnabled()) {
      const r = await global.CinemaLive.onLeaveCinema();
      if (r && r.saved === false && r.error) {
        // ⚠️ 2026-10-07 用户实测被【关在房间里出不来】, 这里必须给兜底。
        //
        // 现象: 点退出 → Gemini 返回空 → 弹「观影记忆没存上」→ 房间不关。
        //      再点退出还是不行 (Live 已经被 stopFrameLoop 停了, 连接是死的),
        //      用户被彻底困住 —— 记忆没存上变成了【禁止退出】, 这不可接受。
        //
        // 记忆存不上是【降级】, 不是【禁止退出】。所以:
        //   · 弹框给「仍然退出」, 点了直接走人
        //   · 同时倒计时自动退出, 免得用户看不懂干等着
        //
        // 常见触发: iOS 切后台时 Live 被系统掐断, 回来连接已死 → Gemini 返回空
        //          (用户原话: "没总结可能是我退了一下后台")
        await showLeaveFallback(r.error);
        return;
      }
    }
    finishClose();
  }

  /** 关掉可能还开着的自定义弹框 (showCustomAlert/Confirm/Choice 共用那一个宿主节点) */
  function closeAnyModal() {
    try {
      var el = document.getElementById('custom-modal-overlay');
      if (el) el.style.display = 'none';
      var ch = document.getElementById('custom-chat-overlay');
      if (ch) ch.style.display = 'none';
    } catch (e) { /* noop */ }
  }

  /**
   * 记忆没存上时的兜底出口: 弹框 + 倒计时 + 「仍然退出」。
   * 返回的 Promise 一定会 resolve —— 无论用户点哪个按钮、等多久, 保证 close() 不卡死。
   */
  function showLeaveFallback(reason) {
    return new Promise(function (resolve) {
      var done = false;
      var tick = null;
      var hardStop = null;

      function settle(val) {
        if (done) return;
        done = true;
        try { if (tick) clearInterval(tick); } catch (e) { /* noop */ }
        try { if (hardStop) clearTimeout(hardStop); } catch (e) { /* noop */ }
        closeAnyModal();
        resolve(val);
      }

      var left = 10;

      // 用 showCustomConfirm —— 它才有【标题 + 正文 + 两个按钮】的签名。
      // ⚠️ 别用 showChoiceModal: 那个是【分页选项列表】(title, options) 返回 Promise,
      //    语义完全不同, 传三个参数进去等于没给正文 (2026-10-07 一度写错过)。
      var modalShown = false;
      if (global.showCustomConfirm) {
        try {
          modalShown = true;
          global.showCustomConfirm(
            '观影记忆没存上',
            '没能把这次的观影记忆写进长期记忆：' + (reason || '未知原因') +
              '<br><br><b>' + left + ' 秒后会自动退出房间，不会把你关在里面。</b>',
            {
              confirmText: '仍然退出',
              cancelText: '再试一次',
              confirmButtonClass: 'btn-danger'
            }
          ).then(function (ok) {
            // ok=true → 「仍然退出」; null/false → 取消或关掉 → 留在房间
            settle(ok ? 'leave' : 'retry');
          }).catch(function () { settle('retry'); });
        } catch (e) {
          try { global.alert('观影记忆没存上\n\n' + (reason || '') + '\n\n' + left + ' 秒后自动退出房间。'); } catch (e2) { /* noop */ }
        }
      } else {
        try { global.alert('观影记忆没存上\n\n' + (reason || '') + '\n\n' + left + ' 秒后自动退出房间。'); } catch (e) { /* noop */ }
      }

      tick = setInterval(function () {
        left--;
        if (left <= 0) settle('timeout');
      }, 1000);

      // 兜底: 无论弹框怎么表现, 15 秒后一律放人
      hardStop = setTimeout(function () { settle('timeout'); }, 15000);
      void modalShown;
    });
  }

  /** 真正关房间 (从 close() 拆出来, 兜底路径也能调) */
  function finishClose() {
    ensureDom();
    if (global.CinemaLive && global.CinemaLive.forceLeave) {
      try { global.CinemaLive.forceLeave('用户选择不保存记忆直接退出'); } catch (e) { /* noop */ }
    }
    els.root.classList.remove('open');
    els.root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cinema-room-active');
    setDrawer(false);
    setChatPanel(false);
    setSettingsSheet(false);
    setAdjusting(false);
    clearCharPickWatchdog();
    // object URL 不 revoke 就是内存泄漏 —— Blob 还压在 IDB 里, 但 URL 一直占着堆
    releaseCharUrls();
    if (roomBgUrl) { URL.revokeObjectURL(roomBgUrl); roomBgUrl = null; }
  }

  // --------------------------------------------------------------------------
  // 提示
  // --------------------------------------------------------------------------

  function reportError(title, message) {
    if (global.showCustomAlert) {
      global.showCustomAlert(title, message);
    } else if (global.alert) {
      global.alert(title + '\n\n' + message);
    } else if (global.console) {
      console.error('[CinemaRoom] ' + title + ': ' + message);
    }
  }

  // --------------------------------------------------------------------------
  // 对外接口
  // --------------------------------------------------------------------------

  // 版本戳: 只为一眼确认「手机上跑的到底是哪一份代码」。
  // PWA 有 service worker 缓存, 用户看到的经常是旧版, 没有戳根本分不清。
  // 每次改动影院都顺手改这里。
  global.__CINEMA_VER = '0.27.0';

  global.CinemaRoom = {
    open: open,
    close: close,
    refreshList: refreshList,
    addLocalFile: addLocalFilm,
    pickFile: pickFile,
    setChatPanel: setChatPanel,
    sendChat: sendChat,
    isChatOpen: function () { return chatOpen; }
  };

  // 入口按钮
  function bindEntry() {
    const btn = document.getElementById('open-cinema-room-btn');
    if (btn && !btn.__cinemaBound) {
      btn.__cinemaBound = true;
      btn.addEventListener('click', function () { open(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }

})(window);
