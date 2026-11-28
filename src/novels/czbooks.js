const CZBOOKS_SITE = '小說狂人';
const czbooksNovelStorageKey = workId => PREFIX + 'novel.czbooks.' + workId;
let disposeSourceNovel;

async function readCzbooksPage(url, signal) {
  const response = await fetch(url, {signal, mode: 'same-origin'});
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return new DOMParser().parseFromString(await response.text(), 'text/html');
}

function czbooksParagraphs(doc) {
  const body = doc.querySelector('.chapter-detail .content');
  if (!body) throw new Error('找不到小說正文');
  const clean = body.cloneNode(true);
  clean.querySelectorAll('script,style,iframe,ins,noscript,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
  for (const br of clean.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of clean.querySelectorAll('p,div')) block.after('\n');
  const paragraphs = clean.textContent.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const chapterTitle = doc.querySelector('.chapter-detail h1.name')?.textContent.trim()
    .replace(/^《[^》]+》\s*(?:\d+\.\s*)?/, '');
  if (chapterTitle && paragraphs[0] === chapterTitle) paragraphs.shift();
  if (/^[（(]本章完[）)]$/.test(paragraphs.at(-1))) paragraphs.pop();
  if (!paragraphs.length) throw new Error('小說正文是空的');
  return paragraphs;
}

function czbooksCatalog(catalog, bookUrl, workId, chapterId) {
  const chapters = new Map();
  for (const link of catalog.querySelectorAll('#chapter-list a[href]')) {
    const url = webUrl(link.getAttribute('href'), bookUrl);
    if (url?.origin !== bookUrl.origin) continue;
    const parts = url.pathname.split('/');
    const id = parts[3];
    const name = link.textContent.trim().replace(/^\d+\.\s*/, '');
    if (parts.length !== 4 || parts[1] !== 'n' || parts[2] !== workId ||
        !/^[a-z0-9]+$/i.test(id) || !name || chapters.has(id)) continue;
    url.hash = '';
    chapters.set(id, {id, title: name, url: url.href});
  }
  if (!chapters.size || (chapterId && !chapters.has(chapterId))) throw new Error('找不到章節目錄');
  const ordered = [...chapters.values()];
  ordered.forEach((chapter, index) => { chapter.order = index + 1; });
  return ordered;
}

function czbooksLoader(workId, workTitle, chapterId, root) {
  return async (chapter, abortSignal) => {
    const key = [CZBOOKS_SITE, workId, chapter.id];
    if (chapter.id !== chapterId) {
      const cached = await readNovelChapter(key).catch(() => null);
      abortSignal.throwIfAborted();
      if (cached) return cached;
    }
    if (!navigator.onLine && chapter.id !== chapterId) throw new Error('離線時無法下載本章。');
    const paragraphs = czbooksParagraphs(chapter.id === chapterId ? root : await readCzbooksPage(chapter.url, abortSignal));
    abortSignal.throwIfAborted();
    try {
      await putNovelChapter({
        site: CZBOOKS_SITE, workId, chapterId: chapter.id, workTitle,
        chapterTitle: chapter.title, order: chapter.order
      }, paragraphs);
    } catch (error) {
      chapter.cacheFailed = true;
      console.warn('[KomaGlide]', error.message);
      return paragraphs;
    }
    getShelfEvents().announce({kind: 'novel-saved'});
    void rememberSite();
    return paragraphs;
  };
}

function detectCzbooks(root, address) {
  if (address.hostname !== 'czbooks.net') return null;
  const route = /^\/n\/([a-z0-9]+)(?:\/([a-z0-9]+))?\/?$/i.exec(address.pathname);
  if (!route) return null;
  const [, workId, chapterId] = route;
  const title = root.querySelector(chapterId ? '.chapter-detail h1.name' : '.novel-detail h1.title');
  if (!title || (chapterId && !root.querySelector('.chapter-detail .content'))) return null;

  const bookUrl = new URL('/n/' + workId, address);
  const wrappedTitle = /^《([^》]+)》/.exec(title.textContent.trim());
  const workTitle = wrappedTitle?.[1] || title.textContent.trim().replace(/\s*《目錄》$/, '');

  return {
    title,
    async open(signal) {
      const catalog = chapterId ? await readCzbooksPage(bookUrl.href, signal) : root;
      const chapters = czbooksCatalog(catalog, bookUrl, workId, chapterId);
      await saveNovelCatalog(workId, chapters).catch(() => {});
      void write(PREFIX + 'novel-shelf-entry', bookUrl.href).catch(() => {});
      return {
        chapters, workTitle, siteName: CZBOOKS_SITE, initialChapter: chapterId,
        storageKey: czbooksNovelStorageKey(workId), cacheFailure: t('novelCacheFailed'),
        loadChapter: czbooksLoader(workId, workTitle, chapterId, root),
      };
    },
  };
}

function showNovelReader(source, request, onClose) {
  const shell = new DOMParser().parseFromString(/* INSERT_NOVEL_DOCUMENT */, 'text/html');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    const original = document.documentElement;
    const scroll = [window.scrollX, window.scrollY];
    const root = document.importNode(shell.documentElement, true);
    root.setAttribute('data-komaglide-started', '');
    original.replaceWith(root);
    function dispose() {
      if (request.signal.aborted) return;
      request.abort();
      root.replaceWith(original);
      window.scrollTo(...scroll);
    }
    try {
      mountNovelReader(document, window, {...source, nativeScroll: true, signal: request.signal,
        close() { dispose(); onClose(); }});
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }
  const overlay = document.createElement('dialog');
  overlay.setAttribute('aria-label', 'KomaGlide 小說閱讀器');
  overlay.style.cssText = 'position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;border:0;padding:0;background:#fbfaf5;overflow:hidden';
  const frame = document.createElement('iframe');
  frame.title = 'KomaGlide 小說閱讀器';
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
  overlay.append(frame);
  document.body.append(overlay);
  const restoreViewport = fitReaderViewport();
  function dispose() {
    if (request.signal.aborted) return;
    request.abort();
    overlay.remove();
    void restoreViewport?.();
  }
  function close() {
    if (request.signal.aborted) return;
    dispose();
    onClose();
  }
  overlay.addEventListener('close', close, {once:true});
  try {
    overlay.showModal();
    const readerDocument = frame.contentDocument;
    readerDocument.documentElement.replaceWith(readerDocument.importNode(shell.documentElement, true));
    mountNovelReader(readerDocument, frame.contentWindow, {...source, close, signal:request.signal});
    frame.contentWindow.focus();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

function openShelfNovel(chapter, related, close) {
  const [site, workId, initialChapter] = chapter.key;
  return showNovelReader({
    chapters: related.map(item => ({id: item.key[2], title: item.chapterTitle, order: item.order,
      url: new URL('/n/' + encodeURIComponent(workId) + '/' + encodeURIComponent(item.key[2]), location.origin).href})),
    workTitle: chapter.workTitle,
    siteName: site,
    initialChapter,
    storageKey: czbooksNovelStorageKey(workId),
    closeLabel: t('backToLibrary'),
    cacheFailure: t('novelCacheFailed'),
    loadChapter: czbooksLoader(workId, chapter.workTitle),
    async refreshCatalog(signal, update) {
      const saved = await readNovelCatalog(workId).catch(() => null);
      if (signal.aborted) return;
      if (saved?.length) update(saved);
      if (!navigator.onLine) return;
      const bookUrl = new URL('/n/' + encodeURIComponent(workId), location.origin);
      const page = await readCzbooksPage(bookUrl.href, signal);
      const fresh = czbooksCatalog(page, bookUrl, workId);
      signal.throwIfAborted();
      update(fresh);
      await saveNovelCatalog(workId, fresh);
    },
  }, new AbortController(), close);
}

function runCzbooksNovel() {
  const book = detectCzbooks(document.documentElement, new URL(location.href));
  if (!book) return false;
  const launch = document.createElement('button');
  launch.type = 'button';
  launch.textContent = 'KomaGlide 小說閱讀器';
  launch.style.cssText = 'margin:8px 0 14px;padding:8px 14px;border:1px solid #305c46;border-radius:5px;color:#fff;background:#305c46;font:600 14px system-ui;cursor:pointer';
  book.title.after(launch);
  let active;
  async function open() {
    if (active) return;
    const request = new AbortController();
    active = request;
    disposeSourceNovel = () => request.abort();
    launch.disabled = true;
    launch.textContent = '載入章節目錄…';
    try {
      const source = await book.open(request.signal);
      if (request.signal.aborted) return;
      disposeSourceNovel = showNovelReader(source, request, () => {
        disposeSourceNovel = undefined;
        active = null;
        launch.disabled = false;
        launch.focus({preventScroll:true});
      });
    } catch (error) {
      disposeSourceNovel = undefined;
      active = null;
      launch.disabled = false;
      console.warn('[KomaGlide]', error.message);
      launch.textContent = '載入失敗，重試小說閱讀器';
      return;
    }
    launch.textContent = 'KomaGlide 小說閱讀器';
  }
  launch.onclick = open;
  registerMenu(launch.textContent, open);
  return true;
}
