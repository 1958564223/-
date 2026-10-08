// Service Worker (sw.js)
// 白名单缓存: 只缓存已知静态资源, API 请求 pass-through
// CACHE_VERSION bump 强制清缓存
// 关键约束: URLS_TO_CACHE 增删需同步 sw.js 注释 + ?v= 版本号

const CACHE_VERSION = 'v0.2.33.5';
const CACHE_NAME = `ephone-cache-${CACHE_VERSION}`;

const URLS_TO_CACHE = [
  './index.html',
  './online-app.css',
  './script.js',
  './modules/hot-news.js',
  './modules/runtime-diagnostics.js',
  // v0.1.28 新增：AI 唱歌�? 个新模块�?
  './modules/ai-music.js',
  './js/music-voice-sample.js',
  './js/role-voice-sample-ui.js',
  // v0.1.29 新增：AI 原创�?IndexedDB 持久化层
  './js/ai-songs-store.js',
  './js/netease-music.js',
  // v1.0.0 改�? 通用 MCP 工具（删 mcd/luckin 硬编�? 删旧 mcp-ui-init + 3 �?css, �?generic-client + ui-list�?
  './js/mcp-generic-client.js',
  './js/mcp-tool-bridge.js',
  './js/mcp-ui-list.js',
  // v0.1.55 新增: MCP 菜单卡片渲染（粉白色系浮动按�?+ 全屏 sheet�?
  './js/mcp-menu-card.js',
  './js/mcp-pay-card.js',
  './js/mcp-tool-call-log.js',
  // v0.2.31.9: 工具调用实时进度 (紧跟 AI 气泡, 完成后移除)
  './js/mcp-tool-progress.js',
  './css/mcp-miniapp-pink.css',
  // v0.2.0 新增：Live2D 视频通话（PIXI v8 + untitled-pixi-live2d-engine + 视频通话主文件）
  // v0.2.31.53 引擎本地化 + 进预缓存: 引擎原来只靠"运行时缓存"活着, 一旦 CACHE_VERSION bump
  //   旧 cache 被 activate 删掉, 引擎就得重新走 CDN, 网络一抖就 PIXI.live2d 不存在 → 模型加载不出。
  //   现在四个引擎文件全在本地 lib/ 且进 URLS_TO_CACHE, 版本 bump / 断网都不影响。
  './lib/live2dcubismcore.min.js',
  './lib/live2d.min.js',
  './lib/pixi.min.js',
  './lib/pixi-live2d-display.cubism4.min.js',
  './modules/live2d-loader.js',
  './modules/video-voice-call.js',
  // v0.2.31.43: 视频通话 AI 说话口型 (独立模块)
  './modules/call-lip-sync.js',
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://phoebeboo.github.io/mewoooo/pp.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js',
  './assets/icon-192.png',
  // v0.2.15.1 新增: �?ByteString 涉及�?3 �?modules (之前漏了, 现在加进白名�? SW 主动缓存)
  './modules/proactive-wake.js',
  './modules/notification-battery.js',
  './modules/background-activity.js',
  // v0.2.31.69: Cinema Room 第一阶段 (2026-10-04) 新模块。
  //   影片本体走 IndexedDB 直存 Blob, 不经过 SW —— 视频永远不进 Cache API
  //   (进 Cache 会双份占空间, 且 24MB+ 直接撑爆安装期缓存), 只把这三个静态壳文件预缓存。
  './modules/cinema-storage.js',
  './modules/cinema-img.js',
  './modules/cinema-room.js',
  './modules/cinema-room.css',
  './modules/cinema-live.js',
  // 房间背景图 93KB, 预缓存是为了离线也能开房间 + 首屏不闪白。
  // jpg 兜底不预缓存 —— 只给不认 webp 的老 WebView 用, 按需拉就行。
  './assets/cinema-room-bg.webp'
];

