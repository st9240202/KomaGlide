siteAdapters.push(function detect8comic(root, address) {
  const route = /^\/online\/new-(\d+)\.html$/.exec(address.pathname);
  if (address.origin !== 'https://articles.onemoreplace.tw' || !route) return null;

  const workId = route[1];
  const workLink = [...root.querySelectorAll('.view-titles a[href]')].find(link => {
    const url = webUrl(link.getAttribute('href'), address);
    return url?.origin === 'https://www.8comic.com' && url.pathname === '/html/' + workId + '.html';
  });
  if (!workLink) return null;
  const labels = [...workLink.querySelectorAll('small')].map(el => el.textContent.trim());
  const chapterLabel = labels.map(label => /^第\s*(\d+(?:\.\d+)?)\s*([集話])$/.exec(label)).find(Boolean);
  if (!chapterLabel) return null;
  const workTitle = [...workLink.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  const chapterNumber = chapterLabel[1];
  // Split chapters can share a displayed number (ch=2a and ch=2b both say 第2集).
  const chapterToken = address.searchParams.get('ch') || chapterNumber;
  const chapterUrl = new URL(address.pathname, address.origin);
  chapterUrl.searchParams.set('ch', chapterToken);
  const chapterTitle = '第' + chapterNumber + chapterLabel[2] +
    (chapterNumber === chapterToken ? '' : '（' + chapterToken + '）');
  const declared = labels.map(label => /^\(\s*(\d+)\s*P\s*\)$/i.exec(label)).find(Boolean);
  const total = declared ? Number(declared[1]) : undefined;

  const pages = new Map();
  for (const slot of root.querySelectorAll('.pinch-zoom .comics-pic')) {
    const img = slot.querySelector(':scope > img');
    const label = slot.querySelector(':scope > b')?.textContent.trim();
    if (!img || !isComicImage(img) || !/^\d+$/.test(label || '')) continue;
    const index = Number(label);
    if (index < 1 || (total && index > total) || pages.has(index)) continue;
    // Unloaded slots reserve their page number. The capture loop waits for
    // the site's native loader to set src and finish decoding the image.
    const selected = img.currentSrc || img.getAttribute('src');
    const source = selected && comic8ImageUrl(selected, chapterUrl);
    if (selected && !source) continue;
    pages.set(index, { img, index, imageUrl: source?.href });
  }
  if (!pages.size) return null;
  // Scrolling the original numbered slot activates the site's own lazy loader.
  // Parsed continuation documents do not have a live viewport.
  function revealPage(index) {
    const slot = pages.get(index)?.img.parentElement;
    if (!slot?.isConnected) return false;
    slot.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return true;
  }
  return {
    workId, workTitle, chapterId: workId + ':' + chapterToken, chapterTitle, chapterUrl: chapterUrl.href,
    total, entries: [...pages.values()].sort((a, b) => a.index - b.index),
    revealPage: root === document ? revealPage : undefined,
    nextPage: null, nextChapter: null,
  };
});
