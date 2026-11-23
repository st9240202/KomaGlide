const nhOrigin = 'https://nhentai.net';
const nhRoute = /^\/g\/([1-9]\d*)(?:\/([1-9]\d*))?\/?$/;
const nhPageLabel = '.reader-pagination .page-number';

function nhImageUrl(value, address, index) {
  const url = webUrl(value, address);
  if (!url || !/^https:\/\/i\d*\.nhentai\.net$/.test(url.origin)) return null;
  const image = /^\/galleries\/[1-9]\d*\/([1-9]\d*)\.(?:jpe?g|png|webp|gif|avif)$/i.exec(url.pathname);
  return image?.[1] === String(index) ? url : null;
}

function nhReadPage(root, address) {
  const route = nhRoute.exec(address.pathname);
  const index = Number(route?.[2]);
  const label = root.querySelector(nhPageLabel);
  const total = Number(label?.querySelector('.num-pages')?.textContent);
  const title = /^(.*?)\s+-\s+Page\s+(\d+)\s+»\s+nhentai$/is.exec(
    root.querySelector('title')?.textContent.trim() || '');
  if (!title?.[1].trim() || +title[2] !== index ||
      Number(label?.querySelector('.current')?.textContent) !== index ||
      !Number.isSafeInteger(total) || index < 1 || index > total) return null;
  const img = root.querySelector('#image-container img');
  const url = nhImageUrl(img?.getAttribute('src'), address, index);
  return {title:title[1].trim(), total, index, entry:url ? {index, img, imageUrl:url.href} : null};
}

siteAdapters.push(function detectNhentai(root, address) {
  if (address.origin !== nhOrigin) return null;
  const route = nhRoute.exec(address.pathname);
  if (!route) return null;
  const [, id, page] = route;
  const chapterUrl = nhOrigin + '/g/' + id + '/';
  let data;
  if (page) {
    data = nhReadPage(root, address);
  } else {
    const heading = root.querySelector('#info h1.title');
    const pages = [...root.querySelectorAll('#info #tags .tag-container')]
      .map(node => /^Pages:\s*(\d+)$/i.exec(node.textContent.trim()))
      .find(Boolean);
    const total = Number(pages?.[1]);
    if (!heading || !Number.isSafeInteger(total) || total < 1) return null;
    const title = root.querySelector('title')?.textContent.replace(/\s+»\s+nhentai\s*$/i, '').trim() ||
      heading.textContent.trim();
    if (title) data = {title, total, index:1};
  }
  if (!data) return null;

  async function resolvePage(index, signal) {
    if (!Number.isSafeInteger(index) || index < 1 || index > data.total) return null;
    const url = new URL(index + '/', chapterUrl);
    const {root, address} = await fetchDocument(url.href, signal);
    const target = nhRoute.exec(address.pathname);
    if (address.origin !== nhOrigin || target?.[1] !== id || target[2] !== String(index)) return null;
    const resolved = nhReadPage(root, address);
    return resolved?.total === data.total ? resolved.entry : null;
  }

  return {workId:id, workTitle:data.title, chapterId:id, chapterTitle:data.title, chapterUrl,
    entries:data.entry ? [data.entry] : [], total:data.total, startIndex:data.index,
    resolvePage, parallelPages:true, pageLabelSelector:nhPageLabel, nextPage:null, nextChapter:null};
});
