// Run node scripts/build.mjs, then node tests/standalone.cjs.
// Set TEST_BROWSER=webkit to exercise mobile WebKit with the same fixture.
// Python 3 independently extracts and checks the downloaded ZIP files.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { chromium, webkit } = require("playwright-core");

const origin = "https://reader.example";
const chapter = origin + "/chapter/1";
const images = [origin + "/1.png", origin + "/2.png"];
const unrelated = "https://example.org/start";

function chapterHTML(imagesAvailable) {
  const slots = images.map(url => '<img ' + (imagesAvailable ? 'src' : 'data-src') + '="' + url + '">').join("");
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<h1>第一話</h1><span data-comic-work="測試作品"></span><div id="comic">' + slots + '</div>';
}

function installManager() {
  window.GM = { getValue: window.managerGet, setValue: window.managerSet };
  window.commands = new Map();
  window.tabRequests = [];
  window.GM_addValueChangeListener = () => 1;
  window.GM_removeValueChangeListener = () => {};
  window.GM_registerMenuCommand = (name, callback) => window.commands.set(name, callback);
  window.GM_openInTab = (url, options) => {
    window.tabRequests.push({url, options});
    if (!window.usingShelfAction) void window.unexpectedAccess("open tab " + url);
    return { closed: false };
  };
  window.open = url => window.unexpectedAccess("open window " + url);
  window.GM_xmlhttpRequest = options => window.unexpectedAccess("privileged request " + options.url);
}

async function expectSavedPages(reader, pngs) {
  for (const [i, expected] of pngs.entries()) {
    const image = reader.locator('figure img[data-index="' + (i + 1) + '"]');
    await image.waitFor();
    const data = await image.evaluate(async img => {
      await img.decode();
      if (!img.src.startsWith("blob:")) throw new Error("Reader did not use a local image");
      const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    });
    assert.equal(data, expected, "page " + (i + 1) + " must render the saved bytes in order");
  }
}

async function openReader(page, pngs) {
  await page.getByRole("button", { name: "直向閱讀器", exact: true }).tap();
  await expectSavedPages(page.getByRole("dialog", { name: "直向閱讀器", exact: true }), pngs);
}

async function expectTouchTarget(button) {
  const box = await button.boundingBox();
  assert(box && box.width >= 44 && box.height >= 44, "touch target must be at least 44 × 44 CSS pixels");
}

