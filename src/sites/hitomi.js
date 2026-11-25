const hitomiOrigin = 'https://hitomi.la';
const hitomiAssets = 'https://ltn.gold-usergeneratedcontent.net';
const hitomiReaderRoute = /^\/reader\/([1-9]\d*)\.html$/;
const hitomiGalleryRoute = /^\/(?:galleries\/|(?:doujinshi|dj|manga|cg|imageset|anime)\/[^/]+-)([1-9]\d*)\.html$/;
const hitomiHash = /^[a-f0-9]{64}$/;
let hitomiGallery;
let hitomiRouting;

async function hitomiAsset(path) {
  const response = await fetch(hitomiAssets + path, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('Hitomi HTTP ' + response.status);
  return response.text();
}

function prepareHitomi(address, schedule) {
  if (address.origin !== hitomiOrigin) return;
  const route = hitomiReaderRoute.exec(address.pathname) || hitomiGalleryRoute.exec(address.pathname);
  if (!route) return;
  const id = route[1];
  void hitomiAsset('/galleries/' + id + '.js').then(source => {
    // The published asset wraps a JSON object in a script assignment.
    const payload = /^\s*var\s+galleryinfo\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(source);
    if (!payload) return;
    const data = JSON.parse(payload[1]);
    if (String(data.id) !== id || data.blocked || !Array.isArray(data.files) || !data.files.length ||
        !data.files.every(file => typeof file?.hash === 'string' && hitomiHash.test(file.hash))) return;
    const title = (data.language === 'japanese' && data.japanese_title) || data.title;
    if (typeof title !== 'string' || !title.trim()) return;
    const gallery = webUrl(data.galleryurl, hitomiOrigin);
    const chapterUrl = gallery?.origin === hitomiOrigin && hitomiGalleryRoute.exec(gallery.pathname)?.[1] === id
      ? hitomiOrigin + gallery.pathname : hitomiOrigin + '/galleries/' + id + '.html';
    hitomiGallery = {id, title: title.trim(), chapterUrl, hashes: data.files.map(file => file.hash)};
    schedule();
  }).catch(error => console.warn('[KomaGlide]', error.message));
}

function hitomiReadRouting() {
  if (hitomiRouting?.expires > Date.now()) return hitomiRouting.task;
  const task = hitomiAsset('/gg.js').then(source => {
    // Read the CDN routing table as data. The site rotates the path prefix.
    const bucket = /\bb:\s*['"](\d+)\/['"]/.exec(source)?.[1];
    const table = /\bvar\s+o\s*=\s*([01]);\s*switch\s*\(g\)\s*\{([\s\S]*?)\}\s*return\s+o\s*;/.exec(source);
    const group = /^\s*((?:case\s+\d+:\s*)+)o\s*=\s*([01]);\s*break\s*;\s*$/.exec(table?.[2] || '');
    if (!bucket || !table || !group) throw new Error(t('imageReadFailed'));
    const overrides = new Set([...group[1].matchAll(/case\s+(\d+):/g)].map(match => Number(match[1])));
    return {bucket, overrides, standard: Number(table[1]) + 1, alternate: Number(group[2]) + 1};
  }).catch(error => {
    if (hitomiRouting?.task === task) hitomiRouting = undefined;
    throw error;
  });
  hitomiRouting = {task, expires: Date.now() + 60_000};
  return task;
}

siteAdapters.push(function detectHitomi(root, address) {
  if (address.origin !== hitomiOrigin || !hitomiGallery) return null;
  const reader = hitomiReaderRoute.exec(address.pathname);
  const route = reader || hitomiGalleryRoute.exec(address.pathname);
  const {id, title, chapterUrl, hashes} = hitomiGallery;
  if (route?.[1] !== id) return null;
  const total = hashes.length;
  const requested = reader ? Number(/^#(\d+)(?:-\d*)?$/.exec(address.hash)?.[1]) : 1;
  const startIndex = requested >= 1 && requested <= total ? requested : 1;
  const entries = [];
  if (reader) {
    const visibleIndices = [startIndex, startIndex + 1];
    for (const img of root.querySelectorAll('#comicImages img.lillie, #mobileImages img.lillie')) {
      const url = webUrl(img.currentSrc || img.getAttribute('src'), address);
      if (url?.protocol !== 'https:' || !/^[aw][12]\.gold-usergeneratedcontent\.net$/.test(url.host)) continue;
      const hash = /\/([a-f0-9]{64})\.(?:avif|webp)$/.exec(url.pathname)?.[1];
      const index = visibleIndices.find(n => hash && hashes[n - 1] === hash && !entries.some(entry => entry.index === n));
      if (index) entries.push({img, index, imageUrl: url.href});
    }
  }

  async function resolvePage(index, signal) {
    if (!Number.isSafeInteger(index) || index < 1 || index > total) return null;
    signal.throwIfAborted();
    const {bucket, overrides, standard, alternate} = await hitomiReadRouting();
    signal.throwIfAborted();
    const hash = hashes[index - 1];
    const shard = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
    const host = overrides.has(shard) ? alternate : standard;
    return {img: root.createElement('img'), index,
      imageUrl: 'https://w' + host + '.gold-usergeneratedcontent.net/' + bucket + '/' + shard + '/' + hash + '.webp'};
  }

  return {workId: id, workTitle: title, chapterId: id, chapterTitle: title, chapterUrl, entries, total, startIndex,
    resolvePage, parallelPages: true, nextPage: null, nextChapter: null};
});