self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  // v0.2.24 �? iOS PWA 模式�?service worker install 后卡 waiting (�?SW 永不关闭), �?self.skipWaiting() 强制 activate
  //   之前 v0.2.23 部署了但 PWA �?SW 没真激�? 报错没变. skipWaiting() 让新 SW 跳过 waiting 立刻 activate.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cache opened, caching core files...');
        // 2026-07-24 修复：cache.addAll �?allSettled 单独缓存每个文件
        // 原因：URLS_TO_CACHE 里有 25 个文件（�?5 个外�?CDN），任何一�?fetch
        // 失败（CDN 抽风 / CORS / 404）整�?addAll 就会 reject，导�?SW install
        // 永远�?installing 状�?�?navigator.serviceWorker.register() 抛错 �?
        // "一键修复通知" alert 里看不到"已重新注�?的成功提示�?
        // 改宽容后：单个失败只 warn 跳过，整�?install 必成功�?
        return Promise.allSettled(
          URLS_TO_CACHE.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] 缓存失败（已跳过�?', url, err.message || err);
              return null;
            })
          )
        ).then(results => {
          const ok = results.filter(r => r.status === 'fulfilled').length;
          const fail = results.length - ok;
          console.log(`[SW] Core files cached: ${ok} ok, ${fail} failed.`);
        });
      })
      .then(() => {
        console.log('[SW] skipWaiting()');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated.');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  const isLocalAsset = url.startsWith(self.location.origin) &&
    (url.includes('/index.html') ||
     url.includes('/online-app.css') ||
     url.includes('/script.js') ||
     url.includes('/modules/hot-news.js') ||
     url.includes('/modules/runtime-diagnostics.js') ||
     // v0.1.28 新增：AI 唱歌模块
     url.includes('/modules/ai-music.js') ||
     url.includes('/js/music-voice-sample.js') ||
     url.includes('/js/role-voice-sample-ui.js') ||
     // v0.1.29 新增：AI 原创曲存储层
     url.includes('/js/ai-songs-store.js') ||
     // v1.0.0 改�? 通用 MCP 文件命中拦截, 走缓存（请求带回 ?v= 时也�?fetch�?
     url.includes('/js/mcp-generic-client.js') ||
     url.includes('/js/mcp-tool-bridge.js') ||
     url.includes('/js/mcp-ui-list.js') ||
     // v0.3.2 更新：Live2D 视频通话（loader + 视频通话主文件 + Cubism 4 core 本地；模型走 IDB 不再 fetch assets/）
     // v0.2.31.53: 引擎四个文件本地化, 一起纳入拦截 (命中预缓存, Netlify/PWA 断网也能起引擎)
     url.includes('/lib/live2dcubismcore.min.js') ||
     url.includes('/lib/live2d.min.js') ||
     url.includes('/lib/pixi.min.js') ||
     url.includes('/lib/pixi-live2d-display.cubism4.min.js') ||
     url.includes('/modules/live2d-loader.js') ||
     url.includes('/modules/video-voice-call.js'));

  const isKnownCDN =
    url.includes('unpkg.com/dexie') ||
    url.includes('cdnjs.cloudflare.com/ajax/libs/html2canvas') ||
    url.includes('cdn.jsdelivr.net/npm/streamsaver') ||
    url.includes('phoebeboo.github.io/mewoooo/pp.js') ||
    url.includes('i.postimg.cc/') ||
    // v0.3.0 回退：Live2D 引擎 (PIXI v6 + pixi-live2d-display 0.4.0 + Cubism 4 core 本地, 330 v0.1.30 旧栈)
    url.includes('cdn.jsdelivr.net/npm/pixi.js@6.5.0') ||
    url.includes('cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0') ||
    url.includes('cdn.jsdelivr.net/gh/dylanNew/live2d');

  if (isLocalAsset || isKnownCDN) {
    const isVersioned = url.includes('?v=');
    if (isVersioned) {
      event.respondWith(
        fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            const noQueryUrl = url.split('?')[0];
            caches.open(CACHE_NAME).then(cache => cache.put(noQueryUrl, clone));
          }
          return response;
        }).catch(() => caches.match(url.split('?')[0]))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(() => null);

        return cachedResponse || fetchPromise;
      })
    );
  }
});

