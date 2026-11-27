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

  async function readPage(url, signal) {
    const response = await fetch(url, {signal, mode: 'same-origin'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return new DOMParser().parseFromString(await response.text(), 'text/html');
  }

  function chapterText(doc) {
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

  return {
    title,
    async open(signal) {
      const catalog = chapterId ? await readPage(bookUrl.href, signal) : root;
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
      return {
        chapters: [...chapters.values()],
        workTitle,
        siteName: '小說狂人',
        initialChapter: chapterId,
        storageKey: PREFIX + 'novel.czbooks.' + workId,
        loadChapter: async (chapter, abortSignal) => chapterText(
          chapter.id === chapterId ? root : await readPage(chapter.url, abortSignal)
        ),
      };
    },
  };
}

function runCzbooksNovel() {
  const book = detectCzbooks(document, new URL(location.href));
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
    launch.disabled = true;
    launch.textContent = '載入章節目錄…';
    try {
      const source = await book.open(request.signal);
      const overlay = document.createElement('dialog');
      overlay.setAttribute('aria-label', 'KomaGlide 小說閱讀器');
      overlay.style.cssText = 'position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;border:0;padding:0;background:#fbfaf5;overflow:hidden';
      const frame = document.createElement('iframe');
      frame.title = 'KomaGlide 小說閱讀器';
      frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
      overlay.append(frame);
      document.body.append(overlay);
      const restoreViewport = fitReaderViewport();
      const close = () => {
        if (request.signal.aborted) return;
        request.abort();
        overlay.remove();
        void restoreViewport?.();
        active = null;
        launch.disabled = false;
        launch.focus({preventScroll:true});
      };
      overlay.addEventListener('close', close, {once:true});
      try {
        overlay.showModal();
        const shell = new DOMParser().parseFromString(/* INSERT_NOVEL_DOCUMENT */, 'text/html');
        const readerDocument = frame.contentDocument;
        readerDocument.documentElement.replaceWith(readerDocument.importNode(shell.documentElement, true));
        mountNovelReader(readerDocument, frame.contentWindow, {...source, close, signal:request.signal});
        frame.contentWindow.focus();
      } catch (error) {
        close();
        throw error;
      }
    } catch (error) {
      active = null;
      launch.disabled = false;
      console.warn('[KomaGlide]', error.message);
      launch.textContent = '載入失敗，重試小說閱讀器';
      return;
    }
    launch.textContent = 'KomaGlide 小說閱讀器';
  }
  launch.onclick = open;
  GM_registerMenuCommand(launch.textContent, open);
  return true;
}