async function expectComicExport(context, shelf, emptyShelf, pngs, engine) {
  await emptyShelf.goto(unrelated + "#komaglide/export");
  await emptyShelf.getByRole("heading", { name: "書架上還沒有漫畫" }).waitFor();
  assert.equal(await emptyShelf.getByRole("button", { name: "準備 ZIP" }).isEnabled(), false);

  const addChapters = async ({ png, missingPage }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("komaglide-library-v1", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const tx = db.transaction(["chapters", "pages"], "readwrite");
      const chapters = tx.objectStore("chapters");
      const pages = tx.objectStore("pages");
      const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0)).buffer;
      // Simulate existing WebKit byte records, including sparse and ungrouped pages.
      for (const [workId, chapterId, chapterTitle, index] of [
        ["another", "1", "同名章節", 2], ["another", "2", "同名章節", 10], ["", "3", "單話", 4],
      ]) {
        const key = [location.origin, workId, chapterId];
        chapters.put({ key, workKnown: !!workId, workTitle: "漫畫/表紙?", chapterTitle,
          count: 1, bytes: bytes.byteLength, total: 10, lastRead: workId ? 2 : 1 }, key);
        if (!missingPage || chapterId !== "2") pages.put({ bytes, mime: "image/png" }, [...key, index]);
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  };
  await shelf.evaluate(addChapters, { png: pngs[0], missingPage: true });
  const mode = shelf.getByRole("link", { name: "匯出模式", exact: true });
  await expectTouchTarget(mode);
  await mode.tap();
  const prepare = shelf.getByRole("button", { name: "準備 ZIP", exact: true });
  const download = shelf.getByRole("link", { name: "下載 ZIP", exact: true });
  const single = shelf.getByRole("checkbox", { name: "第一話", exact: true });
  await single.waitFor();
  assert.equal(await prepare.isEnabled(), false);
  assert.equal(await shelf.getByRole("checkbox", { name: "同名章節" }).count(), 2);
  await expectTouchTarget(shelf.locator(".export-check").first());
  await single.press("Space");
  await shelf.getByText("已選 1 話，共 2 頁", { exact: true }).waitFor();

  async function downloadEntries() {
    await prepare.tap();
    await download.waitFor();
    await expectTouchTarget(download);
    const [file] = await Promise.all([shelf.waitForEvent("download"), download.tap()]);
    assert.match(file.suggestedFilename(), /^KomaGlide-reader\.example-\d{4}-\d{2}-\d{2}\.zip$/);
    const entries = execFileSync("python3", ["-c", [
      "import base64, json, sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      "    assert z.testzip() is None",
      "    print(json.dumps([[name, base64.b64encode(z.read(name)).decode()] for name in z.namelist()]))",
    ].join("\n"), await file.path()], { encoding: "utf8" });
    return JSON.parse(entries);
  }

  const networkRequests = [];
  const blockNetwork = route => {
    networkRequests.push(route.request().url());
    return route.abort("internetdisconnected");
  };
  const networkUrls = /^https?:/;
  await context.route(networkUrls, blockNetwork);
  // WebKit's Playwright offline switch also blocks reading freshly created local Blobs.
  if (engine === "chromium") await context.setOffline(true);
  try {
    const images = await downloadEntries();
    assert.deepEqual(images.map(([name, bytes]) => [name.split("/").at(-1), bytes]),
      [["001.png", pngs[0]], ["002.png", pngs[1]]]);
    await shelf.getByRole("button", { name: "全選", exact: true }).tap();
    await shelf.getByText("已選 4 話，共 5 頁", { exact: true }).waitFor();
    assert.equal(await download.isVisible(), false);
    await prepare.tap();
    await shelf.getByText("部分選取的章節已無法讀取，請確認選取後重試。", { exact: true }).waitFor();
    assert.equal(await download.isVisible(), false);
    await shelf.evaluate(addChapters, { png: pngs[0], missingPage: false });
    const all = await downloadEntries();
    assert.deepEqual(all.slice(0, 2), images);
    assert.deepEqual(all.slice(2), [
      ["2 - 漫畫_表紙_/1 - 同名章節/002.png", pngs[0]],
      ["2 - 漫畫_表紙_/2 - 同名章節/010.png", pngs[0]],
      ["3 - 單話/004.png", pngs[0]],
    ]);
    await shelf.getByRole("button", { name: "清除選取", exact: true }).tap();
    await shelf.getByText("已選 0 話，共 0 頁", { exact: true }).waitFor();
    assert.equal(await prepare.isEnabled(), false);
    await shelf.getByRole("link", { name: "全部作品", exact: true }).tap();
    await shelf.getByRole("link", { name: "第一話", exact: true }).waitFor();
    assert.equal(await download.count(), 0);
    assert.deepEqual(networkRequests, [], "ZIP preparation and download must use only local data");
  } finally {
    if (engine === "chromium") await context.setOffline(false);
    await context.unroute(networkUrls, blockNetwork);
  }
}