// 330 v0.1.83 wake-up 模式 push handler
// 收到 push-server 发来�?{type: 'proactive-wake', chatId, charId, charName, taskId, fixedMessage, aiPrompt} payload
//   v0.2.26 �? �?fixedMessage (不管 messageType, 包括 patrol/fixed/guided/auto) �?直接显示真内�?+ �?IndexedDB
//     + postMessage 主页�?PROACTIVE_WAKE_PUSHED. fixedMessage �?null 时才走�?guided/auto 占位 + postMessage PROACTIVE_WAKE
self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  // ===== wake-up 模式 (v0.1.83+, v0.2.26 �? =====
  if (data.type === 'proactive-wake') {
    const charName = data.charName || data.charId || 'AI 角色';
    const chatId = data.chatId;
    const taskId = data.taskId;
    const messageType = data.messageType || 'fixed';
    const fixedMessage = data.fixedMessage;

    // ===== v0.2.26 优先路径: �?fixedMessage (不管 messageType) 直接用真内容 =====
    //   真凶: 老逻辑 messageType==='fixed' 才用 fixedMessage, push-server patrol 模式 messageType='patrol' 
    //   �?SW �?guided/auto 占位分支 �?通知显示 "X 想跟你说点什�?.." 占位, 完整内容�?fixedMessage 字段被忽�?
    //   �?主页�?handleProactiveWake 又调一�?LLM (浪费 token) + UPDATE_NOTIFICATION 失败时占位保�?
    if (fixedMessage && String(fixedMessage).trim()) {
      event.waitUntil((async () => {
        // 1. �?IndexedDB (native indexedDB API, PWA 完全关掉再开也能看到消息)
        try {
          await writeProactiveMessageToIDB({
            chatId,
            role: 'assistant',
            content: fixedMessage,
            timestamp: Date.now(),
            taskId,
            charId: data.charId,
            charName
          });
          console.log(`[SW v0.2.26] �?已落 IndexedDB: chatId=${chatId} content="${fixedMessage.substring(0, 30)}..."`);
        } catch (e) {
          console.warn('[SW v0.2.26] �?IndexedDB 失败 (不阻塞通知):', e.message);
        }

        // 2. 弹真内容通知 (body 截前 30 字符避免 iOS 178 限制截成乱码省略�? 完整内容�?data.message)
        const notifBody = fixedMessage.length > 30
          ? fixedMessage.substring(0, 30) + '...'
          : fixedMessage;
        await self.registration.showNotification(`💬 ${charName}`, {
          body: notifBody,
          icon: data.icon || './assets/icon-192.png',
          badge: data.badge || './assets/icon-192.png',
          tag: `task-${taskId}`,
          data: { chatId, taskId, type: 'proactive-wake', messageType, message: fixedMessage },
          requireInteraction: true,
          vibrate: [200, 100, 200],
          timestamp: Date.now()
        });

        // 3. postMessage 主页�?(强制 reload chat window, PWA 在前台时立刻显示)
        try {
          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clientList) {
            client.postMessage({
              type: 'PROACTIVE_WAKE_PUSHED',
              chatId,
              taskId,
              charId: data.charId,
              charName,
              message: fixedMessage,
              sentAt: data.sentAt
            });
          }
        } catch (e) {
          console.warn('[SW v0.2.26] postMessage 失败 (不阻�?:', e.message);
        }
      })());
      return;
    }

    // ===== �?guided/auto 模式 (fixedMessage �?null): 弹占�?+ postMessage 主页面让 AI 生成 =====
    //   保留兼容 push-config.js 老接�?(messageType=guided/auto + aiPrompt), 让主页面�?LLM
    const placeholderTitle = `💬 ${charName}`;
    const placeholderBody = `${charName} 想跟你说点什�?..`;
    const placeholderOptions = {
      body: placeholderBody,
      icon: data.icon || './assets/icon-192.png',
      badge: data.badge || './assets/icon-192.png',
      tag: `task-${taskId}`,
      data: { chatId, taskId, type: 'proactive-wake', messageType, generating: true },
      requireInteraction: true,
      vibrate: [200, 100, 200],
      timestamp: Date.now()
    };

    event.waitUntil((async () => {
      // 1. 弹占位通知
      await self.registration.showNotification(placeholderTitle, placeholderOptions);

      // 2. postMessage 主页�?(如果�?, 让主页面�?LLM 生成 + �?UPDATE_NOTIFICATION
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({
          type: 'PROACTIVE_WAKE',
          chatId,
          taskId,
          charId: data.charId,
          charName,
          messageType,
          aiPrompt: data.aiPrompt || null,
          sentAt: data.sentAt
        });
      }
    })());
    return;
  }

  // ===== �?payload 格式兼容 (测试推送等) =====
  const title = data.title || 'EPhone';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || './assets/icon-192.png',
    badge: data.badge || './assets/icon-192.png',
    tag: data.tag || 'default',
    data: data.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// v0.2.26 �? SW �?native indexedDB API 写主动消�?(PWA 关掉再开也能看到)
