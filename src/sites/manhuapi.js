const manhuapiChapterRoute = /^\/chapter\/([1-9]\d*)\.html$/;

function manhuapiSite(address) {
  return /^(?:www\.)?amanhuapi\.net$/.test(address.host);
}

function manhuapiImageUrl(value, address) {
  const url = webUrl(value, address);
  return url?.origin === 'https://manhuapi.dwdghg.com' &&
    /^\/tupian\/images\/comic\/\d+\/\d+\/[^/]+\.(?:avif|webp|jpe?g|png|gif)$/i.test(url.pathname) ? url : null;
}

siteAdapters.push(function detectManhuapi(root, address) {
  const chapterId = manhuapiChapterRoute.exec(address.pathname)?.[1];
  if (!chapterId || !manhuapiSite(address)) return null;
  const book = root.querySelector('a#bookname[href]');
  const bookUrl = webUrl(book?.getAttribute('href'), address);
  const workId = bookUrl?.origin === address.origin && /^\/manhua\/([1-9]\d*)\.html$/.exec(bookUrl.pathname)?.[1];
  const workTitle = book?.textContent.trim();
  const title = root.querySelector('.mh_cont.title h1')?.textContent.trim()
    .replace(/\s*[（(]\s*\d+(?:\s*\/\s*\d+)?\s*[）)]$/, '').trim();
  if (!workId || !workTitle || !title) return null;
  const chapterTitle = title.startsWith(workTitle + ' ') ? title.slice(workTitle.length).trim() : title;
  const select = root.querySelector('.page select[name="titleselect"]');
  const total = select?.options.length;
  if (!total) return null;

  const requested = Number(new URLSearchParams(address.hash.slice(1) || address.search).get('p') || 1);
  const startIndex = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, total) : 1;
  const nativeImage = root.querySelector('.mh_list > p img');
  const currentUrl = manhuapiImageUrl(nativeImage?.currentSrc || nativeImage?.getAttribute('src'), address);
  const placeholder = document.createElement('img');
  const entries = [];
  for (const option of select.options) {
    const index = entries.length + 1;
    const pageUrl = webUrl(option.getAttribute('value'), address);
    const image = manhuapiImageUrl(option.getAttribute('jhc-data'), address);
    if (pageUrl?.origin !== address.origin || pageUrl.pathname !== address.pathname ||
        pageUrl.searchParams.get('p') !== String(index) || !image) return null;
    const img = index === startIndex && currentUrl?.href === image.href ? nativeImage : placeholder;
    entries.push({img, index, imageUrl: image.href});
  }

  const next = [...select.parentElement.querySelectorAll('a[href]')].find(a => /^下一[章話话]$/.test(a.textContent.trim()));
  const nextUrl = webUrl(next?.getAttribute('href'), address);
  const nextId = nextUrl?.origin === address.origin && manhuapiChapterRoute.exec(nextUrl.pathname)?.[1];
  return {workId, workTitle, chapterId, chapterTitle, chapterUrl: address.origin + address.pathname, entries, total, startIndex,
    parallelPages: true, nextPage: null, nextChapter: nextId && nextId !== chapterId ? nextUrl.href : null};
});