async function expectSwipeTurns(page, reader, direction) {
  const settings = reader.getByRole("button", { name: "閱讀設定", exact: true });
  const mode = reader.getByRole("combobox", { name: "閱讀模式" });
  const readingDirection = reader.getByRole("combobox", { name: "翻頁方向" });
  const tapToTurn = reader.getByRole("checkbox", { name: "點按翻頁" });
  await settings.tap();
  await mode.selectOption("single");
  await readingDirection.selectOption(direction);
  await tapToTurn.uncheck();
  await settings.tap();

  const session = await page.context().newCDPSession(page);
  async function swipe(x, y, dx, dy) {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: x + dx * fraction, y: y + dy * fraction }],
      });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  const image = index => reader.locator('img[data-index="' + index + '"]');
  const forward = direction === "rtl" ? 1 : -1;
  try {
    await image(1).waitFor();
    await swipe(190, 240, 16 * forward, 0);
    await swipe(190, 240, 0, 140);
    assert.equal(await image(2).isVisible(), false, "short and vertical gestures should keep page one");
    await swipe(190 - 100 * forward, 240, 190 * forward, 0);
    await image(2).waitFor();
    await swipe(190 - 100 * forward, 240, 190 * forward, 0);
    assert.equal(await image(2).isVisible(), true, "swipe stops at the chapter boundary");
    await swipe(190 + 100 * forward, 240, -190 * forward, 0);
    await image(1).waitFor();
  } finally {
    await session.detach();
  }

  await settings.tap();
  await mode.selectOption("scroll");
  await readingDirection.selectOption("rtl");
  await tapToTurn.check();
  await settings.tap();
}

