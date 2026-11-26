// Run node tests/manhuagui.cjs with playwright-core. Set PLAYWRIGHT_BROWSER=webkit to use WebKit.
// The native reader and all image responses are local fixtures.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { launchSiteBrowser, readSavedChapter } = require("./site-fixture.cjs");

const series = "https://tw.manhuagui.com/comic/23394/";
const chapterUrl = series + "762877.html";
const scrollChapterUrl = series + "924812.html";
const mobileOrigin = "https://m.manhuagui.com";
const mobileChapter = mobileOrigin + "/comic/23394/762877.html";
const images = ["017", "003", "024", "009"].map(name =>
  "https://eu2.hamreus.com/ps3/u/rujiantxrml_xx/fixture/" + name + ".jpg.webp?fixture=public");

// Give each fixture page the userscript APIs needed for preferences and CDN reads.
function installManager() {
  const values = new Map();
  window.privileged = [];
  window.GM = {
    async getValue(key, fallback) { return values.get(key) ?? fallback; },
    async setValue(key, value) { values.set(key, value); },
  };
  window.GM_registerMenuCommand = () => {};
  window.GM_addValueChangeListener = () => 1;
  window.GM_xmlhttpRequest = request => {
    window.privileged.push({ url: request.url, method: request.method, anonymous: request.anonymous,
      headers: request.headers || {} });
    window.fixtureImage(request.url).then(({ data, cacheControl }) => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      request.onload({ status: 200, response: new Blob([bytes], { type: "image/png;charset=utf-8" }),
        responseHeaders: "Cache-Control: " + cacheControl });
    }, request.onerror);
  };
}

