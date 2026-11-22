// ==UserScript==
// @name         KomaGlide
// @namespace    https://komaglide.local/
// @version      0.7.10
// @updateURL    https://raw.githubusercontent.com/st9240202/KomaGlide/main/dist/komaglide.user.js
// @downloadURL  https://raw.githubusercontent.com/st9240202/KomaGlide/main/dist/komaglide.user.js
// @description  在漫畫分頁閱讀、保存圖片，並從腳本選單開啟本站書庫。
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      imgs.xkcd.com
// @connect      img7.8comic.com
// @connect      img9.8comic.com
// @connect      hath.network
// @connect      hamreus.com
// ==/UserScript==

// 開發用範本。安裝到腳本管理器時請選 dist/komaglide.user.js。
(() => {
  'use strict';

  const PREFIX = 'kg1.';
  const SHELF_HASH = '#komaglide/';
  const IMAGE_LIMIT = 32 * 1024 * 1024;
  const MIME = /^image\/(?:jpeg|png|apng|webp|gif|avif|bmp|x-icon)$/i;
  const read = key => GM.getValue(key, null);
  const write = (key, value) => GM.setValue(key, value);

  function webUrl(value, base = document.baseURI) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  const DB_NAME = 'komaglide-library-v1';
const MiB = 1024 ** 2;
const DEFAULT_LIMIT = 1024 * MiB;
const stores = ['pages', 'chapters', 'favoriteWorks', 'settings'];
let opening;
let useImageBytes = false;

function database() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const store of stores) req.result.createObjectStore(store);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        opening = undefined;
      };
      resolve(req.result);
    };
  });
  return opening;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transaction(names, mode, run) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const tables = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    let result;
    let failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('書庫寫入已中斷，請重試。'));
    Promise.resolve().then(() => run(tables)).then(value => {
      result = value;
    }, error => {
      failure = error;
      try { tx.abort(); } catch { reject(error); }
    });
  });
}

async function readState(settings) {
  return await request(settings.get('storage')) || { used: 0, limit: DEFAULT_LIMIT, clock: 0 };
}

function touch(state, chapter) {
  state.clock = Math.max(Date.now(), state.clock + 1);
  chapter.lastRead = state.clock;
}

function identity(page) {
  if (!page || typeof page.site !== 'string' || !page.site || typeof page.chapterId !== 'string' || !page.chapterId ||
      (page.workId != null && typeof page.workId !== 'string') ||
      !Number.isSafeInteger(page.index) || page.index < 1) {
    throw new Error('頁面識別資料不完整，無法存取漫畫頁。');
  }
  return [page.site, page.workId || '', page.chapterId];
}

function indices(key) {
  return IDBKeyRange.bound([...key, 1], [...key, Number.MAX_SAFE_INTEGER]);
}

// Select the complete set of victims before deleting anything. The read-write
// transaction serializes selection, byte accounting and the actual Blob write.
async function makeRoom(tables, state, required, skipKey) {
  if (required <= 0) return;
  const [chapters, favorites] = await Promise.all([
    request(tables.chapters.getAll()), request(tables.favoriteWorks.getAllKeys())
  ]);
  const protectedWorks = new Set(favorites.map(key => JSON.stringify(key)));
  const candidates = chapters.filter(chapter =>
    !chapter.favorite && !(chapter.workKnown && protectedWorks.has(JSON.stringify(chapter.key.slice(0, 2)))) &&
    (!skipKey || indexedDB.cmp(chapter.key, skipKey) !== 0)
  ).sort((a, b) => a.lastRead - b.lastRead);
  let bytes = 0;
  let count = 0;
  while (count < candidates.length && bytes < required) bytes += candidates[count++].bytes;
  if (bytes < required) throw new Error('容量不足。請調高書庫上限或解除收藏，再重新儲存。');
  for (const { key } of candidates.slice(0, count)) {
    tables.chapters.delete(key);
    tables.pages.delete(indices(key));
  }
  state.used -= bytes;
}

function title(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function putPage(page, blob) {
  const key = identity(page);
  if (!(blob instanceof Blob) || !blob.size) throw new Error('圖片沒有內容，請重新載入這一頁。');
  let blobRejected = false;
  function save(image) {
    return transaction(stores, 'readwrite', async tables => {
      const pageKey = [...key, page.index];
      const [state, previous, present] = await Promise.all([
        readState(tables.settings), request(tables.chapters.get(key)), request(tables.pages.getKey(pageKey))
      ]);
      const chapter = previous || { key, favorite: false, count: 0, bytes: 0, total: null };
      if (!present) {
        if (blob.size + chapter.bytes > state.limit) {
          throw new Error('這一話的圖片超過書庫上限。請調高上限後重試。');
        }
        await makeRoom(tables, state, state.used + blob.size - state.limit, key);
        try {
          await request(tables.pages.add({ ...image, imageUrl: title(page.imageUrl, '') }, pageKey));
        } catch (error) {
          blobRejected = !!image.blob && (error.name === 'UnknownError' || error.name === 'DataCloneError');
          throw error;
        }
        state.used += blob.size;
        chapter.bytes += blob.size;
        chapter.count++;
      }
      chapter.workTitle = title(page.workTitle, chapter.workTitle || key[1]);
      chapter.chapterTitle = title(page.chapterTitle, chapter.chapterTitle || key[2]);
      if (typeof page.chapterSubtitle === 'string') chapter.chapterSubtitle = page.chapterSubtitle;
      chapter.chapterUrl = title(page.chapterUrl, chapter.chapterUrl || '');
      chapter.workKnown = !!key[1] && (page.workKnown ?? chapter.workKnown ?? true);
      chapter.lastIndex = Math.max(chapter.lastIndex || 0, page.index);
      if (Number.isSafeInteger(page.total) && page.total >= chapter.lastIndex) {
        chapter.total = Math.max(chapter.total || 0, page.total);
      }
      if (chapter.total && chapter.lastIndex > chapter.total) chapter.total = null;
      if (Number.isFinite(page.chapterOrder)) chapter.order = page.chapterOrder;
      touch(state, chapter);
      tables.chapters.put(chapter, key);
      tables.settings.put(state, 'storage');
    });
  }

  if (!useImageBytes) {
    try { return await save({ blob }); }
    catch (error) { if (!blobRejected) throw error; }
  }
  // Some WebKit contexts cannot persist Blob records. Convert outside the
  // transaction, after a rejected write and its evictions have rolled back.
  const bytes = await blob.arrayBuffer();
  await save({ bytes, mime: blob.type });
  useImageBytes = true;
}

// Keep saved pages readable when the browser can no longer commit recency data.
async function chapterRead(key, read) {
  async function run(tables) {
    const chapter = await request(tables.chapters.get(key));
    if (!chapter) return null;
    const result = await read(tables.pages, chapter);
    if (result && tables.settings) {
      const state = await readState(tables.settings);
      touch(state, chapter);
      tables.chapters.put(chapter, key);
      tables.settings.put(state, 'storage');
    }
    return result;
  }
  try {
    return await transaction(['pages', 'chapters', 'settings'], 'readwrite', run);
  } catch (error) {
    if (error.name !== 'QuotaExceededError') throw error;
    return transaction(['pages', 'chapters'], 'readonly', run);
  }
}

async function lookupPage(page, includeBlob) {
  const key = identity(page);
  const pageKey = [...key, page.index];
  const data = await chapterRead(key, pages => request(includeBlob ? pages.get(pageKey) : pages.getKey(pageKey)));
  if (!includeBlob) return { exists: !!data };
  const blob = data ? data.blob || new Blob([data.bytes], { type: data.mime }) : null;
  return { exists: !!data, blob };
}

async function shelf() {
  return transaction(['chapters', 'favoriteWorks', 'settings'], 'readonly', async tables => ({
    chapters: await request(tables.chapters.getAll()),
    favorites: await request(tables.favoriteWorks.getAllKeys()),
    state: await readState(tables.settings)
  }));
}

async function savedPageCount(key) {
  const chapter = await transaction(['chapters'], 'readonly', tables => request(tables.chapters.get(key)));
  return chapter?.count || 0;
}

async function readChapterSubtitle(key) {
  const chapter = await transaction(['chapters'], 'readonly', tables => request(tables.chapters.get(key)));
  return chapter?.chapterSubtitle;
}

async function setChapterSubtitle(key, subtitle) {
  return transaction(['chapters'], 'readwrite', async ({chapters}) => {
    const chapter = await request(chapters.get(key));
    if (!chapter || chapter.chapterSubtitle === subtitle) return false;
    chapter.chapterSubtitle = subtitle;
    await request(chapters.put(chapter, key));
    return true;
  });
}

async function readChapter(key) {
  return chapterRead(key, async (pages, chapter) => {
    const keys = await request(pages.getAllKeys(indices(key)));
    return { chapter, indices: keys.map(pageKey => pageKey[3]) };
  });
}

async function readerBlob(key, index) {
  const [site, workId, chapterId] = key;
  const result = await lookupPage({ site, workId, chapterId, index }, true);
  return result.blob;
}

async function setLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('請輸入有效的容量上限。');
  return transaction(stores, 'readwrite', async tables => {
    const state = await readState(tables.settings);
    await makeRoom(tables, state, state.used - bytes);
    state.limit = bytes;
    tables.settings.put(state, 'storage');
  });
}

async function setFavorite(key, enabled) {
  return transaction(['chapters', 'favoriteWorks'], 'readwrite', async tables => {
    if (key.length === 2) {
      if (!key[1]) throw new Error('尚未確認這一話所屬的作品。');
      if (enabled) tables.favoriteWorks.put(true, key);
      else tables.favoriteWorks.delete(key);
      return;
    }
    const chapter = await request(tables.chapters.get(key));
    if (!chapter) throw new Error('書庫已移除這一話，請重新開啟書架。');
    chapter.favorite = enabled;
    tables.chapters.put(chapter, key);
  });
}

  let shelfEvents;

function getShelfEvents() {
  if (shelfEvents) return shelfEvents;
  const changes = new EventTarget();
  let channel;
  try {
    channel = new BroadcastChannel('komaglide-site-shelf-v1');
  } catch { /* A shelf opened later still reads the saved pages directly. */ }
  const dispatch = detail => changes.dispatchEvent(new CustomEvent('change', {detail}));
  if (channel) channel.onmessage = ({data}) => {
    if (typeof data?.kind === 'string') dispatch(data);
  };
  shelfEvents = {
    changes,
    announce(detail) {
      dispatch(detail);
      channel?.postMessage(detail);
    },
    messageFor(error) {
      return error?.name === 'QuotaExceededError'
        ? '瀏覽器儲存空間不足，請釋放空間後再試。'
        : error?.message || '無法存取本站書庫。';
    }
  };
  return shelfEvents;
}

