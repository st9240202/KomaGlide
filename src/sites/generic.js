siteAdapters.push(function detectGeneric(root, address) {
  const area = root.querySelector('[data-comic-pages], #comic, .comic-pages, #comic-pages, [itemtype$="/ComicStory"] [itemprop="image"]');
  if (!area) return null;
  const images = (area.matches('img') ? [area] : [...area.querySelectorAll('img')]).filter(isComicImage);
  if (!images.length) return null;
  const title = root.querySelector('[data-comic-title], #ctitle, h1')?.textContent.trim() ||
    root.querySelector('meta[property="og:title"]')?.content || (root.querySelector('title')?.textContent || '').trim();
  if (!title) return null;
  const series = root.querySelector('[data-comic-work], [itemtype$="/ComicSeries"] [itemprop="name"]');
  const workTitle = (series?.getAttribute('data-comic-work') || series?.getAttribute('content') || series?.textContent || '').trim();
  const declared = webUrl(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), address) ||
    webUrl(root.querySelector('meta[property="og:url"]')?.content, address);
  const url = declared?.origin === address.origin ? declared : new URL(address);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  return {chapterId: url.pathname + url.search, chapterUrl: url.href, chapterTitle: title,
    workId: workTitle, workTitle, total: images.length, entries: images.map((img, i) => ({
      img, index: i + 1, lazyImageUrl: img.dataset.src || img.dataset.lazySrc
    }))};
});
