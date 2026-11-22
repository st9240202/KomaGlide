// Synthetic E-Hentai and ExHentai galleries. All HTTP traffic is intercepted.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launchSiteBrowser, readSavedChapter } = require('./site-fixture.cjs');

const japaneseTitle = '日本語の副題';
const galleryPath = '/g/777/abcd/';
const readerPath = n => '/s/' + (100 + n) + '/777-' + n;
const image = n => 'https://one.two.hath.network:8443/h/signed/page-' + n + '.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQSOiAIwacHADslwxhjmTwNAAAAABJRU5ErkJggg==', 'base64');

function galleryHTML(batch) {
  const first = batch * 2 + 1, last = Math.min(first + 1, 8);
  return '<h1 id="gn">測試圖庫</h1><h1 id="gj">' + japaneseTitle + '</h1><p class="gpc">Showing ' + first + ' - ' + last + ' of 8 images</p>' +
    '<div id="gdt">' + Array.from({length:last - first + 1}, (_, i) =>
      '<a href="' + readerPath(first + i) + '"><img src="/thumbnail.png"></a>').join('') + '</div>';
}
function readerHTML(n) {
  return '<div id="i1"><h1>測試圖庫</h1><div id="i2"><div class="sn"><div><span>' + n +
    '</span> / <span>8</span></div></div></div><div id="i3"><img id="img" src="' + image(n) +
    '"></div><div class="sb"><a href="' + galleryPath + '?p=1">Gallery</a></div></div>';
}
async function readPage(dialog, n) {
  const el = dialog.locator('img[data-index="' + n + '"]');
  await el.waitFor({timeout:4000});
  assert(await el.evaluate(async img => { await img.decode(); return img.src.startsWith('blob:') && img.naturalWidth === 4; }));
}

