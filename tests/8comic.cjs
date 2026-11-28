// Run node tests/8comic.cjs with playwright-core. Set PLAYWRIGHT_BROWSER=webkit to use WebKit.
// All browser requests are intercepted. The 4×3 PNG is synthetic.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { launchSiteBrowser, readSavedChapter } = require("./site-fixture.cjs");

const chapterUrl = "https://articles.onemoreplace.tw/online/new-23337.html?ch=1";
const cdn = "https://img9.8comic.com";
const imageUrl = index => cdn + "/3/23337/1/" + String(index).padStart(3, "0") + "_Fixture.jpg";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQSOiAIwacHADslwxhjmTwNAAAAABJRU5ErkJggg==", "base64");

function slot(index, src, imgClass = "") {
  return '<div class="comics-pic"><a name="p' + index + '"></a><img s="opaque" class="' + imgClass +
    '" draggable="false"' + (src ? ' src="' + src + '"' : '') + '><b>' + index + '</b></div>';
}

function splitChapter(firstSrc) {
  return '<li class="view-titles"><a href="https://www.8comic.com/html/23337.html">' +
    '魔法少女x敗北裁判 <small>第2集</small><small> (31P)</small></a></li>' +
    '<style>.comics-pic { height: 160vh }</style><div class="pinch-zoom">' +
    Array.from({ length: 31 }, (_, i) => slot(i + 1, i === 0 ? firstSrc : "")).join("") + '</div>';
}

async function openSpread(page, bundle) {
  await page.evaluate(() => localStorage.setItem("komaglide.reader.preferences.v1", JSON.stringify({mode: "double"})));
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "直向閱讀器", exact: true }).click();
  const reader = page.getByRole("dialog", { name: "直向閱讀器", exact: true });
  for (const index of [1, 2]) {
    const img = reader.locator('figure img[data-index="' + index + '"]');
    await img.waitFor({ timeout: 12_000 });
    assert.deepEqual(await img.evaluate(async el => {
      await el.decode();
      return [el.src.startsWith("blob:"), el.naturalWidth, el.naturalHeight];
    }), [true, 4, 3], "reader should decode stored or freshly captured page " + index);
  }
}

// Only preferences and privileged image requests need a userscript-manager shim.
function installGM(pngData) {
  window.privileged = [];
  const values = new Map();
  const bytes = Uint8Array.from(atob(pngData), ch => ch.charCodeAt(0));
  window.GM = {
    async getValue(key, fallback) { return values.get(key) ?? fallback; },
    async setValue(key, value) { values.set(key, value); },
  };
  window.GM_addValueChangeListener = () => 1;
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = request => {
    const { url, method, responseType, anonymous, redirect, headers } = request;
    window.privileged.push({ url, method, responseType, anonymous, redirect, headers: headers || {} });
    const response = new Blob([bytes], { type: "image/png" });
    request.onload({ status: 200, response });
  };
}

async function testChapterContinuation(browser, bundle) {
  const page = await browser.newPage();
  try {
    const first = chapterUrl.replace("ch=1", "ch=2a");
    const final = chapterUrl.replace("ch=1", "ch=2b");
    const destination = final + "&ccTheme=night#?ch=2b&rpkey=session";
    await page.addInitScript({
      content: '(' + installGM.toString() + ')(' + JSON.stringify(png.toString("base64")) + ');\n' + bundle,
    });
    await page.route(/^https?:\/\//, route => {
      const request = route.request();
      if (request.resourceType() !== "document") return route.fulfill({contentType:"image/png", body:png});
      const initial = new URL(request.url()).searchParams.get("ch") === "2a";
      const token = initial ? "2a" : "2b";
      return route.fulfill({contentType:"text/html; charset=utf-8", body:
        '<!doctype html><meta charset="utf-8"><li class="view-titles"><a href="https://www.8comic.com/html/23337.html">' +
        'Fixture <small>第2集</small><small>(1P)</small></a></li><a id="nextvol">下一集</a>' +
        '<div class="pinch-zoom">' + slot(1, imageUrl(1).replace("/1/", "/" + token + "/")) + '</div>' +
        '<script>window.ch = 2; window.chs = 3; window.ni = "2b"; window.reurl = () => ' +
        JSON.stringify(destination) + ';</script>'});
    });
    await page.goto(first);
    await page.evaluate(() => localStorage.setItem("komaglide.reader.preferences.v1", JSON.stringify({mode: "scroll"})));
    await page.getByRole("button", {name:"直向閱讀器", exact:true}).click();
    const reader = page.getByRole("dialog", {name:"直向閱讀器", exact:true});
    const image = reader.locator("figure img");
    await image.evaluate(img => img.decode());
    // The whole page fits in the viewport. A forward gesture at the bottom
    // must respect the default-off setting even though the next URL is known.
    await reader.dispatchEvent("wheel", {deltaY:200});
    assert.equal(page.url(), first);
    await reader.getByRole("button", {name:"閱讀設定"}).click();
    await reader.getByRole("checkbox", {name:"自動接下一話"}).click();
    await page.waitForURL(destination);
    await reader.waitFor();
    assert.equal(await reader.locator(".source-chapter-title").textContent(), "第2集（2b）");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("kg1.reader-continuation")), null);
    await reader.getByRole("button", {name:"頁面導覽"}).click();
    assert.equal(await reader.getByRole("button", {name:"接上下一話"}).count(), 0);
    await page.reload();
    await page.getByRole("button", {name:"直向閱讀器", exact:true}).waitFor();
    assert.equal(await reader.count(), 0, "refresh must not reuse the one-shot continuation");
  } finally { await page.close(); }
}

