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
  const context = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? browser : await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await context.addInitScript(bytes => {
    window.GM = {
      getValue:async key => JSON.parse(localStorage.getItem(key)) ?? (key === 'kg1.reader-view' ? {mode:'single'} : null),
      setValue:async (key, value) => localStorage.setItem(key, JSON.stringify(value))
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
  let rateLimited = false;
  let limitedPath = galleryPath + '1/';
  let offline = false;
  await context.route(/^https:/, route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() === 'image') return route.fulfill({contentType:'image/png', body:png});
    if (url.origin !== origin) return route.abort();
    const reader = /^\/g\/(?:777|778|779)\/([1-3])\/$/.exec(url.pathname);
    if (request.resourceType() === 'fetch') {
      fetched.push({path:url.pathname, at:Date.now()});
      if (offline) return route.abort();
      if (url.pathname === limitedPath && !rateLimited) {
        rateLimited = true;
        return route.fulfill({status:429, headers:{'Retry-After':'2'}});
      }
    }
    const index = Number(reader?.[1]);
    const source = url.searchParams.has('mismatch') ? image(1) : image(index);
    const body = reader ? readerHTML(index, source) : /^\/g\/(?:777|778|779)\/$/.test(url.pathname)
      ? galleryHTML() : '<title>Search</title>';
    return route.fulfill({contentType:'text/html; charset=utf-8', body:'<!doctype html><meta charset="utf-8">' + body});
  });
  const open = page.getByRole('button', {name:'直向閱讀器', exact:true});
  const startPreload = page.getByRole('button', {name:'開始載入', exact:true});
  const dialog = page.getByRole('dialog', {name:'直向閱讀器', exact:true});
  const settings = dialog.getByRole('button', {name:'閱讀設定', exact:true});
  const preload = dialog.getByRole('combobox', {name:'並行預載數'});
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
  await startPreload.click();
  const loading = page.getByRole('button', {name:'載入中…', exact:true});
  await loading.waitFor();
  assert.equal(await loading.isDisabled(), true);
  await page.getByText('已保存 3 頁 / 共 3 頁', {exact:true}).waitFor({timeout:10000});
  await startPreload.waitFor();
  assert.equal(await dialog.count(), 0, 'preloading from the dock does not open the reader');
  await open.click();
  await settings.click();
  assert.equal(await preload.inputValue(), 'default');
  assert.equal(await preload.locator('option:checked').textContent(), '使用網站預設（3 頁）');
  await settings.click();
  await readPage(2);
  await dialog.locator('.buffer-progress').filter({hasText:/^已保存 3／3 頁$/}).waitFor({timeout:10000});
  const saved = await readSavedChapter(page, '777', '777');
  assert.equal(saved.chapter.total, 3);
  assert.equal(saved.chapter.chapterUrl, gallery);
  assert.equal(saved.chapter.chapterTitle, 'Fixture Gallery');
  assert.deepEqual(saved.pages.map(row => [row.index, row.imageUrl]), [1, 2, 3].map(n => [n, image(n)]));
  assert.deepEqual(fetched.map(({path}) => path), [galleryPath + '1/', galleryPath + '1/', galleryPath + '3/']);
  assert(fetched[1].at - fetched[0].at >= 1950, 'waits for Retry-After before retrying');
  assert(fetched[2].at - fetched[1].at >= 1150, 'paces the following page request');

  offline = true;
  await page.evaluate(() => localStorage.setItem('kg1.parallel-preload', '2'));
  await visit(gallery + '3/');
  await open.click();
  await readPage(3);
  assert.deepEqual(await privileged(), [], 'a saved page is read from IndexedDB');
  await settings.click();
  assert.equal(await preload.inputValue(), '2', 'keeps the existing shared preference until the user chooses a site setting');
  await preload.selectOption('4');
  await visit(gallery + '3/');
  await open.click();
  await settings.click();
  assert.equal(await preload.inputValue(), '4', 'remembers the site override');
  assert.equal(await page.evaluate(() => localStorage.getItem('kg1.parallel-preload')), '2', 'site overrides keep the legacy setting intact');
  await preload.selectOption('default');
  await visit(gallery + '3/');
  await open.click();
  await settings.click();
  assert.equal(await preload.inputValue(), 'default', 'resetting the site ignores the legacy value');
  assert.equal(await preload.locator('option:checked').textContent(), '使用網站預設（3 頁）');
  await visit(origin + '/search/');
  assert.equal(await open.count(), 0);

  offline = false;
  rateLimited = false;
  limitedPath = '/g/778/1/';
  const other = await context.newPage();
  await other.goto(origin + '/g/779/');
  await other.addScriptTag({content:bundle});
  await visit(origin + '/g/778/');
  await startPreload.click();
  const cooldown = await page.waitForFunction(() => {
    const time = Number(localStorage.getItem('kg1.nhentai-next-request'));
    return time - Date.now() > 1500 && time;
  });
  const retryAt = await cooldown.jsonValue();
  await page.close();
  await other.getByRole('button', {name:'開始載入', exact:true}).click();
  await other.getByText('已保存 3 頁 / 共 3 頁', {exact:true}).waitFor({timeout:10000});
  const started = fetched.filter(({path}) => path.startsWith('/g/779/'));
  assert.equal(started.length, 3);
  assert(started[0].at >= retryAt - 50, 'another tab honors Retry-After after the first tab closes');
  await other.close();
}

(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'komaglide-nhentai-'));
  let browser;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/build.mjs'), directory]);
    const bundle = await readFile(path.join(directory, 'komaglide.user.js'), 'utf8');
    browser = await launchSiteBrowser();
    await testNhentai(browser, bundle);
    console.log('nhentai gallery, offline cache, and cross-tab cooldown passed');
  } finally {
    await browser?.close();
    await rm(directory, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