async function testGallery(browser, bundle, origin) {
  const gallery = origin + galleryPath;
  const reader = n => origin + readerPath(n);
  const page = await browser.newPage();
  await page.addInitScript(data => {
    window.GM = {
      getValue:async k => JSON.parse(localStorage.getItem(k)) ?? (k === 'kg1.reader-view' ? {mode:'single'} : null),
      setValue:async (k, v) => localStorage.setItem(k, JSON.stringify(v))
    };
    window.GM_registerMenuCommand = window.GM_addValueChangeListener = () => {};
    window.imageReads = [];
    window.pendingImages = 0;
    window.peakImages = 0;
    window.failImage = null;
    window.GM_xmlhttpRequest = req => {
      if (!req.anonymous || req.redirect !== 'error' || req.headers?.Referer !== location.origin + '/' ||
            new URL(req.url).hostname !== 'one.two.hath.network') {
        throw new Error('Unexpected privileged request');
      }
      window.imageReads.push(req.url);
      window.pendingImages++;
      window.peakImages = Math.max(window.peakImages, window.pendingImages);
      const fail = req.url === window.failImage;
      setTimeout(() => {
        window.pendingImages--;
        req.onload(fail ? {status:503} : {
          status:200, response:new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], {type:'image/png'})
        });
      }, 150);
    };
  }, png.toString('base64'));
  const fetched = [];
  await page.route(/^https?:/, route => {
    const req = route.request(), url = new URL(req.url());
    if (req.resourceType() === 'fetch') fetched.push(url.href);
    if (req.resourceType() === 'image') return route.fulfill({contentType:'image/png', body:png});
    let html;
    if (url.pathname === '/g/777/abcd/') html = galleryHTML(Number(url.searchParams.get('p')) || 0);
    else if (url.pathname.startsWith('/s/')) html = readerHTML(Number(url.pathname.split('-').pop()));
    else return route.abort();
    return route.fulfill({contentType:'text/html;charset=utf-8', body:'<!doctype html><meta charset="utf-8">' + html});
  });
  async function open(url) {
    await page.goto(url);
    await page.addScriptTag({content:bundle});
  }
  async function openReader() {
    await page.getByRole('button', {name:'直向閱讀器', exact:true}).click();
    return page.getByRole('dialog', {name:'直向閱讀器', exact:true});
  }
  await open(gallery + '?p=1');
  await page.getByText(/已保存 0 頁/).waitFor();
  assert.deepEqual(fetched, []);
  assert.deepEqual(await page.evaluate(() => window.imageReads), []);
  if (origin === 'https://exhentai.org') await page.evaluate(url => { window.failImage = url; }, image(4));
  let dialog = await openReader();
  await readPage(dialog, 3);
  const settings = dialog.getByRole('button', {name:'閱讀設定', exact:true});
  const buffering = dialog.getByRole('combobox', {name:'緩衝模式'});
  const parallelPreload = dialog.getByRole('combobox', {name:'並行預載數'});
  await settings.click();
  assert.equal(await dialog.locator('.source-chapter-subtitle').textContent(), japaneseTitle);
  assert.equal(await buffering.inputValue(), 'chapter', 'whole chapter is the default for existing preferences');
  assert.equal(await parallelPreload.inputValue(), '3');
  assert.deepEqual(await parallelPreload.locator('option').evaluateAll(options => options.map(option => option.value)),
    ['1', '2', '3', '4', '5', '6']);
  if (origin === 'https://exhentai.org') {
    await settings.click();
    const progress = dialog.locator('.buffer-progress');
    await progress.filter({hasText: '已保存 7／8 頁 · 有缺頁，見閱讀設定'}).waitFor({timeout:12000});
    assert.equal(await page.evaluate(() => window.peakImages), 3);
    assert.equal(fetched.filter(url => url === gallery + '?p=2').length, 1, 'parallel pages share a gallery request');
    await readPage(dialog, 3);
    await page.evaluate(() => { window.failImage = null; });
    await settings.click();
    await dialog.getByRole('button', {name:'重試缺頁'}).click();
    await progress.filter({hasText: /^已保存 8／8 頁$/}).waitFor({timeout:5000});
    const chapter = await readSavedChapter(page, '777', '777');
    assert.equal(chapter.chapter.count, 8);
    assert.equal(chapter.chapter.total, 8);
    await page.close();
    console.log(origin + ' default whole-chapter buffering from the middle passed');
    return;
  }
  await parallelPreload.selectOption('2');
  await buffering.selectOption('ahead');
  await settings.click();
  await page.getByText(/已保存 4 頁/).waitFor({state:'attached'});
  // Remain on page 3 past another scheduling interval; page 7 is outside the window.
  await page.waitForTimeout(250);
  assert.deepEqual(fetched.toSorted(), [reader(3), reader(4), gallery + '?p=2', reader(5), reader(6)].toSorted());
  assert.deepEqual(await page.evaluate(() => window.imageReads.toSorted()), [3, 4, 5, 6].map(image).toSorted());
  assert.equal(await page.evaluate(() => window.peakImages), 2, 'the selected limit controls simultaneous preloads');
  for (const index of [4, 5]) {
    await page.keyboard.press('PageDown');
    await readPage(dialog, index);
  }
  await page.getByText(/已保存 6 頁/).waitFor({state:'attached'});
  assert.deepEqual(await page.evaluate(() => window.imageReads.toSorted()), [3, 4, 5, 6, 7, 8].map(image).toSorted());

  for (const index of [4, 3, 2]) {
    await page.keyboard.press('PageUp');
    await readPage(dialog, index);
  }
  assert.deepEqual(fetched.slice(-2), [gallery, reader(2)]);

  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('komaglide-library-v1');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('chapters', 'readwrite');
        const chapters = tx.objectStore('chapters');
        const request = chapters.get([location.origin, '777', '777']);
        request.onsuccess = () => {
          const chapter = request.result;
          delete chapter.chapterSubtitle;
          chapters.put(chapter, chapter.key);
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  await open(reader(1));
  dialog = await openReader();
  await settings.click();
  await dialog.locator('.source-chapter-subtitle').filter({hasText:japaneseTitle}).waitFor();
  await page.getByText(/已保存 8 頁/).waitFor({state:'attached'});
  assert.deepEqual(await page.evaluate(() => window.imageReads), [image(1)]);
  await open(reader(2));
  fetched.length = 0;
  dialog = await openReader();
  await readPage(dialog, 2);
  await settings.click();
  assert.equal(await buffering.inputValue(), 'ahead', 'reader should remember the chosen buffer mode');
  assert.equal(await parallelPreload.inputValue(), '2', 'reader should remember the chosen preload count');
  await buffering.selectOption('chapter');
  await settings.click();
  await page.keyboard.press('PageDown');
  await readPage(dialog, 3);
  assert.deepEqual(fetched, [], 'cached page should need no directory or viewer request');
  assert.deepEqual(await page.evaluate(() => window.imageReads), []);
  for (const n of [2, 1]) {
    await page.keyboard.press('PageUp');
    await readPage(dialog, n);
  }
  const saved = await readSavedChapter(page, '777', '777');
  assert.deepEqual(saved.pages.map(p => p.imageUrl), [1, 2, 3, 4, 5, 6, 7, 8].map(image));
  assert.equal(saved.chapter.chapterUrl, gallery);
  assert.equal(saved.chapter.total, 8);
  assert.equal(saved.chapter.chapterTitle, '測試圖庫');
  assert.equal(saved.chapter.chapterSubtitle, japaneseTitle);
  await open(gallery + '#komaglide/shelf');
  const chapterLink = page.locator('.chapter-link').filter({hasText:japaneseTitle});
  await chapterLink.click();
  await page.getByRole('button', {name:'閱讀設定', exact:true}).click();
  await page.locator('#chapter-head [lang=ja]').filter({hasText:japaneseTitle}).waitFor();
  await page.close();
  console.log(origin + ' gallery pagination, native capture and cached rereading passed');
}

async function run() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kg-eh-'));
  const browser = await launchSiteBrowser();
  try {
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/build.mjs'), dir]);
    const bundle = await readFile(path.join(dir, 'komaglide.user.js'), 'utf8');
    for (const origin of ['https://e-hentai.org', 'https://exhentai.org']) {
      await testGallery(browser, bundle, origin);
    }
  } finally {
    await browser.close();
    await rm(dir, {recursive:true, force:true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