// 真凶: SW 是独�?worker context, 拿不�?window.db (Dexie) 也没 modules 脚本, 必须�?native indexedDB
// 同步主线 (init-db-schema.js v60): messages �?schema &id, chatId, timestamp, [chatId+timestamp], role, type
//                                chats �?schema &id, isGroup, ..., lastMessageTimestamp, messageSchemaVersion
// 消息 id 格式: ${chatId}::${timestamp}::${role}::${type}::${index} (�?init-db-schema.js / message-store.js 保持一�?
function writeProactiveMessageToIDB(msg) {
  return new Promise((resolve, reject) => {
    let db;
    try {
      const openReq = indexedDB.open('GeminiChatDB');
      openReq.onerror = () => reject(openReq.error || new Error('open GeminiChatDB 失败'));
      openReq.onsuccess = () => {
        db = openReq.result;
        try {
          if (!db.objectStoreNames.contains('messages')) {
            db.close();
            return reject(new Error('messages store 不存�?(PWA 数据�?schema 未升级到 v60)'));
          }
          if (!db.objectStoreNames.contains('chats')) {
            db.close();
            return reject(new Error('chats store 不存�?'));
          }
          const tx = db.transaction(['messages', 'chats'], 'readwrite');
          const messagesStore = tx.objectStore('messages');
          const chatsStore = tx.objectStore('chats');

          // 1. 写消息到 messages �?
          const messageId = `${msg.chatId}::${msg.timestamp}::assistant::text::0`;
          const messageRow = {
            id: messageId,
            chatId: msg.chatId,
            role: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            type: 'text',
            proactive: true,
            taskId: msg.taskId || null
          };
          messagesStore.put(messageRow);

          // 2. 更新 chat 元数�?(lastMessageTimestamp + lastMessagePreview + messageCount)
          const chatReq = chatsStore.get(msg.chatId);
          chatReq.onsuccess = () => {
            const chat = chatReq.result;
            if (chat) {
              chat.lastMessageTimestamp = msg.timestamp;
              const previewText = String(msg.content || '').replace(/\s+/g, ' ').trim();
              chat.lastMessagePreview = previewText.length > 80 ? previewText.slice(0, 80) + '...' : previewText;
              chat.lastMessageRole = 'assistant';
              chat.lastMessageType = 'text';
              chat.messageCount = (Number(chat.messageCount) || 0) + 1;
              // v0.2.60+ 已经拆表, chat 上不�?history 字段
              delete chat.history;
              chatsStore.put(chat);
            }
          };

          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { const err = tx.error; db.close(); reject(err || new Error('transaction 失败')); };
          tx.onabort = () => { const err = tx.error; db.close(); reject(err || new Error('transaction aborted')); };
        } catch (innerErr) {
          if (db) db.close();
          reject(innerErr);
        }
      };
    } catch (e) {
      if (db) db.close();
      reject(e);
    }
  });
}

// 330 v0.1.83: 主页面调 LLM 生成完消息后, �?UPDATE_NOTIFICATION 替换占位通知
self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (!event.data) return;

  // ===== 兼容�?SHOW_NOTIFICATION =====
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
    return;
  }

  // ===== �? UPDATE_NOTIFICATION 替换占位通知 =====
  if (event.data.type === 'UPDATE_NOTIFICATION') {
    const { tag, title, body, data: notifData } = event.data;
    if (!tag) return;
    event.waitUntil((async () => {
      // 关闭旧的占位通知 (用同一�?tag)
      const existing = await self.registration.getNotifications({ tag });
      for (const n of existing) n.close();

      // 弹新通知
      await self.registration.showNotification(title, {
        body,
        icon: './assets/icon-192.png',
        badge: './assets/icon-192.png',
        tag,
        data: notifData || {},
        requireInteraction: true,
        vibrate: [200, 100, 200],
        timestamp: Date.now()
      });
    })());
    return;
  }
});

self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event);

  event.notification.close();

  const chatId = event.notification.data?.chatId;
  const urlToOpen = chatId ? `/?openChat=${chatId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus().then(client => {
              if (chatId) {
                client.postMessage({ type: 'OPEN_CHAT', chatId });
              }
              return client;
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
