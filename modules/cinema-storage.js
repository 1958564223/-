// ============================================================================
// cinema-storage.js — 330 Cinema Room 影片存储层 (v0.1.0)
//
// 【为什么有这个模块】
// 330 旧观影 (init-features.js:4442) 保存本地视频时走的是:
//     FileReader.readAsDataURL(file) -> 32MB base64 字符串 -> IndexedDB
// 24MB 视频 -> base64 膨胀 4/3 = 32MB 字符串, 结构化克隆时再复制一份,
// 回放时 fetch(dataURL) 又要重新解析一遍。手机上峰值 100MB+, 必然 OOM 崩溃。
//
// 【本模块的铁律】
//   视频本体永远不读进 JS 堆。存 Blob/File 对象本身 —— 浏览器结构化克隆时
//   直接落盘, 堆占用 O(1), 跟文件多大无关。播放时 createObjectURL 拿引用。
//
//   绝对禁止: readAsDataURL / btoa / fetch(dataURL) / new File([dataUrl])
//
// 【三张表为什么要拆开】
//   cinemaFilms    纯元数据 (id/name/size/type/addedAt), 绝不含 Blob。
//                  拆开是因为 Dexie toArray() 会把整条记录反序列化 ——
//                  元数据混着 Blob 的话, 列一次片单就把所有视频读进内存。
//   cinemaBlobs    { id, file } —— File 对象直存, 只有取单片时才读。
//   cinemaProgress { filmId, currentTime, duration, updatedAt } —— 纯数字。
//
// 【对照参考】KI-CO (CinemaCompanionRoom.tsx:1218) 在 Web/PWA 下用
//   URL.createObjectURL(file) 播放, 但从不持久化视频本体, 刷新后要用户
//   重选同名文件 (:1615)。本模块要补的就是它没做的这一层。
// ============================================================================

