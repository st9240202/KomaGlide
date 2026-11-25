const assert = require('node:assert/strict');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {launchSiteBrowser, readSavedChapter} = require('./site-fixture.cjs');

const origin = 'http://www.amanhuapi.net';
const cdn = 'https://manhuapi.dwdghg.com/tupian/images/comic/44/';
const first = '/chapter/101.html';
const second = '/chapter/102.html';
const images = ['31/one.png', '31/two.png', '31/three.png', '32/four.png'].map(name => cdn + name);
const artwork = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQSOiAIwacHADslwxhjmTwNAAAAABJRU5ErkJggg==', 'base64');

function chapterHTML(chapter, current, pages, next) {
  const options = pages.map((url, i) => '<option value="' + chapter + '?p=' + (i + 1) + '" jhc-data="' + url + '">' +
    '第' + (i + 1) + '页 - 共 ' + pages.length + '页</option>').join('');
  return '<!doctype html><meta charset="utf-8"><div class="mh_cont title"><h1>作品 測試話 ' +
    (chapter === first ? '1' : '2') + ' (<span class="jhc_page">' + current + '/' + pages.length + '</span>)</h1></div>' +
    '<a id="bookname" href="/manhua/9.html">作品</a><div class="mh_list"><p><img src="' + pages[current - 1] +
    '"></p></div><div class="page"><a href="/chapter/100.html" rel="next">上一章</a>' +
    '<select name="titleselect">' + options + '</select>' +
    (next ? '<a href="' + next + '">下一章</a>' : '<a href="/manhua/9.html">下一章</a>') + '</div>' +
    '<img src="' + cdn + '99/advert.png">';
}

async function run() {
  const bundle = await readFile(path.join(__dirname, '../dist/komaglide.user.js'), 'utf8');
  const browser = await launchSiteBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript(({origin, data}) => {
      window.requestedPages = [];
      window.GM = {
        getValue: async (key, fallback) => key === 'kg1.reader-view' ? {mode: 'single'} : fallback,
        setValue: async () => {},
      };
      window.GM_registerMenuCommand = window.GM_addValueChangeListener = () => {};
      window.GM_xmlhttpRequest = request => {
        if (!request.anonymous || request.redirect !== 'error' || request.headers.Referer !== origin + '/') {
          throw new Error('Unexpected image request options');
        }
        window.requestedPages.push(request.url);
        const response = new Blob([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], {type: 'image/png'});
        queueMicrotask(() => request.onload({status: 200, response}));
      };
    }, {origin, data: artwork.toString('base64')});
    const documentReads = [];
    await page.route(/^https?:\/\//, request => {
      const url = new URL(request.request().url());
      if (url.origin === origin && [first, second].includes(url.pathname)) {
        documentReads.push(url.pathname + url.search);
        const body = url.pathname === first
          ? chapterHTML(first, +(url.searchParams.get('p') || '1'), images.slice(0, 3), second)
          : chapterHTML(second, 1, images.slice(3));
        return request.fulfill({contentType: 'text/html; charset=utf-8', body});
      }
      if (request.request().resourceType() === 'image' && url.href.startsWith(cdn)) {
        return request.fulfill({contentType: 'image/png', body: artwork});
      }
      return request.abort();
    });
    await page.goto(origin + first + '?p=2');
    await page.addScriptTag({content: bundle});
    const count = n => page.getByText('已保存 ' + n + ' 頁 / 共 3 頁', {exact: true});
    const requestedPages = () => page.evaluate(() => window.requestedPages);
    await count(1).waitFor();
    assert.deepEqual((await readSavedChapter(page, '9', '101')).pages.map(row => row.index), [2]);
    assert.deepEqual(await requestedPages(), [images[1]], 'only the visible native page should save automatically');
    await page.getByRole('button', {name: '開始載入', exact: true}).click();
    await count(3).waitFor();
    const saved = await readSavedChapter(page, '9', '101');
    assert.equal(saved.chapter.chapterTitle, '測試話 1');
    assert.equal(saved.chapter.chapterUrl, origin + first);
    assert.deepEqual(saved.pages.map(row => row.imageUrl), images.slice(0, 3));
    assert.deepEqual(documentReads, [first + '?p=2'], 'preload should use the page selector’s image list');

    await page.getByRole('button', {name: '直向閱讀器', exact: true}).click();
    const reader = page.getByRole('dialog', {name: '直向閱讀器', exact: true});
    await reader.locator('img[data-index="2"]:visible').waitFor();
    await page.keyboard.press('PageDown');
    await reader.locator('img[data-index="3"]:visible').waitFor();
    await reader.getByRole('button', {name: '頁面導覽', exact: true}).click();
    await reader.getByRole('button', {name: '接上下一話', exact: true}).click();
    await reader.locator('img[data-index="1"]:visible').waitFor();
    await page.getByText('已保存 1／1 頁', {exact: true}).waitFor();
    assert.deepEqual(documentReads, [first + '?p=2', second]);
    assert.deepEqual(await requestedPages(), [images[1], images[0], images[2], images[3]]);
    assert.equal((await readSavedChapter(page, '9', '102')).pages[0].imageUrl, images[3]);
    assert.equal(page.url(), origin + first + '?p=2');
    console.log('Manhuapi native page, chapter preload and continuous reading passed');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
