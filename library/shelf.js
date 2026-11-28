import { locale, localeNames, localizeDocument, t } from './i18n.js';
import { shelf, readChapter, readExportChapters, readExportMetadata, readerBlob, setFavorite, setLimit, markComicChapterRead } from './store.js';
import { makeReaderThumbnail, mountReaderControls, watchReaderTheme, readerPreferencesKey, readReaderPreferences, writeReaderPreferences, readComicPosition, writeComicPosition } from './reader-controls.js';
import { makeComicZip, validateComicZip } from './comic-zip.js';

export function mountShelf(routePrefix, { announce, changes, messageFor, saveLanguage, openNovel, legacyView }) {
  localizeDocument();
  const $ = id => document.getElementById(id);
  const languagePicker = $('library-language');
  for (const [value, label] of Object.entries(localeNames)) {
    const option = new Option(label, value);
    option.lang = value;
    languagePicker.add(option);
  }
  languagePicker.value = locale;
  languagePicker.addEventListener('change', async () => {
    languagePicker.disabled = true;
    try {
      await saveLanguage(languagePicker.value);
      location.reload();
    } catch {
      languagePicker.value = locale;
      languagePicker.disabled = false;
      notify(t('languageSaveFailed'));
    }
  });
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    link.hash = routePrefix + link.hash.slice(1);
  }
  const collator = new Intl.Collator(locale, { numeric: true });
  let version = 0;
  let refreshTimer;
  let disposePages = () => {};
  let disposeNovel;
  let shelfHash = routePrefix + 'shelf';
  let pageAtViewport = () => 1;
  let activeKey;
  let retentionCheck = 0;
  let pendingRetentionRequest;
  const selectedChapters = new Set();
  let exportRows = [];
  let exportJob;
  let zipChapters;
  let zipClickedAt = 0;
  const MiB = 1024 ** 2;
  let libraryPreferences = readReaderPreferences(legacyView);
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
    writeReaderPreferences(next);
  }

  applyLibraryPreferences(libraryPreferences);
  themePicker.addEventListener('change', () => changePreference('theme', themePicker.value));
  window.addEventListener('storage', event => {
    if (event.key === readerPreferencesKey || event.key === null) applyLibraryPreferences(readReaderPreferences(legacyView));
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

  function storageProtectionMessage({state}, isRequest) {
    if (state === 'granted') return t('persistenceGranted');
    if (state === 'not-granted') return t(isRequest ? 'persistenceDenied' : 'persistenceNotGranted');
    if (state === 'unsupported') return t(isRequest ? 'persistenceRequestUnsupported' : 'persistenceCheckUnsupported');
    return t(isRequest ? 'persistenceRequestFailed' : 'persistenceCheckFailed');
  }

  function showStorageDiagnostic(element, result, isRequest, api) {
    element.textContent = storageProtectionMessage(result, isRequest);
    if (result.state === 'granted') return;
    const detail = result.state === 'not-granted' ? t('returnedFalse', {api}) : [api, result.detail].filter(Boolean).join(' · ');
    element.append(el('span', detail, 'notice-detail'));
  }

  async function checkStorageProtection() {
    const check = ++retentionCheck;
    const status = $('retention');
    status.textContent = t('checkingPersistence');
    const result = await readStorageProtection('persisted');
    if (check === retentionCheck) showStorageDiagnostic(status, result, false, 'navigator.storage.persisted()');
  }

  function requestStorageProtection() {
    if (pendingRetentionRequest) return pendingRetentionRequest;
    // Start during the click so browser policies that require a gesture can apply.
    const pending = pendingRetentionRequest = readStorageProtection('persist');
    const button = $('request-retention');
    const status = $('retention-result');
    button.disabled = true;
    status.textContent = t('requestingPersistence');
    void pending.then(result => {
      pendingRetentionRequest = null;
      showStorageDiagnostic(status, result, true, 'navigator.storage.persist()');
      button.disabled = false;
      if (!$('storage').hidden) void checkStorageProtection();
    });
    return pending;
  }

  function size(bytes) {
    if (bytes >= 1024 * MiB) return (bytes / (1024 * MiB)).toLocaleString(locale, { maximumFractionDigits: 2 }) + ' GiB';
    if (bytes >= MiB) return (bytes / MiB).toLocaleString(locale, { maximumFractionDigits: 1 }) + ' MiB';
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

  function shelfChapterLink(chapter, checkboxId) {
    const link = checkboxId ? el('label', chapter.chapterTitle, 'chapter-link') : chapterLink(chapter);
    if (checkboxId) link.htmlFor = checkboxId;
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
    if (chapter.kind === 'novel') return t('novelSaved');
    return t(chapter.total ? 'savedKnownTotal' : 'savedUnknownTotal', {count: chapter.count, total: chapter.total});
  }

  function favoriteButton(key, enabled, novel = false) {
    const label = key.length === 3
      ? t(novel ? (enabled ? 'favoritedNovelChapter' : 'favoriteNovelChapter') :
        (enabled ? 'favoritedChapter' : 'favoriteChapter'))
      : t(enabled ? 'favoritedWork' : 'favoriteWork');
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
        const notice = notify(enabled ? t('removedFavorite') : t('addedFavorite'), 'success');
        if (retention) {
          const detail = el('span', '', 'notice-detail');
          notice.append(detail);
          void retention.then(result => {
            if (result.state === 'granted') return;
            const link = el('a', t('storageDiagnostics'));
            link.href = routePrefix + 'storage';
            detail.append(storageProtectionMessage(result, true), ' ', link);
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

  function exportStatus(text = '', error = false) {
    const status = $('export-status');
    status.toggleAttribute('data-error', error);
    status.textContent = text;
    status.hidden = !text;
  }

  function clearPreparedZip() {
    exportJob?.abort();
    exportJob = undefined;
    zipChapters = undefined;
    const download = $('export-download');
    const url = download.getAttribute('href');
    if (url) {
      const delay = zipClickedAt ? 60_000 - (Date.now() - zipClickedAt) : 0;
      if (delay > 0) setTimeout(() => URL.revokeObjectURL(url), delay);
      else URL.revokeObjectURL(url);
      download.removeAttribute('href');
      download.removeAttribute('download');
    }
    download.hidden = true;
    $('export-prepare').hidden = false;
    zipClickedAt = 0;
    exportStatus();
  }

  function updateExportControls() {
    let pages = 0;
    for (const { checkbox, chapter } of exportRows) {
      checkbox.checked = selectedChapters.has(checkbox.id);
      checkbox.disabled = !!exportJob;
      if (checkbox.checked) pages += chapter.count;
    }
    const all = $('export-select-all');
    all.textContent = t(exportRows.length && selectedChapters.size === exportRows.length ? 'exportClear' : 'exportSelectAll');
    all.disabled = !!exportJob || !exportRows.length;
    $('export-prepare').disabled = !!exportJob || !selectedChapters.size;
    const summary = t('exportSelected', {count: selectedChapters.size.toLocaleString(locale), pages: pages.toLocaleString(locale)});
    if ($('export-selection').textContent !== summary) $('export-selection').textContent = summary;
  }

  function exportCheckbox(chapter, checkbox) {
    const target = el('label', null, 'export-check');
    target.append(checkbox);
    exportRows.push({ chapter, checkbox });
    checkbox.onchange = () => {
      clearPreparedZip();
      if (checkbox.checked) selectedChapters.add(checkbox.id);
      else selectedChapters.delete(checkbox.id);
      updateExportControls();
    };
    return target;
  }

  $('export-select-all').onclick = () => {
    clearPreparedZip();
    const clear = selectedChapters.size === exportRows.length;
    selectedChapters.clear();
    if (!clear) for (const { checkbox } of exportRows) selectedChapters.add(checkbox.id);
    updateExportControls();
  };
  $('export-download').onclick = () => { zipClickedAt = Date.now(); };
  const exportRevision = chapter => JSON.stringify([chapter.key, chapter.imageRevision, chapter.count]);
  function clearStaleZip(chapters) {
    if (chapters.some((chapter, i) => !chapter || exportRevision(chapter) !== zipChapters[i])) {
      clearPreparedZip();
      updateExportControls();
      exportStatus(t(chapters.every(Boolean) ? 'exportChapterChanged' : 'exportChapterMissing'), true);
      void render();
      return true;
    }
    return false;
  }
  $('export-prepare').onclick = async () => {
    if (exportJob || !selectedChapters.size) return;
    const prepare = $('export-prepare');
    const selected = exportRows.filter(({ checkbox }) => selectedChapters.has(checkbox.id)).map(({chapter}) => chapter);
    const keys = selected.map(chapter => chapter.key);
    clearPreparedZip();
    zipChapters = selected.map(exportRevision);
    const job = exportJob = new AbortController();
    const { signal } = job;
    updateExportControls();
    exportStatus(t('exportReading'));
    try {
      const chapters = await readExportChapters(keys, validateComicZip, signal);
      if (signal.aborted || clearStaleZip(chapters.map(({chapter}) => chapter))) return;
      const blob = await makeComicZip(chapters, { signal, progress: (done, total) => {
        if (!signal.aborted) exportStatus(t('exportPackaging', {done, total}));
      }});
      if (signal.aborted) return;
      const current = await readExportMetadata(keys);
      if (signal.aborted || clearStaleZip(current)) return;
      const download = $('export-download');
      const host = location.hostname.replace(/[^a-z0-9.-]/gi, '_');
      download.href = URL.createObjectURL(blob);
      download.download = 'KomaGlide-' + host + '-' + new Date().toISOString().slice(0, 10) + '.zip';
      download.hidden = false;
      if (document.activeElement === document.body || document.activeElement === prepare) download.focus({preventScroll: true});
      prepare.hidden = true;
      exportStatus(t('exportReady'));
    } catch (error) {
      if (signal.aborted) return;
      const known = ['exportChapterMissing', 'exportTooLarge'].map(key => t(key));
      exportStatus(known.includes(error?.message) ? error.message : t('exportFailed'), true);
    } finally {
      if (exportJob === job) {
        exportJob = undefined;
        updateExportControls();
      }
    }
  };

  function showBooks(data, starred, exporting, novels) {
    const protectedWorks = new Set(data.favorites.map(key => JSON.stringify(key)));
    const groups = new Map();
    for (const chapter of data.chapters) {
      if (exporting && chapter.kind === 'novel' || novels && chapter.kind !== 'novel') continue;
      const workKey = chapter.key.slice(0, 2);
      const workStar = chapter.workKnown && protectedWorks.has(JSON.stringify(workKey));
      if (starred && !workStar && !chapter.favorite) continue;
      const id = JSON.stringify(chapter.workKnown ? workKey : chapter.key);
      if (!groups.has(id)) groups.set(id, { chapters: [], workKey, workStar, recent: chapter });
      const group = groups.get(id);
      group.chapters.push(chapter);
      if (chapter.lastRead > group.recent.lastRead) group.recent = chapter;
    }
    exportRows = [];
    const frag = document.createDocumentFragment();
    for (const group of [...groups.values()].sort((a, b) => b.recent.lastRead - a.recent.lastRead)) {
      const { recent, workKey, workStar } = group;
      const article = el('article', null, 'work');
      const head = el('div', null, 'work-head');
      const names = el('div');
      const count = group.chapters.length;
      const novel = recent.kind === 'novel';
      const saved = novel ? t('novelChapterCount', {count}) : t(count === 1 ? 'chapterCountOne' : 'chapterCount', {count});
      names.append(el('h2', recent.workKnown ? recent.workTitle : t('ungrouped')),
        el('span', recent.key[0] + ' · ' + saved, 'source'));
      head.append(names);
      if (!exporting && recent.workKnown) head.append(favoriteButton(workKey, workStar));
      article.append(head);
      for (const chapter of group.chapters.sort(chaptersInOrder)) {
        const row = el('div', null, 'chapter-row');
        const action = exporting ? el('input') : favoriteButton(chapter.key, chapter.favorite, novel);
        if (exporting) {
          action.type = 'checkbox';
          action.id = 'kg-export-' + chapter.key.map(encodeURIComponent).join('/');
        }
        const link = shelfChapterLink(chapter, exporting ? action.id : null);
        link.id = 'title-' + action.id;
        action.setAttribute(exporting ? 'aria-labelledby' : 'aria-describedby', link.id);
        row.append(link, el('span', countText(chapter), 'count'), exporting ? exportCheckbox(chapter, action) : action);
        article.append(row);
      }
      frag.append(article);
    }
    if (!groups.size) {
      const empty = el('div', null, 'empty');
      empty.append(el('h2', starred ? t('noFavorites') : t(exporting ? 'noComics' : 'emptyLibrary')));
      if (!exporting) empty.append(el('p', t(starred ? 'favoritesHint' : 'emptyShelfHint')));
      frag.append(empty);
    }
    const books = $('books');
    const focusedId = books.contains(document.activeElement) && document.activeElement.id;
    books.replaceChildren(frag);
    if (exporting) {
      const visible = new Set(exportRows.map(({ checkbox }) => checkbox.id));
      const previousCount = selectedChapters.size;
      for (const id of selectedChapters) if (!visible.has(id)) selectedChapters.delete(id);
      if (selectedChapters.size !== previousCount) {
        clearPreparedZip();
        exportStatus(t('exportChapterMissing'), true);
      } else if (zipChapters) {
        const revisions = new Set(exportRows.filter(({checkbox}) => selectedChapters.has(checkbox.id))
          .map(({chapter}) => exportRevision(chapter)));
        if (zipChapters.some(revision => !revisions.has(revision))) {
          clearPreparedZip();
          exportStatus(t('exportChapterChanged'), true);
        }
      }
      updateExportControls();
    }
    if (focusedId) {
      const nextFocus = $(focusedId) || $(exporting ? 'export-tab' : starred ? 'star-tab' : 'all-tab');
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
    let scrollFrame;
    let lastReadAt = Date.now();
    const lifetime = new AbortController();
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
        if (!blob) throw new Error(t('pageRemoved'));
        const img = el('img');
        const url = URL.createObjectURL(blob);
        urls.set(slot, url);
        img.dataset.index = String(index);
        img.alt = t('pageNumber', {page: index});
        img.onload = () => {
          if (img.naturalWidth && img.naturalHeight) slot.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
        };
        img.onerror = () => {
          if (pending.get(slot) === token) slot.replaceChildren(el('p', t('decodeFailed', {page: index}), 'gap'));
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
      const missing = el('p', t('missingPages', {range}), 'gap');
      missing.dataset.first = first;
      missing.dataset.last = last;
      list.append(missing);
    }
    function figureAt(index) {
      const figure = el('figure');
      figure.dataset.first = index;
      const slot = el('div', null, 'page-slot');
      slot.dataset.index = String(index);
      figure.append(el('figcaption', t('pageNumber', {page: index})), slot);
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
    function recordPosition(page) {
      writeComicPosition(key, page);
      if (Date.now() - lastReadAt >= 5000) {
        lastReadAt = Date.now();
        void markComicChapterRead(key).catch(() => {});
      }
    }
    function recordScroll() {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
      if (preferences.mode !== 'scroll') return;
      const page = pageAtViewport();
      if (page === current) return;
      current = page;
      recordPosition(page);
      controls.update({ current });
    }
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
    function pick(page) {
      current = page;
      recordPosition(page);
      if (preferences.mode === 'scroll') {
        alignToPage();
        controls.update({ current });
      } else draw();
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
      onPick: pick, onTurn: pick,
    });
    updateReaderPreferences = applyPreferences;
    list.dir = preferences.mode === 'double' ? preferences.direction : 'ltr';
    document.documentElement.classList.add('reading-chapter');
    draw(initialPage > 1);
    window.addEventListener('scroll', () => {
      scrollFrame ||= requestAnimationFrame(recordScroll);
    }, {passive: true, signal: lifetime.signal});
    window.addEventListener('pagehide', () => { if (scrollFrame) recordScroll(); }, {signal: lifetime.signal});
    disposePages = () => {
      disposePages = () => {};
      if (scrollFrame) recordScroll();
      lifetime.abort();
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
    if (i > 0) links.push(chapterLink(related[i - 1], t('previousChapter') + ' · ' + related[i - 1].chapterTitle));
    if (i >= 0 && related[i + 1]) links.push(chapterLink(related[i + 1], t('nextChapter') + ' · ' + related[i + 1].chapterTitle));
    return links;
  }

  async function render(reset = false) {
    if (disposeNovel && !reset) return;
    const token = ++version;
    const hash = location.hash.slice(routePrefix.length);
    const reading = hash.startsWith('read/');
    const storage = hash === 'storage';
    const novels = hash === 'novels';
    const starred = hash === 'favorites';
    const exporting = hash === 'export';
    if (reset) {
      disposeNovel?.();
      notify();
      disposePages();
      disposeNovel = undefined;
      if (exporting !== !$('export-tools').hidden) $('books').replaceChildren();
      clearPreparedZip();
      selectedChapters.clear();
      exportRows = [];
      updateExportControls();
      activeKey = undefined;
      window.scrollTo(0, 0);
    }
    $('shelf').hidden = reading || storage;
    $('reader').hidden = !reading;
    $('storage').hidden = !storage;
    $('export-tools').hidden = !exporting;
    themePicker.parentElement.hidden = reading;
    if (reading && reset) {
      $('chapter-head').replaceChildren(el('h1', t('loadingChapter')));
      $('reader-end').replaceChildren();
    }
    try {
      if (reading) {
        const key = hash.slice(5).split('/').map(decodeURIComponent);
        if (key.length !== 3) throw new Error(t('invalidChapterUrl'));
        const result = await readChapter(key);
        if (version !== token) return;
        if (!result) throw new Error(t('chapterNotFound'));
        const { chapter, indices } = result;
        const data = await shelf();
        if (version !== token) return;
        if (chapter.kind === 'novel' && openNovel) {
          const related = data.chapters.filter(item => item.kind === 'novel' &&
            item.key[0] === key[0] && item.key[1] === key[1]).sort(chaptersInOrder);
          if (!related.some(item => item.key[2] === key[2])) throw new Error(t('chapterRemoved'));
          $('reader').hidden = true;
          disposeNovel = openNovel(chapter, related, () => { location.hash = shelfHash; });
          document.title = chapter.chapterTitle + ' · KomaGlide';
          return;
        }
        if (!indices) throw new Error(t('chapterNotFound'));
        const current = reset ? readComicPosition(key) || 1 : pageAtViewport();
        if (reset) void markComicChapterRead(key).catch(() => {});
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
      document.title = (storage ? t('storageSettings') : t(novels ? 'novelShelf' : 'library')) + ' · KomaGlide';
      if (storage) {
        $('storage-summary').textContent = t('storageUsage', {used: size(used), limit: size(limit)});
        if (reset) $('limit').value = String(limit / MiB);
        if (reset) void checkStorageProtection();
      } else {
        const novelTab = $('novel-tab');
        if (novelTab) {
          novelTab.hidden = novels;
          document.querySelector('.title-row h1').textContent = t(novels ? 'novelShelf' : 'siteLibrary');
        }
        if (!exporting) shelfHash = location.hash || routePrefix + 'shelf';
        $('usage').textContent = size(used) + ' / ' + size(limit);
        for (const [id, active] of [['all-tab', !starred && !exporting && !novels], ['star-tab', starred], ['export-tab', exporting]]) {
          if (active) $(id).setAttribute('aria-current', 'page');
          else $(id).removeAttribute('aria-current');
        }
        showBooks(data, starred, exporting, novels);
      }
    } catch (error) {
      if (version === token) {
        if (reading) {
          disposePages();
          activeKey = undefined;
          $('chapter-head').replaceChildren(el('h1', t('chapterOpenFailed')));
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
      const evicted = await setLimit(Number($('limit').value) * MiB);
      announce({ kind: 'limit', evicted });
      notify(t('storageLimitSaved'));
    } catch (error) {
      notify(messageFor(error));
    } finally {
      if (button) button.disabled = false;
    }
  };

  changes.addEventListener('change', ({ detail }) => {
    if (disposeNovel) return;
    if (detail.kind === 'error') {
      notify(detail.message);
      return;
    }
    if (location.hash.startsWith(routePrefix + 'read/')) {
      // Avoid losing the reading position when background transfers arrive.
      if (activeKey && detail.kind === 'saved' && activeKey[0] === detail.site &&
          activeKey[1] === detail.workId && activeKey[2] === detail.chapterId) {
        notify(t('newPagesSaved'));
        const refresh = el('button', t('refreshPages'));
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