function notifyPageSaved({site, workId, chapterId}) {
  getShelfEvents().announce({kind: 'saved', site, workId, chapterId});
}

  
function mountShelf(routePrefix, { announce, changes, messageFor }) {
  const $ = id => document.getElementById(id);
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    link.hash = routePrefix + link.hash.slice(1);
  }
  const collator = new Intl.Collator('zh-Hant', { numeric: true });
  let version = 0;
  let refreshTimer;
  let disposePages = () => {};
  let pageAtViewport = () => 1;
  let activeKey;
  let retentionCheck = 0;
  let pendingRetentionRequest;
  const MiB = 1024 ** 2;
  const preferencesKey = 'komaglide.reader.preferences.v1';

  function readPreferences() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(preferencesKey)); } catch { /* Storage may be unavailable. */ }
    return {
      mode: ['single', 'double'].includes(saved?.mode) ? saved.mode : 'scroll',
      theme: ['light', 'dark'].includes(saved?.theme) ? saved.theme : 'system',
      direction: saved?.direction === 'ltr' ? 'ltr' : 'rtl',
      tapToTurn: saved?.tapToTurn !== false,
      thumbnailSize: ['small', 'large'].includes(saved?.thumbnailSize) ? saved.thumbnailSize : 'medium',
    };
  }

  let libraryPreferences = readPreferences();
  let updateReaderPreferences;
  const themePicker = $('library-theme');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const setLibraryTheme = watchReaderTheme(theme => {
    const root = document.documentElement;
    if (root.dataset.readerTheme === theme) return;
    root.dataset.readerTheme = theme;
    themeColor.content = getComputedStyle(root).getPropertyValue('--paper').trim();
  });

  function applyLibraryPreferences(next) {
    libraryPreferences = next;
    themePicker.value = next.theme;
    setLibraryTheme(next.theme);
    updateReaderPreferences?.(next);
  }

  function changePreference(field, value) {
    const next = { ...libraryPreferences, [field]: value };
    applyLibraryPreferences(next);
    try { localStorage.setItem(preferencesKey, JSON.stringify(next)); } catch { /* Keep the choice for this tab. */ }
  }

  applyLibraryPreferences(libraryPreferences);
  themePicker.addEventListener('change', () => changePreference('theme', themePicker.value));
  window.addEventListener('storage', event => {
    if (event.key === preferencesKey || event.key === null) applyLibraryPreferences(readPreferences());
  });

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function notify(text = '', tone = '') {
    const notice = $('notice');
    notice.dataset.tone = tone;
    notice.textContent = text;
    notice.hidden = !text;
    return notice;
  }

  async function readStorageProtection(method) {
    try {
      const storage = navigator.storage;
      if (typeof storage?.[method] !== 'function') return {state: 'unsupported'};
      return {state: await storage[method]() ? 'granted' : 'not-granted'};
    } catch (error) {
      return {state: 'error', detail: [error?.name, error?.message].filter(Boolean).join(' · ') || String(error)};
    }
  }

  function storageProtectionMessage({state}, action) {
    if (state === 'granted') return '瀏覽器已授予持久儲存。';
    if (state === 'not-granted') return action === '查詢'
      ? '本站目前尚未獲得持久儲存保護。'
      : '瀏覽器未核准這次持久儲存申請。';
    if (state === 'unsupported') return '目前的瀏覽器環境未提供持久儲存' + action + '功能。';
    return '瀏覽器' + action + '持久儲存時發生錯誤。';
  }

  function showStorageDiagnostic(element, result, action, api) {
    element.textContent = storageProtectionMessage(result, action);
    if (result.state === 'granted') return;
    const detail = result.state === 'not-granted' ? api + ' 回傳 false' : [api, result.detail].filter(Boolean).join(' · ');
    element.append(el('span', detail, 'notice-detail'));
  }

  async function checkStorageProtection() {
    const check = ++retentionCheck;
    const status = $('retention');
    status.textContent = '正在查詢本站的持久儲存狀態。';
    const result = await readStorageProtection('persisted');
    if (check === retentionCheck) showStorageDiagnostic(status, result, '查詢', 'navigator.storage.persisted()');
  }

  function requestStorageProtection() {
    if (pendingRetentionRequest) return pendingRetentionRequest;
    // Start during the click so browser policies that require a gesture can apply.
    const pending = pendingRetentionRequest = readStorageProtection('persist');
    const button = $('request-retention');
    const status = $('retention-result');
    button.disabled = true;
    status.textContent = '正在向瀏覽器申請持久儲存。';
    void pending.then(result => {
      pendingRetentionRequest = null;
      showStorageDiagnostic(status, result, '申請', 'navigator.storage.persist()');
      button.disabled = false;
      if (!$('storage').hidden) void checkStorageProtection();
    });
    return pending;
  }

  function size(bytes) {
    if (bytes >= 1024 * MiB) return (bytes / (1024 * MiB)).toLocaleString('zh-Hant', { maximumFractionDigits: 2 }) + ' GiB';
    if (bytes >= MiB) return (bytes / MiB).toLocaleString('zh-Hant', { maximumFractionDigits: 1 }) + ' MiB';
    if (bytes >= 1024) return Math.ceil(bytes / 1024) + ' KiB';
    return bytes + ' B';
  }

  function chapterHref(key) {
    return routePrefix + 'read/' + key.map(encodeURIComponent).join('/');
  }

  function japaneseSubtitle(chapter, tag, className) {
    const subtitle = el(tag, chapter.chapterSubtitle, className);
    subtitle.lang = 'ja';
    return subtitle;
  }

  function chapterLink(chapter, label = chapter.chapterTitle) {
    const link = el('a', label, 'chapter-link');
    link.href = chapterHref(chapter.key);
    return link;
  }

  function shelfChapterLink(chapter) {
    const link = chapterLink(chapter);
    // Only separate an explicit chapter number from a named title. Keep the
    // original wording and separator for copying and assistive technology.
    const parts = /^(第\s*[0-9０-９〇零一二三四五六七八九十百千萬兩]+(?:[.．][0-9０-９]+)?\s*[話集章回卷冊]|(?:chapter|episode)\s+\d+(?:\.\d+)?)([：:]\s*|\s+)(\S[\s\S]*)$/iu.exec(chapter.chapterTitle);
    if (parts) {
      const [, number, separator, title] = parts;
      const punctuation = separator.trimEnd();
      const heading = el('span', null, 'chapter-heading');
      const ordinal = el('span', number + punctuation, 'chapter-ordinal');
      ordinal.append(el('span', separator.slice(punctuation.length), 'chapter-separator'));
      heading.append(ordinal, el('span', title));
      link.replaceChildren(heading);
    }
    if (chapter.chapterSubtitle) link.append(japaneseSubtitle(chapter, 'span', 'chapter-subtitle'));
    return link;
  }

  function chaptersInOrder(a, b) {
    if (Number.isFinite(a.order) && Number.isFinite(b.order) && a.order !== b.order) return a.order - b.order;
    return collator.compare(a.chapterTitle, b.chapterTitle) || collator.compare(a.key[2], b.key[2]);
  }

  function countText(chapter) {
    return chapter.total ? '已存 ' + chapter.count + ' / ' + chapter.total + ' 頁' : '已存 ' + chapter.count + ' 頁 · 總頁數未知';
  }

  function favoriteButton(key, enabled, name) {
    const label = (enabled ? '已收藏' : '收藏') + name;
    const button = el('button', label, 'favorite');
    button.type = 'button';
    button.id = 'kg-favorite-' + key.map(encodeURIComponent).join('/');
    button.setAttribute('aria-pressed', String(enabled));
    if (key.length === 3) {
      const ns = 'http://www.w3.org/2000/svg';
      const icon = document.createElementNS(ns, 'svg');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M6.25 4.75a1 1 0 0 1 1-1h9.5a1 1 0 0 1 1 1v15.5L12 16.3l-5.75 3.95z');
      icon.append(path);
      button.replaceChildren(icon);
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    button.onclick = async () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      button.setAttribute('aria-disabled', 'true');
      const route = location.hash;
      const retention = enabled ? null : requestStorageProtection();
      try {
        await setFavorite(key, !enabled);
        announce({ kind: 'favorite' });
        if (location.hash !== route) return;
        const notice = notify(enabled ? '已取消收藏。' : '已收藏。', 'success');
        if (retention) {
          const detail = el('span', '', 'notice-detail');
          notice.append(detail);
          void retention.then(result => {
            if (result.state === 'granted') return;
            const link = el('a', '查看儲存診斷');
            link.href = routePrefix + 'storage';
            detail.append(storageProtectionMessage(result, '申請'), ' ', link);
          });
        }
      } catch (error) {
        notify(messageFor(error));
      } finally {
        button.removeAttribute('aria-disabled');
      }
    };
    return button;
  }

  function showBooks(data, starred) {
    const protectedWorks = new Set(data.favorites.map(key => JSON.stringify(key)));
    const groups = new Map();
    for (const chapter of data.chapters) {
      const workKey = chapter.key.slice(0, 2);
      const workStar = chapter.workKnown && protectedWorks.has(JSON.stringify(workKey));
      if (starred && !workStar && !chapter.favorite) continue;
      const id = JSON.stringify(chapter.workKnown ? workKey : chapter.key);
      if (!groups.has(id)) groups.set(id, { chapters: [], workKey, workStar, recent: chapter });
      const group = groups.get(id);
      group.chapters.push(chapter);
      if (chapter.lastRead > group.recent.lastRead) group.recent = chapter;
    }
    const frag = document.createDocumentFragment();
    for (const group of [...groups.values()].sort((a, b) => b.recent.lastRead - a.recent.lastRead)) {
      const { recent, workKey, workStar } = group;
      const article = el('article', null, 'work');
      const head = el('div', null, 'work-head');
      const names = el('div');
      names.append(el('h2', recent.workKnown ? recent.workTitle : '尚未歸入作品'),
        el('span', recent.key[0] + ' · ' + group.chapters.length + ' 話', 'source'));
      head.append(names);
      if (recent.workKnown) head.append(favoriteButton(workKey, workStar, '作品'));
      article.append(head);
      for (const chapter of group.chapters.sort(chaptersInOrder)) {
        const row = el('div', null, 'chapter-row');
        const link = shelfChapterLink(chapter);
        const bookmark = favoriteButton(chapter.key, chapter.favorite, '單話');
        link.id = 'title-' + bookmark.id;
        bookmark.setAttribute('aria-describedby', link.id);
        row.append(link, el('span', countText(chapter), 'count'), bookmark);
        article.append(row);
      }
      frag.append(article);
    }
    if (!groups.size) {
      const empty = el('div', null, 'empty');
      empty.append(el('h2', starred ? '還沒有收藏' : '書架上還沒有漫畫'),
        el('p', starred ? '在全部作品中收藏作品或單話，即可在這裡找到。' :
          '安裝 KomaGlide 腳本後，到支援的漫畫頁閱讀。已儲存的頁面會自動出現在這裡。'));
      frag.append(empty);
    }
    const books = $('books');
    const focusedId = books.contains(document.activeElement) && document.activeElement.id;
    books.replaceChildren(frag);
    if (focusedId) {
      const nextFocus = $(focusedId) || $(starred ? 'star-tab' : 'all-tab');
      nextFocus.focus({ preventScroll: true });
    }
  }

  function addPages(key, chapter, indices, initialPage) {
    const list = $('pages');
    const toolbar = $('reader-tools');
    const saved = new Set(indices);
    const total = Math.max(chapter.total || 0, indices.at(-1) || 1);
    let current = Math.max(1, Math.min(initialPage, total));
    let preferences = libraryPreferences;
    let scrollAnchor;
    const pending = new Map();
    const urls = new Map();
    function release(slot) {
      pending.delete(slot);
      if (urls.has(slot)) URL.revokeObjectURL(urls.get(slot));
      urls.delete(slot);
      slot.replaceChildren();
    }
    async function load(slot) {
      const token = Symbol();
      pending.set(slot, token);
      try {
        const index = Number(slot.dataset.index);
        const blob = await readerBlob(key, index);
        if (pending.get(slot) !== token) return;
        if (!blob) throw new Error('此頁已從書庫移除。');
        const img = el('img');
        const url = URL.createObjectURL(blob);
        urls.set(slot, url);
        img.dataset.index = String(index);
        img.alt = '第 ' + index + ' 頁';
        img.onload = () => {
          if (img.naturalWidth && img.naturalHeight) slot.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
        };
        img.onerror = () => {
          if (pending.get(slot) === token) slot.replaceChildren(el('p', '第 ' + index + ' 頁的圖片無法解碼。', 'gap'));
        };
        img.src = url;
        slot.replaceChildren(img);
      } catch (error) {
        if (pending.get(slot) === token) slot.replaceChildren(el('p', messageFor(error), 'gap'));
      }
    }
    const observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting && !pending.has(target) && list.contains(target)) load(target);
        if (!isIntersecting) release(target);
      }
    }, { rootMargin: '1400px 0px' });
    function gap(first, last) {
      if (first > last) return;
      const range = first === last ? String(first) : first + '–' + last;
      const missing = el('p', '第 ' + range + ' 頁尚未儲存', 'gap');
      missing.dataset.first = first;
      missing.dataset.last = last;
      list.append(missing);
    }
    function figureAt(index) {
      const figure = el('figure');
      figure.dataset.first = index;
      const slot = el('div', null, 'page-slot');
      slot.dataset.index = String(index);
      figure.append(el('figcaption', '第 ' + index + ' 頁'), slot);
      list.append(figure);
      observer.observe(slot);
    }
    function clear() {
      observer.disconnect();
      observer.takeRecords();
      for (const slot of pending.keys()) release(slot);
      list.replaceChildren();
    }
    function alignToPage() {
      const row = [...list.children].find(node => Number(node.dataset.first) <= current &&
        Number(node.dataset.last || node.dataset.first) >= current);
      if (!row) return;
      window.scrollBy(0, row.getBoundingClientRect().top);
      scrollAnchor = { page: current, y: window.scrollY };
    }
    pageAtViewport = () => {
      if (preferences.mode !== 'scroll') return current;
      // A short final page may share the viewport with its predecessor after a jump.
      if (scrollAnchor?.y === window.scrollY) return scrollAnchor.page;
      scrollAnchor = undefined;
      const row = [...list.children].find(node => node.getBoundingClientRect().bottom > 1);
      return row ? Number(row.dataset.first) : total;
    };
    function draw(align = false) {
      clear();
      scrollAnchor = undefined;
      $('reader').dataset.mode = preferences.mode;
      document.documentElement.classList.toggle('paged-reader', preferences.mode !== 'scroll');
      if (preferences.mode === 'scroll') {
        let next = 1;
        for (const index of indices) {
          gap(next, index - 1);
          figureAt(index);
          next = index + 1;
        }
        gap(next, total);
      } else {
        const first = preferences.mode === 'double' ? current - ((current - 1) % 2) : current;
        const last = preferences.mode === 'double' ? Math.min(first + 1, total) : first;
        for (let index = first; index <= last; index++) {
          if (saved.has(index)) figureAt(index);
          else gap(index, index);
        }
        if (align) window.scrollTo(0, 0);
      }
      controls.update({ ...preferences, current, total });
      if (align && preferences.mode === 'scroll') alignToPage();
    }
    function applyPreferences(next) {
      const modeChanged = next.mode !== preferences.mode;
      if (modeChanged) current = pageAtViewport();
      preferences = next;
      list.dir = next.mode === 'double' ? next.direction : 'ltr';
      if (modeChanged) draw(true);
      else controls.update({ ...preferences, current, total });
    }
    const controls = mountReaderControls(toolbar, {
      ...preferences, keyTarget: document, tapTarget: list,
      settingsExtras: [$('chapter-head'), $('reader-return')],
      navigationExtras: $('reader-end').childElementCount ? [$('reader-end')] : [],
      onMode: mode => changePreference('mode', mode),
      onTheme: theme => changePreference('theme', theme),
      onDirection: direction => changePreference('direction', direction),
      onTapToTurn: enabled => changePreference('tapToTurn', enabled),
      onThumbnailSize: size => changePreference('thumbnailSize', size),
      getCurrentPage: () => pageAtViewport(),
      getThumbnail: async (index, size) => saved.has(index) ? makeReaderThumbnail(await readerBlob(key, index), size) : null,
      onPick: page => {
        current = page;
        if (preferences.mode === 'scroll') {
          alignToPage();
          controls.update({ current });
        } else draw();
      },
      onTurn: page => { current = page; draw(); },
    });
    updateReaderPreferences = applyPreferences;
    list.dir = preferences.mode === 'double' ? preferences.direction : 'ltr';
    document.documentElement.classList.add('reading-chapter');
    draw(initialPage > 1);
    disposePages = () => {
      disposePages = () => {};
      updateReaderPreferences = undefined;
      controls.destroy();
      clear();
      delete $('reader').dataset.mode;
      document.documentElement.classList.remove('reading-chapter', 'paged-reader');
      pageAtViewport = () => 1;
    };
  }

  function chapterNeighbors(chapter, chapters) {
    const related = chapters.filter(c => c.workKnown && chapter.workKnown &&
      c.key[0] === chapter.key[0] && c.key[1] === chapter.key[1]).sort(chaptersInOrder);
    const i = related.findIndex(c => c.key[2] === chapter.key[2]);
    const links = [];
    if (i > 0) links.push(chapterLink(related[i - 1], '上一話 · ' + related[i - 1].chapterTitle));
    if (i >= 0 && related[i + 1]) links.push(chapterLink(related[i + 1], '下一話 · ' + related[i + 1].chapterTitle));
    return links;
  }

  async function render(reset = false) {
    const token = ++version;
    const hash = location.hash.slice(routePrefix.length);
    const reading = hash.startsWith('read/');
    const storage = hash === 'storage';
    const starred = hash === 'favorites';
    if (reset) {
      notify();
      disposePages();
      activeKey = undefined;
      window.scrollTo(0, 0);
    }
    $('shelf').hidden = reading || storage;
    $('reader').hidden = !reading;
    $('storage').hidden = !storage;
    themePicker.parentElement.hidden = reading;
    if (reading && reset) {
      $('chapter-head').replaceChildren(el('h1', '載入這一話中'));
      $('reader-end').replaceChildren();
    }
    try {
      if (reading) {
        const key = hash.slice(5).split('/').map(decodeURIComponent);
        if (key.length !== 3) throw new Error('這個閱讀網址不完整，請返回書庫重新選話。');
        const result = await readChapter(key);
        if (version !== token) return;
        if (!result) throw new Error('書庫裡找不到這一話，請返回書庫選擇其他話。');
        const { chapter, indices } = result;
        const data = await shelf();
        if (version !== token) return;
        const current = reset ? 1 : pageAtViewport();
        disposePages();
        activeKey = key;
        const source = (chapter.workKnown ? chapter.workTitle + ' · ' : '') + key[0];
        const heading = $('chapter-head');
        heading.replaceChildren(el('h1', chapter.chapterTitle));
        if (chapter.chapterSubtitle) heading.append(japaneseSubtitle(chapter, 'p', 'chapter-subtitle'));
        heading.append(el('p', source, 'source'), el('p', countText(chapter)));
        document.title = chapter.chapterTitle + ' · KomaGlide';
        $('reader-end').replaceChildren(...chapterNeighbors(chapter, data.chapters));
        addPages(key, chapter, indices, current);
        return;
      }
      const data = await shelf();
      if (version !== token) return;
      const { used, limit } = data.state;
      document.title = (storage ? '容量設定' : '書庫') + ' · KomaGlide';
      if (storage) {
        $('storage-summary').textContent = '已使用 ' + size(used) + '，目前上限 ' + size(limit) + '。';
        if (reset) $('limit').value = String(limit / MiB);
        if (reset) void checkStorageProtection();
      } else {
        $('usage').textContent = size(used) + ' / ' + size(limit);
        for (const [id, active] of [['all-tab', !starred], ['star-tab', starred]]) {
          if (active) $(id).setAttribute('aria-current', 'page');
          else $(id).removeAttribute('aria-current');
        }
        showBooks(data, starred);
      }
    } catch (error) {
      if (version === token) {
        if (reading) {
          disposePages();
          activeKey = undefined;
          $('chapter-head').replaceChildren(el('h1', '無法開啟這一話'));
          $('reader-end').replaceChildren();
        }
        notify(messageFor(error));
      }
    }
  }

  $('request-retention').onclick = requestStorageProtection;
  $('limit-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      await setLimit(Number($('limit').value) * MiB);
      announce({ kind: 'limit' });
      notify('已更新書庫容量上限。');
    } catch (error) {
      notify(messageFor(error));
    } finally {
      if (button) button.disabled = false;
    }
  };

  changes.addEventListener('change', ({ detail }) => {
    if (detail.kind === 'error') {
      notify(detail.message);
      return;
    }
    if (location.hash.startsWith(routePrefix + 'read/')) {
      // Avoid losing the reading position when background transfers arrive.
      if (activeKey && detail.kind === 'saved' && activeKey[0] === detail.site &&
          activeKey[1] === detail.workId && activeKey[2] === detail.chapterId) {
        notify('這一話有新儲存的頁面。');
        const refresh = el('button', '更新頁面');
        refresh.onclick = () => { notify(); render(); };
        $('notice').append(' ', refresh);
      }
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => render(), 120);
  });

  window.addEventListener('hashchange', () => render(true));
  render(true);
}


  // Remember the page that can host each site's shelf. Comic bytes stay in that site's IndexedDB.
  let rememberedSite = false;
  async function rememberSite() {
    if (rememberedSite) return;
    rememberedSite = true;
    const url = new URL(location.href);
    url.hash = '';
    url.username = url.password = '';
    try {
      await write(PREFIX + 'shelf-entry.' + url.origin, url.href);
      await write(PREFIX + 'last-shelf-site', url.origin);
    } catch {
      rememberedSite = false;
    }
  }

  async function openShelf() {
    const siteEntry = origin => read(PREFIX + 'shelf-entry.' + origin);
    const current = webUrl(await siteEntry(location.origin));
    let entry = current?.origin === location.origin ? current : null;
    if (!entry) {
      const last = webUrl(await read(PREFIX + 'last-shelf-site'));
      const saved = last && webUrl(await siteEntry(last.origin));
      entry = saved && saved.origin === last.origin ? saved : new URL(location.href);
    }
    entry.hash = SHELF_HASH + 'shelf';
    GM_openInTab(entry.href, {active: true, setParent: false});
  }

  function displayShelf() {
    // This explicitly opened tab uses the comic site's storage origin. Its UI is bundled.
    // The chapter document has finished parsing. Drop its event handlers and
    // install the bundled DOM before mounting controls or observing page slots.
    const shell = new DOMParser().parseFromString("<!doctype html>\n<html lang=\"zh-Hant\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <meta name=\"theme-color\" content=\"#f7f6f2\">\n  <meta name=\"referrer\" content=\"no-referrer\">\n  <link rel=\"icon\" href=\"data:,\">\n  <title>本站書庫 · KomaGlide</title>\n<style>:root {\n  color-scheme: light;\n  font-family: \"DM Sans\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif;\n  line-height: 1.6;\n  color: var(--ink);\n  background: var(--paper);\n  --ink: #222520;\n  --muted: #586158;\n  --line: #d4d7cd;\n  --accent: #305c46;\n  --paper: #f7f6f2;\n  --panel: #e9ede2;\n  --slot: #edeee7;\n  --field: #fff;\n  --field-border: #9ca79b;\n  --hover: #e3e9df;\n  --active: #d3ded0;\n  --favorite-ink: #23492d;\n  --favorite-fill: #e3ecd7;\n  --favorite-border: #72866a;\n  --on-accent: #fff;\n  --accent-hover: #244432;\n}\n:root[data-reader-theme=\"dark\"] {\n  color-scheme: dark;\n  --ink: #e8ebe5;\n  --muted: #b2baaf;\n  --line: #434c43;\n  --accent: #b3dbbc;\n  --paper: #161a17;\n  --panel: #202721;\n  --slot: #202520;\n  --field: #29302a;\n  --field-border: #798779;\n  --hover: #344238;\n  --active: #415146;\n  --favorite-ink: #c3dfbe;\n  --favorite-fill: #2d3d30;\n  --favorite-border: #798e78;\n  --on-accent: #192d20;\n  --accent-hover: #c5e5cd;\n}\n:root[data-reader-theme=\"dark\"] :focus-visible {\n  outline-color: #a4c790;\n}\n:root[data-reader-theme=\"dark\"] ::selection {\n  background: #416049;\n  color: #f2f5f0;\n}\n* { box-sizing: border-box; }\nbody { margin: 0; }\n[hidden] { display: none !important; }\nbutton, input { font: inherit; }\na { color: inherit; text-underline-offset: .24em; }\na:hover { color: var(--accent); }\nbutton { cursor: pointer; }\nbutton:disabled { opacity: .55; cursor: wait; }\n:focus-visible { outline: 3px solid #6a8552; outline-offset: 3px; }\n::selection { background: #d6e5c4; }\n.masthead { border-bottom: 1px solid var(--line); }\n.topline, main { width: min(100% - 3rem, 64rem); margin-inline: auto; }\n.topline { min-height: 3.35rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; }\n.masthead-tools { display: flex; min-width: 0; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: .25rem .75rem; padding-block: .5rem; }\n.brand { font-family: \"DM Sans\", sans-serif; font-size: 1.2rem; font-weight: 750; letter-spacing: -.035em; text-decoration: none; }\n#offline-state, .source, .count, #usage, .hint, figcaption, .back { color: var(--muted); font-size: .88rem; }\n#offline-state { font-size: .75rem; overflow-wrap: anywhere; }\nmain { padding-block: 3rem 5rem; }\nh1, h2, p, figure { margin: 0; }\nh1, h2 { overflow-wrap: anywhere; line-height: 1.35; }\nh1 { font-size: 2.5rem; letter-spacing: -.025em; }\nh2 { font-size: 1.26rem; }\n.title-row, .work-head, .shelf-tools { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }\n.title-row { margin-bottom: 1.1rem; }\n.title-row h1 { min-width: 0; font-size: clamp(1.8125rem, 3vw, 2.25rem); letter-spacing: .015em; }\n.nav-action, button { border: 1px solid var(--field-border); border-radius: .35rem; background: transparent; padding: .38rem .75rem; color: var(--ink); text-decoration: none; white-space: nowrap; }\n.nav-action { color: var(--muted); font-size: .8125rem; padding: .32rem .56rem; border-color: var(--line); }\n.nav-action:hover, button:enabled:hover { background: var(--hover); }\n.nav-action:active, button:enabled:active { background: var(--active); }\n.shelf-tools { border-bottom: 1px solid var(--line); flex-wrap: wrap; gap: .25rem 1rem; }\n.shelf-tools nav { display: flex; gap: 1.3rem; }\n.shelf-tools a { display: flex; align-items: center; min-height: 2.25rem; padding-bottom: .375rem; font-size: .875rem; color: var(--muted); text-decoration: none; }\n.shelf-tools a[aria-current] { color: var(--accent); box-shadow: inset 0 -2px var(--accent); font-weight: 700; }\n#usage, .count, figcaption { font-variant-numeric: tabular-nums; }\n#usage, .work .source, .chapter-row .count { font-size: .75rem; }\n.work { padding-top: clamp(1.5rem, 3vw, 2rem); }\n.work-head { margin-bottom: .875rem; }\n.work-head > div { min-width: 0; }\n.work-head h2 {\n  font: 700 clamp(1.9375rem, 3vw, 2.375rem)/1.35 \"Songti TC\", \"Noto Serif TC\", \"PMingLiU\", serif;\n  letter-spacing: .025em;\n}\n.source { overflow-wrap: anywhere; }\n.chapter-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto 44px;\n  align-items: center;\n  column-gap: 1rem;\n  border-top: 1px solid var(--line);\n  padding-block: .75rem;\n}\n.chapter-row:last-child { border-bottom: 1px solid var(--line); }\n.chapter-link { font-weight: 570; overflow-wrap: anywhere; }\n.chapter-row .chapter-link { display: block; min-width: 0; font-size: 1.125rem; line-height: 1.48; font-weight: 650; letter-spacing: .015em; text-decoration: none; }\n.chapter-row .chapter-link:is(:hover, :focus-visible) { color: var(--accent); text-decoration: underline; }\n.chapter-heading { display: flex; align-items: baseline; gap: .625rem; }\n.chapter-heading > span { min-width: 0; }\n.chapter-ordinal { flex: none; max-width: 42%; font-size: .8125rem; font-weight: 500; letter-spacing: normal; color: var(--muted); }\n.chapter-separator { font-size: 0; }\n.chapter-subtitle { display: block; color: var(--muted); font-size: .88rem; font-weight: normal; overflow-wrap: anywhere; }\n.favorite { color: var(--muted); font-size: .75rem; padding: .32rem .56rem; border-color: var(--line); }\n.favorite[aria-pressed=\"true\"] { color: var(--favorite-ink); border-color: var(--favorite-border); background: var(--favorite-fill); }\n.chapter-row .favorite { display: grid; place-items: center; justify-self: end; width: 44px; height: 44px; padding: 0; border: 0; background: transparent; }\n.chapter-row .favorite[aria-pressed=\"true\"] { color: var(--accent); }\n.chapter-row .favorite:hover { background: var(--hover); }\n.chapter-row .favorite:active { background: var(--active); }\n.favorite[aria-disabled=\"true\"] { opacity: .55; cursor: wait; }\n.chapter-row .favorite svg { width: 19px; height: 19px; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; fill: none; }\n.chapter-row .favorite[aria-pressed=\"true\"] svg { fill: currentColor; }\n.empty { padding: 4.5rem 0; }\n.empty p, .hint { margin-top: .7rem; color: var(--muted); max-width: 39rem; }\n#notice { margin-bottom: 1.25rem; padding: .7rem 1rem; background: var(--notice-surface, #f2e9cf); color: var(--notice-ink, #574722); border-radius: .3rem; overflow-wrap: anywhere; }\n#notice[data-tone=\"success\"] { background: var(--favorite-fill); color: var(--favorite-ink); font-weight: 650; }\n.notice-detail { display: block; margin-top: .25rem; font-weight: 400; }\n.notice-detail:empty { display: none; }\n.notice-detail a { display: inline-block; }\n.storage-retention { margin-top: 1.75rem; overflow-wrap: anywhere; }\n#request-retention { margin-top: .75rem; min-height: 44px; }\n.back { display: inline-block; margin-bottom: 1.25rem; }\n#storage h1 { margin-bottom: 1rem; }\nform { margin: 1.75rem 0 0; }\nlabel { display: block; font-weight: 650; }\n.field { display: flex; gap: .65rem; margin-top: .5rem; }\ninput { min-width: 0; width: 9rem; padding: .4rem .6rem; border: 1px solid var(--field-border); border-radius: .35rem; background: var(--field); color: var(--ink); }\n.primary { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }\n.primary:enabled:is(:hover, :active) { background: var(--accent-hover); }\n#reader { max-width: 48rem; margin-inline: auto; }\n#chapter-head p { margin-top: .35rem; }\n.reading-chapter #chapter-head h1 { font-size: 1.12rem; }\n.reading-chapter #chapter-head p { color: var(--muted); font-size: .85rem; }\n.reading-chapter #reader-return { margin: 0; }\n#reader-end { display: grid; gap: .6rem; }\n#reader-end:empty { display: none; }\n#reader-tools { height: 0; }\n.reading-chapter .masthead { display: none; }\n.reading-chapter main { width: 100%; padding: 0; }\n.reading-chapter #notice {\n  position: fixed;\n  z-index: 1;\n  inset: auto 0 .75rem;\n  margin: auto;\n  width: max-content;\n  max-width: calc(100% - 2rem);\n  max-height: 35dvh;\n  overflow: auto;\n}\n#pages figcaption {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n  clip-path: inset(50%);\n  white-space: nowrap;\n}\n#reader[data-mode=\"scroll\"] #pages > * + * { margin-top: .25rem; }\n.page-slot { background: var(--slot); aspect-ratio: 2 / 3; width: 100%; }\n.page-slot img { display: block; width: 100%; height: auto; }\n.gap { padding: 1rem; text-align: center; background: var(--slot); color: var(--muted); }\n.theme-picker, .kg-reader-controls label {\n  display: flex;\n  align-items: center;\n  gap: .5rem;\n  font-size: .85rem;\n  font-weight: 500;\n  color: var(--muted);\n}\n.kg-reader-controls select, .theme-picker select {\n  border: 1px solid var(--field-border);\n  border-radius: .35rem;\n  color: var(--ink);\n  background: var(--field);\n  font: inherit;\n  font-size: .88rem;\n  padding: .3rem .55rem;\n  min-height: 2.1rem;\n}\n.kg-reader-controls select:hover, .theme-picker select:hover { background: var(--hover); }\n.theme-picker { flex: none; gap: .3125rem; font-size: .75rem; }\n.theme-picker select { min-height: 1.875rem; padding: .125rem .25rem; font-size: .75rem; border-color: var(--line); background: transparent; }\n.kg-reader-controls button:disabled { cursor: default; }\n.paged-reader #reader { max-width: none; }\n.paged-reader #pages {\n  display: flex;\n  justify-content: center;\n  width: 100%;\n  height: 100dvh;\n  gap: 2px;\n}\n.paged-reader #pages > * {\n  flex: 1 1 0;\n  min-width: 0;\n  direction: ltr;\n}\n.paged-reader .page-slot {\n  height: 100%;\n  background: transparent;\n}\n.paged-reader .page-slot img {\n  height: 100%;\n  object-fit: contain;\n}\n#pages[dir=\"rtl\"] { --first-spine: left; --second-spine: right; }\n#pages[dir=\"ltr\"] { --first-spine: right; --second-spine: left; }\n#reader[data-mode=\"double\"] figure:first-child:not(:only-child) img { object-position: var(--first-spine) center; }\n#reader[data-mode=\"double\"] figure:nth-child(2) img { object-position: var(--second-spine) center; }\n.paged-reader #pages > .gap { display: grid; place-items: center; }\n:root[data-reader-theme=\"dark\"] #notice { --notice-surface: #423b28; --notice-ink: #f0e2bc; }\n@media (max-width: 38rem) {\n  .topline, main { width: calc(100% - 2.5rem); }\n  main { padding-top: 1.6875rem; }\n  h1 { font-size: 1.95rem; }\n  .chapter-row { grid-template-columns: minmax(0, 1fr) 44px; column-gap: .375rem; padding-block: .8125rem .75rem; }\n  .chapter-row .count { grid-column: 1; margin-top: .125rem; }\n  .chapter-row .favorite { grid-column: 2; grid-row: 1 / 3; }\n}\n@media (max-width: 22rem) {\n  .work-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .375rem .5rem; }\n  .work-head > div { display: contents; }\n  .work-head h2, .work-head > :only-child .source { grid-column: 1 / -1; }\n  .work-head .favorite { grid-column: 2; }\n}\n\n.kg-reader-controls input[type=\"checkbox\"] {\n  width: 1rem;\n  height: 1rem;\n  margin: 0;\n  padding: 0;\n  accent-color: var(--accent);\n}\n.kg-page-turns[data-direction=\"rtl\"] { flex-direction: row-reverse; }\n\ndialog.kg-thumb-picker {\n  position: fixed;\n  inset: 0;\n  margin: auto;\n  box-sizing: border-box;\n  width: 94vw;\n  height: 92dvh;\n  max-width: 100%;\n  max-height: 100dvh;\n  padding: 0;\n  overflow: hidden;\n  border: 1px solid var(--line);\n  border-radius: .6rem;\n  background: var(--paper);\n  color: var(--ink);\n  font: inherit;\n  text-align: start;\n}\ndialog.kg-thumb-picker[open] { display: flex; flex-direction: column; }\n.kg-thumb-picker::backdrop { background: rgb(9 14 10 / 68%); }\n.kg-thumb-head, .kg-thumb-footer {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: .75rem;\n  padding: .75rem 1rem;\n}\n.kg-thumb-head { flex-wrap: wrap; border-bottom: 1px solid var(--line); }\n.kg-thumb-head strong { font-size: 1.1rem; margin: 0; }\n.kg-thumb-range {\n  color: var(--muted, var(--ink));\n  font-size: .85rem;\n  font-variant-numeric: tabular-nums;\n}\n.kg-thumb-head .kg-thumb-size {\n  display: inline-flex;\n  align-items: center;\n  gap: .4rem;\n  margin-inline-start: auto;\n  color: var(--muted, var(--ink));\n  font-size: .85rem;\n  white-space: nowrap;\n}\n.kg-thumb-size select { min-height: 2.1rem; }\n.kg-thumb-footer { justify-content: space-between; border-top: 1px solid var(--line); }\n.kg-thumb-grid {\n  --tile-min: 6rem;\n  display: grid;\n  flex: 1 1 0;\n  min-height: 0;\n  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--tile-min)), 1fr));\n  grid-auto-rows: max-content;\n  align-content: start;\n  gap: .75rem;\n  padding: 1rem;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n  scroll-padding: 1rem;\n}\n.kg-thumb-grid[data-size=\"small\"] { --tile-min: 4rem; }\n.kg-thumb-grid[data-size=\"large\"] { --tile-min: clamp(15rem, 24vw, 26rem); }\n.kg-thumb-grid .kg-thumb-page {\n  display: flex;\n  flex-direction: column;\n  align-items: stretch;\n  gap: .22rem;\n  min-width: 0;\n  padding: .25rem;\n  border: 1px solid transparent;\n  border-radius: .35rem;\n  background: transparent;\n  color: var(--ink);\n  font: inherit;\n  font-size: .85rem;\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n  white-space: normal;\n  cursor: pointer;\n}\n.kg-thumb-grid .kg-thumb-page:hover { background: var(--hover); }\n.kg-thumb-grid .kg-thumb-page[aria-current=\"page\"] {\n  border-color: var(--accent);\n  color: var(--accent);\n  font-weight: 700;\n}\n.kg-thumb-frame {\n  display: grid;\n  place-items: center;\n  width: 100%;\n  flex: none;\n  aspect-ratio: 3 / 4;\n  overflow: hidden;\n  background: var(--slot, var(--well));\n  color: var(--muted, var(--ink));\n  font-size: .8rem;\n}\n.kg-thumb-frame img {\n  display: block;\n  width: 100%;\n  height: 100%;\n  min-height: 0;\n  object-fit: contain;\n}\n@media (max-width: 38rem) {\n  dialog.kg-thumb-picker { width: calc(100vw - .5rem); height: calc(100dvh - 1rem); }\n  .kg-thumb-head { gap: .4rem .6rem; padding: .6rem; }\n  .kg-thumb-grid { --tile-min: 4.8rem; gap: .5rem; padding: .65rem; }\n  .kg-thumb-grid[data-size=\"small\"] { --tile-min: 3.3rem; }\n  .kg-thumb-grid[data-size=\"large\"] { --tile-min: 12rem; }\n}\n.kg-reader-controls {\n  --edge-width: 2.5rem;\n  --edge-surface: var(--paper);\n  display: contents;\n}\n.kg-edge, .kg-edge-panel {\n  display: flex;\n  align-items: center;\n}\n.kg-edge {\n  position: fixed;\n  top: 50%;\n  transform: translateY(-50%);\n  z-index: 8;\n  pointer-events: none;\n}\n.kg-edge-left { left: env(safe-area-inset-left, 0px); }\n.kg-edge-right { right: env(safe-area-inset-right, 0px); flex-direction: row-reverse; }\n.kg-reader-controls .kg-edge-toggle {\n  position: relative;\n  padding: .7rem .35rem;\n  width: var(--edge-width);\n  min-height: 3.8rem;\n  display: grid;\n  place-items: center;\n  border: 1px solid var(--line);\n  background: color-mix(in srgb, var(--edge-surface) 91%, transparent);\n  color: var(--ink);\n  font: inherit;\n  font-size: .8rem;\n  font-weight: 600;\n  letter-spacing: .1em;\n  line-height: 1;\n  writing-mode: vertical-rl;\n  text-orientation: upright;\n  pointer-events: auto;\n  cursor: pointer;\n}\n.kg-edge-left .kg-edge-toggle { border-left: 0; border-radius: 0 .45rem .45rem 0; }\n.kg-edge-right .kg-edge-toggle { border-right: 0; border-radius: .45rem 0 0 .45rem; }\n.kg-reader-controls .kg-edge-toggle:is(:hover, [aria-expanded=\"true\"]) {\n  background: var(--hover);\n  color: var(--accent);\n}\n.kg-edge .kg-edge-panel {\n  position: absolute;\n  width: 15rem;\n  max-width: calc(100vw - 2 * var(--edge-width) - 1.25rem);\n  max-height: calc(100dvh - 2rem);\n  flex-direction: column;\n  align-items: stretch;\n  gap: .65rem;\n  margin: 0;\n  padding: 1rem;\n  overflow: auto;\n  overscroll-behavior: contain;\n  border: 1px solid var(--line);\n  border-radius: .6rem;\n  background: var(--edge-surface);\n  color: var(--ink);\n  box-shadow: 0 .3rem 1.2rem rgb(0 0 0 / 18%);\n  font-size: .9rem;\n  line-height: 1.45;\n  pointer-events: auto;\n}\n.kg-edge-panel[hidden] { display: none; }\n.kg-edge-left .kg-edge-panel { left: calc(100% + .35rem); }\n.kg-edge-right .kg-edge-panel { right: calc(100% + .35rem); }\n.kg-edge-panel h2 {\n  margin: 0 0 .2rem;\n  color: var(--ink);\n  font: inherit;\n  font-size: 1.05rem;\n  font-weight: 700;\n}\n.kg-edge-panel > label {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: .6rem;\n  font-size: .875rem;\n}\n.kg-edge-panel > label:has(input) { justify-content: start; }\n.kg-edge-extras {\n  display: grid;\n  gap: .6rem;\n  min-width: 0;\n  padding-top: .75rem;\n  border-top: 1px solid var(--line);\n}\n.kg-edge-extras:not(:has(> :not([hidden]))) { display: none; }\n.kg-page-turns {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: .25rem;\n}\n.kg-page-count { font-variant-numeric: tabular-nums; text-align: center; }\n.kg-edge-panel .kg-page-turns button { padding-inline: .45rem; }\n.kg-edge-panel button, .kg-edge-panel select { min-height: 2.15rem; }\n</style></head>\n<body>\n  <header class=\"masthead\">\n    <div class=\"topline\">\n      <a class=\"brand\" href=\"#shelf\" aria-label=\"KomaGlide 本站書庫首頁\">KomaGlide</a>\n      <div class=\"masthead-tools\">\n        <span id=\"offline-state\" role=\"status\"></span>\n        <label class=\"theme-picker\" for=\"library-theme\">外觀\n          <select id=\"library-theme\">\n            <option value=\"system\">跟隨系統</option>\n            <option value=\"light\">淺色</option>\n            <option value=\"dark\">深色</option>\n          </select>\n        </label>\n      </div>\n    </div>\n  </header>\n  <main>\n    <p id=\"notice\" role=\"status\" hidden></p>\n    <section id=\"shelf\">\n      <div class=\"title-row\">\n        <h1>本站書庫</h1>\n        <a class=\"nav-action\" href=\"#storage\">容量設定</a>\n      </div>\n      <div class=\"shelf-tools\">\n        <nav aria-label=\"書庫篩選\">\n          <a href=\"#shelf\" id=\"all-tab\">全部作品</a>\n          <a href=\"#favorites\" id=\"star-tab\">收藏</a>\n        </nav>\n        <span id=\"usage\"></span>\n      </div>\n      <div id=\"books\"></div>\n    </section>\n    <section id=\"storage\" hidden>\n      <a class=\"back\" href=\"#shelf\">返回書庫</a>\n      <h1>容量設定</h1>\n      <p id=\"storage-summary\"></p>\n      <form id=\"limit-form\">\n        <label for=\"limit\">書庫容量上限（MiB）</label>\n        <div class=\"field\"><input type=\"number\" id=\"limit\" required min=\"1\" step=\"1\"><button class=\"primary\" type=\"submit\">儲存上限</button></div>\n      </form>\n      <p class=\"hint\">收藏和一般快取共用容量。調低上限時，書庫會從最久沒讀、尚未收藏的一話開始，整話移除。</p>\n      <section class=\"storage-retention\" aria-labelledby=\"retention-title\">\n        <h2 id=\"retention-title\">瀏覽器儲存保護</h2>\n        <p class=\"hint\" id=\"retention\" role=\"status\"></p>\n        <p class=\"hint\">空間不足時，瀏覽器可能清除未受保護的網站資料。</p>\n        <button id=\"request-retention\" type=\"button\">申請持久儲存</button>\n        <p class=\"hint\" id=\"retention-result\" role=\"status\"></p>\n      </section>\n    </section>\n    <section id=\"reader\" hidden>\n      <a id=\"reader-return\" class=\"back\" href=\"#shelf\">返回書庫</a>\n      <div id=\"chapter-head\"></div>\n      <div id=\"reader-tools\"></div>\n      <div id=\"pages\"></div>\n      <nav id=\"reader-end\" aria-label=\"話數導覽\"></nav>\n    </section>\n    <noscript>請啟用 JavaScript 以開啟本機書庫。</noscript>\n  </main>\n</body>\n</html>\n", 'text/html');
    document.open();
    document.close();
    const root = document.importNode(shell.documentElement, true);
    if (document.documentElement) document.documentElement.replaceWith(root);
    else document.appendChild(root);
    document.getElementById('offline-state').textContent = location.host;
    mountShelf(SHELF_HASH, getShelfEvents());
  }

  const notContent = 'nav,aside,footer,header,[role="navigation"],[role="banner"],[aria-hidden="true"],[hidden],.advertisement,.ads,.promo,.navigation';
  function isComicImage(img) {
    if (img.closest(notContent)) return false;
    const marker = [img.className, img.id, img.alt, img.getAttribute('role')].join(' ');
    if (/(?:^|[\s_-])(logo|banner|advertisement|advert|ads?|promo|avatar|thumbnail|icon|presentation)(?:$|[\s_-])/i.test(marker)) return false;
    const w = Number(img.getAttribute('width')), h = Number(img.getAttribute('height'));
    return !(w > 0 && h > 0 && w <= 64 && h <= 64);
  }

  const siteAdapters = [];
  siteAdapters.push(function detect8comic(root, address) {
  const route = /^\/online\/new-(\d+)\.html$/.exec(address.pathname);
  if (address.origin !== 'https://articles.onemoreplace.tw' || !route) return null;

  const workId = route[1];
  const workLink = [...root.querySelectorAll('.view-titles a[href]')].find(link => {
    const url = webUrl(link.getAttribute('href'), address);
    return url?.origin === 'https://www.8comic.com' && url.pathname === '/html/' + workId + '.html';
  });
  if (!workLink) return null;
  const labels = [...workLink.querySelectorAll('small')].map(el => el.textContent.trim());
  const chapterLabel = labels.map(label => /^第\s*(\d+(?:\.\d+)?)\s*([集話])$/.exec(label)).find(Boolean);
  if (!chapterLabel) return null;
  const workTitle = [...workLink.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  const chapterNumber = chapterLabel[1];
  // Split chapters can share a displayed number (ch=2a and ch=2b both say 第2集).
  const chapterToken = address.searchParams.get('ch') || chapterNumber;
  const chapterUrl = new URL(address.pathname, address.origin);
  chapterUrl.searchParams.set('ch', chapterToken);
  const chapterTitle = '第' + chapterNumber + chapterLabel[2] +
    (chapterNumber === chapterToken ? '' : '（' + chapterToken + '）');
  const declared = labels.map(label => /^\(\s*(\d+)\s*P\s*\)$/i.exec(label)).find(Boolean);
  const total = declared ? Number(declared[1]) : undefined;

  const pages = new Map();
  for (const slot of root.querySelectorAll('.pinch-zoom .comics-pic')) {
    const img = slot.querySelector(':scope > img');
    const label = slot.querySelector(':scope > b')?.textContent.trim();
    if (!img || !isComicImage(img) || !/^\d+$/.test(label || '')) continue;
    const index = Number(label);
    if (index < 1 || (total && index > total) || pages.has(index)) continue;
    // Unloaded slots reserve their page number. The capture loop waits for
    // the site's native loader to set src and finish decoding the image.
    const selected = img.currentSrc || img.getAttribute('src');
    const source = selected && comic8ImageUrl(selected, chapterUrl);
    if (selected && !source) continue;
    pages.set(index, { img, index, imageUrl: source?.href });
  }
  if (!pages.size) return null;
  // Scrolling the original numbered slot activates the site's own lazy loader.
  // Parsed continuation documents do not have a live viewport.
  function revealPage(index) {
    const slot = pages.get(index)?.img.parentElement;
    if (!slot?.isConnected) return false;
    slot.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return true;
  }
  return {
    workId, workTitle, chapterId: workId + ':' + chapterToken, chapterTitle, chapterUrl: chapterUrl.href,
    total, entries: [...pages.values()].sort((a, b) => a.index - b.index),
    revealPage: root === document ? revealPage : undefined,
    nextPage: null, nextChapter: null,
  };
});

// The gallery publishes signed /s/ links in thumbnail batches. Only its reader
// pages publish full images. Keep those links across scans of the live document.
const ehOrigins = new Set(['https://e-hentai.org', 'https://exhentai.org']);
const ehDirectories = new WeakMap();
const ehGalleryRoute = /^\/g\/(\d+)\/([a-f0-9]+)\/?$/;
const ehReaderRoute = /^\/s\/[a-f0-9]+\/(\d+)-(\d+)$/;

function ehImageUrl(value, base) {
  const url = webUrl(value, base);
  return url?.protocol === 'https:' && url.hostname.endsWith('.hath.network') &&
    url.pathname.startsWith('/h/') ? url : null;
}

function ehReadGallery(root, address, galleryId, directory) {
  const title = root.querySelector('#gn')?.textContent.trim();
  const range = /Showing\s+([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)\s+images?/i.exec(
    root.querySelector('.gpc')?.textContent || '');
  if (!title || !range || ehGalleryRoute.exec(address.pathname)?.[1] !== galleryId) return null;
  const [first, last, total] = range.slice(1).map(n => Number(n.replaceAll(',', '')));
  const batch = Number(address.searchParams.get('p') || 0);
  if (!Number.isSafeInteger(total) || first < 1 || last < first || last > total ||
      !Number.isSafeInteger(batch) || batch < 0) return null;
  const perBatch = batch === 0 ? last : (first - 1) / batch;
  if (!Number.isSafeInteger(perBatch) || perBatch < 1 || first !== batch * perBatch + 1) return null;

  for (const link of root.querySelectorAll('#gdt a[href]')) {
    const url = webUrl(link.getAttribute('href'), address);
    const route = url?.origin === address.origin && ehReaderRoute.exec(url.pathname);
    if (route && route[1] === galleryId && +route[2] >= first && +route[2] <= last) {
      directory.links.set(+route[2], url.href);
    }
  }
  directory.perBatch = perBatch;
  const subtitle = root.querySelector('#gj')?.textContent.trim();
  directory.subtitle = subtitle && subtitle !== title ? subtitle : '';
  return {title, total, index:first};
}

function ehReadImage(root, address, galleryId) {
  const route = ehReaderRoute.exec(address.pathname);
  const index = Number(route?.[2]);
  const counter = /^(\d+)\s*\/\s*(\d+)$/.exec(root.querySelector('#i2 .sn div')?.textContent.trim() || '');
  const total = Number(counter?.[2]);
  if (route?.[1] !== galleryId || !counter || +counter[1] !== index || index < 1 || index > total) return null;
  const img = root.querySelector('#i3 img#img');
  const url = ehImageUrl(img?.getAttribute('src'), address);
  const title = root.querySelector('#i1 h1')?.textContent.trim();
  return title ? {title, total, index, entry:url ? {index, img, imageUrl:url.href} : null} : null;
}

siteAdapters.push(function detectEHentai(root, address) {
  if (!ehOrigins.has(address.origin)) return null;
  const gallery = ehGalleryRoute.exec(address.pathname);
  const reader = ehReaderRoute.exec(address.pathname);
  if (!gallery && !reader) return null;
  const galleryUrl = gallery ? new URL(address) : webUrl(root.querySelector('.sb a[href*="/g/"]')?.getAttribute('href'), address);
  const id = galleryUrl && ehGalleryRoute.exec(galleryUrl.pathname)?.[1];
  if (!id || galleryUrl.origin !== address.origin || (reader && reader[1] !== id)) return null;
  galleryUrl.search = galleryUrl.hash = '';
  let directory = ehDirectories.get(root);
  if (directory?.gallery !== galleryUrl.href) {
    directory = {gallery:galleryUrl.href, links:new Map(), batches:new WeakMap(), perBatch:0};
    ehDirectories.set(root, directory);
  }
  const data = gallery ? ehReadGallery(root, address, id, directory) : ehReadImage(root, address, id);
  if (!data) return null;
  async function readBatch(batch, signal) {
    const url = new URL(galleryUrl);
    if (batch) url.searchParams.set('p', batch);
    const parsed = await fetchDocument(url.href, signal);
    if (parsed.address.origin !== address.origin || parsed.address.pathname !== galleryUrl.pathname ||
        !ehReadGallery(parsed.root, parsed.address, id, directory)) throw new Error('無法讀取圖庫目錄');
  }
  function loadBatch(batch, signal) {
    let pending = directory.batches.get(signal);
    if (!pending) {
      pending = new Map();
      directory.batches.set(signal, pending);
    }
    if (!pending.has(batch)) pending.set(batch, readBatch(batch, signal).finally(() => pending.delete(batch)));
    return pending.get(batch);
  }
  async function resolvePage(index, signal) {
    if (!directory.links.has(index)) {
      // Direct image URLs have no directory information until the first lookup.
      if (!directory.perBatch) await loadBatch(0, signal);
      if (!directory.links.has(index)) await loadBatch(Math.floor((index - 1) / directory.perBatch), signal);
    }
    const url = directory.links.get(index);
    if (!url) return null;
    const parsed = await fetchDocument(url, signal);
    if (parsed.address.origin !== address.origin) return null;
    const page = ehReadImage(parsed.root, parsed.address, id);
    return page?.index === index ? page.entry : null;
  }
  return {workId:id, workTitle:data.title, chapterId:id, chapterTitle:data.title, chapterUrl:galleryUrl.href,
    chapterSubtitle:directory.subtitle,
    async loadChapterSubtitle(signal) {
      if (directory.subtitle === undefined) await loadBatch(0, signal);
      return directory.subtitle;
    },
    entries:data.entry ? [data.entry] : [], total:data.total, startIndex:data.index, resolvePage, parallelPages:true,
    pageLabelSelector:'#i2 .sn div', nextPage:null, nextChapter:null};
});

// The native pager reuses its main image. Scroll mode also appends captioned images.
const manhuaguiImages = new WeakMap();

function manhuaguiImageUrl(value, base) {
  const url = webUrl(value, base);
  return url && /^https:\/\/[a-z0-9-]+\.hamreus\.com$/i.test(url.origin) &&
    /\.(?:webp|jpe?g|png|gif|avif)$/i.test(url.pathname) ? url : null;
}

siteAdapters.push(function detectManhuagui(root, address) {
  const route = /^\/comic\/(\d+)\/(\d+)\.html$/.exec(address.pathname);
  if (address.origin !== 'https://tw.manhuagui.com' || !route || root !== document) return null;
  const [, workId, chapterId] = route;
  const work = root.querySelector('.title h1 a[href]');
  const workUrl = webUrl(work?.getAttribute('href'), address);
  const workTitle = work?.textContent.trim();
  const chapterTitle = root.querySelector('.title h2')?.textContent.trim();
  if (workUrl?.origin !== address.origin || workUrl.pathname !== '/comic/' + workId + '/' || !workTitle || !chapterTitle) return null;

  const select = root.querySelector('select#pageSelect');
  const counter = root.querySelector('.title #page');
  const box = root.querySelector('#mangaBox');
  const total = select?.options.length;
  if (!box || !counter || !total || ![...select.options].every((option, i) => option.value === String(i + 1))) return null;

  function loadedEntry(img, index) {
    if (!img?.complete || img.naturalWidth <= 2 || img.naturalHeight <= 2) return null;
    const url = manhuaguiImageUrl(img.currentSrc, address);
    if (!url || url.href !== webUrl(img.getAttribute('src'), address)?.href) return null;
    return {index, img, imageUrl: url.href};
  }

  function currentPage() {
    const index = Number(counter.textContent.trim());
    if (!Number.isInteger(index) || index < 1 || index > total || select.value !== String(index)) return null;
    const entry = loadedEntry(box.querySelector('img#mangaFile'), index);
    if (!entry) return null;
    const previous = manhuaguiImages.get(box);
    if (previous?.imageUrl === entry.imageUrl && previous.index !== index) return null;
    manhuaguiImages.set(box, entry);
    return entry;
  }

  function resolvePage(index, signal) {
    if (signal.aborted || !select.isConnected || !select.options[index - 1] || location.pathname !== address.pathname) return null;
    const before = currentPage();
    if (before?.index === index) return before;
    return new Promise(resolve => {
      function finish(result) {
        clearTimeout(timer);
        observer.disconnect();
        box.removeEventListener('load', check, true);
        signal.removeEventListener('abort', cancel);
        resolve(result);
      }
      function check() {
        const entry = currentPage();
        if (entry?.index === index) finish(entry);
      }
      const cancel = () => finish(null);
      const observer = new MutationObserver(check);
      const timer = setTimeout(cancel, 15_000);
      observer.observe(box, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset']});
      observer.observe(counter, {subtree: true, childList: true, characterData: true});
      box.addEventListener('load', check, true);
      signal.addEventListener('abort', cancel, {once: true});
      select.value = String(index);
      select.dispatchEvent(new Event('change', {bubbles: true}));
      check();
    });
  }

  const native = currentPage();
  const entries = new Map();
  if (native) entries.set(native.index, native);
  // The site puts each scroll page number BELOW its image. Filenames may skip
  // numbers after a double-page spread, and the native select can remain at 1.
  const pageLabelSelector = '#mangaMoreBox > p.img_info';
  for (const label of root.querySelectorAll(pageLabelSelector)) {
    const img = label.previousElementSibling;
    if (!img?.matches('img[data-tag="mangaFile"]')) continue;
    const number = /^\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/.exec(label.textContent);
    if (!number || Number(number[2]) !== total) continue;
    const index = Number(number[1]);
    if (index < 1 || index > total || entries.has(index)) continue;
    const entry = loadedEntry(img, index);
    if (entry) entries.set(index, entry);
  }
  return {workId, workTitle, chapterId, chapterTitle, chapterUrl: address.origin + address.pathname,
    total, entries: [...entries.values()], pageLabelSelector, resolvePage, nextPage: null, nextChapter: null};
});

siteAdapters.push(function detectPepper(root, address) {
  const episode = address.pathname.match(/^\/([^/]+)\/webcomic\/(ep\d+_[^/]+?)(?:__(?:hd|sbs))?\.html$/i);
  if (!episode) return null;
  const images = [...root.querySelectorAll('.webcomic-page img, #comicpage img')];
  const entries = [];
  for (const img of images) {
    if (!isComicImage(img) || /^(header|footer|credits)$/i.test(img.alt.trim())) continue;
    const number = (img.getAttribute('src') || img.dataset.src || '').match(/_E\d+P(\d+)(?:[^\d/]*)\.(?:jpe?g|webp|png)(?:[?#]|$)/i)
      || img.alt.match(/\bpage\s+(\d+)\s*$/i);
    const index = Number(number?.[1]);
    if (index > 0 && !entries.some(e => e.index === index)) entries.push({index, img});
  }
  if (!entries.length) return null;
  const chapterId = '/' + episode[1] + '/webcomic/' + episode[2] + '.html';
  const chapterTitle = (root.querySelector('h1')?.textContent || (root.querySelector('title')?.textContent || '')).replace(/\s+[-–|]\s+Pepper\s*&\s*Carrot.*$/i, '').trim();
  return {chapterId, chapterTitle, chapterUrl: address.origin + chapterId,
    workId: 'pepper-and-carrot', workTitle: 'Pepper&Carrot', entries,
    total: Math.max(...entries.map(e => e.index))};
});

siteAdapters.push(function detectGeneric(root, address) {
  const area = root.querySelector('[data-comic-pages], #comic, .comic-pages, #comic-pages, [itemtype$="/ComicStory"] [itemprop="image"]');
  if (!area) return null;
  const images = (area.matches('img') ? [area] : [...area.querySelectorAll('img')]).filter(isComicImage);
  if (!images.length) return null;
  const title = root.querySelector('[data-comic-title], #ctitle, h1')?.textContent.trim() ||
    root.querySelector('meta[property="og:title"]')?.content || (root.querySelector('title')?.textContent || '').trim();
  if (!title) return null;
  const series = root.querySelector('[data-comic-work], [itemtype$="/ComicSeries"] [itemprop="name"]');
  const workTitle = (series?.getAttribute('data-comic-work') || series?.getAttribute('content') || series?.textContent || '').trim();
  const declared = webUrl(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), address) ||
    webUrl(root.querySelector('meta[property="og:url"]')?.content, address);
  const url = declared?.origin === address.origin ? declared : new URL(address);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  return {chapterId: url.pathname + url.search, chapterUrl: url.href, chapterTitle: title,
    workId: workTitle, workTitle, total: images.length, entries: images.map((img, i) => ({img, index: i + 1}))};
});


  function detectChapter(root = document, address = new URL(location.href)) {
    for (const adapter of siteAdapters) {
      const found = adapter(root, address);
      if (!found) continue;
      const base = webUrl(root.querySelector('base[href]')?.getAttribute('href'), address);
      const baseURL = base?.origin === address.origin ? base.href : address.href;
      function nextLink(override, selector) {
        const candidates = override === undefined
          ? [...root.querySelectorAll(selector)].map(a => a.getAttribute('href') || a.dataset.nextPage || a.dataset.nextChapter)
          : [override];
        for (const candidate of candidates) {
          const next = webUrl(candidate, baseURL);
          if (!next || next.origin !== address.origin || next.href.split('#')[0] === address.href.split('#')[0]) continue;
          next.hash = '';
          return next.href;
        }
        return null;
      }
      return {...found, baseURL,
        nextPage: nextLink(found.nextPage, '[data-next-page], a[rel~="next-page"]'),
        nextChapter: nextLink(found.nextChapter, '[data-next-chapter], a[rel~="next"]:not([data-next-page]), link[rel~="next"]:not([data-next-page])')};
    }
    return null;
  }

  function pageFor(chapter, entry, live = false) {
    const {img, index} = entry;
    const selected = img.currentSrc || img.getAttribute('src');
    const src = live ? selected : entry.imageUrl || img.dataset.src || img.dataset.lazySrc ||
      selected || img.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
    const url = webUrl(src, chapter.baseURL);
    // A lazy reader may not have published src yet; the offline copy is keyed
    // by chapter and page number and can still be read without a URL.
    if (live && !url) return null;
    if (live && entry.imageUrl && webUrl(entry.imageUrl, chapter.baseURL)?.href !== url.href) return null;
    return {...chapterInfo(chapter), index, imageUrl:url?.href || ''};
  }
  function chapterInfo({chapterId, chapterTitle, chapterSubtitle, chapterUrl, workId, workTitle, total}) {
    return {site: location.origin, chapterId, chapterTitle, chapterSubtitle, chapterUrl, workId, workTitle,
      workKnown: Boolean(workId), total};
  }
  function checkedMime(value) {
    const mime = (value || '').split(';')[0].trim().toLowerCase();
    if (!MIME.test(mime)) throw new Error('圖檔格式不支援');
    return mime;
  }

  function comic8ImageUrl(value, address, fallbackChapter) {
    if (address.origin !== 'https://articles.onemoreplace.tw') return null;
    const work = address.pathname.match(/^\/online\/new-(\d+)\.html$/);
    if (!work) return null;
    const url = webUrl(value, address);
    if (!url || !/^https:\/\/img\d+\.8comic\.com$/.test(url.origin)) return null;
    const image = url.pathname.match(/^\/\d+\/(\d+)\/(\d+(?:\.\d+|[a-z])?)\/\d+_[\w-]+\.jpg$/i);
    const chapter = new URL(address.href).searchParams.get('ch') ?? fallbackChapter;
    return image?.[1] === work[1] && image[2] === chapter ? url : null;
  }

  function fetchPublicImage(url, readerOrigin) {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('無法讀取漫畫圖檔'));
      const xhr = GM_xmlhttpRequest({url: url.href, method: 'GET', responseType: 'blob',
        anonymous: true, timeout: 30_000, redirect: 'error',
        ...(readerOrigin ? {headers: {Referer: readerOrigin + '/'}} : {}),
        onprogress(event) { if (event.loaded > IMAGE_LIMIT) { xhr.abort(); fail(); } },
        onload(response) {
          try {
            const blob = response.response;
            if (response.status !== 200) return reject(new Error('圖站回應 HTTP ' + response.status));
            if (readerOrigin && /^cache-control:[^\r\n]*\bno-store\b/im.test(response.responseHeaders || '')) {
              return reject(new Error('此圖片限線上閱讀'));
            }
            if (!blob || !blob.size || blob.size > IMAGE_LIMIT) return fail();
            const mime = checkedMime(blob.type);
            resolve(blob.type === mime ? blob : blob.slice(0, blob.size, mime));
          } catch (err) { reject(err); }
        }, ontimeout: fail, onabort: fail, onerror: fail});
    });
  }

  async function fetchImage(page) {
    const url = new URL(page.imageUrl);
    if (ehOrigins.has(location.origin) && ehImageUrl(url, location)) {
      return fetchPublicImage(url, location.origin);
    }
    if (location.origin === 'https://tw.manhuagui.com' &&
        location.pathname === '/comic/' + page.workId + '/' + page.chapterId + '.html' &&
        manhuaguiImageUrl(url, location)) return fetchPublicImage(url, location.origin);
    if (['https://img7.8comic.com', 'https://img9.8comic.com'].includes(url.origin)) {
      const canonical = new URL(page.chapterUrl);
      const fallback = canonical.origin === location.origin && canonical.pathname === location.pathname
        ? canonical.searchParams.get('ch') : null;
      if (comic8ImageUrl(url, location, fallback)) return fetchPublicImage(url);
    }
    let response;
    try {
      response = await fetch(url.href, {cache: 'force-cache', credentials: 'same-origin', signal: AbortSignal.timeout(30_000)});
    } catch (error) {
      if (/^(?:www\.)?xkcd\.com$/i.test(location.hostname) && url.origin === 'https://imgs.xkcd.com' && url.pathname.startsWith('/comics/')) {
        return fetchPublicImage(url);
      }
      throw error;
    }
    if (!response.ok) throw new Error('讀取圖檔失敗（HTTP ' + response.status + '）');
    const mime = checkedMime(response.headers.get('content-type'));
    const stream = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await stream.read();
        if (done) break;
        size += value.length;
        if (size > IMAGE_LIMIT) { await stream.cancel(); throw new Error('單頁超過 32 MiB'); }
        parts.push(value);
      }
    } finally { stream.releaseLock(); }
    if (!size) throw new Error('圖檔為空');
    return new Blob(parts, {type: mime});
  }

  const inFlightWrites = new Map();
  const chapterSubtitles = new Map();
  function capture(page) {
    const key = JSON.stringify([page.site, page.workId, page.chapterId, page.index]);
    if (!inFlightWrites.has(key)) {
      const task = (async () => {
        const blob = await fetchImage(page);
        try {
          const chapterSubtitle = chapterSubtitles.get(page.chapterUrl) ?? page.chapterSubtitle;
          await putPage({...page, chapterSubtitle}, blob);
          notifyPageSaved(page);
          void rememberSite();
          return {blob};
        } catch (storageError) {
          return {blob, storageError};
        }
      })().finally(() => inFlightWrites.delete(key));
      inFlightWrites.set(key, task);
    }
    return inFlightWrites.get(key);
  }

  async function saveLoaded(page) {
    if ((await lookupPage(page, false)).exists) {
      void rememberSite();
      return;
    }
    const {storageError} = await capture(page);
    if (storageError) throw storageError;
  }

  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    const el = element('button', text);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  }

  // This module is also bundled into the userscript's isolated reader dialog.
