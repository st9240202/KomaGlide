const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launchSiteBrowser, readSavedChapter } = require('./site-fixture.cjs');

const origin = 'https://nhentai.net';
const galleryPath = '/g/777/';
const gallery = origin + galleryPath;
const image = n => 'https://i' + n + '.nhentai.net/galleries/9876/' + n + '.webp';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQSOiAIwacHADslwxhjmTwNAAAAABJRU5ErkJggg==', 'base64');

function galleryHTML() {
  return '<title>Fixture Gallery » nhentai</title><div id="info"><h1 class="title">Fixture Title</h1>' +
    '<div id="tags"><div class="tag-container">Pages: <span class="name">3</span></div></div></div>' +
    '<div id="thumbnail-container"><a href="1/"><img src="https://t1.nhentai.net/galleries/9876/1t.webp"></a></div>';
}

function readerHTML(index, url) {
  return '<title>Fixture Gallery - Page ' + index + ' » nhentai</title>' +
    '<div class="reader-pagination"><button class="page-number"><span class="current">' + index +
    '</span> of <span class="num-pages">3</span></button></div>' +
    '<div id="image-container"><img src="' + url + '"></div>';
}

async function testNhentai(browser, bundle) {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript(bytes => {
    window.GM = {
      getValue:async key => key === 'kg1.reader-view' ? {mode:'single'} : null,
      setValue:async () => {}
    };
    window.GM_registerMenuCommand = window.GM_addValueChangeListener = () => {};
    window.imageReads = [];
    window.GM_xmlhttpRequest = request => {
      if (!request.anonymous || request.redirect !== 'error' || request.headers?.Referer !== location.origin + '/') {
        throw new Error('Unexpected privileged request');
      }
      window.imageReads.push(request.url);
      const response = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], {type:'image/png'});
      queueMicrotask(() => request.onload({status:200, response}));
    };
  }, png.toString('base64'));
  const fetched = [];
  let offline = false;
  await page.route(/^https:/, route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() === 'image') return route.fulfill({contentType:'image/png', body:png});
    if (url.origin !== origin) return route.abort();
    const reader = /^\/g\/777\/([1-3])\/$/.exec(url.pathname);
    if (request.resourceType() === 'fetch') {
      fetched.push(url.pathname);
      if (offline) return route.abort();
    }
    const index = Number(reader?.[1]);
    const source = url.searchParams.has('mismatch') ? image(1) : image(index);
    const body = reader ? readerHTML(index, source) : url.pathname === galleryPath ? galleryHTML() : '<title>Search</title>';
    return route.fulfill({contentType:'text/html; charset=utf-8', body:'<!doctype html><meta charset="utf-8">' + body});
  });
  const open = page.getByRole('button', {name:'直向閱讀器', exact:true});
  const dialog = page.getByRole('dialog', {name:'直向閱讀器', exact:true});
  const privileged = () => page.evaluate(() => window.imageReads);
  async function visit(url) {
    await page.goto(url);
    await page.addScriptTag({content:bundle});
  }
  async function readPage(index) {
    const img = dialog.locator('img[data-index="' + index + '"]');
    await img.waitFor({timeout:5000});
    assert(await img.evaluate(async el => { await el.decode(); return el.src.startsWith('blob:') && el.naturalWidth === 4; }));
  }

  await visit(gallery + '2/?mismatch');
  await page.getByText('已保存 0 頁 / 共 3 頁', {exact:true}).waitFor();
  assert.deepEqual(await privileged(), [], 'an image with the previous page number is ignored');

  await visit(gallery + '2/');
  await page.getByText('已保存 1 頁 / 共 3 頁', {exact:true}).waitFor();
  assert.deepEqual(await privileged(), [image(2)]);
  await open.click();
  await readPage(2);

  await visit(gallery);
  await page.getByText('已保存 1 頁 / 共 3 頁', {exact:true}).waitFor();
  assert.deepEqual(await privileged(), [], 'gallery thumbnails are never captured');
  await open.click();
  await readPage(1);
  await dialog.locator('.buffer-progress').filter({hasText:/^已保存 3／3 頁$/}).waitFor({timeout:10000});
  const saved = await readSavedChapter(page, '777', '777');
  assert.equal(saved.chapter.total, 3);
  assert.equal(saved.chapter.chapterUrl, gallery);
  assert.equal(saved.chapter.chapterTitle, 'Fixture Gallery');
  assert.deepEqual(saved.pages.map(row => [row.index, row.imageUrl]), [1, 2, 3].map(n => [n, image(n)]));
  assert.deepEqual(fetched.sort(), [galleryPath + '1/', galleryPath + '3/']);

  offline = true;
  await visit(gallery + '3/');
  await open.click();
  await readPage(3);
  assert.deepEqual(await privileged(), [], 'a saved page is read from IndexedDB');
  await visit(origin + '/search/');
  assert.equal(await open.count(), 0);
  await page.close();
}

(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'komaglide-nhentai-'));
  let browser;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/build.mjs'), directory]);
    const bundle = await readFile(path.join(directory, 'komaglide.user.js'), 'utf8');
    browser = await launchSiteBrowser();
    await testNhentai(browser, bundle);
    console.log('nhentai gallery, direct reader, and offline cache passed');
  } finally {
    await browser?.close();
    await rm(directory, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
