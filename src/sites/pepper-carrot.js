siteAdapters.push(function detectPepper(root, address) {
  const episode = address.pathname.match(/^\/([^/]+)\/webcomic\/(ep\d+_[^/]+?)(?:__(?:hd|sbs))?\.html$/i);
  if (!episode) return null;
  const images = [...root.querySelectorAll('.webcomic-page img, #comicpage img')];
  const entries = [];
  for (const img of images) {
    if (!isComicImage(img) || /^(header|footer|credits)$/i.test(img.alt.trim())) continue;
    const number = (img.getAttribute('src') || img.dataset.src || '').match(/_E\d+P(\d+)(?:[^\d/]*)\.(?:jpe?g|webp|png)(?:[?#]|$)/i)
      || img.alt.match(/\bpage\s+(\d+)\s*$/i);
    const index = Number(number?.[1]);
    if (index > 0 && !entries.some(e => e.index === index)) entries.push({index, img});
  }
  if (!entries.length) return null;
  const chapterId = '/' + episode[1] + '/webcomic/' + episode[2] + '.html';
  const chapterTitle = (root.querySelector('h1')?.textContent || (root.querySelector('title')?.textContent || '')).replace(/\s+[-–|]\s+Pepper\s*&\s*Carrot.*$/i, '').trim();
  return {chapterId, chapterTitle, chapterUrl: address.origin + chapterId,
    workId: 'pepper-and-carrot', workTitle: 'Pepper&Carrot', entries,
    total: Math.max(...entries.map(e => e.index))};
});