function watchReaderTheme(paint, signal) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  function apply() {
    paint(choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice);
  }
  systemDark.addEventListener('change', apply, { signal });
  return theme => { choice = theme; apply(); };
}

async function makeReaderThumbnail(blob, size = 'medium') {
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const large = size === 'large';
    const scale = Math.min(1, (large ? 512 : 192) / bitmap.width, (large ? 682 : 256) / bitmap.height);
    if (scale === 1 && blob.size <= 64 * 1024) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', large ? .84 : .78));
  } finally { bitmap.close(); }
}

function readerButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

// Reads already sent to the library may finish after a picker closes or reopens.
let activeThumbnailReads = 0;
const thumbnailPumps = new Set();

// Only the visible rows of one group need decoded thumbnails and Blob URLs.
function openThumbnailPicker(container, { total, current, direction, thumbnailSize, onThumbnailSize, getThumbnail, onPick, onClose }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'kg-thumb-picker';
  dialog.setAttribute('aria-label', '小圖選頁');
  const header = document.createElement('div');
  header.className = 'kg-thumb-head';
  const heading = document.createElement('strong');
  heading.textContent = '小圖選頁';
  const range = document.createElement('span');
  range.className = 'kg-thumb-range';
  const sizeLabel = document.createElement('label');
  sizeLabel.className = 'kg-thumb-size';
  const sizeMenu = document.createElement('select');
  sizeMenu.setAttribute('aria-label', '縮圖大小');
  for (const [value, text] of [['small', '小'], ['medium', '中'], ['large', '大']]) {
    sizeMenu.add(new Option(text, value));
  }
  sizeMenu.value = thumbnailSize;
  sizeLabel.append('縮圖大小', sizeMenu);
  const close = readerButton('關閉', dispose);
  close.setAttribute('aria-label', '關閉小圖');
  header.append(heading, range, sizeLabel, close);
  const grid = document.createElement('div');
  grid.className = 'kg-thumb-grid';
  grid.dir = direction;
  grid.dataset.size = thumbnailSize;
  const footer = document.createElement('div');
  footer.className = 'kg-thumb-footer';
  const batch = 60;
  let start = current - ((current - 1) % batch);
  const back = readerButton('上一組', () => show(start - batch, start - 1));
  const more = readerButton('下一組', () => show(start + batch, start + batch));
  footer.append(back, more);
  footer.hidden = total <= batch;
  dialog.append(header, grid, footer);
  container.append(dialog);

  const waiting = new Set();
  const entries = new Map();
  let closed = false;
  let lastFocusedTile;
  grid.addEventListener('focusin', event => { lastFocusedTile = event.target.closest('button[data-page]'); });
  function resize(size) {
    if (grid.dataset.size === size) return;
    const viewport = grid.getBoundingClientRect();
    const inView = tile => {
      const box = tile.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    };
    // Keep the page being browsed in view even after the grid changes its column count.
    const anchor = lastFocusedTile && grid.contains(lastFocusedTile) && inView(lastFocusedTile)
      ? lastFocusedTile : Array.from(grid.children).find(inView);
    const offset = anchor ? anchor.getBoundingClientRect().top - viewport.top : 0;
    sizeMenu.value = size;
    grid.dataset.size = size;
    if (anchor) {
      const box = anchor.getBoundingClientRect();
      const top = Math.max(0, Math.min(offset, grid.clientHeight - box.height));
      grid.scrollTop += box.top - grid.getBoundingClientRect().top - top;
    }
    if (size === 'large') {
      for (const [tile, entry] of entries) {
        if (entry.visible && entry.url && !entry.large && !entry.loading) waiting.add(tile);
      }
      pump();
    }
  }
  sizeMenu.addEventListener('change', () => onThumbnailSize(sizeMenu.value));
  function release(tile) {
    waiting.delete(tile);
    const entry = entries.get(tile);
    if (!entry) return;
    entry.visible = false;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    if (!entry.loading) entries.delete(tile);
    tile.firstElementChild.replaceChildren();
  }
  async function load(tile, entry, large) {
    const frame = tile.firstElementChild;
    let url;
    try {
      const blob = await getThumbnail(Number(tile.dataset.page), large ? 'large' : 'medium');
      if (!entry.visible) return;
      if (!blob) {
        if (!entry.url) frame.textContent = '無預覽';
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      url = URL.createObjectURL(blob);
      img.src = url;
      await img.decode();
      if (!entry.visible) return;
      frame.replaceChildren(img);
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.url = url;
      entry.large = large;
      url = null;
    } catch {
      if (entry.visible && !entry.url) frame.textContent = '無預覽';
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  function pump() {
    while (!closed && activeThumbnailReads < 2 && waiting.size) {
      const tile = waiting.values().next().value;
      waiting.delete(tile);
      const entry = entries.get(tile);
      const large = grid.dataset.size === 'large';
      if (entry.loading || (entry.url && (entry.large || !large))) continue;
      entry.loading = true;
      activeThumbnailReads++;
      load(tile, entry, large).finally(() => {
        entry.loading = false;
        if (!entry.visible) entries.delete(tile);
        else if (!large && entry.url && grid.dataset.size === 'large') waiting.add(tile);
        activeThumbnailReads--;
        for (const next of thumbnailPumps) next();
      });
    }
  }
  thumbnailPumps.add(pump);
  const observer = new IntersectionObserver(changes => {
    for (const { target, isIntersecting } of changes) {
      if (!grid.contains(target)) continue;
      if (!isIntersecting) release(target);
      else {
        const entry = entries.get(target) || {};
        if (entry.visible) continue;
        entry.visible = true;
        entries.set(target, entry);
        if (!entry.loading) waiting.add(target);
      }
    }
    pump();
  }, { root: grid, rootMargin: '60px 0px' });
  function clearGrid() {
    observer.disconnect();
    observer.takeRecords();
    for (const tile of entries.keys()) release(tile);
    grid.replaceChildren();
  }
  function show(first, focusPage) {
    clearGrid();
    start = first;
    const last = Math.min(total, start + batch - 1);
    range.textContent = total <= batch ? total + ' 頁' : start + '–' + last + ' / ' + total + ' 頁';
    back.disabled = start === 1;
    more.disabled = last === total;
    for (let page = start; page <= last; page++) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'kg-thumb-page';
      tile.dataset.page = page;
      tile.setAttribute('aria-label', '第 ' + page + ' 頁');
      if (page === current) tile.setAttribute('aria-current', 'page');
      const frame = document.createElement('span');
      frame.className = 'kg-thumb-frame';
      const label = document.createElement('span');
      label.textContent = String(page);
      tile.append(frame, label);
      grid.append(tile);
      observer.observe(tile);
    }
    const focus = grid.children[focusPage - start];
    focus.focus({ preventScroll: true });
    focus.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  grid.addEventListener('click', event => {
    const tile = event.target.closest('button[data-page]');
    if (!tile) return;
    dispose();
    onPick(Number(tile.dataset.page));
  });
  grid.addEventListener('keydown', event => {
    const tile = event.target.closest('button[data-page]');
    if (!tile) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const step = { ArrowRight: direction === 'rtl' ? -1 : 1, ArrowLeft: direction === 'rtl' ? 1 : -1,
      ArrowUp: -cols, ArrowDown: cols }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const target = Math.min(total, Math.max(1, Number(tile.dataset.page) + step));
    if (target < start || target >= start + batch) show(target - ((target - 1) % batch), target);
    else grid.children[target - start].focus();
  });
  function dispose() {
    if (closed) return;
    closed = true;
    thumbnailPumps.delete(pump);
    if (dialog.open) dialog.close();
    clearGrid();
    dialog.remove();
    onClose();
  }
  dialog.addEventListener('close', dispose, { once: true });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dispose();
  });
  dialog.showModal();
  show(start, current);
  return { close: dispose, resize };
}

function bindTapNavigation(target, enabled, navigate, listen) {
  let press;
  target.addEventListener('pointerdown', event => {
    press = enabled() && event.isPrimary && event.button === 0
      ? { x: event.clientX, y: event.clientY, id: event.pointerId, time: event.timeStamp } : null;
  }, listen);
  target.addEventListener('pointermove', event => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) press = null;
  }, listen);
  for (const type of ['pointercancel', 'dragstart', 'contextmenu']) {
    target.addEventListener(type, () => { press = null; }, listen);
  }
  target.addEventListener('click', event => {
    const down = press;
    press = null;
    if (!down || !enabled() || event.defaultPrevented || event.button !== 0 || event.detail === 0 ||
        (event.pointerId != null && event.pointerId !== down.id) || event.timeStamp - down.time > 650 ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 12 ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        event.target.closest('a, button, input, select, textarea, [contenteditable="true"]')) return;
    const rect = target.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    if (x >= 0 && x < 1 / 3) navigate('left');
    else if (x > 2 / 3 && x <= 1) navigate('right');
  }, listen);
}

