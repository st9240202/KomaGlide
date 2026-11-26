// The native pager reuses its main image. Scroll mode also appends captioned images.
const manhuaguiImages = new WeakMap();
const manhuaguiOrigins = new Set(['https://tw.manhuagui.com', 'https://m.manhuagui.com']);
const manhuaguiRoute = /^\/comic\/(\d+)\/(\d+)\.html$/;
const mobileManhuaguiConfig = new WeakMap();

function readMobileManhuaguiConfig(root, site) {
  if (mobileManhuaguiConfig.has(root)) return mobileManhuaguiConfig.get(root);
  // The mobile reader keeps its settings inside SMH.reader. Read the inline
  // argument as data. The site's dictionary decoder does not execute the packer.
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const script of root.querySelectorAll('script:not([src])')) {
    const source = script.textContent;
    if (source.length > 128_000 || !source.includes('function(p,a,c,k,e,d)')) continue;
    const packet = /\}\('([^']*)',(\d{1,2}),(\d{1,4}),'([^']*)'\[/.exec(source);
    if (!packet) continue;
    const [, packed, base, count, dictionary] = packet;
    const radix = Number(base);
    if (radix < 2 || radix > alphabet.length) continue;
    try {
      const unpacked = dictionary.includes('|') ? dictionary : site.LZString?.decompressFromBase64(dictionary);
      const words = unpacked?.split('|');
      if (words?.length !== Number(count)) continue;
      const data = packed.replace(/\b[0-9a-zA-Z]+\b/g, token => {
        let index = 0;
        for (const char of token) {
          const digit = alphabet.indexOf(char);
          if (digit >= radix) return token;
          index = index * radix + digit;
          if (index >= words.length) return token;
        }
        return words[index] || token;
      });
      const json = /^SMH\.reader\((\{[\s\S]*\})\)\.preInit\(\);?$/.exec(data)?.[1];
      if (!json) continue;
      const {bookId, chapterId, nextId} = JSON.parse(json);
      const config = {bookId, chapterId, nextId};
      mobileManhuaguiConfig.set(root, config);
      return config;
    } catch {
      // An unrecognized packet should not affect normal reading.
    }
  }
  return null;
}

function nextManhuaguiChapter(root, address, workId, chapterId, mobile) {
  const site = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const config = mobile ? readMobileManhuaguiConfig(root, site) : site.cInfo;
  const book = mobile ? config?.bookId : config?.bid;
  const chapter = mobile ? config?.chapterId : config?.cid;
  const next = Number(config?.nextId);
  if (String(book) !== workId || String(chapter) !== chapterId ||
      !Number.isSafeInteger(next) || next <= 0 || String(next) === chapterId) return null;
  const chapterUrl = new URL('/comic/' + workId + '/' + next + '.html', address).href;
  return {url:chapterUrl, chapterUrl};
}

function manhuaguiImageUrl(value, base) {
  const url = webUrl(value, base);
  return url && /^https:\/\/[a-z0-9-]+\.hamreus\.com$/i.test(url.origin) &&
    /\.(?:webp|jpe?g|png|gif|avif)$/i.test(url.pathname) ? url : null;
}

function manhuaguiLoadedEntry(img, index, address) {
  if (!img?.complete || img.naturalWidth <= 2 || img.naturalHeight <= 2) return null;
  const url = manhuaguiImageUrl(img.currentSrc, address);
  if (!url || url.href !== webUrl(img.getAttribute('src'), address)?.href) return null;
  return {index, img, imageUrl:url.href};
}

function manhuaguiCurrentEntry(box, img, index, address) {
  const entry = manhuaguiLoadedEntry(img, index, address);
  if (!entry) return null;
  const previous = manhuaguiImages.get(box);
  if (previous?.imageUrl === entry.imageUrl && previous.index !== index) return null;
  manhuaguiImages.set(box, entry);
  return entry;
}

function waitForManhuaguiPage(box, counter, index, signal, currentPage, selectPage) {
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
    observer.observe(box, {subtree:true, childList:true, attributes:true, attributeFilter:['src','srcset']});
    observer.observe(counter, {subtree:true, childList:true, characterData:true});
    box.addEventListener('load', check, true);
    signal.addEventListener('abort', cancel, {once:true});
    selectPage();
    check();
  });
}

