// Run node scripts/build.mjs, then node tests/czbooks.cjs with playwright-core.
const assert = require('node:assert/strict');
const path = require('node:path');
const { launchSiteBrowser } = require('./site-fixture.cjs');

const origin = 'https://czbooks.net';
const catalog = origin + '/n/sample';
const titles = ['潮聲', '候船室', '回港'];
const body = index => ('第 ' + index + ' 章的測試正文。').repeat(90);
const novelKey = ['小說狂人', 'sample'];
const libraryPath = path.resolve(__dirname, '../library');
const dist = path.resolve(__dirname, '../dist/komaglide.user.js');

function installManager(stayStyle) {
  const values = new Map();
  window.commands = new Map();
  window.GM = {
    getValue: async (key, fallback) => values.get(key) ?? fallback,
    setValue: async (key, value) => { values.set(key, value); },
  };
  const register = (name, callback) => window.commands.set(name, callback);
  const openTab = url => { window.shelfUrl = url; };
  if (stayStyle) {
    window.GM.getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM.registerMenuCommand = register;
    window.GM.openInTab = openTab;
  } else {
    window.GM_registerMenuCommand = register;
    window.GM_openInTab = openTab;
  }
}

async function verifyStore(page) {
  const stats = await page.evaluate(async novelKey => {
    const {putNovelChapter, putPage, readNovelChapter, readExportChapters, setLimit, shelf} = await import('/store.js');
    const first = [...novelKey, 'c1'];
    const third = [...novelKey, 'c3'];
    const paragraphs = await readNovelChapter(first);
    const textBytes = new TextEncoder().encode(JSON.stringify(paragraphs)).byteLength;
    const exportRejected = await readExportChapters([first], () => {}, new AbortController().signal)
      .then(() => false, () => true);
    const {chapters} = await shelf();
    const [site, workId, chapterId] = first;
    const {workTitle, chapterTitle, order} = chapters.find(chapter => chapter.key[2] === chapterId);
    await putNovelChapter({site, workId, chapterId, workTitle, chapterTitle, order}, paragraphs);
    const before = await shelf();
    await readNovelChapter(third); // Read more recently than the favorite.
    await putPage({site: location.origin, workId: 'comic', chapterId: 'ch1', index: 1}, new Blob(['comic']));
    await setLimit(textBytes + 5);
    const after = await shelf();
    return {
      before: before.state.used, after: after.state.used, textBytes, exportRejected,
      first: Boolean(await readNovelChapter(first)), third: Boolean(await readNovelChapter(third)),
      comic: after.chapters.some(chapter => chapter.key[1] === 'comic'),
    };
  }, novelKey);
  assert.deepEqual(stats, {
    before: stats.textBytes * 3, after: stats.textBytes + 5, textBytes: stats.textBytes, exportRejected: true,
    first: true, third: false, comic: true,
  });
}