async function readBundle() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "komaglide-manhuagui-"));
  try {
    execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/build.mjs"), dir]);
    return await readFile(path.join(dir, "komaglide.user.js"), "utf8");
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function readerHTML() {
  const options = images.map((_, i) => '<option value="' + (i + 1) + '">第' + (i + 1) + '頁</option>').join("");
  return '<!doctype html><meta charset="utf-8"><div class="title"><h1><a href="/comic/23394/">測試作品</a></h1>' +
    '<h2>短篇番外</h2><span>( <span id="page">1</span>/' + images.length + ' )</span></div>' +
    '<select id="pageSelect">' + options + '</select><div id="mangaBox">' +
    '<img id="mangaFile" class="mangaFile" src="' + images[0] + '"></div>';
}

function scrollLabel(index) {
  return '<p class="img_info">(<span class="img_page">' + index + '</span>/' + images.length + ')</p>';
}

function scrollPage(index) {
  return '<img data-tag="mangaFile" src="' + images[index - 1] + '">' + scrollLabel(index);
}

async function expectPage(reader, index, expectedBytes) {
  const img = reader.locator('figure:not([hidden]) img[data-index="' + index + '"]');
  await img.waitFor({ timeout: 12_000 });
  const decoded = await img.evaluate(async i => {
    await i.decode();
    return [new URL(i.src).protocol, i.naturalWidth, i.naturalHeight];
  });
  assert.deepEqual(decoded, ["blob:", index + 5, 8], "page " + index + " should decode its own bytes");
  if (expectedBytes) {
    const base64 = await img.evaluate(async i => {
      const bytes = new Uint8Array(await (await fetch(i.src)).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    });
    assert.equal(base64, expectedBytes, "cached scroll page " + index + " must contain the expected image");
  }
}

async function installReader(page, bundle) {
  await page.evaluate(() => GM.setValue("kg1.reader-view", { mode: "double" }));
  await page.addScriptTag({ content: bundle });
}

async function openReader(page) {
  await page.getByRole("button", { name: "直向閱讀器", exact: true }).click({ timeout: 4000 });
  return page.getByRole("dialog", { name: "直向閱讀器", exact: true });
}

async function testMobile(page, bundle, pngs) {
  await page.goto(mobileOrigin + "/list/");
  await page.addScriptTag({ content: bundle });
  assert.equal(await page.getByRole("button", { name: "直向閱讀器", exact: true }).count(), 0);

  await page.goto(mobileChapter + "#p=3");
  await page.evaluate(urls => {
    const current = () => Number(new URLSearchParams(location.hash.slice(1)).get("p") || 1);
    function loadPage() {
      const index = current();
      document.querySelector("#pageNo").textContent = String(index);
      setTimeout(() => {
        if (current() !== index) return;
        const img = document.createElement("img");
        img.src = urls[index - 1];
        document.querySelector("#manga").replaceChildren(img);
      }, 200);
    }
    window.addEventListener("hashchange", loadPage);
    loadPage();
  }, images);
  await installReader(page, bundle);
  await page.getByText("已保存 1 頁 / 共 4 頁", { exact: true }).waitFor();
  const initial = await readSavedChapter(page, "23394", "762877");
  assert.deepEqual(initial.pages.map(row => [row.index, row.imageUrl]), [[3, images[2]]]);
  const historyLength = await page.evaluate(() => history.length);

  await page.getByRole("button", { name: "開始載入", exact: true }).click();
  await page.getByText("已保存 4 頁 / 共 4 頁", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.evaluate(() => history.length), historyLength, "preload should not add native history entries");
  const saved = await readSavedChapter(page, "23394", "762877");
  assert.deepEqual(saved.pages.map(row => [row.index, row.imageUrl]), images.map((url, i) => [i + 1, url]));
  assert.equal(saved.chapter.chapterUrl, mobileChapter);
  assert.equal(saved.chapter.chapterTitle, "短篇番外");
  assert.equal(saved.chapter.workTitle, "測試作品");
  const privileged = await page.evaluate(() => window.privileged);
  assert.deepEqual(privileged.map(req => req.url).sort(), [...images].sort());
  assert(privileged.every(req => req.anonymous && req.headers.Referer === mobileOrigin + "/"));

  await page.goto(mobileChapter + "?cached=1#p=3");
  await page.evaluate(() => {
    const words = Array(37).fill("");
    Object.assign(words, {1:"SMH", 2:"reader", 3:"bookId", 4:"23394", 5:"chapterId", 6:"762877",
      7:"nextId", 8:"762594", 36:"preInit"});
    window.LZString = {decompressFromBase64: () => words.join("|")};
    const packet = document.createElement("script");
    packet.type = "text/plain";
    packet.textContent = "function(p,a,c,k,e,d){return p;}('1.2({\"3\":4,\"5\":6,\"7\":8}).A();',37,37," +
      "'fixture-dictionary'['split']('|'),0,{})";
    document.head.append(packet);
  });
  await installReader(page, bundle);
  const reader = await openReader(page);
  await expectPage(reader, 3, pngs[2]);
  await expectPage(reader, 4, pngs[3]);
  const navigation = reader.getByRole("button", { name: "頁面導覽" });
  await navigation.click();
  await reader.getByRole("button", { name: "接上下一話" }).waitFor({ timeout: 4000 });
  await navigation.click();
  await page.keyboard.press("PageUp");
  await expectPage(reader, 1, pngs[0]);
  await expectPage(reader, 2, pngs[1]);
  assert.deepEqual(await page.evaluate(() => window.privileged), [], "reopening a cached chapter needs no image requests");
}

async function run() {
  const bundle = await readBundle();
  const browser = await launchSiteBrowser();
  try {
    const context = process.env.PLAYWRIGHT_BROWSER === "webkit" ? browser : await browser.newContext();
    const page = await context.newPage();
    const pngs = await page.evaluate(count => Array.from({ length: count }, (_, i) => {
      const canvas = document.createElement("canvas");
      canvas.width = i + 6;
      canvas.height = 8;
      return canvas.toDataURL().split(",")[1];
    }), images.length);
    await context.addInitScript(installManager);
    let cacheControl = "max-age=315360000";
    await context.exposeFunction("fixtureImage", url => {
      assert(images.includes(url), "unexpected privileged URL");
      return { data: pngs[images.indexOf(url)], cacheControl };
    });
    let html = '<h1>測試作品</h1><a href="762877.html">短篇番外</a>';
    const requests = [];
    await context.route(/^https?:\/\//, route => {
      const url = route.request().url();
      if (url === mobileOrigin + "/list/") {
        return route.fulfill({ contentType: "text/html", body: '<a href="/comic/23394/">測試作品</a>' });
      }
      if (url.split("?")[0] === mobileChapter) {
        return route.fulfill({ contentType: "text/html; charset=utf-8",
          body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<h1 id="mangaTitle"><a href="/comic/23394/">測試作品</a> 短篇番外</h1>' +
            '<span class="manga-page"><b id="pageNo">1</b>/4P</span><div id="manga"></div>' });
      }
      if (url === series || url === chapterUrl || url === scrollChapterUrl || url === series + "762878.html") {
        return route.fulfill({ contentType: "text/html;charset=utf-8", body: html });
      }
      if (images.includes(url)) {
        requests.push(url);
        return route.fulfill({ contentType: "image/png", body: Buffer.from(pngs[images.indexOf(url)], "base64") });
      }
      return route.abort();
    });
    await page.goto(series);
    await page.addScriptTag({ content: bundle });
    assert.equal(await page.getByRole("button", { name: "直向閱讀器", exact: true }).count(), 0);

    html = readerHTML();
    await page.goto(chapterUrl);
    await page.evaluate(urls => {
      window.nativeSelections = [];
      const select = document.querySelector("#pageSelect");
      select.addEventListener("change", () => {
        const index = Number(select.value);
        window.nativeSelections.push(index);
        document.querySelector("#page").textContent = String(index);
        location.hash = "p=" + index;
        // The site's page controls can already show the new page while the old
        // image is on screen. Hold the replacement through a source rescan.
        setTimeout(() => {
          if (Number(select.value) !== index) return;
          const img = document.querySelector("#mangaFile").cloneNode(false);
          img.src = urls[index - 1];
          document.querySelector("#mangaFile").replaceWith(img);
        }, 200);
      });
    }, images);
    await installReader(page, bundle);
    await page.getByText(/已保存 1 頁/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.nativeSelections), [], "background cache should preserve native selection");
    // This tab only ever sees native page 1. Its dock must also reflect pages
    // committed by the reader in the first tab.
    const observer = await context.newPage();
    await observer.goto(chapterUrl);
    await installReader(observer, bundle);
    await observer.getByText(/已保存 1 頁/).waitFor();
    let reader = await openReader(page);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The reader is on pages 1–2. Pages 3–4 must reach the shelf while hidden.
    await observer.getByText(/已保存 4 頁/).waitFor({ timeout: 8000 });
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expectPage(reader, 1);
    await expectPage(reader, 2);
    await page.keyboard.press("PageDown");
    await expectPage(reader, 3);
    await expectPage(reader, 4);
    const { chapter, pages } = await readSavedChapter(page, "23394", "762877");
    assert.deepEqual(pages, images.map((imageUrl, i) => ({ index: i + 1, imageUrl, mime: "image/png" })));
    assert.equal(chapter.count, pages.length);
    const storedCount = new RegExp("已保存 " + chapter.count + " 頁");
    await page.getByTitle("開啟本站書庫").filter({ hasText: storedCount }).waitFor({ state: "attached", timeout: 4000 });
    await observer.getByText(storedCount).waitFor({ timeout: 4000 });
    await observer.close();
    assert.deepEqual(chapter.key, [new URL(chapterUrl).origin, "23394", "762877"]);
    assert.equal(chapter.workTitle, "測試作品");
    assert.equal(chapter.chapterTitle, "短篇番外");
    assert.equal(chapter.chapterUrl, chapterUrl);
    assert.equal(chapter.total, images.length);
    assert.deepEqual(await page.evaluate(() => window.privileged), images.map(url => ({
      url, method: "GET", anonymous: true, headers: { Referer: new URL(chapterUrl).origin + "/" },
    })));

    await page.reload();
    // Browsers can request an eager native image on navigation. Measure only
    // activity caused by opening and turning the cached reader on this document.
    requests.length = 0;
    await installReader(page, bundle);
    await page.getByText(storedCount).waitFor({ timeout: 4000 });
    reader = await openReader(page);
    await expectPage(reader, 1);
    await expectPage(reader, 2);
    await page.keyboard.press("PageDown");
    await expectPage(reader, 3);
    await expectPage(reader, 4);
    assert.deepEqual(requests, []);
    assert.deepEqual(await page.evaluate(() => window.privileged), []);

    // The site's continuous-scroll layout leaves the selector at page 1 and
    // appends a page number *after* each loaded image in a separate container.
    // The hidden preload also has a valid CDN URL for a page not yet appended.
    html = readerHTML() + '<div hidden id="imgPreLoad"><img src="' + images[3] + '"></div>' +
      '<div id="mangaMoreBox">' + scrollLabel(1) + scrollPage(2) + '</div>';
    await page.goto(scrollChapterUrl);
    await page.evaluate(() => {
      window.nativeSelections = [];
      const pager = document.querySelector("#pageSelect");
      pager.addEventListener("change", () => window.nativeSelections.push(pager.value));
    });
    await installReader(page, bundle);
    await page.getByText(/已保存 2 頁/).waitFor({ timeout: 4000 });
    let saved = await readSavedChapter(page, "23394", "924812");
    assert.deepEqual(saved.pages.map(p => p.index), [1, 2], "preloaded images outside the scroll container stay out");
    for (const index of [3, 4]) {
      const scrollBox = page.locator("#mangaMoreBox");
      if (index === 3) {
        // A cached image can finish loading before the site inserts its label.
        // Let both the image load handler and the debounced scan finish first.
        await scrollBox.evaluate(async (box, url) => {
          const img = document.createElement("img");
          img.dataset.tag = "mangaFile";
          img.src = url;
          box.append(img);
          await img.decode();
        }, images[index - 1]);
        await page.waitForTimeout(200);
        await scrollBox.evaluate((box, label) => box.insertAdjacentHTML("beforeend", label), scrollLabel(index));
      } else {
        await scrollBox.evaluate((box, markup) => box.insertAdjacentHTML("beforeend", markup), scrollPage(index));
      }
      await scrollBox.locator("p").last().scrollIntoViewIfNeeded();
      await page.getByText(new RegExp("已保存 " + index + " 頁")).waitFor({ timeout: 4000 });
    }
    saved = await readSavedChapter(page, "23394", "924812");
    assert.deepEqual(saved.pages.map(p => [p.index, p.imageUrl]), images.map((url, i) => [i + 1, url]));
    assert.equal(saved.chapter.count, images.length);
    assert.equal(await page.locator("#pageSelect").inputValue(), "1");
    assert.equal(await page.locator("#page").textContent(), "1");
    reader = await openReader(page);
    await expectPage(reader, 1, pngs[0]);
    await expectPage(reader, 2, pngs[1]);
    await page.keyboard.press("PageDown");
    await expectPage(reader, 3, pngs[2]);
    await expectPage(reader, 4, pngs[3]);
    assert.deepEqual(await page.evaluate(() => window.nativeSelections), []);
    assert.deepEqual(await page.evaluate(() => window.privileged.map(r => r.url)), images);
    html = readerHTML();
    cacheControl = "private, no-store";
    await page.goto(series + "762878.html");
    await installReader(page, bundle);
    await page.getByText(/此圖片限線上閱讀/).waitFor();
    const excluded = await readSavedChapter(page, "23394", "762878");
    assert.deepEqual(excluded.pages, [], "no-store responses must stay out of the library");
    assert.equal(excluded.chapter, undefined);
    cacheControl = "max-age=315360000";
    await testMobile(page, bundle, pngs);
    console.log("Manhuagui desktop and mobile capture, preload, page order and cached reader passed");
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
