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

  /* INSERT_I18N */
  /* INSERT_SITE_STORE */
  /* INSERT_SHELF_EVENTS */
  /* INSERT_COMIC_ZIP */
  /* INSERT_SHELF_VIEW */

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
    const shell = new DOMParser().parseFromString(/* INSERT_SHELF_DOCUMENT */, 'text/html');
    document.open();
    document.close();
    const root = document.importNode(shell.documentElement, true);
    if (document.documentElement) document.documentElement.replaceWith(root);
    else document.appendChild(root);
    mountShelf(SHELF_HASH, {
      ...getShelfEvents(),
      saveLanguage: value => write(languageKey, value),
    });
    document.getElementById('offline-state').textContent = location.host;
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
  /* INSERT_SITE_ADAPTERS */

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
    if (!MIME.test(mime)) throw new Error(t('unsupportedImage'));
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
      const fail = () => reject(new Error(t('imageReadFailed')));
      const xhr = GM_xmlhttpRequest({url: url.href, method: 'GET', responseType: 'blob',
        anonymous: true, timeout: 30_000, redirect: 'error',
        ...(readerOrigin ? {headers: {Referer: readerOrigin + '/'}} : {}),
        onprogress(event) { if (event.loaded > IMAGE_LIMIT) { xhr.abort(); fail(); } },
        onload(response) {
          try {
            const blob = response.response;
            if (response.status !== 200) return reject(new Error(t('imageHttpStatus', {status: response.status})));
            if (readerOrigin && /^cache-control:[^\r\n]*\bno-store\b/im.test(response.responseHeaders || '')) {
              return reject(new Error(t('onlineOnly')));
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
    if (location.origin === nhOrigin && nhRoute.exec(location.pathname)?.[1] === page.chapterId &&
        nhImageUrl(url, location, page.index)) return fetchPublicImage(url, nhOrigin);
    if (manhuaguiOrigins.has(location.origin) &&
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
    if (!response.ok) throw new Error(t('imageHttpFailed', {status: response.status}));
    const mime = checkedMime(response.headers.get('content-type'));
    const stream = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await stream.read();
        if (done) break;
        size += value.length;
        if (size > IMAGE_LIMIT) { await stream.cancel(); throw new Error(t('imageTooLarge')); }
        parts.push(value);
      }
    } finally { stream.releaseLock(); }
    if (!size) throw new Error(t('blankImage'));
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

  /* INSERT_READER_CONTROLS */

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
    .dock button {min-width:44px;min-height:44px;margin:0;padding:4px clamp(6px, 2.5vw, 12px);border:0;border-radius:0;font:inherit;color:var(--ink)}
    .dock button:focus-visible {outline-offset:-3px}
    .dock .dock-reader {border-radius:7px 0 0 7px;background:var(--surface);color:var(--accent);font-weight:700}
    .dock .dock-reader:hover {background:var(--hover)}
    .dock .dock-preload {border-left:1px solid var(--line)}
    .dock .dock-shelf {border-left:1px solid var(--line);border-radius:0 7px 7px 0;text-align:start;font-weight:600}
    @media (min-width:20rem) {
      .dock .dock-reader, .dock .dock-preload {flex-shrink:0;white-space:nowrap}
    }
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
    @media (pointer:coarse) {
      dialog:not(.paged) .pages figure img {width:100%}
    }
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
    /* INSERT_READER_NAV_CSS */
  `;
  function readerRoot(host) {
    host.lang = locale;
    const root = host.attachShadow({mode: 'open'});
    root.append(element('style', readerCSS));
    return root;
  }

  async function fetchDocument(address, signal) {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(address, {mode:'same-origin', credentials:'same-origin',
      signal:signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!response.ok) {
      throw Object.assign(new Error(t('nextPageNotHtml')), {
        status:response.status, retryAfter:response.headers.get('Retry-After')
      });
    }
    if (!/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error(t('nextPageNotHtml'));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '', size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error(t('chapterHtmlTooLarge')); }
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

  async function fetchChapter(address, signal) {
    const parsed = await fetchDocument(address, signal);
    const chapter = detectChapter(parsed.root, parsed.address);
    if (!chapter) throw new Error(t('nextChapterUnrecognized'));
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
    label.append(input, document.createTextNode(t('autoContinue')));
    return label;
  }

  const VIEW = PREFIX + 'reader-view';
  const PARALLEL_PRELOAD = PREFIX + 'parallel-preload';
  const SITE_PARALLEL_PRELOAD = PARALLEL_PRELOAD + '.' + location.origin;
  const PARALLEL_PRELOAD_CHOICES = [1, 2, 3, 4, 5, 6];
  const DEFAULT_PARALLEL_PRELOAD = 3;
  const READ_AHEAD_PAGES = 3;
  const BUFFER_IDLE_MS = 1200;
  async function readParallelPreload(chapter) {
    if (!chapter.parallelPages) return null;
    const [site, legacy] = await Promise.all([
      read(SITE_PARALLEL_PRELOAD).catch(() => null), read(PARALLEL_PRELOAD).catch(() => null)
    ]);
    return site ?? legacy;
  }
  function createFlow(root, first, overlay, view = {}) {
    const {onPreloadFinished} = view;
    const preload = Boolean(onPreloadFinished);
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
    const defaultParallelPreload = PARALLEL_PRELOAD_CHOICES.includes(first.defaultParallelPreload)
      ? first.defaultParallelPreload : DEFAULT_PARALLEL_PRELOAD;
    const savedParallelPreload = PARALLEL_PRELOAD_CHOICES.includes(view.parallelPreload) ? view.parallelPreload : null;
    let parallelPreload = savedParallelPreload ?? defaultParallelPreload;
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
    const imageObserver = preload ? null : new IntersectionObserver(changes => {
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
      caption.append(button(t('retry'), () => {
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
      if ((!overlay && !preload) || !liveChapter?.revealPage || groups[0].figures.get(index) !== figure) return false;
      const before = {left:window.scrollX, top:window.scrollY, behavior:'instant'};
      if (!liveChapter.revealPage(index)) return false;
      if (window.scrollX !== before.left || window.scrollY !== before.top) sourceScroll ??= before;
      return true;
    }
    async function resolveFigure(figure, showNotice) {
      const page = entries.get(figure);
      const source = liveChapter;
      if (page.imageUrl || (!overlay && !preload) || !source?.resolvePage || groups[0].figures.get(page.index) !== figure) return page;
      const notice = showNotice && element('figcaption', t('waitingForPage', {page: page.index}));
      if (notice) figure.append(notice);
      try {
        const entry = await source.resolvePage(page.index, controller.signal);
        if (stopped || !liveChapter) return page;
        const resolved = entry?.index === page.index && entry.imageUrl && pageFor(source, entry);
        if (!resolved?.imageUrl) throw new Error(t('sitePageFailed', {page: page.index}));
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
          reject(new Error(t('siteImageTimeout')));
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
        bufferProgress.textContent = t(failed ? 'bufferProgressMissing' : 'bufferProgress', {count, total: section.total});
      } catch {
        if (!stopped && group === section) bufferProgress.textContent = t('bufferProgressFailed');
      }
    }
    function scheduleBufferProgress() {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(updateBufferProgress, 80);
    }
    async function bufferNextPage() {
      if (stopped || (!preload && document.hidden)) return false;
      if (performance.now() < bufferReadyAt) return true;
      const full = preload || bufferMode === 'chapter';
      const end = preload ? 0 : lastVisiblePage();
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
      const stillWanted = () => !stopped && (preload || !document.hidden) && revision === bufferRevision;
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
          if (!resolved.imageUrl) throw new Error(t('imageNotAvailable'));
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
          if (!preload) showBufferErrors();
        }
      }
    }
    function bufferFailure(missing) {
      const [figure, reason] = missing[0];
      return t('bufferMissing', {count: missing.length, page: figure.dataset.index, reason});
    }
    function showBufferErrors() {
      const missing = [...failedBuffers].filter(([figure]) => group.figures.get(Number(figure.dataset.index)) === figure);
      bufferError.hidden = !missing.length;
      if (missing.length) {
        bufferError.replaceChildren(bufferFailure(missing) + ' ',
          button(t('retryPages'), () => {
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
      if ((!overlay && !preload) || stopped || (!preload && document.hidden) || bufferScheduled) return;
      bufferScheduled = true;
      // Start behind queued visible work. Native pagers keep using the same
      // serial queue because selecting a new page replaces the current image.
      setTimeout(() => {
        const task = imageTasks.then(bufferNextPage);
        // Independent requests don't block a turn to a page outside their batch.
        const finished = task.catch(error => {
          console.warn('[KomaGlide]', error);
          if (preload) message.textContent = error.message;
          return false;
        });
        if (!(group === groups[0] && liveChapter?.parallelPages)) imageTasks = finished;
        void finished.then(more => {
          bufferScheduled = false;
          if (more) scheduleBuffer();
          else if (preload && !stopped) {
            onPreloadFinished(message.textContent || (failedBuffers.size ? bufferFailure([...failedBuffers]) : ''));
          }
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
      img.alt = t('pageNumber', {page: page.index});
      img.dataset.index = String(page.index);
      let blob = cached.blob;
      if (!blob) {
        page = await resolveFigure(figure, true);
        if (obsolete()) return;
        if (!page.imageUrl) {
          waitingForSource.add(figure);
          if (revealNativePage(figure, page.index)) {
            showPageRetry(figure, t('waitingForPage', {page: page.index}));
          } else {
            figure.append(element('figcaption', t('pageNotSavedOnSite', {page: page.index})));
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
          figure.append(element('figcaption', t('onlineDisplay', {reason: err.message})));
          img.src = page.imageUrl;
        }
      }
      if (obsolete()) return;
      if (blob) {
        img.src = URL.createObjectURL(blob);
        displayedImages.set(figure, {url:img.src, blob});
      }
      img.addEventListener('load', () => { figure.style.minHeight = ''; });
      img.addEventListener('error', () => figure.append(element('figcaption',t('imageDisplayFailed'))));
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
      imageObserver?.observe(figure);
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
      if ((overlay || preload) && (chapter.resolvePage || (preload && chapter.revealPage))) {
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
            imageObserver?.unobserve(existing);
            imageObserver?.observe(existing);
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
      if (preload) return;
      const next = target();
      const paged = overlay && mode !== 'scroll';
      const atEnd = !paged || visibleEnd() === group.total;
      const loadedNext = paged && groups.indexOf(group) < groups.length - 1;
      previousGroup.hidden = !paged || groups.indexOf(group) < 1 || position > (mode === 'double' ? 2 : 1);
      nextButton.textContent = loadedNext ? t('nextChapter') : next?.same ? t('continuePage') : t('continueChapter');
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
      message.textContent = t('connecting');
      renderEnd();
      try {
        let chapter = await fetchChapter(next.url, controller.signal);
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
        if (!preload) {
          boundary.unobserve(endMarker);
          boundary.observe(endMarker);
        }
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
    const previousGroup = button(t('previousChapter'), () => {
      group = groups[groups.indexOf(group) - 1];
      position = group.total;
      updateView();
    });
    chapterActions.append(message, previousGroup, nextButton);
    if (!overlay && !preload) chapterActions.append(toggleControl(controller.signal));
    root.append(pane, endMarker);
    if (preload) {
      addPages(first, false);
      scheduleBuffer();
    }
    if (overlay) {
      addPages(first, false);
      const settingsExtras = [
        chapterTitle, chapterSubtitle, bufferError, toggleControl(controller.signal),
        button(t('library'), openShelf), button(t('closeReader'), () => overlay.close())
      ];
      overlay.append(...settingsExtras, chapterActions, bufferProgress);
      getShelfEvents().changes.addEventListener('change', ({detail}) => {
        if (detail.kind === 'limit' || (detail.kind === 'saved' && detail.workId === group.chapter.workId &&
            detail.chapterId === group.chapter.chapterId)) scheduleBufferProgress();
      }, {signal:controller.signal});
      controls = mountReaderControls(overlay, {
        mode, theme, direction, tapToTurn, thumbnailSize, keyTarget:overlay, themeTarget:overlay, tapTarget:pane, onMode:changeMode,
        settingsExtras, navigationExtras:[chapterActions], bufferMode,
        parallelPreload: first.parallelPages ? {
          value: savedParallelPreload ?? 'default',
          defaultValue: defaultParallelPreload,
          choices: PARALLEL_PRELOAD_CHOICES,
          onChange(value) {
            const choice = value === 'default' ? value : Number(value);
            parallelPreload = choice === 'default' ? defaultParallelPreload : choice;
            // Let in-flight requests finish. The next batch uses the new limit.
            void write(SITE_PARALLEL_PRELOAD, choice);
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
    if (!preload) boundary.observe(endMarker);
    function dispose() {
      stopped = true;
      checkNativeBuffer?.();
      controller.abort();
      controls?.destroy();
      cancelAnimationFrame(scrollFrame);
      clearTimeout(progressTimer);
      imageObserver?.disconnect();
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

  function fitReaderViewport() {
    const viewport = window.visualViewport;
    if (!viewport || !matchMedia('(pointer: coarse)').matches) return;
    const width = document.documentElement.clientWidth;
    const scale = viewport.scale;
    const deviceWidth = viewport.width * scale;
    if (width <= deviceWidth + 1) return;

    // A desktop-width page can leave the mobile browser zoomed out even when
    // the dialog fills the layout viewport. Use the device width while it is open.
    const content = 'width=device-width, initial-scale=1';
    const original = [...document.head.querySelectorAll('meta[name="viewport" i]')]
      .map(meta => [meta, meta.getAttribute('content')]);
    const added = original.length ? null : element('meta');
    if (added) {
      added.name = 'viewport';
      added.content = content;
      document.head.append(added);
    }
    for (const [meta] of original) meta.content = content;
    return async () => {
      const owned = (added ? [[added, null]] : original).filter(([meta]) => meta.content === content);
      if (!owned.length) return;
      const afterLayout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Chromium can retain both the last viewport width and zoom after
      // removing a viewport tag. Apply the original values before removing it.
      const restoredScale = scale * (viewport.width * viewport.scale / deviceWidth);
      const previousView = 'width=' + width + ', initial-scale=' + restoredScale;
      for (const [meta] of owned) meta.content = previousView;
      await afterLayout();
      for (const [meta, previous] of owned) {
        if (meta.content !== previousView) continue;
        if (meta === added) meta.content = '';
        else if (previous === null) meta.removeAttribute('content');
        else meta.content = previous;
      }
      if (added?.content === '') {
        await afterLayout();
        if (added.content === '') added.remove();
      }
    };
  }

  function sourceReader() {
    const host = element('div');
    host.className = 'kg-source-tools';
    const root = readerRoot(host);
    const dock = element('div','', 'dock');
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', 'KomaGlide');
    const status = button(t('library'), openShelf);
    status.className = 'dock-shelf';
    status.title = t('openSiteLibrary');
    const count = element('span', '', 'dock-count');
    status.append(count);
    const errorNotice = element('p', '', 'dock-error');
    errorNotice.setAttribute('role', 'status');
    errorNotice.tabIndex = 0;
    const open = button(t('verticalReader'), openReader);
    open.className = 'dock-reader';
    const preloadButton = button(t('startPreload'), startPreload);
    preloadButton.className = 'dock-preload';
    dock.append(open, preloadButton, status, errorNotice);
    root.append(dock);
    document.body.append(host);
    trackDockViewport(dock);
    let chapter, inlineHost, inlineFlow, dialog, overlayFlow;
    let preloadJob, preloadError = '', captureError = '';

    function updatePreloadStatus() {
      preloadButton.disabled = Boolean(preloadJob);
      const label = t(preloadJob ? 'preloading' : preloadError ? 'retryPages' : 'startPreload');
      if (preloadButton.textContent !== label) preloadButton.textContent = label;
      const detail = preloadError || captureError;
      if (errorNotice.textContent !== detail) errorNotice.textContent = detail;
    }
    function stopPreload() {
      preloadJob?.flow?.dispose();
      preloadJob = null;
      updatePreloadStatus();
    }
    async function startPreload() {
      if (preloadJob || dialog || !chapter) return;
      const job = {};
      preloadJob = job;
      preloadError = '';
      updatePreloadStatus();
      const parallelPreload = await readParallelPreload(chapter);
      if (preloadJob !== job) return;
      job.flow = createFlow(element('div'), chapter, null, {
        parallelPreload,
        onPreloadFinished(error) {
          preloadError = error;
          stopPreload();
        }
      });
    }
    async function openReader() {
      if (dialog || !chapter) return;
      const resumePreload = preloadJob && chapter.chapterUrl;
      stopPreload();
      dialog = element('dialog');
      dialog.setAttribute('aria-label',t('verticalReader'));
      const [view, parallelPreload] = await Promise.all([read(VIEW).catch(() => null), readParallelPreload(chapter)]);
      const restoreViewport = fitReaderViewport();
      root.append(dialog);
      dialog.showModal();
      const savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      dialog.addEventListener('close', async () => {
        overlayFlow?.dispose();
        overlayFlow = null;
        dialog.remove();
        document.documentElement.style.overflow = savedOverflow;
        if (restoreViewport) await restoreViewport();
        dialog = null;
        open.focus({preventScroll:true});
        if (resumePreload && resumePreload === chapter.chapterUrl) void startPreload();
      }, {once:true});
      overlayFlow = createFlow(dialog, chapter, dialog, {...view, parallelPreload});
    }
    GM_registerMenuCommand(t('verticalReader'), openReader);
    return {
      update(value) {
        const changed = chapter?.chapterId !== value.chapterId || chapter?.workId !== value.workId;
        chapter = value;
        overlayFlow?.refreshSource(value);
        preloadJob?.flow?.refreshSource(value);
        if (!changed) return;
        preloadError = captureError = '';
        stopPreload();
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
        captureError = error || '';
        updatePreloadStatus();
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
        show(t('savingPaused'), failure.error);
        return;
      }
      // One metadata read per burst, including writes by the reader or another tab.
      statusTimer = setTimeout(async () => {
        try {
          const count = await savedPageCount(chapterKey);
          if (revision !== statusRevision || active) return;
          const key = chapterTotal >= count && chapterTotal > 0 ? 'savedPagesOfTotal' : 'savedPages';
          show(t(key, {count, total: chapterTotal}));
        } catch (error) {
          if (revision === statusRevision && !active) show(t('savedCountFailed'), error.message);
        }
      }, 60);
    }

    async function drain() {
      if (active || !queue.length) return;
      active = true;
      while (queue.length) {
        const {page, key} = queue.shift();
        if (isCurrentChapter(page)) show(t('savingPage', {page: page.index}));
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

  const language = read(languageKey).catch(() => null);
  async function start() {
    setLocale(await language);
    GM_registerMenuCommand(t('openKomaGlideLibrary'), openShelf);
    if (location.hash.startsWith(SHELF_HASH)) displayShelf();
    else runSource();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, {once: true});
  } else {
    void start();
  }
})();
