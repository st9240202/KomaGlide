// Run after building the userscript, with Playwright Core and matching browsers.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium, webkit} = require('playwright-core');

const origin = 'https://review.example';
const library = path.resolve(__dirname, '../library');
const bundle = path.resolve(__dirname, '../dist/komaglide.user.js');
const html = (title, images) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<h1>' + title + '</h1><div data-comic-pages>' + images + '</div>';

async function run() {
  const useWebKit = process.env.PLAYWRIGHT_BROWSER === 'webkit';
  const context = await (useWebKit ? webkit : chromium).launchPersistentContext('', {
    viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true,
    ...(useWebKit ? {} : {channel: 'chromium', executablePath: process.env.CHROMIUM_PATH}),
  });
  try {
    context.setDefaultTimeout(12000);
    const source = await context.newPage();
    await context.route(origin + '/seed', route => route.fulfill({contentType: 'text/html', body: html('重現用', '')}));
    await source.goto(origin + '/seed');
    const pictures = await source.evaluate(() => [[8, 8], [16, 16], [390, 880]].map(([width, height], i) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = ['red', 'blue', 'green'][i];
      context.fillRect(0, 0, width, height);
      return canvas.toDataURL().split(',')[1];
    }));
    const [preview, full, tall] = pictures.map(value => Buffer.from(value, 'base64'));
    const catalog = [{id: 'c1', title: '小說章節', order: 1, url: origin + '/n/book/c1'}];
    const catalogBytes = Buffer.byteLength(JSON.stringify(catalog));
    await source.evaluate(async ({preview, catalog}) => {
      const open = indexedDB.open('komaglide-library-v1', 1);
      open.onupgradeneeded = () => {
        for (const store of ['pages', 'chapters', 'favoriteWorks', 'settings']) open.result.createObjectStore(store);
      };
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction(['pages', 'chapters', 'settings'], 'readwrite');
      const key = [location.origin, '', '/lazy'];
      const novelKey = ['小說狂人', 'book', 'c1'];
      const bytes = Uint8Array.from(atob(preview), c => c.charCodeAt(0));
      tx.objectStore('pages').put({bytes, mime: 'image/png', imageUrl: location.origin + '/preview.png'}, [...key, 1]);
      tx.objectStore('pages').put({paragraphs: ['文']}, [...novelKey, 1]);
      tx.objectStore('chapters').put({key, count: 1, bytes: bytes.length, total: 1, lastRead: 1,
        chapterTitle: '延遲載入', workKnown: false}, key);
      const novelBytes = new TextEncoder().encode(JSON.stringify(['文'])).byteLength;
      tx.objectStore('chapters').put({key: novelKey, bytes: novelBytes, favorite: true, kind: 'novel', lastRead: 2,
        workKnown: true, chapterTitle: '小說章節', workTitle: '小說'}, novelKey);
      tx.objectStore('settings').put({used: bytes.length + novelBytes, limit: 8 * 1024 ** 2, clock: 2}, 'storage');
      for (const id of ['book', 'orphan']) tx.objectStore('settings').put(catalog, ['novelCatalog', id]);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }, {preview: pictures[0], catalog});

    await context.route(origin + '/**', route => {
      const {pathname} = new URL(route.request().url());
      if (pathname.startsWith('/modules/')) return route.fulfill({
        path: path.join(library, path.basename(pathname)), contentType: 'text/javascript',
      });
      if (pathname === '/lazy' || pathname === '/fresh') {
        return route.fulfill({contentType: 'text/html', body: html(pathname === '/lazy' ? '延遲載入' : '新章',
          '<img id="body-image" src="/preview.png" data-src="/full.png">')});
      }
      if (pathname === '/long') return route.fulfill({contentType: 'text/html', body: html('長篇',
        '<img src="/tall.png">'.repeat(24))});
      if (pathname === '/large') return route.fulfill({contentType: 'text/html', body: html('大圖', '<img src="/large.png">')});
      const images = {'/preview.png': preview, '/full.png': full, '/tall.png': tall,
        '/large.png': Buffer.concat([full, Buffer.alloc(1200 * 1024)])};
      return images[pathname] ? route.fulfill({contentType: 'image/png', body: images[pathname]}) : route.abort();
    });
    await context.addInitScript(() => {
      window.GM_getValue = (_key, fallback) => fallback;
      window.GM_setValue = () => {};
      window.GM_registerMenuCommand = () => {};
    });
    await context.addInitScript({path: bundle});
    await source.goto(origin + '/lazy');
    await source.getByText(/已保存 1 頁/).waitFor();
    const migrated = await source.evaluate(async () => {
      const {readNovelCatalog, shelf} = await import('/modules/store.js');
      const {state, chapters} = await shelf();
      return {used: state.used, chapterBytes: chapters.reduce((sum, c) => sum + c.bytes, 0),
        catalog: await readNovelCatalog('book'), orphan: await readNovelCatalog('orphan')};
    });
    assert.deepEqual(migrated.catalog, catalog);
    assert.equal(migrated.orphan, undefined);
    assert.equal(migrated.used - migrated.chapterBytes, catalogBytes);

    const shelf = await context.newPage();
    await shelf.goto(origin + '/lazy#komaglide/export');
    await shelf.getByRole('checkbox', {name: '延遲載入'}).check();
    const prepare = shelf.getByRole('button', {name: '準備 ZIP'});
    const ready = shelf.getByRole('link', {name: '下載 ZIP'});
    const changed = shelf.getByText('所選章節的頁面已更新，請重新準備 ZIP。');
    async function prepareZip() {
      await prepare.click();
      await ready.waitFor();
      return ready.getAttribute('href');
    }
    await prepareZip();
    await source.locator('#body-image').evaluate(img => { img.src = img.dataset.src; });
    await changed.waitFor();
    assert.equal(await ready.count(), 0, 'Replacing a page invalidates a ready ZIP even when the count is unchanged');
    const stored = await source.evaluate(async () => {
      const {lookupPage, shelf} = await import('/modules/store.js');
      const info = {site: location.origin, chapterId: '/lazy', index: 1};
      let puts = 0;
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { puts++; return original.apply(this, args); };
      try {
        for (let i = 0; i < 100; i++) assertExists(await lookupPage(info, false));
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      function assertExists(result) { if (!result.exists) throw Error('No image'); }
      const {blob} = await lookupPage(info, true);
      const image = await createImageBitmap(blob);
      const {state, chapters} = await shelf();
      const result = {width: image.width, puts, stateBytes: state.used, chapterBytes: chapters.find(c => c.key[2] === '/lazy').bytes};
      image.close();
      return result;
    });
    assert.deepEqual(stored, {width: 16, puts: 0,
      chapterBytes: full.length, stateBytes: migrated.used - preview.length + full.length});
    await prepareZip();
    await source.locator('[data-comic-pages]').evaluate(area => {
      const page = document.createElement('img');
      page.src = '/full.png';
      area.append(page);
    });
    await shelf.getByText('已選 1 話，共 2 頁').waitFor();
    await changed.waitFor();
    assert.equal(await ready.count(), 0);
    const href = await prepareZip();
    const files = await shelf.evaluate(async href => {
      const zip = new DataView(await (await fetch(href)).arrayBuffer());
      return zip.getUint16(zip.byteLength - 12, true);
    }, href);
    assert.equal(files, 2);

    const fresh = await context.newPage();
    await fresh.goto(origin + '/fresh');
    await fresh.locator('#body-image').evaluate(img => img.decode());
    await fresh.getByText(/已保存 0 頁/).waitFor();
    await fresh.locator('#body-image').evaluate(img => { img.src = img.dataset.src; });
    await fresh.getByText(/已保存 1 頁/).waitFor();
    await fresh.close();

    const large = await context.newPage();
    await large.goto(origin + '/large');
    await large.getByText(/已保存 1 頁/).waitFor();
    await shelf.getByRole('link', {name: '容量設定'}).click();
    await shelf.locator('#limit').fill('1');
    await shelf.getByRole('button', {name: '儲存上限'}).click();
    await source.getByText(/已保存 0 頁/).waitFor();
    await source.locator('#body-image').evaluate(async img => {
      img.src = '/full.png?reload';
      img.dataset.src = '/full.png?reload';
      await img.decode();
    });
    await source.getByText(/已保存 [12] 頁/).waitFor();

    await source.goto(origin + '/long');
    await source.getByText(/已保存 24 頁/).waitFor();
    const dialog = source.getByRole('dialog', {name: '直向閱讀器'});
    const settings = dialog.getByRole('button', {name: '閱讀設定'});
    await source.getByRole('button', {name: '直向閱讀器'}).click();
    await settings.click();
    await dialog.getByRole('combobox', {name: '閱讀模式'}).selectOption('single');
    await dialog.getByRole('combobox', {name: '外觀'}).selectOption('dark');
    await settings.click();
    await dialog.getByRole('button', {name: '頁面導覽'}).click();
    await dialog.getByRole('button', {name: '小圖選頁'}).click();
    await source.getByRole('dialog', {name: '小圖選頁'}).getByRole('button', {name: '第 24 頁', exact: true}).click();
    await dialog.locator('img[data-index="24"]').waitFor();
    await shelf.goto(origin + '/long#komaglide/shelf');
    await shelf.getByRole('link', {name: '長篇'}).click();
    await shelf.locator('#pages img[data-index="24"]').waitFor();
    assert.equal(await shelf.locator('html').getAttribute('data-reader-theme'), 'dark');
    await shelf.getByRole('button', {name: '頁面導覽'}).click();
    await shelf.getByRole('button', {name: '從頭讀'}).click();
    await shelf.locator('#pages img[data-index="1"]').waitFor();
    await shelf.getByRole('button', {name: '閱讀設定'}).click();
    await shelf.getByRole('combobox', {name: '閱讀模式'}).selectOption('scroll');
    await source.reload();
    await source.getByRole('button', {name: '直向閱讀器'}).click();
    await dialog.locator('img[data-index="1"]').waitFor();
    assert.equal(await dialog.getAttribute('data-reader-mode'), 'scroll');
    const firstHeight = await dialog.locator('figure[data-index="1"]').evaluate(async figure => {
      await figure.querySelector('img').decode();
      return figure.getBoundingClientRect().height;
    });
    await dialog.locator('figure[data-index="24"]').scrollIntoViewIfNeeded();
    await dialog.locator('img[data-index="24"]').waitFor();
    await dialog.locator('img[data-index="1"]').waitFor({state: 'detached'});
    const placeHeight = await dialog.locator('figure[data-index="1"]').evaluate(figure => figure.getBoundingClientRect().height);
    assert(Math.abs(firstHeight - placeHeight) < 2, 'Releasing an offscreen image keeps its place in the scroll layout');
    assert(await dialog.locator('figure img').count() < 12);
    console.log((useWebKit ? 'WebKit' : 'Chromium') + ': migration, lazy images, read-only lookups, ZIP revisions, eviction recovery, shared reading and image release passed');
  } finally { await context.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