function detectMobileManhuagui(root, address, workId, chapterId) {
  const heading = root.querySelector('#mangaTitle');
  const work = heading?.querySelector('a[href]');
  const workUrl = webUrl(work?.getAttribute('href'), address);
  const workTitle = work?.textContent.trim();
  const chapterTitle = heading?.textContent.trim().slice(workTitle?.length).trim();
  const counter = root.querySelector('.manga-page #pageNo');
  const box = root.querySelector('#manga');
  const total = Number(/^\s*\d+\s*\/\s*(\d+)\s*P\s*$/i.exec(counter?.parentElement.textContent || '')?.[1]);
  if (workUrl?.origin !== address.origin || workUrl.pathname !== '/comic/' + workId + '/' || !workTitle || !chapterTitle ||
      !box || !Number.isSafeInteger(total) || total < 1) return null;

  const hashPage = () => Number(new URLSearchParams(location.hash.slice(1)).get('p') || 1);
  function currentPage() {
    const index = Number(counter.textContent.trim());
    if (index !== hashPage() || !Number.isSafeInteger(index) || index < 1 || index > total) return null;
    return manhuaguiCurrentEntry(box, box.querySelector(':scope > img'), index, address);
  }
  function resolvePage(index, signal) {
    if (signal.aborted || !box.isConnected || !Number.isSafeInteger(index) ||
        index < 1 || index > total || location.pathname !== address.pathname) return null;
    return waitForManhuaguiPage(box, counter, index, signal, currentPage, () => {
      if (hashPage() === index) return;
      const oldURL = location.href;
      const url = new URL(oldURL);
      url.hash = 'p=' + index;
      // Let the site's own pager load that image without adding a history
      // entry for each page buffered by the reader.
      history.replaceState(history.state, '', url.href);
      window.dispatchEvent(new HashChangeEvent('hashchange', {oldURL, newURL:url.href}));
    });
  }

  const entry = currentPage();
  const start = hashPage();
  return {workId, workTitle, chapterId, chapterTitle, chapterUrl:address.origin + address.pathname,
    total, entries:entry ? [entry] : [], startIndex:Number.isSafeInteger(start) && start >= 1 && start <= total ? start : 1,
    pageLabelSelector:'#pageNo', resolvePage, nextPage:null, nextChapter:null,
    nextChapterNavigation:nextManhuaguiChapter(root, address, workId, chapterId, true)};
}

siteAdapters.push(function detectManhuagui(root, address) {
  const route = manhuaguiRoute.exec(address.pathname);
  if (!manhuaguiOrigins.has(address.origin) || !route || root !== document) return null;
  const [, workId, chapterId] = route;
  if (address.hostname === 'm.manhuagui.com') return detectMobileManhuagui(root, address, workId, chapterId);
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

  function currentPage() {
    const index = Number(counter.textContent.trim());
    if (!Number.isInteger(index) || index < 1 || index > total || select.value !== String(index)) return null;
    return manhuaguiCurrentEntry(box, box.querySelector('img#mangaFile'), index, address);
  }

  function resolvePage(index, signal) {
    if (signal.aborted || !select.isConnected || !select.options[index - 1] || location.pathname !== address.pathname) return null;
    return waitForManhuaguiPage(box, counter, index, signal, currentPage, () => {
      select.value = String(index);
      select.dispatchEvent(new Event('change', {bubbles: true}));
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
    const entry = manhuaguiLoadedEntry(img, index, address);
    if (entry) entries.set(index, entry);
  }
  return {workId, workTitle, chapterId, chapterTitle, chapterUrl: address.origin + address.pathname,
    total, entries: [...entries.values()], pageLabelSelector, resolvePage, nextPage: null, nextChapter: null,
    nextChapterNavigation:nextManhuaguiChapter(root, address, workId, chapterId, false)};
});
