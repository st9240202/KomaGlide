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
        !ehReadGallery(parsed.root, parsed.address, id, directory)) throw new Error(t('galleryFailed'));
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
    entries:data.entry ? [data.entry] : [], total:data.total, startIndex:data.index, pageSelected:Boolean(reader),
    resolvePage, parallelPages:true,
    pageLabelSelector:'#i2 .sn div', nextPage:null, nextChapter:null};
});
