const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { launchSiteBrowser, readSavedChapter } = require('./site-fixture.cjs');

const origin = 'https://hitomi.la';
const assets = 'https://ltn.gold-usergeneratedcontent.net';
const gallery = '/unlisted-category/fixture-title-777.html';
const nestedGallery = '/another-category/localized/other-title-777.html';
const parallelGalleries = [778, 779];
const tag = '/tag/fixture-title-777.html';
const reader = '/reader/777.html';
const hashes = ['a'.repeat(61) + 'abc', 'b'.repeat(61) + '12f', 'c'.repeat(61) + '301'];
const images = hashes.map((hash, i) => 'https://w' + [2, 1, 1][i] + '.gold-usergeneratedcontent.net/1234567890/' +
  [3243, 3858, 304][i] + '/' + hash + '.webp');
const native = images[1].replace('w1.', 'a1.').replace('.webp', '.avif');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQSOiAIwacHADslwxhjmTwNAAAAABJRU5ErkJggg==', 'base64');
const routing = `gg = {m:function(g) {
  var o = 1;
  switch(g) {
    case 3858:
    case 304:
    o = 0; break;
  }
  return o;
}, b: '1234567890/'};
window.fixtureScriptExecuted = true;`;

async function run() {
  const bundle = await readFile(path.join(__dirname, '../dist/komaglide.user.js'), 'utf8');
  const browser = await launchSiteBrowser();
  try {
    const context = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? browser : await browser.newContext();
    const page = await context.newPage();
    await context.addInitScript(() => {
      window.GM = {
        getValue: async (key, fallback) => JSON.parse(localStorage.getItem(key)) ?? fallback,
        setValue: async (key, value) => localStorage.setItem(key, JSON.stringify(value)),
      };
      window.GM_registerMenuCommand = window.GM_addValueChangeListener = () => {};
    });
    let imageFetches = [];
    let routingReads = 0;
    let metadataReads = 0;
    let cachedOnly = false;
    let measureParallel = false;
    let activeImages = 0;
    let peakImages = 0;
    const cors = {'access-control-allow-origin': '*'};
    await context.route(/^https:\/\//, async route => {
      const url = route.request().url();
      if (url === origin + '/all.html' || url === origin + tag) {
        return route.fulfill({contentType: 'text/html', body: '<a href="' + gallery + '">Catalog</a><a href="' + reader + '">Read</a>'});
      }
      if (url === origin + gallery) {
        return route.fulfill({contentType: 'text/html', body: '<main class="gallery"><h1>Fixture Title</h1><a href="' + reader + '">Read</a></main>'});
      }
      if (url === origin + nestedGallery || url === origin + '/galleries/777.html') {
        return route.fulfill({contentType: 'text/html', body: '<script src="' + assets + '/galleries/777.js"></script><h1>Fixture Title</h1>'});
      }
      if (parallelGalleries.some(id => url === origin + '/galleries/' + id + '.html')) {
        return route.fulfill({contentType: 'text/html', body: '<h1>Parallel fixture</h1>'});
      }
      if (url === origin + reader) {
        return route.fulfill({contentType: 'text/html', body: '<div id="mobileImages"><picture>' +
          '<img class="lillie" src="' + native + '"></picture></div>' +
          '<div id="preload"><img class="lillie" src="' + images[2] + '"></div>'});
      }
      const metadataId = [777, ...parallelGalleries].find(id => url === assets + '/galleries/' + id + '.js');
      if (metadataId) {
        if (route.request().resourceType() === 'fetch') metadataReads++;
        const data = {id: String(metadataId), title: 'Fixture Title', galleryurl: metadataId === 777
          ? gallery : '/galleries/' + metadataId + '.html', files: hashes.map(hash => ({hash}))};
        return route.fulfill({headers: cors, body: 'var galleryinfo = ' + JSON.stringify(data) + ';'});
      }
      if (url === assets + '/gg.js') {
        routingReads++;
        return route.fulfill({headers: cors, body: routing});
      }
      if (images.includes(url) || url === native) {
        if (route.request().resourceType() === 'fetch') imageFetches.push(url);
        if (cachedOnly) return route.abort();
        if (!measureParallel) return route.fulfill({headers: cors, contentType: 'image/png', body: png});
        peakImages = Math.max(peakImages, ++activeImages);
        try {
          await new Promise(resolve => setTimeout(resolve, 350));
          return await route.fulfill({headers: cors, contentType: 'image/png', body: png});
        } finally { activeImages--; }
      }
      return route.abort();
    });
    async function open(target) {
      await page.goto(origin + target);
      await page.addScriptTag({content: bundle});
    }
    const counts = n => page.getByText('已保存 ' + n + ' 頁 / 共 3 頁', {exact: true});
    const readerButton = page.getByRole('button', {name: '直向閱讀器', exact: true});
    await open('/all.html');
    assert.equal(await readerButton.count(), 0);
    await open(tag);
    assert.equal(await readerButton.count(), 0);
    await open(reader + '#2-3');
    await counts(1).waitFor();
    assert.deepEqual((await readSavedChapter(page, '777', '777')).pages.map(row => row.index), [2]);
    assert.deepEqual(imageFetches, [native], 'only the native page on screen should be saved automatically');

    imageFetches = [];
    await open(gallery);
    await counts(1).waitFor();
    await page.getByRole('button', {name: '開始載入', exact: true}).click();
    await counts(3).waitFor();
    assert.deepEqual(imageFetches.sort(), [images[0], images[2]].sort());
    assert.equal(routingReads, 1, 'parallel preloads should share the CDN routing request');
    assert.equal(await page.evaluate(() => window.fixtureScriptExecuted), undefined);
    const saved = await readSavedChapter(page, '777', '777');
    assert.equal(saved.chapter.chapterUrl, origin + gallery);
    assert.deepEqual(saved.pages.map(row => row.index), [1, 2, 3]);
    assert.equal(metadataReads, 2, 'catalog and tag pages must not fetch gallery metadata');

    await open(nestedGallery);
    await counts(3).waitFor();

    cachedOnly = true;
    imageFetches = [];
    await open(reader + '#3');
    await readerButton.click();
    const overlay = page.getByRole('dialog', {name: '直向閱讀器', exact: true});
    const pageThree = overlay.locator('img[data-index="3"]');
    await pageThree.waitFor();
    assert.equal(await pageThree.evaluate(async img => { await img.decode(); return new URL(img.src).protocol; }), 'blob:');
    assert.deepEqual(imageFetches, [], 'the reader should reopen the requested page from the shared cache');
    assert.equal(routingReads, 1, 'cached images should not need the routing table');

    await overlay.getByRole('button', {name: '閱讀設定'}).click();
    await overlay.getByRole('combobox', {name: '並行預載數'}).selectOption('2');
    cachedOnly = false;
    const tabs = await Promise.all(parallelGalleries.map(async id => {
      const tab = await context.newPage();
      await tab.goto(origin + '/galleries/' + id + '.html');
      await tab.addScriptTag({content: bundle});
      await tab.getByText('已保存 0 頁 / 共 3 頁', {exact: true}).waitFor();
      return tab;
    }));
    measureParallel = true;
    await Promise.all(tabs.map(tab => tab.getByRole('button', {name: '開始載入', exact: true}).click()));
    await Promise.all(tabs.map(tab => tab.getByText('已保存 3 頁 / 共 3 頁', {exact: true}).waitFor()));
    assert.equal(peakImages, 2, 'same-origin tabs share the configured parallel request limit');
    console.log('Hitomi gallery preload, cached reopening and cross-tab request limit passed');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
