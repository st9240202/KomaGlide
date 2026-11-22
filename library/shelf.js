import { shelf, readChapter, readerBlob, setFavorite, setLimit } from './store.js';
import { makeReaderThumbnail, mountReaderControls, watchReaderTheme } from './reader-controls.js';

export function mountShelf(routePrefix, { announce, changes, messageFor }) {
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