(function (global) {
  'use strict';

  const FILMS = 'cinemaFilms';
  const BLOBS = 'cinemaBlobs';
  const PROGRESS = 'cinemaProgress';
  // 人物立绘表 (db v66)。常量提到最上面 —— ensureCharTable() 会用,
  // 放在文件下面会撞 const 的 TDZ (声明前访问直接 ReferenceError)。
  const CHARS = 'cinemaChars';

  // 300MB 软警告线 —— 超过只提示, 不阻止 (用户 2026-10-04 决策)。
  // iOS PWA 长期存储配额常在 1GB 量级, 硬拦会让人存不进东西。
  const SOFT_WARN_BYTES = 300 * 1024 * 1024;

  function newId() {
    return (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : 'cine_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // 等 330 的 db 打开完成。init-data-protection.js:70 挂了 window.dbReadyPromise。
  async function whenDbReady() {
    if (global.dbReadyPromise) {
      try { await global.dbReadyPromise; } catch (e) { /* 下面统一再判一次 */ }
    }
    const db = global.db;
    if (!db) throw new Error('CinemaStorage: 330 db 未初始化');
    if (!db[FILMS] || !db[BLOBS] || !db[PROGRESS]) {
      throw new Error('CinemaStorage: Cinema Room 数据表缺失 (db schema 未升级到 v65)');
    }
    return db;
  }

  // --------------------------------------------------------------------------
  // 人物表自愈 (2026-10-04 18:00 真机事故)
  //
  // 【出了什么事】加了 db.version(66) 建 cinemaChars, 但忘了 bump index.html 里
  // init-db-schema.js 的 ?v=。Service Worker 一直吐缓存里的旧版 → 手机上 Dexie
  // 压根不知道有 v66 → cinemaChars 永远不建 → 上传人物直接报"数据表缺失"。
  //
  // 【为什么要有自愈】?v= 漏 bump 这类事故只要一次就够受的。这里做一层兜底:
  // 发现表不在, 就用 Dexie 的 schema API 现场把版本顶上去并建表 —— 用户最多
  // 刷新一次就能用, 不用等我们再发一版。写操作不依赖这张表, 所以不会牵连影片。
  //
  // 【为什么不自动重建整个 db】db.version(66) 只声明新增表, 不改任何已有表,
  // 所以 upgrade 是纯增量, 不会丢用户数据 —— 这是 Dexie 文档保证的。
  // --------------------------------------------------------------------------
  let charsHealing = null;
  async function ensureCharTable() {
    const db = await whenDbReady();
    if (db[CHARS]) return db[CHARS];
    if (!charsHealing) {
      charsHealing = (async function () {
        try {
          // ⚠️ 必须先 close() —— Dexie 不允许在库【已打开】时加版本号,
          //    否则直接抛 SchemaError: Cannot add version when database is open。
          //    (第一版自愈合在这, 真机一走兜底就报错, 是这次测试抓出来的。)
          //    close 之后 db.open() 会由 330 自己的 dbReadyPromise 那条链重新拉起来,
          //    这里紧接着自己 open 一次, 不用等别的地方。
          try { db.close(); } catch (e) { /* 本来就没开 */ }

          db.version(66).stores({ [CHARS]: '&id, updatedAt' });
          await db.open();
          if (db[CHARS]) {
            console.warn('[CinemaStorage] 人物表缺失, 已现场补建 v66');
            return db[CHARS];
          }
        } catch (e) {
          console.error('[CinemaStorage] 人物表补建失败', (e && e.name) || '', (e && e.message) || e);
        }
        return null;
      })();
    }
    return charsHealing;
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[^/.]+$/, '');
  }

  // --------------------------------------------------------------------------
  // 容量
  // --------------------------------------------------------------------------

  async function getUsage() {
    const db = await whenDbReady();
    const rows = await db[FILMS].toArray();
    let filmBytes = 0;
    let filmCount = 0;
    for (const row of rows) {
      filmBytes += row.size || 0;
      filmCount += 1;
    }
    let quota = null;
    let usage = null;
    try {
      if (global.navigator && navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        quota = est.quota;
        usage = est.usage;
      }
    } catch (e) { /* 拿不到就只报影片字节数 */ }

    return {
      filmBytes: filmBytes,
      filmCount: filmCount,
      quota: quota,
      usage: usage,
      softWarnBytes: SOFT_WARN_BYTES,
      overSoftWarn: filmBytes > SOFT_WARN_BYTES
    };
  }

  // 加入前的软警告检查: 返回 { warn, current, incoming, total }
  async function checkSoftWarn(incomingBytes) {
    const info = await getUsage();
    const total = info.filmBytes + (incomingBytes || 0);
    return {
      warn: total > SOFT_WARN_BYTES,
      current: info.filmBytes,
      incoming: incomingBytes || 0,
      total: total,
      quota: info.quota
    };
  }

  // --------------------------------------------------------------------------
  // 影片: 写入
  // --------------------------------------------------------------------------

  /**
   * 加入一部影片。file 传 File 或 Blob 都可以。
   * 在线片源 (B 站外链 / URL) 传 meta.url 且不给 file, 只存元数据。
   */
  async function addFilm(file, meta) {
    const db = await whenDbReady();
    const m = meta || {};
    const id = m.id || newId();
    const name = m.name || (file && (stripExt(file.name) || file.name)) || '未命名影片';

    const record = {
      id: id,
      name: name,
      // 本地影片 = 存 Blob; 在线片源 = 只存 URL 字符串 (体积可忽略)
      size: file ? (file.size || 0) : 0,
      type: file ? (file.type || '') : '',
      sourceType: file ? 'local-file' : 'url',
      url: m.url || '',
      platform: m.platform || '',
      addedAt: Date.now()
    };

    // 先写 Blob 再写元数据: Blob 写失败(配额满)就什么都没留下, 不会出现"列表里有、播不了"
    if (file) {
      await db[BLOBS].put({ id: id, file: file });
    }
    try {
      await db[FILMS].put(record);
      await db[PROGRESS].put({ filmId: id, currentTime: 0, duration: 0, updatedAt: Date.now() });
    } catch (e) {
      // 元数据写失败就把 Blob 撤掉, 免得白占用户手机空间
      if (file) { try { await db[BLOBS].delete(id); } catch (e2) { /* ignore */ } }
      throw e;
    }
    return record;
  }

  // --------------------------------------------------------------------------
  // 影片: 读取
  // --------------------------------------------------------------------------

  // 列片单。只读 cinemaFilms(纯元数据) + cinemaProgress(纯数字), 一条 Blob 都不碰。
  async function listFilms() {
    const db = await whenDbReady();
    const rows = await db[FILMS].orderBy('addedAt').reverse().toArray();
    const progs = await db[PROGRESS].toArray();
    const pMap = new Map();
    for (const p of progs) pMap.set(p.filmId, p);

    return rows.map(function (r) {
      const p = pMap.get(r.id);
      return {
        id: r.id,
        name: r.name,
        size: r.size || 0,
        type: r.type || '',
        sourceType: r.sourceType || 'local-file',
        url: r.url || '',
        platform: r.platform || '',
        addedAt: r.addedAt || 0,
        currentTime: p ? (p.currentTime || 0) : 0,
        duration: p ? (p.duration || 0) : 0
      };
    });
  }

  // 取单个影片的 File 对象。返回 null = 本体已被系统驱逐(见下 missing 处理)。
  async function getFilmFile(id) {
    const db = await whenDbReady();
    const row = await db[BLOBS].get(id);
    if (!row || !row.file) return null;
    return row.file;
  }

  async function getFilm(id) {
    const db = await whenDbReady();
    return db[FILMS].get(id);
  }

  // --------------------------------------------------------------------------
  // 影片: 删除
  // --------------------------------------------------------------------------

  async function removeFilm(id) {
    const db = await whenDbReady();
    const record = await db[FILMS].get(id);
    await db[FILMS].delete(id);
    await db[BLOBS].delete(id);
    await db[PROGRESS].delete(id);
    return record ? (record.size || 0) : 0;  // 返回释放的字节数
  }

  // --------------------------------------------------------------------------
  // 播放进度
  // --------------------------------------------------------------------------

  async function saveProgress(filmId, currentTime, duration) {
    if (!filmId) return;
    const db = await whenDbReady();
    try {
      await db[PROGRESS].put({
        filmId: filmId,
        currentTime: Math.max(0, Number(currentTime) || 0),
        duration: Math.max(0, Number(duration) || 0),
        updatedAt: Date.now()
      });
    } catch (e) {
      // 进度写失败不能影响播放, 静默降级
      if (global.console) console.warn('[CinemaStorage] 进度保存失败', e);
    }
  }

  async function getProgress(filmId) {
    const db = await whenDbReady();
    const p = await db[PROGRESS].get(filmId);
    return p || { filmId: filmId, currentTime: 0, duration: 0 };
  }

  // --------------------------------------------------------------------------
  // 工具
  // --------------------------------------------------------------------------

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = (h > 0 ? String(m).padStart(2, '0') : String(m));
    return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  // --------------------------------------------------------------------------
  // 人物立绘 (沙发上的透明小人)
  //
  // 【图片规格建议】(2026-10-04)
  //   显示尺寸: 角色位宽 = 视口 28% ≈ 110px, 高宽比 3:5 → 约 110x185 CSS px
  //   3 倍屏需要 ≈ 330x555 物理像素
  //   → 推荐存 768x1280 (3:5), WebP 带透明, quality 0.85
  //   → 体积 60~120KB; 同一张 PNG 带透明会是 400KB~1MB, 差 5~8 倍
  //   → 想更小可以用 512x853 的 WebP (30~60KB), 手机上依然清晰
  //
  // 【为什么必须存 Blob】
  //   跟 cinemaBlobs 同一个道理: base64 会让内存翻好几倍, 手机上会卡。
  //   浏览器结构化克隆 Blob 时直接落盘, 堆占用可忽略。
  // --------------------------------------------------------------------------

  const CHARS_TABLES_NOTE = true;   // CHARS 已在文件顶部声明 (ensureCharTable 要用)

  // 位置/缩放的默认值。用户没调过就落这套, 渲染层直接用, 不用到处判空。
  // x/y 是【相对房间背景图的百分比】(0~100), scale 是倍数。
  // 用百分比而不是 px: 换手机/转屏时道具还坐在沙发的同一个位置。
  //
  // ⚠️ 每个 slot 的默认值不同, 而且这里跟 cinema-room.js 的初始值必须一致 ——
  //    两边不一致会导致"存图写 50/50、渲染写 26/74", 人物一进房就跳到中间 (踩过)。
  //
  // 【背景图 2026-10-04 换成无茶几版】(1080x1920)
  //   沙发靠背顶 ~52% / 坐垫中线 ~66% / 坐垫左右 ~63%~75% / 沙发底沿 ~76%
  //   → 人物脚底落在 66% 才真正坐在坐垫上 (旧图是 60%, 因为旧图沙发位置更高)
  //   → 茶几默认落在 84% (沙发前方空地), 宽一点矮一点
  const DEFAULT_CHAR_LAYOUT = { x: 50, y: 66, scale: 1 };
  const DEFAULT_CHAR_LAYOUT_BY_SLOT = {
    left: { x: 27, y: 66, scale: 1 },
    right: { x: 73, y: 66, scale: 1 },
    table: { x: 50, y: 84, scale: 1 }
  };
  // 合法 slot 白名单。茶几是 2026-10-04 加的 (背景图去掉了茶几, 改成用户自己传)。
  const CHAR_SLOTS = ['left', 'right', 'table'];
  function defaultLayoutFor(slot) {
    return Object.assign({}, DEFAULT_CHAR_LAYOUT_BY_SLOT[slot] || DEFAULT_CHAR_LAYOUT);
  }

  /**
   * 存道具图 (人物 / 茶几)。换图时位置重置 (新图尺寸肯定不一样, 旧位置没意义)。
   */
  async function saveChar(slot, blob) {
    if (CHAR_SLOTS.indexOf(slot) === -1) throw new Error('slot 只能是 left / right / table');
    if (!blob) throw new Error('没有图片数据');
    const table = await ensureCharTable();
    if (!table) throw new Error('道具数据表缺失 (db schema 未升级到 v66), 请刷新页面重试');
    const d = defaultLayoutFor(slot);
    await table.put({
      id: slot,
      image: blob,
      x: d.x, y: d.y, scale: d.scale,
      updatedAt: Date.now()
    });
    return slot;
  }

  /**
   * 只更新位置/缩放, 【不碰 image】。
   * ⚠️ 必须走 table.update 而不是 put —— put 会把整条记录重写,
   *    如果只传 {id, x, y, scale}, image 字段就没了 (道具直接消失)。
   */
  async function setCharLayout(slot, layout) {
    if (CHAR_SLOTS.indexOf(slot) === -1) throw new Error('slot 只能是 left / right / table');
    const table = await ensureCharTable();
    if (!table) return null;
    const d = defaultLayoutFor(slot);
    const patch = {
      x: clampNum(layout && layout.x, 0, 100, d.x),
      y: clampNum(layout && layout.y, 0, 100, d.y),
      scale: clampNum(layout && layout.scale, 0.3, 3, d.scale)
    };
    const n = await table.update(slot, patch);
    if (!n) return null;   // 这张 slot 还没图 —— 不建记录, 免得出现"有位置没图"的空壳
    return patch;
  }

  function clampNum(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** 取图片 + 位置。位置字段缺失的老数据补默认 (按 slot 区分左右)。 */
  async function getChar(slot) {
    const row = await getCharRow(slot);
    return (row && row.image) ? row.image : null;
  }

  async function getCharRow(slot) {
    const table = await ensureCharTable();
    if (!table) return null;
    const row = await table.get(slot);
    if (!row) return null;
    const d = defaultLayoutFor(slot);
    return {
      image: row.image || null,
      x: clampNum(row.x, 0, 100, d.x),
      y: clampNum(row.y, 0, 100, d.y),
      scale: clampNum(row.scale, 0.3, 3, d.scale)
    };
  }

  async function getAllChars() {
    const out = {};
    const table = await ensureCharTable();
    if (!table) return out;
    for (const slot of CHAR_SLOTS) {
      const row = await table.get(slot);
      if (row && row.image) out[slot] = row.image;
    }
    return out;
  }

  async function removeChar(slot) {
    const table = await ensureCharTable();
    if (!table) return false;
    await table.delete(slot);
    return true;
  }

  global.CinemaStorage = {
    FILMS: FILMS,
    BLOBS: BLOBS,
    PROGRESS: PROGRESS,
    SOFT_WARN_BYTES: SOFT_WARN_BYTES,
    addFilm: addFilm,
    listFilms: listFilms,
    getFilm: getFilm,
    getFilmFile: getFilmFile,
    removeFilm: removeFilm,
    saveProgress: saveProgress,
    getProgress: getProgress,
    getUsage: getUsage,
    checkSoftWarn: checkSoftWarn,
    formatBytes: formatBytes,
    formatTime: formatTime,
    // 人物立绘
    saveChar: saveChar,
    getChar: getChar,
    getCharRow: getCharRow,
    setCharLayout: setCharLayout,
    DEFAULT_CHAR_LAYOUT: DEFAULT_CHAR_LAYOUT,
    DEFAULT_CHAR_LAYOUT_BY_SLOT: DEFAULT_CHAR_LAYOUT_BY_SLOT,
    CHAR_SLOTS: CHAR_SLOTS,
    defaultLayoutFor: defaultLayoutFor,
    getAllChars: getAllChars,
    removeChar: removeChar
  };

})(window);