async function run() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "komaglide-8comic-"));
  let bundle;
  try {
    execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/build.mjs"), dir]);
    bundle = await readFile(path.join(dir, "komaglide.user.js"), "utf8");
  } finally { await rm(dir, { recursive: true, force: true }); }
  const permissions = [...bundle.matchAll(/^\/\/\s+@connect\s+(\S+)\s*$/gm)].map(match => match[1]);
  assert(!permissions.includes("*"));
  assert.deepEqual(permissions.filter(host => /(^|\.)8comic\.com$/i.test(host)).sort(), ["img7.8comic.com", "img9.8comic.com"]);
  const browser = await launchSiteBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript(installGM, png.toString("base64"));
    let html = '<li class="view-titles"><a href="https://www.8comic.com/html/23337.html">' +
      '魔法少女x敗北裁判 <small>第1集</small><small> (57P)</small></a></li>' +
      '<div class="pinch-zoom">' + slot(4, "") + slot(2, imageUrl(2)) + slot(1, imageUrl(1)) +
      slot(5, imageUrl(5), "advertisement") + '</div><aside>' + slot(3, imageUrl(3)) + '</aside>';
    const imageRequests = [];
    const fetches = [];
    let heldNativeImage;
    await page.route(/^https?:\/\//, async route => {
      const req = route.request();
      if (req.resourceType() === "document") {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8">' + html });
      }
      if (req.resourceType() === "image") {
        imageRequests.push(req.url());
        if (req.url() === heldNativeImage?.url) await heldNativeImage.pending;
      }
      if (req.resourceType() === "fetch") fetches.push(req.url());
      return route.fulfill({ contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: png });
    });
    await page.goto(chapterUrl + "&ccTheme=night#?ch=1&rpkey=session&rpStart=1");
    await page.addScriptTag({ content: bundle });
    await page.getByText(/已保存 2 頁/).waitFor();
    assert(!imageRequests.includes(imageUrl(4)), "an unseen page must wait for the native loader");
    await page.evaluate(src => {
      location.hash = "?ch=1&rpkey=changed&rpStart=4";
      document.querySelector('.pinch-zoom img:not([src])').src = src;
    }, imageUrl(4));
    await page.getByText(/已保存 3 頁/).waitFor();
    const { chapter, pages } = await readSavedChapter(page, "23337", "23337:1");
    assert.deepEqual(chapter.key, [new URL(chapterUrl).origin, "23337", "23337:1"]);
    assert.deepEqual([chapter.chapterTitle, chapter.chapterUrl, chapter.workTitle, chapter.workKnown, chapter.total],
      ["第1集", chapterUrl, "魔法少女x敗北裁判", true, 57]);
    const expected = [1, 2, 4].map(index => ({ index, imageUrl: imageUrl(index), mime: "image/png" }));
    assert.deepEqual(pages, expected);
    const requests = await page.evaluate(() => window.privileged);
    assert.deepEqual(requests, expected.map(p => ({ url: p.imageUrl, method: "GET", responseType: "blob",
      anonymous: true, redirect: "error", headers: {} })));
    assert.deepEqual(fetches, []);

    const splitUrl = chapterUrl.replace("ch=1", "ch=2a");
    const firstImage = "https://img7.8comic.com/3/23337/2a/001_HV9.jpg";
    const secondImage = "https://img7.8comic.com/3/23337/2a/002_Fixture.jpg";
    let releaseFirstImage;
    heldNativeImage = { url: firstImage, pending: new Promise(resolve => { releaseFirstImage = resolve; }) };
    html = splitChapter(firstImage);
    await page.goto(splitUrl + "&ccTheme=night#?ch=2a&rpkey=session", { waitUntil: "domcontentloaded" });
    await page.evaluate(src => {
      const second = document.querySelector('a[name="p2"]').parentElement;
      const loader = new IntersectionObserver(changes => {
        if (changes.some(change => change.isIntersecting)) {
          second.querySelector("img").src = src;
          loader.disconnect();
        }
      });
      loader.observe(second);
    }, secondImage);
    try {
      // Page 1 has a published URL but its native response is still pending.
      // Page 2 has no URL at all until the reader reveals the original slot.
      await openSpread(page, bundle);
    } finally { releaseFirstImage(); }
    const split = await readSavedChapter(page, "23337", "23337:2a");
    assert.deepEqual(split.pages.map(p => [p.index, p.imageUrl]), [[1, firstImage], [2, secondImage]]);
    assert.deepEqual([split.chapter.chapterUrl, split.chapter.total], [splitUrl, 31]);
    assert.deepEqual(await page.evaluate(() => window.privileged.map(r => r.url)), [firstImage, secondImage]);
    assert.deepEqual(fetches, []);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "直向閱讀器" }).waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.scrollY === 0, undefined, { timeout: 3000 });

    // A fresh document exposes no image URLs. The same original reader URL
    // must still render the spread from the cache without fetching or revealing any slot.
    html = splitChapter("");
    await page.goto(splitUrl);
    imageRequests.length = 0;
    await openSpread(page, bundle);
    assert.deepEqual(await page.evaluate(() => window.privileged), []);
    assert.deepEqual(imageRequests, []);
    assert.equal(await page.evaluate(() => window.scrollY), 0);

    const siblingUrl = chapterUrl.replace("ch=1", "ch=2b");
    const siblingImage = firstImage.replace("/2a/", "/2b/");
    html = splitChapter(siblingImage);
    await page.goto(siblingUrl);
    await page.addScriptTag({ content: bundle });
    await page.getByText(/已保存 1 頁/).waitFor();
    const sibling = await readSavedChapter(page, "23337", "23337:2b");
    assert.equal(sibling.chapter.chapterUrl, siblingUrl);
    assert.deepEqual(sibling.pages, [{ index: 1, imageUrl: siblingImage, mime: "image/png" }]);

    // A native lazy loader may require a slot to remain onscreen before it publishes src.
    const lazyUrl = chapterUrl.replace("ch=1", "ch=3");
    const lazyImages = Array.from({length:6}, (_, i) => imageUrl(i + 1).replace("/1/", "/3/"));
    html = splitChapter(lazyImages[0]).replace("(31P)", "(6P)");
    await page.goto(lazyUrl);
    await page.evaluate(urls => {
      const timers = new Map();
      const loader = new IntersectionObserver(changes => {
        for (const {target, isIntersecting} of changes) {
          clearTimeout(timers.get(target));
          const img = target.querySelector("img");
          if (isIntersecting && !img.hasAttribute("src")) {
            timers.set(target, setTimeout(() => { img.src = urls[Number(target.textContent) - 1]; }, 300));
          }
        }
      });
      for (const slot of [...document.querySelectorAll(".comics-pic")].slice(0, urls.length)) loader.observe(slot);
      localStorage.setItem("komaglide.reader.preferences.v1", JSON.stringify({mode: "single"}));
    }, lazyImages);
    await page.addScriptTag({content:bundle});
    await page.getByRole("button", {name:"直向閱讀器", exact:true}).click();
    await page.getByText(/已保存 6 頁/).waitFor({state:"attached", timeout:12000});
    const lazy = await readSavedChapter(page, "23337", "23337:3");
    assert.deepEqual(lazy.pages.map(p => p.imageUrl), lazyImages);
    assert.equal(await page.locator("figure:not([hidden])").first().getAttribute("data-index"), "1");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.scrollY === 0);

    // Use the generic adapter to exercise the transport even where the reader
    // adapter excludes an image or does not recognize the source website.
    for (const [origin, urls] of [
      [chapterUrl, [cdn + "/3/999/1/001_Fixture.jpg", cdn + "/tracking/logo.jpg", "https://elsewhere.test/3/23337/1/001_Fixture.jpg"]],
      [splitUrl, [siblingImage]],
      ["https://unrelated.test/online/new-23337.html", [imageUrl(1)]],
    ]) {
      html = "<h1>Fixture</h1><div id='comic'>" + urls.map(src => '<img src="' + src + '">').join("") + "</div>";
      fetches.length = 0;
      await page.goto(origin);
      await page.addScriptTag({ content: bundle });
      await page.getByText(new RegExp("已保存 " + urls.length + " 頁")).waitFor();
      assert.deepEqual(fetches, urls);
      assert.deepEqual(await page.evaluate(() => window.privileged), []);
    }
    await testChapterContinuation(browser, bundle);
    console.log("8comic chapter identity, lazy loading, reader and cache, image transport and chapter continuation passed");
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