async function run(ios) {
  const browser = await launchSiteBrowser();
  try {
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true,
      ...(ios ? {userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15"} : {})});
    await context.addInitScript(installManager, ios);
    await context.addInitScript({path: dist});
    const fetched = [];
    await context.route(origin + '/**', route => {
      const {pathname} = new URL(route.request().url());
      if (pathname === '/store.js' || pathname === '/i18n.js') {
        return route.fulfill({path: path.join(libraryPath, pathname), contentType: 'application/javascript'});
      }
      if (pathname === '/n/sample') {
        const links = titles.map((title, i) => '<a href="/n/sample/c' + (i + 1) + '">' + title + '</a>').join('');
        return route.fulfill({contentType: 'text/html', body:
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
          '<div class="novel-detail"><h1 class="title">《潮汐小說》</h1><div id="chapter-list">' + links + '</div></div>'});
      }
      const index = Number(pathname.match(/\/c(\d+)$/)?.[1]);
      if (!index) return route.abort();
      fetched.push(index);
      return route.fulfill({contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><div class="chapter-detail">' +
        '<h1 class="name">《潮汐小說》' + titles[index - 1] + '</h1><div class="content"><p>' + body(index) + '</p></div></div>'});
    });

    const page = await context.newPage();
    await page.goto(catalog);
    await page.waitForFunction(() => window.commands.has('開啟 KomaGlide 書庫') && window.commands.has('KomaGlide 小說閱讀器'));
    await page.getByRole('button', {name: 'KomaGlide 小說閱讀器'}).click();
    const reader = ios ? page : page.frameLocator('iframe[title="KomaGlide 小說閱讀器"]');
    await reader.getByText(body(1)).waitFor();
    if (ios) {
      assert.equal(await page.evaluate(() => {
        window.scrollTo(0, 300);
        return window.scrollY >= 300 && document.getElementById('reader').scrollTop === 0;
      }), true, 'The top-level document scrolls on iOS');
    }
    await reader.locator('#reader').evaluate(element => {
      const doc = element.ownerDocument;
      const area = doc.documentElement.classList.contains('native-scroll') ? doc.scrollingElement : element;
      area.scrollTop = 450;
    });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kg1.novel.czbooks.sample.progress.c1'))?.offset > 0);
    await reader.getByRole('button', {name: '目錄', exact: true}).click();
    await reader.locator('#mobile-toc').getByRole('button', {name: /回港/}).click();
    await reader.getByText(body(3)).waitFor();
    await reader.getByRole('button', {name: '返回原站'}).click();
    await page.getByRole('button', {name: 'KomaGlide 小說閱讀器'}).click();
    await reader.getByText(body(3)).waitFor();
    await reader.getByRole('button', {name: '返回原站'}).click();
    assert.deepEqual(fetched, [1, 3], 'Reopening the source reader uses the saved chapter');
    await page.evaluate(() => window.commands.get('開啟 KomaGlide 書庫')());
    await page.waitForFunction(() => window.shelfUrl?.endsWith('#komaglide/shelf'));
    assert.equal(await page.evaluate(() => window.shelfUrl), catalog + '#komaglide/shelf');

    const other = await context.newPage();
    const otherSite = 'https://unrelated.example/';
    await other.route(otherSite, route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Other site</title>'}));
    await other.goto(otherSite);
    await other.exposeFunction('sharedValue', (key, fallback) =>
      page.evaluate(([key, fallback]) => GM.getValue(key, fallback), [key, fallback]));
    await other.evaluate(() => { GM.getValue = window.sharedValue; });
    await other.waitForFunction(() => window.commands.has('小說書庫'));
    await other.evaluate(() => window.commands.get('小說書庫')());
    const novelShelf = await other.evaluate(() => window.shelfUrl);
    assert.equal(novelShelf, catalog + '#komaglide/novels');
    await other.goto(novelShelf);
    await other.getByRole('heading', {name: '小說書庫', exact: true}).waitFor();
    await other.getByText('小說狂人 · 已存 2 章').waitFor();
    // Simulate a book cached by a version that stored text but no catalog.
    await page.evaluate(async () => (await import('/store.js')).saveNovelCatalog('sample', []));
    let releaseCatalog;
    const gate = new Promise(resolve => { releaseCatalog = resolve; });
    await other.route(catalog, async route => {
      await gate;
      await route.fallback();
    });
    await other.getByRole('link', {name: '潮聲'}).click();
    const otherReader = ios ? other : other.frameLocator('iframe[title="KomaGlide 小說閱讀器"]');
    await otherReader.getByText(body(1)).waitFor();
    assert.equal(await otherReader.locator('#next').isDisabled(), true, 'Wait for the missing catalog entry instead of skipping a chapter');
    releaseCatalog();
    await otherReader.locator('#toc .chapter-link').filter({hasText: '候船室'}).waitFor({state: 'attached'});
    await page.waitForFunction(async () => (await (await import('/store.js')).readNovelCatalog('sample'))?.length === 3);
    await other.close();

    await page.reload();
    await context.setOffline(true);
    await page.evaluate(() => window.commands.get('開啟 KomaGlide 書庫')());
    await page.getByRole('heading', {name: '潮汐小說'}).waitFor();
    await page.getByText('小說狂人 · 已存 2 章').waitFor();
    assert.equal(await page.getByText('可離線讀').count(), 2);
    assert.equal(await page.getByRole('link', {name: '候船室'}).count(), 0);
    await page.getByRole('link', {name: '潮聲'}).click();
    await reader.getByText(body(1)).waitFor();
    assert.ok(await reader.locator('#reader').evaluate(element =>
      Math.max(element.scrollTop, element.ownerDocument.scrollingElement.scrollTop)) > 300,
      'Opening a previously read chapter from the offline shelf restores its text position');
    await reader.locator('#toc .chapter-link').filter({hasText: '候船室'}).waitFor({state: 'attached'});
    assert.deepEqual(fetched, [1, 3], 'The full catalog does not prefetch any chapter text');
    await reader.locator('#next').click();
    await reader.getByRole('button', {name: '重試'}).waitFor();
    assert.equal(await reader.locator('#chapter-title').innerText(), '潮聲');
    await context.setOffline(false);
    await reader.getByRole('button', {name: '重試'}).click();
    await reader.getByText(body(2)).waitFor();
    assert.deepEqual(fetched, [1, 3, 2], 'Retry downloads just the missing chapter');
    await context.setOffline(true);
    await reader.locator('#next').click();
    await reader.getByText(body(3)).waitFor();
    await reader.getByText('第 3 章', {exact: true}).waitFor();
    await reader.getByRole('button', {name: '返回書庫'}).click();
    await page.getByRole('heading', {name: '潮汐小說'}).waitFor();
    await page.getByRole('link', {name: '候船室'}).click();
    await reader.getByText(body(2)).waitFor();
    await reader.getByRole('button', {name: '返回書庫'}).click();
    assert.deepEqual(fetched, [1, 3, 2], 'Downloaded chapter can be reopened offline');

    await page.getByRole('button', {name: '收藏本章'}).first().click();
    await page.getByRole('button', {name: '已收藏本章', exact: true}).waitFor();
    await page.getByRole('link', {name: '收藏', exact: true}).click();
    await page.getByRole('link', {name: '潮聲'}).waitFor();
    await page.getByRole('link', {name: '回港'}).waitFor({state: 'detached'});
    await page.getByRole('link', {name: '匯出模式'}).click();
    await page.getByRole('heading', {name: '書架上還沒有漫畫'}).waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 0);
    await context.setOffline(false);
    await verifyStore(page);
    console.log('Czbooks cache, offline reader, original chapter order, favorites, quota, and comic ZIP exclusion passed');
  } finally {
    await browser.close();
  }
}

run(false).then(() => run(true)).catch(error => { console.error(error); process.exitCode = 1; });