function mountReaderControls(container, options) {
  const { keyTarget, themeTarget, onMode, onTheme, onTurn } = options;
  const toolbar = document.createElement('div');
  toolbar.className = 'kg-reader-controls';
  const lifetime = new AbortController();
  const listen = { signal: lifetime.signal };
  const setTheme = themeTarget && watchReaderTheme(theme => {
    themeTarget.dataset.readerTheme = theme;
  }, lifetime.signal);
  let state = { mode: 'scroll', theme: 'system', direction: 'rtl', tapToTurn: true, current: 1, total: 0 };
  let first = 1;
  let stride = 1;
  let picker;
  let openDrawer;
  const restoreExtras = [];

  function setDrawer(next, returnFocus = false) {
    const previous = openDrawer;
    if (previous) {
      previous.panel.hidden = true;
      previous.toggle.setAttribute('aria-expanded', 'false');
    }
    openDrawer = next;
    if (next) {
      next.panel.hidden = false;
      next.toggle.setAttribute('aria-expanded', 'true');
    } else if (returnFocus) previous?.toggle.focus({ preventScroll: true });
  }

  function drawer(side, title, shortTitle) {
    const wrapper = document.createElement('div');
    wrapper.className = 'kg-edge kg-edge-' + side;
    const panel = document.createElement('section');
    panel.id = 'kg-' + side + '-panel';
    panel.className = 'kg-edge-panel';
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.id = panel.id + '-title';
    heading.textContent = title;
    panel.setAttribute('aria-labelledby', heading.id);
    panel.append(heading);
    const toggle = readerButton(shortTitle, () => setDrawer(openDrawer === entry ? null : entry));
    toggle.className = 'kg-edge-toggle';
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
    toggle.setAttribute('aria-controls', panel.id);
    toggle.setAttribute('aria-expanded', 'false');
    const entry = { panel, toggle };
    wrapper.append(toggle, panel);
    toolbar.append(wrapper);
    return entry;
  }

  // The chapter links, title, and exit action belong to the surrounding reader.
  // Put them back when navigating to another chapter or refreshing its cache.
  function attachExtras(panel, nodes) {
    if (!nodes?.length) return;
    const extras = document.createElement('div');
    extras.className = 'kg-edge-extras';
    for (const node of nodes) {
      const marker = document.createComment('reader control');
      node.before(marker);
      extras.append(node);
      restoreExtras.push(() => marker.replaceWith(node));
    }
    panel.append(extras);
  }

  const settings = drawer('left', '閱讀設定', '設定');
  const navigation = drawer('right', '頁面導覽', '導覽');

  function menu(name, choices, change) {
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.setAttribute('aria-label', name);
    for (const [value, text] of choices) select.add(new Option(text, value));
    select.addEventListener('change', () => change(select.value), listen);
    label.append(name, select);
    settings.panel.append(label);
    return select;
  }

  const mode = menu('閱讀模式', [['scroll', '直向捲動'], ['single', '單頁'], ['double', '雙頁']], onMode);
  if (options.onBufferMode) {
    const buffer = menu('緩衝模式', [['chapter', '停留時緩衝整話'], ['ahead', '只預載後面 3 頁']], options.onBufferMode);
    buffer.value = options.bufferMode;
  }
  if (options.parallelPreload) {
    const {value, choices, onChange} = options.parallelPreload;
    const preload = menu('並行預載數', choices.map(count => [count, count + ' 頁']), onChange);
    preload.value = String(value);
  }
  const theme = menu('外觀', [['system', '跟隨系統'], ['light', '淺色'], ['dark', '深色']], onTheme);
  const direction = menu('翻頁方向', [['rtl', '從右到左'], ['ltr', '從左到右']], options.onDirection);
  const tapLabel = document.createElement('label');
  const tap = document.createElement('input');
  tap.type = 'checkbox';
  tap.addEventListener('change', () => options.onTapToTurn(tap.checked), listen);
  tapLabel.append(tap, '點按翻頁');
  const browse = readerButton('小圖選頁', () => {
    if (picker || state.total < 1) return;
    const current = Math.max(1, Math.min(options.getCurrentPage(), state.total));
    picker = openThumbnailPicker(toolbar, { ...state, current, getThumbnail: options.getThumbnail,
      onThumbnailSize: options.onThumbnailSize,
      onPick: page => { setDrawer(null, true); options.onPick(page); },
      onClose: () => { picker = null; } });
  });
  browse.setAttribute('aria-haspopup', 'dialog');
  settings.panel.append(tapLabel);
  attachExtras(settings.panel, options.settingsExtras);
  navigation.panel.append(browse);
  const pager = document.createElement('span');
  pager.className = 'kg-page-turns';
  function turn(step) {
    const target = first + step * stride;
    if (state.mode !== 'scroll' && target >= 1 && target <= state.total) onTurn(target);
  }
  function sideStep(side) { return (side === 'left') === (state.direction === 'rtl') ? 1 : -1; }
  bindTapNavigation(options.tapTarget, () => state.tapToTurn && !picker && !openDrawer, side => {
    const step = sideStep(side);
    if (state.mode !== 'scroll') { turn(step); return; }
    const target = options.getCurrentPage() + step;
    if (target >= 1 && target <= state.total) options.onPick(target);
  }, listen);
  const previous = readerButton('上一頁', () => turn(-1));
  const next = readerButton('下一頁', () => turn(1));
  const count = document.createElement('span');
  count.className = 'kg-page-count';
  count.setAttribute('aria-live', 'polite');
  pager.append(previous, count, next);
  navigation.panel.append(pager);
  attachExtras(navigation.panel, options.navigationExtras);
  container.append(toolbar);

  keyTarget.addEventListener('click', event => {
    if (!openDrawer || picker || event.composedPath().includes(toolbar)) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawer(null, true);
  }, { capture: true, signal: lifetime.signal });
  keyTarget.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picker && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      picker.close();
      return;
    }
    if (event.key === 'Escape' && openDrawer && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      setDrawer(null, true);
      return;
    }
    if (picker || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        state.mode === 'scroll' || event.composedPath().some(node =>
          node instanceof Element && (node.matches('select, input, textarea') || node.isContentEditable))) return;
    const step = { ArrowLeft: sideStep('left'), ArrowRight: sideStep('right'), PageDown: 1, PageUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    turn(step);
  }, listen);

  function update(changes) {
    const old = state;
    state = { ...state, ...changes };
    if (state.chapterKey !== old.chapterKey || state.total !== old.total || state.direction !== old.direction) picker?.close();
    else if (state.thumbnailSize !== old.thumbnailSize) picker?.resize(state.thumbnailSize);
    stride = state.mode === 'double' ? 2 : 1;
    const page = Math.max(1, Math.min(state.current, state.total));
    first = page - ((page - 1) % stride);
    const last = Math.min(first + stride - 1, state.total);
    mode.value = state.mode;
    theme.value = state.theme;
    direction.value = state.direction;
    tap.checked = state.tapToTurn;
    const rtl = state.direction === 'rtl';
    tapLabel.title = rtl ? '點畫面左側前進，右側返回' : '點畫面右側前進，左側返回';
    previous.setAttribute('aria-keyshortcuts', rtl ? 'ArrowRight PageUp' : 'ArrowLeft PageUp');
    next.setAttribute('aria-keyshortcuts', rtl ? 'ArrowLeft PageDown' : 'ArrowRight PageDown');
    setTheme?.(state.theme);
    browse.disabled = state.total < 1;
    pager.hidden = state.mode === 'scroll';
    pager.dataset.direction = state.direction;
    previous.disabled = first <= 1;
    next.disabled = last >= state.total;
    const range = first < last ? first + '–' + last : first;
    count.textContent = state.total ? range + ' / ' + state.total : '0 / 0';
  }
  update({ mode: options.mode || 'scroll', theme: options.theme || 'system', direction: options.direction || 'rtl',
    tapToTurn: options.tapToTurn !== false, thumbnailSize: options.thumbnailSize || 'medium',
    current: options.current || 1, total: options.total || 0 });
  return { update, destroy() {
    picker?.close();
    lifetime.abort();
    for (const restore of restoreExtras) restore();
    if (themeTarget) delete themeTarget.dataset.readerTheme;
    toolbar.remove();
  } };
}


  const readerCSS = `
    :host {color-scheme:light; font:15px/1.5 "DM Sans","PingFang TC","Microsoft JhengHei",sans-serif; color:#222520}
    *,*::before,*::after {box-sizing:border-box} [hidden] {display:none!important}
    :host,dialog:not(.kg-thumb-picker) {--paper:#f7f6f2;--ink:#222520;--surface:#e9ede2;--line:#9ca79b;--well:#eaece5;--hover:#dbe3d6;--alert:#733b2e;--accent:#39654c}
    dialog[data-reader-theme="dark"] {color-scheme:dark;--paper:#171b18;--ink:#e5e9e2;--surface:#242b24;--line:#636e63;--well:#202620;--hover:#354237;--alert:#eeb9a5;--accent:#a7c8ad}
    button,select {font:inherit;font-size:14px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:5px 9px}
    button {cursor:pointer} button:hover:not(:disabled),select:hover {background:var(--hover)} button:disabled {cursor:default;opacity:.5}
    :focus-visible {outline:3px solid var(--accent);outline-offset:2px}
    :host(.kg-source-tools) {display:contents!important}
    .dock {
      all:initial;direction:ltr;box-sizing:border-box;font:14px/1.25 "DM Sans","PingFang TC","Microsoft JhengHei",sans-serif;
      --paper:#f7f6f2;--ink:#222520;--muted:#586158;--line:#9ca79b;--surface:#e9ede2;--hover:#dbe3d6;--accent:#39654c;--alert:#733b2e;
      --dock-bottom-gap:max(8px, var(--dock-toolbar-clearance, 0px), calc(env(safe-area-inset-bottom,0px) + 8px));
      color-scheme:light;position:fixed;z-index:2147483646;right:calc(env(safe-area-inset-right,0px) + 8px);
      bottom:var(--dock-bottom-gap);
      max-width:calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px) - 16px);
      display:flex;align-items:stretch;background:var(--paper);color:var(--ink);
      border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 7px rgb(0 0 0 / 14%);
    }
    @supports (height:100dvh) {
      .dock {
        top:calc(min(100dvh, var(--dock-visible-bottom, 100dvh)) - var(--dock-bottom-gap));
        bottom:auto;
        transform:translateY(-100%);
      }
    }
    @supports (-webkit-touch-callout:none) {
      /* Leave room for iOS/iPadOS browser controls drawn over the page. */
      .dock {--dock-toolbar-clearance:48px}
    }
    @media(prefers-color-scheme:dark) {
      .dock {color-scheme:dark;--paper:#171b18;--ink:#e5e9e2;--muted:#b2baaf;--line:#636e63;--surface:#242b24;--hover:#354237;--accent:#a7c8ad;--alert:#eeb9a5}
    }
    .dock button {min-width:44px;min-height:44px;margin:0;padding:4px 12px;border:0;border-radius:0;font:inherit;color:var(--ink)}
    .dock button:focus-visible {outline-offset:-3px}
    .dock .dock-reader {border-radius:7px 0 0 7px;background:var(--surface);color:var(--accent);font-weight:700}
    .dock .dock-reader:hover {background:var(--hover)}
    .dock .dock-shelf {border-left:1px solid var(--line);border-radius:0 7px 7px 0;text-align:start;font-weight:600}
    .dock-count {display:block;color:var(--muted);font-size:12px;font-weight:400;line-height:1.35;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .dock-error {
      position:absolute;right:0;bottom:calc(100% + 5px);width:max-content;max-width:min(300px,calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px) - 18px));
      max-height:min(8em,35dvh);overflow:auto;overscroll-behavior:contain;margin:0;padding:8px 10px;border:1px solid var(--line);border-radius:6px;
      background:var(--paper);color:var(--alert);font-size:13px;line-height:1.45;overflow-wrap:anywhere;
    }
    .dock-error:empty {display:none}
    .tail {display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
    dialog:not(.kg-thumb-picker) {width:100vw;max-width:none;height:100dvh;max-height:none;inset:0;margin:0;border:0;padding:0;background:var(--paper);color:var(--ink);font:inherit;overflow:auto;overscroll-behavior:contain}
    dialog:not(.kg-thumb-picker)::backdrop {background:var(--paper)}
    .source-chapter-title {font-size:15px;font-weight:650;overflow-wrap:anywhere}
    .source-chapter-subtitle {font-size:13px;overflow-wrap:anywhere}
    .buffer-progress {position:fixed;bottom:max(8px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);padding:2px 9px;border-radius:5px;background:var(--paper);color:var(--ink);border:1px solid var(--line);font-size:12px;white-space:nowrap;pointer-events:none}
    .chapter-actions {display:grid;gap:.5rem}
    .chapter-actions [role="status"]:empty {display:none}
    .chapter-boundary {height:1px;pointer-events:none}
    .tail {margin:16px auto;padding:12px;background:var(--surface);border-radius:5px}
    .pages,.tail {width:min(100%,960px);margin-inline:auto}
    h2 {font:600 1.35rem/1.35 "DM Sans","PingFang TC",sans-serif;margin:1.2rem 0;overflow-wrap:anywhere}
    figure {padding:0;margin:0 auto 10px;background:var(--well);width:100%}
    figure img {display:block;max-width:100%;height:auto;margin:auto} figure figcaption {padding:8px;color:var(--alert)}
    label {display:inline-flex;align-items:center;gap:4px;white-space:nowrap} input {accent-color:var(--accent)}
    dialog.paged[open] {overflow:hidden}
    .paged .chapter-boundary {display:none}
    .paged .pages {display:flex;align-items:stretch;direction:rtl;justify-content:center;height:100%;width:100%;gap:2px;overflow:hidden}
    .paged[data-reader-direction="ltr"] .pages {direction:ltr}
    .paged .pages h2 {display:none}
    .paged figure {direction:ltr;display:flex;flex-flow:column;align-items:center;justify-content:center;flex:0 1 auto;width:100%;min-height:0!important;min-width:0;margin:0;background:var(--paper)}
    .paged figure img {width:100%;height:100%;min-height:0;object-fit:contain}
    .paged[data-reader-mode="double"] figure:not(:only-of-type) {max-width:50%}
    .paged figure.spread-single {max-width:100%!important}
    .paged figure.spread-right img {object-position:left center}
    .paged figure.spread-left img {object-position:right center}
    @media(max-width:600px){button,select{font-size:13px}}
    .kg-reader-controls input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
}
.kg-page-turns[data-direction="rtl"] { flex-direction: row-reverse; }

dialog.kg-thumb-picker {
  position: fixed;
  inset: 0;
  margin: auto;
  box-sizing: border-box;
  width: 94vw;
  height: 92dvh;
  max-width: 100%;
  max-height: 100dvh;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: .6rem;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  text-align: start;
}
dialog.kg-thumb-picker[open] { display: flex; flex-direction: column; }
.kg-thumb-picker::backdrop { background: rgb(9 14 10 / 68%); }
.kg-thumb-head, .kg-thumb-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: .75rem;
  padding: .75rem 1rem;
}
.kg-thumb-head { flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.kg-thumb-head strong { font-size: 1.1rem; margin: 0; }
.kg-thumb-range {
  color: var(--muted, var(--ink));
  font-size: .85rem;
  font-variant-numeric: tabular-nums;
}
.kg-thumb-head .kg-thumb-size {
  display: inline-flex;
  align-items: center;
  gap: .4rem;
  margin-inline-start: auto;
  color: var(--muted, var(--ink));
  font-size: .85rem;
  white-space: nowrap;
}
.kg-thumb-size select { min-height: 2.1rem; }
.kg-thumb-footer { justify-content: space-between; border-top: 1px solid var(--line); }
.kg-thumb-grid {
  --tile-min: 6rem;
  display: grid;
  flex: 1 1 0;
  min-height: 0;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--tile-min)), 1fr));
  grid-auto-rows: max-content;
  align-content: start;
  gap: .75rem;
  padding: 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding: 1rem;
}
.kg-thumb-grid[data-size="small"] { --tile-min: 4rem; }
.kg-thumb-grid[data-size="large"] { --tile-min: clamp(15rem, 24vw, 26rem); }
.kg-thumb-grid .kg-thumb-page {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: .22rem;
  min-width: 0;
  padding: .25rem;
  border: 1px solid transparent;
  border-radius: .35rem;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: .85rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: normal;
  cursor: pointer;
}
.kg-thumb-grid .kg-thumb-page:hover { background: var(--hover); }
.kg-thumb-grid .kg-thumb-page[aria-current="page"] {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 700;
}
.kg-thumb-frame {
  display: grid;
  place-items: center;
  width: 100%;
  flex: none;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--slot, var(--well));
  color: var(--muted, var(--ink));
  font-size: .8rem;
}
.kg-thumb-frame img {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
}
@media (max-width: 38rem) {
  dialog.kg-thumb-picker { width: calc(100vw - .5rem); height: calc(100dvh - 1rem); }
  .kg-thumb-head { gap: .4rem .6rem; padding: .6rem; }
  .kg-thumb-grid { --tile-min: 4.8rem; gap: .5rem; padding: .65rem; }
  .kg-thumb-grid[data-size="small"] { --tile-min: 3.3rem; }
  .kg-thumb-grid[data-size="large"] { --tile-min: 12rem; }
}
.kg-reader-controls {
  --edge-width: 2.5rem;
  --edge-surface: var(--paper);
  display: contents;
}
.kg-edge, .kg-edge-panel {
  display: flex;
  align-items: center;
}
.kg-edge {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  z-index: 8;
  pointer-events: none;
}
.kg-edge-left { left: env(safe-area-inset-left, 0px); }
.kg-edge-right { right: env(safe-area-inset-right, 0px); flex-direction: row-reverse; }
.kg-reader-controls .kg-edge-toggle {
  position: relative;
  padding: .7rem .35rem;
  width: var(--edge-width);
  min-height: 3.8rem;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--edge-surface) 91%, transparent);
  color: var(--ink);
  font: inherit;
  font-size: .8rem;
  font-weight: 600;
  letter-spacing: .1em;
  line-height: 1;
  writing-mode: vertical-rl;
  text-orientation: upright;
  pointer-events: auto;
  cursor: pointer;
}
.kg-edge-left .kg-edge-toggle { border-left: 0; border-radius: 0 .45rem .45rem 0; }
.kg-edge-right .kg-edge-toggle { border-right: 0; border-radius: .45rem 0 0 .45rem; }
.kg-reader-controls .kg-edge-toggle:is(:hover, [aria-expanded="true"]) {
  background: var(--hover);
  color: var(--accent);
}
.kg-edge .kg-edge-panel {
  position: absolute;
  width: 15rem;
  max-width: calc(100vw - 2 * var(--edge-width) - 1.25rem);
  max-height: calc(100dvh - 2rem);
  flex-direction: column;
  align-items: stretch;
  gap: .65rem;
  margin: 0;
  padding: 1rem;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--line);
  border-radius: .6rem;
  background: var(--edge-surface);
  color: var(--ink);
  box-shadow: 0 .3rem 1.2rem rgb(0 0 0 / 18%);
  font-size: .9rem;
  line-height: 1.45;
  pointer-events: auto;
}
.kg-edge-panel[hidden] { display: none; }
.kg-edge-left .kg-edge-panel { left: calc(100% + .35rem); }
.kg-edge-right .kg-edge-panel { right: calc(100% + .35rem); }
.kg-edge-panel h2 {
  margin: 0 0 .2rem;
  color: var(--ink);
  font: inherit;
  font-size: 1.05rem;
  font-weight: 700;
}
.kg-edge-panel > label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .6rem;
  font-size: .875rem;
}
.kg-edge-panel > label:has(input) { justify-content: start; }
.kg-edge-extras {
  display: grid;
  gap: .6rem;
  min-width: 0;
  padding-top: .75rem;
  border-top: 1px solid var(--line);
}
.kg-edge-extras:not(:has(> :not([hidden]))) { display: none; }
.kg-page-turns {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .25rem;
}
.kg-page-count { font-variant-numeric: tabular-nums; text-align: center; }
.kg-edge-panel .kg-page-turns button { padding-inline: .45rem; }
.kg-edge-panel button, .kg-edge-panel select { min-height: 2.15rem; }

  `;
  function readerRoot(host) {
    const root = host.attachShadow({mode: 'open'});
    root.append(element('style', readerCSS));
    return root;
  }

  async function fetchDocument(address, signal) {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(address, {mode:'same-origin', credentials:'same-origin',
      signal:signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('下一頁沒有傳回章節網頁');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '', size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('章節網頁過大'); }
        html += decoder.decode(value, {stream:true});
      }
      html += decoder.decode();
    } finally { reader.releaseLock(); }
    // A template has an inert owner document. We only read attributes/text from it
    // and never attach, clone, execute, or copy a site's elements into the reader.
    const template = document.createElement('template');
    template.innerHTML = html;
    return {root:template.content, address:new URL(response.url)};
  }

  async function fetchChapter(address) {
    const parsed = await fetchDocument(address);
    const chapter = detectChapter(parsed.root, parsed.address);
    if (!chapter) throw new Error('無法辨識接續章節');
    return chapter;
  }

  const AUTO = PREFIX + 'auto-next-chapter';
  let autoNext = false;
  const settingsChanged = new EventTarget();
  function applyAuto(value) {
    autoNext = value === true;
    settingsChanged.dispatchEvent(new Event('change'));
  }
  function toggleControl(signal) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = autoNext;
    input.addEventListener('change', async () => {
      const enabled = input.checked;
      await write(AUTO, enabled);
      applyAuto(enabled);
    });
    settingsChanged.addEventListener('change', () => { input.checked = autoNext; }, {signal});
    label.append(input, document.createTextNode('自動接下一話'));
    return label;
  }

  const VIEW = PREFIX + 'reader-view';
  const PARALLEL_PRELOAD = PREFIX + 'parallel-preload';
  const PARALLEL_PRELOAD_CHOICES = [1, 2, 3, 4, 5, 6];
  const DEFAULT_PARALLEL_PRELOAD = 3;
  const READ_AHEAD_PAGES = 3;
  const BUFFER_IDLE_MS = 1200;
  function createFlow(root, first, overlay, view = {}) {
    const controller = new AbortController();
    const pane = element('main', '', 'pages');
    const chapterActions = element('div', '', overlay ? 'chapter-actions' : 'tail');
    const endMarker = overlay ? element('div', '', 'chapter-boundary') : chapterActions;
    const chapterTitle = overlay ? element('strong', first.chapterTitle, 'source-chapter-title') : null;
    const chapterSubtitle = overlay ? element('span', '', 'source-chapter-subtitle') : null;
    if (chapterSubtitle) chapterSubtitle.lang = 'ja';
    const message = element('span');
    message.setAttribute('role','status');
    const nextButton = button('', () => appendNext());
    const visited = new Set([first.baseURL, first.chapterUrl]);
    const displayedImages = new Map();
    const groups = [];
    let liveChapter = first;
    let sourceScroll;
    let group, position = first.startIndex || 1, controls, scrollFrame = 0, scrollAnchor = null;
    let mode = ['single', 'double'].includes(view.mode) ? view.mode : 'scroll';
    let theme = ['light', 'dark'].includes(view.theme) ? view.theme : 'system';
    let direction = view.direction === 'ltr' ? 'ltr' : 'rtl';
    let tapToTurn = view.tapToTurn !== false;
    let thumbnailSize = ['small', 'large'].includes(view.thumbnailSize) ? view.thumbnailSize : 'medium';
    let current = first, busy = false, nearEnd = false, stopped = false;
    let imageTasks = Promise.resolve();
    let bufferMode = view.bufferMode === 'ahead' ? 'ahead' : 'chapter';
    let parallelPreload = PARALLEL_PRELOAD_CHOICES.includes(view.parallelPreload)
      ? view.parallelPreload : DEFAULT_PARALLEL_PRELOAD;
    let bufferScheduled = false, bufferReadyAt = 0, bufferCursor = 0;
    let bufferGroup, bufferPosition, bufferLayout, bufferRevision = 0;
    const bufferAttempts = new WeakMap();
    const bufferRetries = new WeakMap();
    const pendingBuffers = new WeakMap();
    const failedBuffers = new Map();
    const pendingDraws = new WeakMap();
    let progressTimer;
    let checkNativeBuffer;
    const bufferProgress = element('span', '', 'buffer-progress');
    bufferProgress.hidden = true;
    const bufferError = element('div');
    bufferError.hidden = true;
    const entries = new WeakMap();
    const requests = new WeakMap();
    const waitingForSource = new WeakSet();
    const options = {root: overlay || null, rootMargin:'360px 0px'};
    const imageObserver = new IntersectionObserver(changes => {
      for (const change of changes) {
        const figure = change.target;
        if (change.isIntersecting) loadFigure(figure);
        else if (liveChapter?.resolvePage && mode === 'scroll' && requests.has(figure) && !figure.querySelector('img')) {
          // After a long jump, leave the native pager free for the new viewport.
          releaseFigure(figure);
        }
      }
      scheduleBuffer();
    }, options);
    function showPageRetry(figure, message) {
      const caption = element('figcaption', message + ' ');
      caption.append(button('重試', () => {
        releaseFigure(figure);
        loadFigure(figure);
      }));
      figure.append(caption);
    }
    function loadFigure(figure) {
      if (figure.hidden || requests.has(figure)) return;
      const ticket = Symbol();
      requests.set(figure, ticket);
      pendingDraws.set(figure, ticket);
      imageTasks = imageTasks.then(() => drawPage(figure, ticket)).catch(err => {
        if (!stopped && requests.get(figure) === ticket) showPageRetry(figure, err.message);
      }).finally(() => {
        if (pendingDraws.get(figure) === ticket) pendingDraws.delete(figure);
        scheduleBuffer();
      });
    }
    function releaseFigure(figure) {
      requests.delete(figure);
      waitingForSource.delete(figure);
      const image = displayedImages.get(figure);
      if (image) URL.revokeObjectURL(image.url);
      displayedImages.delete(figure);
      figure.replaceChildren();
      figure.style.minHeight = 'min(60vh, 420px)';
    }
    function revealNativePage(figure, index) {
      if (!overlay || !liveChapter?.revealPage || groups[0].figures.get(index) !== figure) return false;
      const before = {left:window.scrollX, top:window.scrollY, behavior:'instant'};
      if (!liveChapter.revealPage(index)) return false;
      if (window.scrollX !== before.left || window.scrollY !== before.top) sourceScroll ??= before;
      return true;
    }
    async function resolveFigure(figure, showNotice) {
      const page = entries.get(figure);
      const source = liveChapter;
      if (page.imageUrl || !overlay || !source?.resolvePage || groups[0].figures.get(page.index) !== figure) return page;
      const notice = showNotice && element('figcaption', '等候原站載入第 ' + page.index + ' 頁…');
      if (notice) figure.append(notice);
      try {
        const entry = await source.resolvePage(page.index, controller.signal);
        if (stopped || !liveChapter) return page;
        const resolved = entry?.index === page.index && entry.imageUrl && pageFor(source, entry);
        if (!resolved?.imageUrl) throw new Error('原站未能載入第 ' + page.index + ' 頁。');
        entries.set(figure, resolved);
        return resolved;
      } finally {
        if (notice) notice.remove();
      }
    }

    function restartBuffer() {
      bufferRevision++;
      checkNativeBuffer?.();
      bufferCursor = 0;
      bufferReadyAt = performance.now() + (bufferMode === 'chapter' ? BUFFER_IDLE_MS : 0);
      scheduleBuffer();
    }
    function lastVisiblePage() {
      let end = visibleEnd();
      if (mode === 'scroll') {
        const bottom = overlay.getBoundingClientRect().bottom;
        while (end < group.total && group.figures.get(end + 1)?.getBoundingClientRect().top < bottom) end++;
      }
      return end;
    }
    // A lazy slot can take several scans to publish its URL after scrolling.
    // Keep the slot in view until the native loader responds or reading moves on.
    function waitForNativeBuffer(figure, stillWanted) {
      return new Promise((resolve, reject) => {
        function finish(page) {
          clearTimeout(timer);
          checkNativeBuffer = null;
          resolve(page);
        }
        const timer = setTimeout(() => {
          checkNativeBuffer = null;
          reject(new Error('原站載圖逾時'));
        }, 8000);
        checkNativeBuffer = () => {
          const page = entries.get(figure);
          if (!stillWanted()) finish(null);
          else if (page.imageUrl) finish(page);
        };
        checkNativeBuffer();
      });
    }
    async function updateBufferProgress() {
      const section = group;
      const {site, workId, chapterId} = section.chapter;
      try {
        const count = await savedPageCount([site, workId || '', chapterId]);
        if (stopped || group !== section) return;
        const failed = [...failedBuffers].some(([figure]) => section.figures.get(Number(figure.dataset.index)) === figure);
        bufferProgress.hidden = false;
        bufferProgress.textContent = '已保存 ' + count + '／' + section.total + ' 頁' +
          (failed ? ' · 有缺頁，見閱讀設定' : '');
      } catch {
        if (!stopped && group === section) bufferProgress.textContent = '無法讀取緩衝進度';
      }
    }
    function scheduleBufferProgress() {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(updateBufferProgress, 80);
    }
    async function bufferNextPage() {
      if (stopped || document.hidden) return false;
      if (performance.now() < bufferReadyAt) return true;
      const full = bufferMode === 'chapter';
      const end = lastVisiblePage();
      const count = full ? group.total : Math.min(READ_AHEAD_PAGES, group.total - end);
      const parallel = group === groups[0] && liveChapter?.parallelPages;
      const limit = parallel ? parallelPreload : 1;
      const figures = [];
      const start = full ? bufferCursor || end : end;
      // Walk forward from the current spread, then wrap to earlier missing pages.
      for (let n = 0; n < count && figures.length < limit; n++) {
        const index = full ? (start + n) % count + 1 : start + n + 1;
        const figure = group.figures.get(index);
        if (!figure || pendingDraws.has(figure) || failedBuffers.has(figure) ||
            bufferAttempts.get(figure) === entries.get(figure)) continue;
        figures.push(figure);
        bufferCursor = index;
      }
      if (!figures.length) {
        const needsNextPage = full || group.total - end < READ_AHEAD_PAGES;
        if (needsNextPage && !busy && !message.textContent && group === groups.at(-1) && target()?.same) {
          await appendNext(true);
          return !message.textContent;
        }
        return false;
      }
      await Promise.all(figures.map(figure => {
        const task = bufferPage(figure).finally(() => pendingBuffers.delete(figure));
        pendingBuffers.set(figure, task);
        return task;
      }));
      return true;
    }
    async function bufferPage(figure) {
      const revision = bufferRevision;
      const page = entries.get(figure);
      const stillWanted = () => !stopped && !document.hidden && revision === bufferRevision;
      try {
        let resolved = page;
        if (!(await lookupPage(page, false)).exists) {
          if (!stillWanted()) return true;
          resolved = await resolveFigure(figure, false);
          if (!stillWanted()) return true;
          if (!resolved.imageUrl && revealNativePage(figure, page.index)) {
            resolved = await waitForNativeBuffer(figure, stillWanted);
            if (!resolved || !stillWanted()) return true;
          }
          if (!resolved.imageUrl) throw new Error('原站尚未提供圖檔');
          await saveLoaded(resolved);
        }
        bufferAttempts.set(figure, resolved);
        bufferRetries.delete(figure);
      } catch (error) {
        if (!stillWanted()) return true;
        const retries = bufferRetries.get(figure) || 0;
        if (retries < 2) {
          bufferRetries.set(figure, retries + 1);
          bufferReadyAt = performance.now() + 1000;
        } else {
          failedBuffers.set(figure, error.message);
          showBufferErrors();
        }
      }
    }
    function showBufferErrors() {
      const missing = [...failedBuffers].filter(([figure]) => group.figures.get(Number(figure.dataset.index)) === figure);
      bufferError.hidden = !missing.length;
      if (missing.length) {
        const [figure, reason] = missing[0];
        bufferError.replaceChildren('緩衝缺 ' + missing.length + ' 頁（第 ' + figure.dataset.index + ' 頁：' + reason + '） ',
          button('重試缺頁', () => {
            for (const [page] of missing) {
              failedBuffers.delete(page);
              bufferRetries.delete(page);
            }
            showBufferErrors();
            restartBuffer();
          }));
      }
      scheduleBufferProgress();
    }
    function scheduleBuffer() {
      if (!overlay || stopped || document.hidden || bufferScheduled) return;
      bufferScheduled = true;
      // Start behind queued visible work. Native pagers keep using the same
      // serial queue because selecting a new page replaces the current image.
      setTimeout(() => {
        const task = imageTasks.then(bufferNextPage);
        // Independent requests don't block a turn to a page outside their batch.
        const finished = task.catch(error => {
          console.warn('[KomaGlide]', error);
          return false;
        });
        if (!(group === groups[0] && liveChapter?.parallelPages)) imageTasks = finished;
        void finished.then(more => {
          bufferScheduled = false;
          if (more) scheduleBuffer();
        });
      }, Math.max(100, bufferReadyAt - performance.now()));
    }

    async function drawPage(figure, ticket) {
      const obsolete = () => stopped || requests.get(figure) !== ticket;
      if (obsolete()) return;
      await pendingBuffers.get(figure);
      if (obsolete()) return;
      const cached = await lookupPage(entries.get(figure), true);
      if (cached.exists) {
        bufferAttempts.set(figure, entries.get(figure));
        if (failedBuffers.delete(figure)) showBufferErrors();
      }
      if (obsolete()) return;
      let page = entries.get(figure);
      const img = element('img');
      img.alt = '第 ' + page.index + ' 頁';
      img.dataset.index = String(page.index);
      let blob = cached.blob;
      if (!blob) {
        page = await resolveFigure(figure, true);
        if (obsolete()) return;
        if (!page.imageUrl) {
          waitingForSource.add(figure);
          if (revealNativePage(figure, page.index)) {
            showPageRetry(figure, '等候原站載入第 ' + page.index + ' 頁…');
          } else {
            figure.append(element('figcaption', '第 ' + page.index + ' 頁尚未儲存，請在原站載入此頁。'));
          }
          return;
        }
        try {
          const result = await capture(page);
          blob = result.blob;
          if (result.storageError) {
            if (!obsolete()) figure.append(element('figcaption', result.storageError.message));
          } else {
            bufferAttempts.set(figure, page);
            if (failedBuffers.delete(figure)) showBufferErrors();
          }
        } catch (err) {
          if (obsolete()) return;
          figure.append(element('figcaption', '線上顯示 · ' + err.message));
          img.src = page.imageUrl;
        }
      }
      if (obsolete()) return;
      if (blob) {
        img.src = URL.createObjectURL(blob);
        displayedImages.set(figure, {url:img.src, blob});
      }
      img.addEventListener('load', () => { figure.style.minHeight = ''; });
      img.addEventListener('error', () => figure.append(element('figcaption','圖檔無法顯示')));
      figure.prepend(img);
    }

    function insertFigure(section, page) {
      const following = page.index < section.lastIndex && [...section.figures].find(([n]) => n > page.index);
      const before = following?.[1] || groups[groups.indexOf(section) + 1]?.title || null;
      const figure = element('figure');
      figure.dataset.index = String(page.index);
      figure.style.minHeight = 'min(60vh, 420px)';
      entries.set(figure, page);
      section.figures.set(page.index, figure);
      if (following) section.figures = new Map([...section.figures].sort(([a], [b]) => a - b));
      section.lastIndex = Math.max(section.lastIndex, page.index);
      pane.insertBefore(figure, before);
      imageObserver.observe(figure);
      return figure;
    }
    function ensureFigure(section, index) {
      if (section.figures.has(index)) return section.figures.get(index);
      // Some readers publish a page count before they create every image slot.
      // An absent slot can still have a local copy keyed by this page number.
      return insertFigure(section, {...section.chapter, index, imageUrl:''});
    }
    function addPages(chapter, heading) {
      let section = groups.at(-1);
      if (!section || heading) {
        const title = heading ? element('h2', chapter.chapterTitle) : null;
        if (title) pane.append(title);
        section = {title, chapter:chapterInfo(chapter), figures:new Map(), total:0, lastIndex:0};
        groups.push(section);
        if (!group) group = section;
      }
      mergePages(section, chapter);
      return section;
    }
    function mergePages(section, chapter) {
      const previousTotal = section.total;
      let changed = false;
      if (Number.isSafeInteger(chapter.total)) section.total = Math.max(section.total, chapter.total);
      // A single-image native pager exposes just the current page's URL.
      // Reserve its numbered slots so a scroll can request any page, including offline copies.
      if (overlay && chapter.resolvePage) {
        for (let index = previousTotal + 1; index <= section.total; index++) ensureFigure(section, index);
      }
      for (const entry of [...chapter.entries].sort((a, b) => a.index - b.index)) {
        const page = pageFor(chapter, entry);
        if (!page) continue;
        const existing = section.figures.get(page.index);
        if (existing) {
          const previousUrl = entries.get(existing).imageUrl;
          if (!page.imageUrl || previousUrl === page.imageUrl) continue;
          entries.set(existing, page);
          if (!displayedImages.has(existing) && (previousUrl || waitingForSource.has(existing))) {
            releaseFigure(existing);
            imageObserver.unobserve(existing);
            imageObserver.observe(existing);
          }
        } else insertFigure(section, page);
        section.total = Math.max(section.total, page.index);
        changed = true;
      }
      return changed || previousTotal !== section.total;
    }
    function firstVisible() {
      const top = overlay.getBoundingClientRect().top;
      if (scrollAnchor) {
        const bounds = scrollAnchor.getBoundingClientRect();
        if (bounds.bottom > top && bounds.top < overlay.getBoundingClientRect().bottom) return;
        scrollAnchor = null;
      }
      for (const section of groups) {
        for (const [index, figure] of section.figures) {
          if (figure.getBoundingClientRect().bottom > top + 1) {
            group = section;
            position = index;
            return;
          }
        }
      }
    }
    function visibleEnd() {
      const start = mode === 'double' ? position - ((position - 1) % 2) : position;
      return Math.min(group.total, start + (mode === 'double' ? 1 : 0));
    }
    function syncControls() {
      controls.update({mode, theme, direction, tapToTurn, thumbnailSize, current:position, total:group.total,
        chapterKey:JSON.stringify([group.chapter.workId, group.chapter.chapterId])});
      chapterTitle.textContent = group.chapter.chapterTitle;
      const subtitle = group.chapter.chapterSubtitle;
      chapterSubtitle.textContent = subtitle || '';
      chapterSubtitle.hidden = !subtitle;
      if (bufferGroup !== group || bufferPosition !== position || bufferLayout !== mode) {
        if (bufferGroup !== group) showBufferErrors();
        bufferGroup = group;
        bufferPosition = position;
        bufferLayout = mode;
        restartBuffer();
      } else scheduleBuffer();
    }
    function updateView() {
      if (!overlay || !group) return;
      syncControls();
      overlay.dataset.readerMode = mode;
      overlay.dataset.readerDirection = direction;
      overlay.classList.toggle('paged', mode !== 'scroll');
      const start = mode === 'double' ? position - ((position - 1) % 2) : position;
      const end = visibleEnd();
      if (mode !== 'scroll') {
        for (let index = start; index <= end; index++) ensureFigure(group, index);
      }
      for (const section of groups) {
        if (section.title) section.title.hidden = mode !== 'scroll';
        for (const [index, figure] of section.figures) {
          const hidden = mode !== 'scroll' && (section !== group || index < start || index > end);
          if (hidden && !figure.hidden) releaseFigure(figure);
          figure.hidden = hidden;
          const onSpread = mode === 'double' && !hidden;
          figure.classList.toggle('spread-single', onSpread && start === end);
          figure.classList.toggle('spread-right', onSpread && start < end && index === (direction === 'rtl' ? start : end));
          figure.classList.toggle('spread-left', onSpread && start < end && index === (direction === 'rtl' ? end : start));
          if (!hidden && mode !== 'scroll') loadFigure(figure);
        }
      }
      renderEnd();
    }
    function saveView() { void write(VIEW, {mode, theme, direction, tapToTurn, thumbnailSize, bufferMode}); }
    function scrollToPosition() {
      // At the end of a short chapter the viewport may also show an earlier page.
      // Keep the selected page until the reader scrolls again.
      scrollAnchor = ensureFigure(group, position);
      overlay.scrollTop += scrollAnchor.getBoundingClientRect().top - overlay.getBoundingClientRect().top;
    }
    function pickPage(index) {
      if (!Number.isSafeInteger(index) || index < 1 || index > group.total) return;
      position = index;
      updateView();
      if (mode === 'scroll') scrollToPosition();
    }
    function changeMode(value) {
      if (mode === 'scroll') firstVisible();
      mode = value;
      updateView();
      if (mode === 'scroll') scrollToPosition();
      else overlay.scrollTop = 0;
      saveView();
    }
    function target() {
      if (current.nextPage && !visited.has(current.nextPage)) return {url:current.nextPage, same:true};
      if (current.nextChapter && !visited.has(current.nextChapter)) return {url:current.nextChapter, same:false};
      return null;
    }
    function renderEnd() {
      const next = target();
      const paged = overlay && mode !== 'scroll';
      const atEnd = !paged || visibleEnd() === group.total;
      const loadedNext = paged && groups.indexOf(group) < groups.length - 1;
      previousGroup.hidden = !paged || groups.indexOf(group) < 1 || position > (mode === 'double' ? 2 : 1);
      nextButton.textContent = loadedNext ? '下一話' : next?.same ? '接上下一頁' : '接上下一話';
      nextButton.disabled = busy;
      nextButton.hidden = !atEnd || (!loadedNext && !next);
      chapterActions.hidden = previousGroup.hidden && nextButton.hidden && !message.textContent;
    }
    async function appendNext(background = false) {
      if (stopped || busy) return;
      if (overlay && mode !== 'scroll' && groups.indexOf(group) < groups.length - 1) {
        group = groups[groups.indexOf(group) + 1];
        position = 1;
        updateView();
        return;
      }
      const next = target();
      if (!next) return;
      busy = true;
      message.textContent = '正在接續…';
      renderEnd();
      try {
        let chapter = await fetchChapter(next.url);
        if (stopped) return;
        visited.add(next.url);
        if (next.same) {
          const previous = current;
          const last = Math.max(...previous.entries.map(e => e.index));
          const more = chapter.entries.map((entry, i) => ({...entry, index:last + i + 1}));
          chapter = {...chapter, chapterId:previous.chapterId, chapterUrl:previous.chapterUrl,
            chapterTitle:previous.chapterTitle, workId:previous.workId, workTitle:previous.workTitle,
            total:last + more.length, entries:more};
        }
        current = chapter;
        const added = addPages(chapter, !next.same);
        if (overlay) {
          if (background) updateView();
          else if (mode === 'scroll') {
            firstVisible();
            syncControls();
          } else {
            group = added;
            position = chapter.entries[0]?.index || 1;
            updateView();
          }
        }
        message.textContent = '';
        if (overlay) scheduleBufferProgress();
        // Re-observe the boundary after layout. Small chapters may still fit in view.
        boundary.unobserve(endMarker);
        boundary.observe(endMarker);
      } catch (err) {
        message.textContent = err.message;
      } finally {
        busy = false;
        renderEnd();
      }
    }
    function maybeContinue() {
      if ((!overlay || mode === 'scroll') && nearEnd && !message.textContent && (target()?.same || autoNext)) void appendNext();
    }
    const boundary = new IntersectionObserver(changes => {
      nearEnd = changes[changes.length-1].isIntersecting;
      maybeContinue();
    }, options);
    settingsChanged.addEventListener('change', maybeContinue, {signal:controller.signal});
    const previousGroup = button('上一話', () => {
      group = groups[groups.indexOf(group) - 1];
      position = group.total;
      updateView();
    });
    chapterActions.append(message, previousGroup, nextButton);
    if (!overlay) chapterActions.append(toggleControl(controller.signal));
    root.append(pane, endMarker);
    if (overlay) {
      addPages(first, false);
      const settingsExtras = [chapterTitle, chapterSubtitle, bufferError, toggleControl(controller.signal), button('關閉閱讀器', () => overlay.close())];
      overlay.append(...settingsExtras, chapterActions, bufferProgress);
      getShelfEvents().changes.addEventListener('change', ({detail}) => {
        if (detail.kind === 'limit' || (detail.kind === 'saved' && detail.workId === group.chapter.workId &&
            detail.chapterId === group.chapter.chapterId)) scheduleBufferProgress();
      }, {signal:controller.signal});
      controls = mountReaderControls(overlay, {
        mode, theme, direction, tapToTurn, thumbnailSize, keyTarget:overlay, themeTarget:overlay, tapTarget:pane, onMode:changeMode,
        settingsExtras, navigationExtras:[chapterActions], bufferMode,
        parallelPreload: first.parallelPages ? {
          value: parallelPreload,
          choices: PARALLEL_PRELOAD_CHOICES,
          onChange(value) {
            parallelPreload = Number(value);
            // Let in-flight requests finish. The next batch uses the new limit.
            void write(PARALLEL_PRELOAD, parallelPreload);
            scheduleBuffer();
          }
        } : null,
        onBufferMode(value) {
          bufferMode = value;
          saveView();
          restartBuffer();
        },
        onTheme(value) {
          theme = value;
          controls.update({theme});
          saveView();
        },
        onDirection(value) { direction = value; updateView(); saveView(); },
        onTapToTurn(value) { tapToTurn = value; controls.update({tapToTurn}); saveView(); },
        onThumbnailSize(value) { thumbnailSize = value; controls.update({thumbnailSize}); saveView(); },
        onTurn:pickPage, onPick:pickPage,
        getCurrentPage() {
          if (mode === 'scroll') { firstVisible(); syncControls(); }
          return position;
        },
        async getThumbnail(index, size) {
          if (!Number.isSafeInteger(index) || index < 1 || index > group.total) return null;
          const figure = group.figures.get(index);
          const local = displayedImages.get(figure);
          if (local) return makeReaderThumbnail(local.blob, size);
          // A preview reads only from the local library. Missing pages stay selectable.
          const page = entries.get(figure) || {...group.chapter, index};
          const {blob} = await lookupPage(page, true);
          return blob ? makeReaderThumbnail(blob, size) : null;
        }
      });
      updateView();
      if (mode === 'scroll' && position > 1) scrollToPosition();
      document.addEventListener('visibilitychange', restartBuffer, {signal:controller.signal});
      const clearScrollAnchor = () => { scrollAnchor = null; if (mode === 'scroll') restartBuffer(); };
      const scrollInput = {passive:true, signal:controller.signal};
      for (const type of ['wheel', 'touchmove']) overlay.addEventListener(type, clearScrollAnchor, scrollInput);
      overlay.addEventListener('keydown', event => {
        if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) clearScrollAnchor();
      }, scrollInput);
      overlay.addEventListener('pointerdown', event => {
        if (event.target === overlay) clearScrollAnchor();
      }, scrollInput);
      overlay.addEventListener('scroll', () => {
        if (scrollFrame || mode !== 'scroll') return;
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          if (mode === 'scroll' && !stopped) {
            firstVisible();
            syncControls();
          }
        });
      }, {passive:true, signal:controller.signal});
    }
    renderEnd();
    boundary.observe(endMarker);
    function dispose() {
      stopped = true;
      checkNativeBuffer?.();
      controller.abort();
      controls?.destroy();
      cancelAnimationFrame(scrollFrame);
      clearTimeout(progressTimer);
      imageObserver.disconnect();
      boundary.disconnect();
      for (const {url} of displayedImages.values()) URL.revokeObjectURL(url);
      if (sourceScroll && liveChapter) window.scrollTo(sourceScroll);
    }
    function refreshSource(chapter) {
      liveChapter = chapter.workId === first.workId && chapter.chapterId === first.chapterId ? chapter : null;
      if (liveChapter) {
        const section = groups[0];
        const subtitleChanged = section.chapter.chapterSubtitle !== liveChapter.chapterSubtitle;
        section.chapter.chapterSubtitle = liveChapter.chapterSubtitle;
        if (mergePages(section, liveChapter) || subtitleChanged) updateView();
      }
      checkNativeBuffer?.();
    }
    return {dispose, refreshSource};
  }

  function trackDockViewport(dock) {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    function update() {
      frame = 0;
      if (viewport.height > 0) {
        dock.style.setProperty('--dock-visible-bottom', (viewport.offsetTop + viewport.height) + 'px');
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule, {passive:true});
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    update();
  }

  function sourceReader() {
    const host = element('div');
    host.className = 'kg-source-tools';
    const root = readerRoot(host);
    const dock = element('div','', 'dock');
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', 'KomaGlide');
    const status = button('書庫', openShelf);
    status.className = 'dock-shelf';
    status.title = '開啟本站書庫';
    const count = element('span', '', 'dock-count');
    status.append(count);
    const errorNotice = element('p', '', 'dock-error');
    errorNotice.setAttribute('role', 'status');
    errorNotice.tabIndex = 0;
    const open = button('直向閱讀器', openReader);
    open.className = 'dock-reader';
    dock.append(open, status, errorNotice);
    root.append(dock);
    document.body.append(host);
    trackDockViewport(dock);
    let chapter, inlineHost, inlineFlow, dialog, overlayFlow;
    async function openReader() {
      if (dialog || !chapter) return;
      dialog = element('dialog');
      dialog.setAttribute('aria-label','直向閱讀器');
      const [view, parallelPreload] = await Promise.all([
        read(VIEW).catch(() => null),
        chapter.parallelPages ? read(PARALLEL_PRELOAD).catch(() => null) : null
      ]);
      root.append(dialog);
      dialog.showModal();
      const savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      dialog.addEventListener('close', () => {
        overlayFlow?.dispose();
        overlayFlow = null;
        dialog.remove();
        dialog = null;
        document.documentElement.style.overflow = savedOverflow;
        open.focus({preventScroll:true});
      }, {once:true});
      overlayFlow = createFlow(dialog, chapter, dialog, {...view, parallelPreload});
    }
    GM_registerMenuCommand('直向閱讀器', openReader);
    return {
      update(value) {
        const changed = chapter?.chapterId !== value.chapterId || chapter?.workId !== value.workId;
        chapter = value;
        overlayFlow?.refreshSource(value);
        if (!changed) return;
        inlineFlow?.dispose();
        inlineFlow = null;
        inlineHost?.remove();
        if (!value.nextPage && !value.nextChapter) return;
        const last = value.entries[value.entries.length-1].img;
        const anchor = last.closest('.webcomic-page,[data-comic-pages],#comic,.comic-pages,#comic-pages,#comicpage') ||
          last.closest('picture,a') || last;
        inlineHost = element('div');
        anchor.after(inlineHost);
        inlineFlow = createFlow(readerRoot(inlineHost), chapter, null);
      },
      show(text, error) {
        count.textContent = text;
        const detail = error || '';
        if (errorNotice.textContent !== detail) errorNotice.textContent = detail;
      }
    };
  }

  function runSource() {
    const saved = new Set();
    const failures = new Map();
    const queue = [];
    const pending = new Set();
    let active = false;
    let scanScheduled = false;
    let hasNativePager = false;
    let pageLabelSelector;
    let controls;
    let chapterKey;
    let chapterTotal;
    let statusRevision = 0;
    let statusTimer;
    GM_addValueChangeListener(AUTO, (_name, _old, value) => applyAuto(value));
    void read(AUTO).then(applyAuto);

    function show(text, error) { controls?.show(text, error); }

    function isCurrentChapter(page) {
      return page.chapterId === chapterKey[2] && (page.workId || '') === chapterKey[1];
    }

    function refreshStatus() {
      const revision = ++statusRevision;
      clearTimeout(statusTimer);
      if (active) return;
      const failure = [...failures.values()].find(item => isCurrentChapter(item.page));
      if (failure) {
        show('保存暫停', failure.error);
        return;
      }
      // One metadata read per burst, including writes by the reader or another tab.
      statusTimer = setTimeout(async () => {
        try {
          const count = await savedPageCount(chapterKey);
          if (revision !== statusRevision || active) return;
          const total = chapterTotal >= count && chapterTotal > 0 ? ' / 共 ' + chapterTotal + ' 頁' : '';
          show('已保存 ' + count + ' 頁' + total);
        } catch (error) {
          if (revision === statusRevision && !active) show('無法讀取保存頁數', error.message);
        }
      }, 60);
    }

    async function drain() {
      if (active || !queue.length) return;
      active = true;
      while (queue.length) {
        const {page, key} = queue.shift();
        if (isCurrentChapter(page)) show('正在保存第 ' + page.index + ' 頁');
        try {
          await saveLoaded(page);
          saved.add(key);
          failures.delete(key);
        } catch (err) {
          const attempts = (failures.get(key)?.attempts || 0) + 1;
          failures.set(key, {page, attempts, error: String(err.message), retryAt: Date.now() + 2500 * attempts});
          if (attempts < 3) setTimeout(schedule, 2600 * attempts);
          console.warn('[KomaGlide]', err.message);
        } finally { pending.delete(key); }
      }
      active = false;
      refreshStatus();
    }

    let pendingSubtitle;
    function rememberSubtitle(chapter, key, subtitle) {
      if (chapterSubtitles.get(chapter.chapterUrl) === subtitle) return;
      chapterSubtitles.set(chapter.chapterUrl, subtitle);
      void setChapterSubtitle(key, subtitle).then(changed => {
        if (changed) getShelfEvents().announce({kind:'subtitle'});
      }).catch(() => {});
    }
    function syncSubtitle(chapter) {
      if (!chapter.loadChapterSubtitle) return;
      if (chapter.chapterSubtitle !== undefined) {
        rememberSubtitle(chapter, chapterKey, chapter.chapterSubtitle);
      } else if (chapterSubtitles.has(chapter.chapterUrl)) {
        chapter.chapterSubtitle = chapterSubtitles.get(chapter.chapterUrl);
      } else if (pendingSubtitle?.url !== chapter.chapterUrl) {
        pendingSubtitle?.controller.abort();
        const controller = new AbortController();
        pendingSubtitle = {url:chapter.chapterUrl, controller};
        const key = chapterKey;
        void (async () => {
          // A cached chapter can show its subtitle even with the gallery offline.
          const storedSubtitle = await readChapterSubtitle(key).catch(() => undefined);
          const subtitle = storedSubtitle ?? await chapter.loadChapterSubtitle(controller.signal);
          if (controller.signal.aborted || subtitle === undefined) return;
          if (!chapterSubtitles.has(chapter.chapterUrl)) rememberSubtitle(chapter, key, subtitle);
          schedule();
        })().catch(() => {});
      }
    }

    function scan() {
      const chapter = detectChapter();
      if (!chapter) return;
      hasNativePager = Boolean(chapter.resolvePage);
      pageLabelSelector = chapter.pageLabelSelector;
      if (!controls) {
        controls = sourceReader();
        getShelfEvents().changes.addEventListener('change', ({detail}) => {
          // A write to another chapter can also evict the displayed chapter.
          if (detail.kind === 'saved' || detail.kind === 'limit') refreshStatus();
        });
      }
      if (!chapterKey || !isCurrentChapter(chapter) || chapterTotal !== chapter.total) {
        chapterKey = [location.origin, chapter.workId || '', chapter.chapterId];
        chapterTotal = chapter.total;
        refreshStatus();
      }
      syncSubtitle(chapter);
      controls.update(chapter);
      for (const entry of chapter.entries) {
        const {img, index} = entry;
        if (!img.complete || !img.naturalWidth || (img.naturalWidth <= 2 && img.naturalHeight <= 2)) continue;
        const page = pageFor(chapter, entry, true);
        if (!page) continue;
        const key = JSON.stringify([page.site, page.workId, page.chapterId, index]);
        const failure = failures.get(key);
        if (saved.has(key) || pending.has(key) || (failure && (failure.attempts >= 3 || Date.now() < failure.retryAt))) continue;
        queue.push({page, key});
        pending.add(key);
      }
      void drain();
    }
    function schedule() {
      if (scanScheduled) return;
      scanScheduled = true;
      setTimeout(() => {
        scanScheduled = false;
        scan();
      }, 120);
    }
    document.addEventListener('load', event => {
      if (!(event.target instanceof HTMLImageElement)) return;
      // Take a snapshot after the native load handler updates its page number
      // and before the next user action can replace the shared image node.
      if (hasNativePager) queueMicrotask(scan);
      else schedule();
    }, true);
    new MutationObserver(changes => {
      // Some readers finish labelling an already decoded image in a later DOM update.
      const selector = pageLabelSelector ? 'img,source,' + pageLabelSelector : 'img,source';
      if (changes.some(({target, addedNodes}) => target instanceof HTMLImageElement ||
        (pageLabelSelector && target.closest?.(pageLabelSelector)) ||
        [...addedNodes].some(node => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))))) schedule();
    }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['src','srcset']});
    window.addEventListener('popstate', schedule);
    window.addEventListener('hashchange', schedule);
    scan();
  }

  GM_registerMenuCommand('開啟 KomaGlide 書庫', openShelf);
  const start = location.hash.startsWith(SHELF_HASH) ? displayShelf : runSource;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, {once: true});
  } else {
    start();
  }
})();
