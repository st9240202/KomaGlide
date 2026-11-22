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