async function expectDockInsideVisualViewport(page) {
  const originalSize = page.viewportSize();
  try {
    for (const size of [{ width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
      await page.setViewportSize(size);
      const positions = await page.evaluate(async () => {
        const dock = document.querySelector('.kg-source-tools').shadowRoot.querySelector('.dock');
        const viewport = window.visualViewport;
        const filler = document.createElement('div');
        filler.style.height = '300vh';
        document.body.append(filler);
        const maxScroll = document.documentElement.scrollHeight - innerHeight;
        // Model the browser bars changing the visible area without resizing the
        // layout viewport. The headless browser has no iPadOS browser chrome.
        try {
          const samples = [];
          for (const [scrollTop, hiddenHeight, offsetTop, event] of [
            [0, 64, 0, 'resize'],
            [maxScroll / 2, 64, 24, 'scroll'],
            [maxScroll, 0, 0, 'resize'],
          ]) {
            window.scrollTo(0, scrollTop);
            const height = innerHeight - hiddenHeight;
            Object.defineProperties(viewport, {
              height: { configurable: true, value: height },
              offsetTop: { configurable: true, value: offsetTop },
            });
            viewport.dispatchEvent(new Event(event));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const rect = dock.getBoundingClientRect();
            samples.push({ top: rect.top, bottomGap: height + offsetTop - rect.bottom, offsetTop, scrollTop });
          }
          return samples;
        } finally {
          delete viewport.height;
          delete viewport.offsetTop;
          viewport.dispatchEvent(new Event('resize'));
          filler.remove();
          window.scrollTo(0, 0);
        }
      });
      for (const position of positions) {
        assert(position.top >= position.offsetTop && position.bottomGap >= 7 && position.bottomGap <= 64,
          `dock must stay above the visible viewport edge: ${JSON.stringify(position)}`);
      }
    }
  } finally {
    await page.setViewportSize(originalSize);
  }
}

async function run() {
  const bundle = await readFile(path.join(__dirname, "../dist/komaglide.user.js"), "utf8");
  const engine = process.env.TEST_BROWSER || "chromium";
  assert(["chromium", "webkit"].includes(engine), "TEST_BROWSER must be chromium or webkit");
  const profile = await mkdtemp(path.join(tmpdir(), "komaglide-standalone-"));
  let context;
  try {
    const browserType = engine === "webkit" ? webkit : chromium;
    context = await browserType.launchPersistentContext(profile, {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      ...(engine === "chromium" ? { channel: "chromium", executablePath: process.env.CHROMIUM_PATH } : {}),
    });
    context.setDefaultTimeout(10000);
    const unexpected = [];
    const settings = new Map();
    await context.exposeFunction("managerGet", (key, fallback) => settings.get(key) ?? fallback);
    await context.exposeFunction("managerSet", (key, value) => { settings.set(key, value); });
    await context.exposeFunction("unexpectedAccess", message => { unexpected.push(message); });
    // Run at document-start, as both managers do for this script. Injecting
    // after goto would miss first-open races between the host and shelf DOMs.
    await context.addInitScript({ content:
      '(' + installManager.toString() + ')();\nif (/^https?:$/.test(location.protocol)) {\n' + bundle + '\n}'
    });
    let pageCount = 0;
    context.on("page", () => { pageCount++; });
    let page = await context.newPage();
    const pngs = await page.evaluate(() => ["red", "blue"].map(color => {
      const canvas = document.createElement("canvas");
      canvas.width = 9;
      canvas.height = 7;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL().split(",")[1];
    }));
    let imagesAvailable = true;
    await context.route(/^https?:/, async route => {
      const url = route.request().url().split("#")[0];
      if (url === chapter) return route.fulfill({ contentType: "text/html; charset=utf-8", body: chapterHTML(imagesAvailable) });
      if (url === unrelated || url === origin + "/") {
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Start</title>" });
      }
      const index = images.indexOf(url);
      if (index !== -1 && imagesAvailable) {
        return route.fulfill({ contentType: "image/png", headers: { "Cache-Control": "no-store" }, body: Buffer.from(pngs[index], "base64") });
      }
      unexpected.push(url);
      return route.abort();
    });
    await page.goto(chapter);
    const shelfShortcut = page.getByRole("button", { name: /書庫.*已保存 2 頁/ });
    await shelfShortcut.waitFor();
    await expectTouchTarget(shelfShortcut);
    await expectTouchTarget(page.getByRole("button", { name: "直向閱讀器", exact: true }));
    await expectDockInsideVisualViewport(page);
    await openReader(page, pngs);
    if (engine === "chromium") {
      await expectSwipeTurns(page, page.getByRole("dialog", { name: "直向閱讀器", exact: true }), "rtl");
    }
    const reader = page.getByRole("dialog", { name: "直向閱讀器", exact: true });
    await reader.getByRole("button", { name: "閱讀設定", exact: true }).tap();
    await page.evaluate(() => { window.usingShelfAction = true; });
    await reader.getByRole("button", { name: "書庫", exact: true }).tap();
    await page.waitForFunction(() => window.tabRequests.length > 0);
    assert.deepEqual(await page.evaluate(() => window.tabRequests), [
      {url:chapter + "#komaglide/shelf", options:{active:true, setParent:false}},
    ]);
    assert.equal(await reader.isVisible(), true, "the shelf opens separately from the current reader");
    await page.close();

    // First load the chapter document again. Its image hints remain available
    // to the reader, but every attempt to reach either image now fails the test.
    imagesAvailable = false;
    page = await context.newPage();
    await page.goto(chapter);
    await openReader(page, pngs);
    assert.equal(pageCount, 2, "only the two comic tabs opened by the test may exist");
    await page.goto(unrelated);
    await page.waitForFunction(() => window.commands.has("開啟 KomaGlide 書庫"));
    await page.evaluate(async () => {
      window.usingShelfAction = true;
      await window.commands.get("開啟 KomaGlide 書庫")();
    });
    await page.waitForFunction(() => window.tabRequests.length > 0);
    const requests = await page.evaluate(() => window.tabRequests);
    assert.equal(requests.length, 1);
    const target = new URL(requests[0].url);
    assert.equal(target.origin, origin, "open the last comic site's shelf from an unrelated page");
    assert.equal(target.hash, "#komaglide/shelf");
    assert.notEqual(requests[0].options?.active, false, "the explicit shelf opens in the foreground");

    const shelf = await context.newPage();
    await shelf.goto(target.href);
    await shelf.getByRole("heading", { name: /書庫/, level: 1 }).waitFor();
    await shelf.evaluate(() => {
      window.testStorage = {
        persist: () => new Promise(resolve => {
          window.finishStorageRequest = resolve;
        }),
        persisted: async () => false,
      };
      Object.defineProperty(navigator, "storage", { configurable: true, get: () => window.testStorage });
    });
    const bookmark = shelf.getByRole("button", { name: "收藏單話", exact: true, pressed: false });
    await expectTouchTarget(bookmark);
    await bookmark.tap();
    await shelf.getByText("已收藏。", { exact: true }).waitFor();
    await shelf.getByRole("button", { name: "已收藏單話", exact: true, pressed: true }).waitFor();
    await shelf.evaluate(() => window.finishStorageRequest(false));
    await shelf.locator("#notice").filter({ hasText: "瀏覽器未核准這次持久儲存申請。" }).waitFor();
    await shelf.getByRole("link", { name: "查看儲存診斷" }).tap();
    await shelf.getByText("navigator.storage.persisted() 回傳 false", { exact: true }).waitFor();
    await shelf.getByText("navigator.storage.persist() 回傳 false", { exact: true }).waitFor();
    const requestStorage = shelf.getByRole("button", { name: "申請持久儲存" });
    await expectTouchTarget(requestStorage);
    await shelf.evaluate(() => { window.testStorage.persist = undefined; });
    await requestStorage.tap();
    await shelf.locator("#retention-result").filter({ hasText: "目前的瀏覽器環境未提供持久儲存申請功能。" }).waitFor();
    await shelf.evaluate(() => {
      window.testStorage.persist = () => { throw new DOMException("Request blocked", "SecurityError"); };
      window.testStorage.persisted = () => Promise.reject(new DOMException("Status unavailable", "NotAllowedError"));
    });
    await requestStorage.tap();
    await shelf.getByText("navigator.storage.persist() · SecurityError · Request blocked", { exact: true }).waitFor();
    await shelf.getByText("navigator.storage.persisted() · NotAllowedError · Status unavailable", { exact: true }).waitFor();
    await shelf.evaluate(() => {
      window.testStorage.persist = async () => true;
      window.testStorage.persisted = async () => true;
    });
    await requestStorage.tap();
    await shelf.getByText("瀏覽器已授予持久儲存。", { exact: true }).last().waitFor();
    await shelf.getByRole("link", { name: "返回書庫", exact: true }).tap();
    await shelf.getByRole("link", { name: "收藏", exact: true }).tap();
    assert.equal(new URL(shelf.url()).hash, "#komaglide/favorites");
    await shelf.getByRole("link", { name: "第一話", exact: true }).tap();
    assert.match(new URL(shelf.url()).hash, /^#komaglide\/read\//);
    await expectSavedPages(shelf, pngs);
    await shelf.reload();
    await expectSavedPages(shelf, pngs);
    if (engine === "chromium") await expectSwipeTurns(shelf, shelf.locator("#reader"), "ltr");

    await shelf.goto(target.href);
    assert.equal(await shelf.locator("html").getAttribute("lang"), "zh-Hant");
    const locales = [
      ["en", "Site Library", "Vertical Reader", "Reading Settings", "Open KomaGlide Library"],
      ["ja", "このサイトの本棚", "縦読みリーダー", "閲覧設定", "KomaGlide の本棚を開く"],
      ["zh-Hans", "本站书库", "纵向阅读器", "阅读设置", "打开 KomaGlide 书库"],
    ];
    for (const [language, library, reader, settingsLabel, menuLabel] of locales) {
      await shelf.locator("#library-language").selectOption(language);
      await shelf.locator('html[lang="' + language + '"]').waitFor({ state: "attached" });
      await shelf.getByRole("heading", { name: library, exact: true }).waitFor();
      assert.equal(await shelf.locator("#library-language").inputValue(), language);

      // The same manager preference applies when a chapter is opened again.
      await page.goto(chapter);
      await page.waitForFunction(label => window.commands.has(label), menuLabel);
      await page.getByRole("button", { name: reader, exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: reader, exact: true });
      await dialog.getByRole("button", { name: settingsLabel, exact: true }).tap();
      const panel = dialog.locator("#kg-left-panel");
      assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth));
    }
    await shelf.locator("#library-language").selectOption("zh-Hant");
    await shelf.locator('html[lang="zh-Hant"]').waitFor({ state: "attached" });
    await shelf.getByRole("heading", { name: "本站書庫", exact: true }).waitFor();
    await expectComicExport(context, shelf, page, pngs, engine);
    assert.equal(pageCount, 3);
    assert.deepEqual(unexpected, [], "no automatic tabs, library requests or uncached image loads");
    console.log(engine + ": capture, cached reread, chapter reload, interface languages and offline ZIP downloads passed on touch layout");
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
