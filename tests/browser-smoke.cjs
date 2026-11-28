// Use playwright-core, a matching full Chromium, and an unpacked copy of the
// official Tampermonkey Chrome Web Store package. Python's zipfile reads CRX3:
// curl -fL 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=149.0&acceptformat=crx3&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc' -o /tmp/tampermonkey.crx
// python3 -m zipfile -e /tmp/tampermonkey.crx /tmp/tampermonkey
// TAMPERMONKEY_DIR=/tmp/tampermonkey node tests/browser-smoke.cjs
// Set CHROMIUM_PATH to override Playwright's matching browser executable.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { deflateSync } = require("node:zlib");
const { chromium } = require("playwright-core");

const project = path.resolve(__dirname, "..");
const fixtureBase = "http://127.0.0.1/";
const timeout = 65_000;

function pngChunk(name, bytes) {
  const typeAndData = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const byte of typeAndData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  const chunk = Buffer.alloc(12 + bytes.length);
  chunk.writeUInt32BE(bytes.length);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + bytes.length);
  return chunk;
}

// Give each page distinct image bytes and decoded dimensions so we can verify
// its identity after restarting, even when metadata and page counts look right.
function comicPage(width, color, large = false) {
  const height = 560;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    pixels.fill(Buffer.from(color), y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1));
  }
  if (large) {
    // A textured page also exercises a larger image than the solid-color pages.
    let seed = 17;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * 3; x++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        pixels[y * (1 + width * 3) + 1 + x] = seed & 255;
      }
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const pepperPath = "/en/webcomic/ep01_Potion-of-Flight.html";
const xkcdPath = "/123/";
const followingPath = "/124/";
const followingPart = "/124/part-two";
const pepperImages = ["00", "01", "02", "03"].map(n => "/art/en_Pepper-and-Carrot_by-David-Revoy_E01P" + n + ".png");
const xkcdImage = "/art/fixture.png";
const followingImage = "/art/following.png";
const partImage = "/art/following-part.png";
const promo = "/art/banner.png";
const art = new Map([
  [pepperImages[0], comicPage(420, [17, 18, 19])],
  [pepperImages[1], comicPage(421, [220, 60, 40], true)],
  [pepperImages[2], comicPage(422, [30, 150, 70])],
  [pepperImages[3], comicPage(427, [80, 140, 90])],
  [xkcdImage, comicPage(423, [30, 70, 190])],
  [followingImage, comicPage(425, [20, 70, 220])],
  [partImage, comicPage(426, [100, 70, 120])],
  [promo, comicPage(424, [150, 150, 150])],
]);

function chapterHTML(isPepper, pathname) {
  const continuation = pathname === followingPath || pathname === followingPart;
  const title = isPepper ? "Episode 1: Potion of Flight" : continuation ? "Following comic" : "Fixture XKCD";
  const image = pathname === followingPart ? partImage : continuation ? followingImage : xkcdImage;
  const site = isPepper ? "Pepper&Carrot" : "xkcd";
  const body = isPepper
    ? '<div class="container webcomic"><h1>' + title + '</h1>' + pepperImages.map((src, i) =>
      '<div class="webcomic-page"' + (i === 2 ? ' style="padding-top:6500px"' : '') +
      '><img' + (i >= 2 ? ' loading="lazy" width="422" height="560"' : '') +
      ' src="' + src + '" alt="Page ' + i + '"></div>').join("") + '</div>' 
    : '<div id="ctitle">' + title + '</div><div id="comic"><img src="' + image + '" alt="' + title + '"></div>';
  return '<!doctype html><meta charset="utf-8"><title>' + title + '</title><meta property="og:site_name" content="' + site +
    '"><meta property="og:title" content="' + title + '"><body>' + body +
    (pathname === xkcdPath ? '<a rel="next" href="' + followingPath + '">Next chapter</a>' : '') +
    (pathname === followingPath ? '<a data-next-page href="' + followingPart + '">Next page</a>' : '') +
    '<nav class="navigation"><img src="' + promo + '" alt="Advertisement"></nav></body>';
}

async function listen(handler, port = 0) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    async close() {
      const closed = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function serveChapter(isPepper, requests, imagesAvailable) {
  return (req, res) => {
    const pathname = new URL(req.url, fixtureBase).pathname;
    res.setHeader("Cache-Control", "no-store");
    if (pathname === (isPepper ? pepperPath : xkcdPath) || (!isPepper && [followingPath, followingPart].includes(pathname))) {
      requests[pathname] = (requests[pathname] || 0) + 1;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(chapterHTML(isPepper, pathname));
    } else if (art.has(pathname)) {
      requests[pathname] = (requests[pathname] || 0) + 1;
      if (imagesAvailable()) res.writeHead(200, { "Content-Type": "image/png" }).end(art.get(pathname));
      else res.writeHead(404).end();
    } else {
      res.writeHead(404).end();
    }
  };
}

async function install(context, sourceURL) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout });
  const extensionOrigin = "chrome-extension://" + new URL(worker.url()).host;
  const tab = await context.newPage();
  await tab.goto("chrome://extensions/?id=" + new URL(worker.url()).host);
  const toggle = tab.locator("#allow-user-scripts cr-toggle");
  await toggle.waitFor();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  await tab.goto(extensionOrigin + "/options.html#nav=utils");
  const urlField = tab.locator('input[id$="_url"]:visible');
  await urlField.fill(sourceURL);
  await urlField.locator("..").getByRole("button").click();
  const installer = await waitForOpenedTab(context, extensionOrigin + "/ask.html?");
  const installButton = installer.locator('input[type="button"]:visible').first();
  await installButton.waitFor();
  assert.match(await installer.locator("body").innerText(), /KomaGlide/);
  await Promise.all([installer.waitForEvent("close", { timeout }), installButton.click()]);
  await tab.close();
}

async function waitForOpenedTab(context, urlPrefix) {
  // The extension may also open a welcome tab during a fresh installation.
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = context.pages().find(page => page.url().startsWith(urlPrefix));
    if (tab) return tab;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("No tab opened at " + urlPrefix);
}

async function expectImage(img, original) {
  await img.scrollIntoViewIfNeeded();
  const actual = await img.evaluate(async e => {
    await e.decode();
    const bytes = await (await fetch(e.currentSrc)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { width: e.naturalWidth, height: e.naturalHeight, scheme: new URL(e.currentSrc).protocol,
      sha256: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("") };
  });
  const bytes = art.get(original);
  assert.deepEqual(actual, { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
    scheme: "blob:", sha256: createHash("sha256").update(bytes).digest("hex") });
}

const settingsMenu = "閱讀設定";
const navigationMenu = "頁面導覽";

async function setDrawer(surface, name, open = true) {
  const toggle = surface.getByRole("button", { name, exact: true });
  await toggle.waitFor();
  if (await toggle.getAttribute("aria-expanded") !== String(open)) await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), String(open));
  return toggle;
}

async function openThumbnails(page, surface) {
  await setDrawer(surface, navigationMenu);
  await surface.getByRole("button", { name: "小圖選頁", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "小圖選頁", exact: true });
  await picker.waitFor();
  return picker;
}

async function checkThumbnailSizes(page, picker) {
  const size = picker.getByRole("combobox", { name: "縮圖大小", exact: true });
  assert.equal(await size.inputValue(), "medium", "existing preferences should default to medium thumbnails");
  const selected = picker.locator('.kg-thumb-page[aria-current="page"]');
  const pageNumber = await selected.getAttribute("data-page");
  const originalViewport = page.viewportSize();
  for (const viewport of [originalViewport, { width: 390, height: 740 }]) {
    await page.setViewportSize(viewport);
    let previous;
    for (const value of ["small", "medium", "large"]) {
      await size.selectOption(value);
      const layout = await picker.locator(".kg-thumb-grid").evaluate(grid => ({
        width: grid.querySelector(".kg-thumb-frame").getBoundingClientRect().width,
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(track => parseFloat(track) > 0).length,
        overflow: grid.scrollWidth - grid.clientWidth,
      }));
      assert(layout.width > 0 && layout.columns >= 1 && layout.overflow <= 1, "grid should fit the picker");
      if (value === "large") {
        const box = await picker.boundingBox();
        assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1 && box.width >= viewport.width * .9 &&
          box.height >= viewport.height * .9,
          "the expanded picker should use the viewport without spilling off-screen: " + JSON.stringify(box));
        assert(layout.width >= 210, "large previews should have room for artwork: " + JSON.stringify(layout));
        // Page three is off the current 1–2 spread and must be read from the site cache.
        const previewTile = viewport.width === 390 ? selected : picker.locator('[data-page="3"]');
        const tile = await previewTile.elementHandle();
        await page.waitForFunction(el => el.querySelector("img")?.naturalWidth > 192, tile, { timeout: 15_000 });
        await tile.dispose();
        if (viewport.width === 390) {
          const scrolls = await picker.locator(".kg-thumb-grid").evaluate(grid => {
            const original = grid.scrollTop;
            grid.scrollTop = grid.scrollHeight;
            const end = grid.scrollTop;
            grid.scrollTop = original;
            return end > 0;
          });
          assert(scrolls, "later large previews should be reachable by scrolling inside the dialog");
        }
      }
      if (previous) {
        assert(layout.width > previous.width && layout.columns < previous.columns,
          value + " should have larger art and fewer columns at " + viewport.width + "px: " +
          JSON.stringify({ previous, layout }));
      }
      assert.equal(await selected.getAttribute("data-page"), pageNumber, "resizing should keep the current page");
      previous = layout;
    }
  }
  await page.setViewportSize(originalViewport);
}

async function checkSavedThumbnailSize(page, surface) {
  const picker = await openThumbnails(page, surface);
  assert.equal(await picker.getByRole("combobox", { name: "縮圖大小", exact: true }).inputValue(), "large",
    "the reader should remember its thumbnail size");
  await picker.getByRole("button", { name: "關閉小圖", exact: true }).click();
}

async function pickThumbnail(page, surface, index, rgb) {
  const picker = await openThumbnails(page, surface);
  const tile = picker.getByRole("button", { name: "第 " + index + " 頁", exact: true });
  if (rgb) {
    const actual = await tile.locator("img[src]").evaluate(async image => {
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, 1, 1);
      return { source: new URL(image.currentSrc).protocol, rgb: Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3) };
    });
    assert.equal(actual.source, "blob:");
    assert(actual.rgb.every((channel, i) => Math.abs(channel - rgb[i]) < 4),
      "thumbnail for page " + index + " should show that page's own artwork: " + actual.rgb);
  }
  await tile.click();
  await picker.waitFor({ state: "hidden" });
}

async function tapReader(page, surface, xFraction, touch = false, yFraction = .5) {
  const pane = surface.locator("main.pages");
  const { x, y } = await pane.evaluate((el, { xFraction, yFraction }) => {
    const box = el.getBoundingClientRect();
    const top = Math.max(0, box.top);
    return { x: Math.round(box.x + box.width * xFraction),
      y: Math.round(top + (Math.min(box.bottom, window.innerHeight) - top) * yFraction) };
  }, { xFraction, yFraction });
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function checkEdgeLayout(page, surface) {
  const original = page.viewportSize();
  const settings = surface.getByRole("button", { name: settingsMenu, exact: true });
  const nav = surface.getByRole("button", { name: navigationMenu, exact: true });
  const canvas = surface.locator("main.pages");
  for (const size of [original, { width: 390, height: 740 }, { width: 740, height: 390 }]) {
    await page.setViewportSize(size);
    await setDrawer(surface, settingsMenu, false);
    await setDrawer(surface, navigationMenu, false);
    const bounds = await canvas.boundingBox();
    assert(Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1 &&
      Math.abs(bounds.width - size.width) <= 2 && Math.abs(bounds.height - size.height) <= 2,
      "the comic canvas fills the viewport: " + JSON.stringify(bounds));
    const artwork = await canvas.locator("img[data-index]:visible").first().evaluate(el => ({
      height: el.getBoundingClientRect().height, fit: getComputedStyle(el).objectFit,
    }));
    assert(Math.abs(artwork.height - bounds.height) <= 2 && artwork.fit === "contain",
      "the full canvas height is available to the uncropped artwork");
    const left = await settings.boundingBox(), right = await nav.boundingBox();
    assert(left.x < size.width * .1 && right.x + right.width > size.width * .9, "reader toggles are at opposite edges");
    await setDrawer(surface, settingsMenu);
    assert.deepEqual(await canvas.boundingBox(), bounds, "opening settings moved the comic");
    await setDrawer(surface, navigationMenu);
    assert.equal(await settings.getAttribute("aria-expanded"), "false");
    assert.deepEqual(await canvas.boundingBox(), bounds, "opening navigation moved the comic");
    await page.keyboard.press("Escape");
    assert.equal(await nav.getAttribute("aria-expanded"), "false");
    assert(await nav.evaluate(el => el.matches(":focus")), "Escape should return focus to the navigation toggle");
    // With RTL and tap-to-turn enabled, the first tap on the left-hand side
    // dismisses the right panel. Only a subsequent tap may turn the page.
    await setDrawer(surface, navigationMenu);
    const before = await surface.locator(".kg-page-count").textContent();
    await tapReader(page, surface, .24, true);
    assert.equal(await nav.getAttribute("aria-expanded"), "false");
    assert.equal(await surface.locator(".kg-page-count").textContent(), before, "dismissing the panel turned a page");
    await setDrawer(surface, navigationMenu);
    await tapReader(page, surface, .5, true, .1);
    assert.equal(await nav.getAttribute("aria-expanded"), "false");
    assert.equal(await nav.isVisible(), true, "the first center tap should only close the drawer");
    await tapReader(page, surface, .5, true);
    assert.equal(await settings.isVisible(), false);
    assert.equal(await nav.isVisible(), false);
    assert.deepEqual(await canvas.boundingBox(), bounds, "hiding the buttons moved the comic");
    await tapReader(page, surface, .5, true);
    assert.equal(await settings.isVisible(), true);
    assert.equal(await nav.isVisible(), true);
  }
  await page.setViewportSize(original);
}

async function testPagedReader(page, surface) {
  const mode = surface.getByRole("combobox", { name: "閱讀模式", exact: true });
  const theme = surface.getByRole("combobox", { name: "外觀", exact: true });
  const next = surface.getByRole("button", { name: "下一頁", exact: true });
  const previous = surface.getByRole("button", { name: "上一頁", exact: true });
  const direction = surface.getByRole("combobox", { name: "翻頁方向", exact: true });
  const tap = surface.getByRole("checkbox", { name: "點按翻頁", exact: true });
  const images = surface.locator("img[data-index]:visible");
  const image = index => surface.locator('img[data-index="' + index + '"]:visible');
  const settingsToggle = surface.getByRole("button", { name: settingsMenu, exact: true });
  const navToggle = surface.getByRole("button", { name: navigationMenu, exact: true });
  await settingsToggle.waitFor();
  assert.equal(await settingsToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await navToggle.getAttribute("aria-expanded"), "false");
  async function selectMode(value) {
    await setDrawer(surface, settingsMenu);
    await mode.selectOption(value);
  }
  async function closeMenus() {
    await setDrawer(surface, settingsMenu, false);
    await setDrawer(surface, navigationMenu, false);
  }
  await setDrawer(surface, settingsMenu);
  await mode.waitFor();
  assert.equal(await mode.inputValue(), "scroll");
  assert.equal(await theme.inputValue(), "system");
  await theme.selectOption("dark");
  const themed = surface.locator("xpath=ancestor-or-self::*[@data-reader-theme='dark']").first();
  await themed.waitFor({ state: "attached" });
  assert.equal(await themed.evaluate(el => getComputedStyle(el).colorScheme), "dark");

  // Jump from the continuous strip and retain its exact page on layout switch.
  await pickThumbnail(page, surface, 2, [30, 150, 70]);
  await selectMode("single");
  await expectImage(image(2), pepperImages[2]);
  await selectMode("scroll");
  await closeMenus();
  await tapReader(page, surface, 0.85);
  await selectMode("single");
  await expectImage(image(1), pepperImages[1]);
  await selectMode("scroll");
  await closeMenus();
  await tapReader(page, surface, 0.15, true);
  await selectMode("single");
  await expectImage(image(2), pepperImages[2]);
  await pickThumbnail(page, surface, 1);
  await expectImage(image(1), pepperImages[1]);
  assert.equal(await images.count(), 1);
  assert.equal(await image(1).evaluate(el => getComputedStyle(el).filter), "none");
  assert.equal(await surface.locator(".kg-page-count").textContent(), "1 / 3");
  await setDrawer(surface, navigationMenu);
  assert.equal(await previous.isDisabled(), true);
  await setDrawer(surface, settingsMenu);
  assert.equal(await direction.inputValue(), "rtl");
  assert.equal(await tap.isChecked(), true);
  await closeMenus();
  await tapReader(page, surface, 0.5);
  assert.equal(await settingsToggle.isVisible(), false);
  assert.equal(await navToggle.isVisible(), false);
  assert.equal(await surface.locator(".kg-page-count").textContent(), "1 / 3", "center tap should leave the page in place");
  await tapReader(page, surface, 0.15, true);
  await expectImage(image(2), pepperImages[2]);
  await tapReader(page, surface, 0.85);
  await expectImage(image(1), pepperImages[1]);
  await tapReader(page, surface, 0.5);
  await setDrawer(surface, settingsMenu);
  await tap.uncheck();
  await closeMenus();
  await tapReader(page, surface, 0.15);
  assert.equal(await surface.locator(".kg-page-count").textContent(), "1 / 3", "disabled tap should not turn the page");
  await tapReader(page, surface, 0.5);
  assert.equal(await settingsToggle.isVisible(), false, "the center still works with tap-to-turn disabled");
  await tapReader(page, surface, 0.5);
  await setDrawer(surface, settingsMenu);
  await tap.check();
  await checkEdgeLayout(page, surface);
  await setDrawer(surface, navigationMenu);
  await next.click();
  await expectImage(image(2), pepperImages[2]);
  await selectMode("double");
  await expectImage(image(1), pepperImages[1]);
  await expectImage(image(2), pepperImages[2]);
  assert.equal(await images.count(), 2);
  assert.equal(await surface.locator(".kg-page-count").textContent(), "1–2 / 3");
  const first = await image(1).boundingBox();
  const second = await image(2).boundingBox();
  assert(first.x >= second.x + second.width - 1, "page one should be to the right of page two");
  assert(Math.abs(first.y - second.y) < Math.max(first.height, second.height) / 2, "spread pages should overlap vertically");
  await setDrawer(surface, navigationMenu);
  assert.equal(await previous.isDisabled(), true);

  // Keep focus in the reader and outside a native select.
  await closeMenus();
  await navToggle.focus();
  await page.keyboard.press("ArrowLeft");
  await expectImage(image(3), pepperImages[3]);
  assert.equal(await images.count(), 1, "odd final spread should show its last page once");
  await setDrawer(surface, navigationMenu);
  assert.equal(await next.isDisabled(), true);
  await setDrawer(surface, navigationMenu, false);
  await navToggle.focus();
  await page.keyboard.press("ArrowRight");
  await expectImage(image(1), pepperImages[1]);
  await setDrawer(surface, navigationMenu);
  assert.equal(await previous.isDisabled(), true);
  const picker = await openThumbnails(page, surface);
  await picker.locator("img[src]").first().waitFor();
  await checkThumbnailSizes(page, picker);
  // A constrained one-column picker should scroll full thumbnail rows.
  const rows = await picker.evaluate(dialog => {
    const saved = dialog.style.cssText;
    dialog.style.width = "10rem";
    dialog.style.maxHeight = "13rem";
    const result = Array.from(dialog.querySelectorAll(".kg-thumb-page"), tile => {
      const box = tile.getBoundingClientRect();
      const frame = tile.firstElementChild.getBoundingClientRect();
      const number = tile.lastElementChild.getBoundingClientRect();
      return { top: box.top, end: box.bottom, frameTop: frame.top, frameEnd: frame.bottom, frameWidth: frame.width,
        labelTop: number.top, labelEnd: number.bottom };
    });
    dialog.style.cssText = saved;
    return result;
  });
  for (const [i, row] of rows.entries()) {
    assert(row.frameWidth > 0 && row.frameEnd - row.frameTop >= row.frameWidth &&
      row.frameTop >= row.top && row.frameEnd <= row.labelTop + 1 && row.labelEnd <= row.end + 1,
      "a thumbnail and its page number should fit inside their own button: " + JSON.stringify(row));
    if (i > 0) assert(rows[i - 1].end <= row.top, "adjacent thumbnail rows should not overlap");
  }
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  assert.equal(await navToggle.getAttribute("aria-expanded"), "true", "Escape closes only the thumbnail dialog");
  assert.equal(await surface.locator(".kg-page-count").textContent(), "1–2 / 3", "closing the picker should keep the spread");
  await page.keyboard.press("Escape");
  assert.equal(await navToggle.getAttribute("aria-expanded"), "false");
  assert(await navToggle.evaluate(el => el.matches(":focus")));

  await setDrawer(surface, settingsMenu);
  await direction.selectOption("ltr");
  const left = await image(1).boundingBox();
  const right = await image(2).boundingBox();
  assert(left.x + left.width <= right.x + 1, "page one should move left of page two in LTR mode");
  await closeMenus();
  await tapReader(page, surface, 0.5);
  assert.equal(await navToggle.isVisible(), false, "the center should hide the buttons in double-page mode");
  await tapReader(page, surface, 0.5);
  await tapReader(page, surface, 0.85);
  await expectImage(image(3), pepperImages[3]);
  await tapReader(page, surface, 0.15, true);
  await expectImage(image(1), pepperImages[1]);
  await navToggle.focus();
  await page.keyboard.press("ArrowRight");
  await expectImage(image(3), pepperImages[3]);
  await page.keyboard.press("ArrowLeft");
  await expectImage(image(1), pepperImages[1]);
  await pickThumbnail(page, surface, 3, [80, 140, 90]);
  await expectImage(image(3), pepperImages[3]);
  await pickThumbnail(page, surface, 2, [30, 150, 70]);
  assert.equal(await surface.locator(".kg-page-count").textContent(), "1–2 / 3", "choosing an even page should open its spread");
  await setDrawer(surface, settingsMenu);
  await tap.uncheck();
}

async function testReadingModes(context, first, second, secondOrigin, hits) {
  const openReader = first.getByRole("button", { name: "直向閱讀器", exact: true });
  const baseline = pepperImages.slice(1).map(url => hits[url]);
  await openReader.click();
  const dialog = first.getByRole("dialog", { name: "直向閱讀器" });
  await testPagedReader(first, dialog);
  await dialog.getByRole("button", { name: "關閉閱讀器" }).click();
  await openReader.click();
  const layout = dialog.getByRole("combobox", { name: "閱讀模式" });
  await checkSavedThumbnailSize(first, dialog);
  await setDrawer(dialog, settingsMenu);
  await layout.waitFor();
  assert.equal(await layout.inputValue(), "double", "overlay should keep its selected mode on reopen");
  assert.equal(await dialog.getByRole("combobox", { name: "外觀" }).inputValue(), "dark");
  assert.equal(await dialog.getByRole("combobox", { name: "翻頁方向" }).inputValue(), "ltr");
  assert.equal(await dialog.getByRole("checkbox", { name: "點按翻頁" }).isChecked(), false);
  await layout.selectOption("scroll");
  await setDrawer(dialog, settingsMenu, false);
  for (const [i, url] of pepperImages.slice(1).entries()) {
    const figure = dialog.locator("figure").nth(i);
    await figure.scrollIntoViewIfNeeded();
    await expectImage(figure.locator("img"), url);
  }
  assert.deepEqual(pepperImages.slice(1).map(url => hits[url]), baseline);
  await first.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  const nextChapter = second.getByRole("button", { name: "接上下一話", exact: true });
  await nextChapter.scrollIntoViewIfNeeded();
  const setting = { name: "自動接下一話" };
  assert.equal(await second.getByRole("checkbox", setting).isChecked(), false);
  assert.equal(hits[followingPath] || 0, 0, "disabled auto-next must not request the next chapter");

  // Cache the following chapter through a normal visit. Its explicitly linked
  // second page should append automatically while cross-chapter mode is off.
  const warm = await context.newPage();
  await warm.goto(secondOrigin + followingPath);
  // A short first page can bring the continuation into view before the dock updates.
  await warm.getByText(/已保存 [12] 頁/).waitFor({ timeout });
  await warm.locator("#comic").evaluate(el => el.scrollIntoView({ block: "end" }));
  await expectImage(warm.locator("figure img[data-index='2']"), partImage);
  await warm.close();

  const followingHits = () => [hits[followingImage], hits[partImage]];
  const before = followingHits();
  await nextChapter.click();
  for (const [index, url] of [followingImage, partImage].entries()) {
    const figure = second.locator("figure").nth(index);
    await figure.scrollIntoViewIfNeeded();
    await expectImage(figure.locator("img"), url);
  }
  assert.deepEqual(followingHits(), before);

  await second.getByRole("button", { name: "直向閱讀器", exact: true }).click();
  const secondReader = second.getByRole("dialog", { name: "直向閱讀器", exact: true });
  await setDrawer(secondReader, settingsMenu);
  const secondMode = secondReader.getByRole("combobox", { name: "閱讀模式", exact: true });
  assert.equal(await secondMode.inputValue(), "scroll", "a different site's reading mode keeps its own preference");
  await secondMode.selectOption("single");
  await secondReader.getByRole("button", { name: "關閉閱讀器" }).click();

  // Change the preference from a different website and verify its value and
  // behavior after a fresh navigation on the second comic site.
  await openReader.click();
  await setDrawer(dialog, settingsMenu);
  await layout.selectOption("single");
  await dialog.getByRole("checkbox", setting).check();
  await dialog.getByRole("button", { name: "關閉閱讀器" }).click();
  const auto = await context.newPage();
  await auto.goto(secondOrigin + xkcdPath);
  await auto.getByText(/已保存 1 頁/).waitFor({ timeout });
  await auto.locator("#comic").evaluate(el => el.scrollIntoView({ block: "end" }));
  await auto.getByRole("heading", { name: "Following comic" }).waitFor({ timeout });
  await expectImage(auto.locator("figure img[data-index='1']").first(), followingImage);
  // A continued chapter reuses page numbers starting from one. Its picker
  // must use the new chapter's bytes, including its appended second page.
  await auto.getByRole("button", { name: "直向閱讀器", exact: true }).click();
  const continued = auto.getByRole("dialog", { name: "直向閱讀器", exact: true });
  await setDrawer(continued, navigationMenu);
  await continued.getByRole("button", { name: "接上下一話", exact: true }).click();
  await continued.locator(".source-chapter-title").filter({ hasText: "Following comic" }).waitFor({ state: "attached" });
  await expectImage(continued.locator("img[data-index='1']:visible"), followingImage);
  await pickThumbnail(auto, continued, 1, [20, 70, 220]);
  await setDrawer(continued, navigationMenu);
  await continued.getByRole("button", { name: "接上下一頁", exact: true }).click();
  await continued.locator(".kg-page-count").filter({ hasText: "2 / 2" }).waitFor();
  await pickThumbnail(auto, continued, 2, [100, 70, 120]);
  await expectImage(continued.locator("img[data-index='2']:visible"), partImage);
  assert.deepEqual(followingHits(), before);
  await auto.close();
  return { cachedOverlayImageRequests: 0, cachedContinuationImageRequests: 0,
    automaticSameChapterPage: true, manualNextChapter: true, crossSiteAutoNextPreference: true, darkSingleAndRTLSpread: true,
    bidirectionalMouseAndTouch: true, cachedThumbnailJumps: true, fullViewportEdgeMenus: true };
}

async function run() {
  if (!process.env.TAMPERMONKEY_DIR) throw new Error("Set TAMPERMONKEY_DIR to an unpacked official Tampermonkey extension");
  const extension = path.resolve(process.env.TAMPERMONKEY_DIR);
  const manifest = JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8"));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "komaglide-tm-smoke-"));
  const profile = path.join(temporary, "profile");
  const bundle = path.join(temporary, "dist");
  const args = ["--disable-extensions-except=" + extension, "--load-extension=" + extension];
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, hasTouch: true, args,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const servers = [];
  const hits = {};
  let context;
  let serveImages = true;
  try {
    execFileSync(process.execPath, [path.join(project, "scripts/build.mjs"), bundle]);
    const script = await fs.readFile(path.join(bundle, "komaglide.user.js"));
    const installer = await listen((req, res) => {
      if (req.url === "/komaglide.user.js") res.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
      else res.writeHead(404).end();
    });
    servers.push(installer);
    const pepper = await listen(serveChapter(true, hits, () => serveImages));
    servers.push(pepper);
    const xkcd = await listen(serveChapter(false, hits, () => serveImages));
    servers.push(xkcd);
    const secondOrigin = xkcd.origin.replace("127.0.0.1", "localhost");
    const chapterURLs = [pepper.origin + pepperPath, secondOrigin + xkcdPath];
    assert.notEqual(new URL(chapterURLs[0]).hostname, new URL(chapterURLs[1]).hostname);

    context = await launch();
    const chrome = context.browser().version();
    await install(context, installer.origin + "/komaglide.user.js");
    // Once installed, the userscript must work without its distribution host.
    await installer.close();
    servers.splice(servers.indexOf(installer), 1);
    const originalTabs = new Set(context.pages());
    const first = await context.newPage();
    await first.goto(chapterURLs[0]);
    const second = await context.newPage();
    await second.goto(chapterURLs[1]);
    await first.getByText(/已保存 1 頁/).waitFor({ timeout });
    assert.equal(hits[pepperImages[2]] || 0, 0, "the site and script should leave the unseen lazy page alone");
    await first.getByAltText("Page 2", { exact: true }).scrollIntoViewIfNeeded();
    await first.getByAltText("Page 3", { exact: true }).scrollIntoViewIfNeeded();
    await Promise.all([
      first.getByText(/已保存 3 頁/).waitFor({ timeout }),
      second.getByText(/已保存 1 頁/).waitFor({ timeout }),
    ]);
    for (const original of [...pepperImages, xkcdImage, promo]) assert(hits[original] > 0, "fixture did not load " + original);

    const before = hits[pepperImages[1]];
    await first.reload();
    await first.getByAltText("Page 2", { exact: true }).scrollIntoViewIfNeeded();
    await first.getByAltText("Page 3", { exact: true }).scrollIntoViewIfNeeded();
    await first.getByText(/已保存 3 頁/).waitFor({ timeout });
    const eagerRevisitRequests = hits[pepperImages[1]] - before;
    assert.equal(eagerRevisitRequests, 1, "Chrome loads eager images once and the script must skip its own duplicate fetch");

    const readingModes = await testReadingModes(context, first, second, secondOrigin, hits);
    const unexpectedTabs = context.pages().filter(page => !originalTabs.has(page) && page !== first && page !== second)
      .map(page => page.url())
      .filter(url => !url.startsWith("https://www.tampermonkey.net/index.php?"));
    assert.deepEqual(unexpectedTabs, [], "reading must not open a background tab");

    // A reader may explicitly open a foreground shelf. It belongs to the
    // comic origin and should only list the chapters saved on that site.
    for (const [source, titles, expectedImage] of [
      [first, ["Episode 1: Potion of Flight"], pepperImages[1]],
      [second, ["Fixture XKCD", "Following comic"], xkcdImage],
    ]) {
      const [shelf] = await Promise.all([
        context.waitForEvent("page", { timeout }),
        source.getByTitle("開啟本站書庫", { exact: true }).click(),
      ]);
      const links = shelf.locator("#books a.chapter-link");
      await links.filter({ hasText: titles[0] }).waitFor({ timeout });
      assert.equal(new URL(shelf.url()).origin, new URL(source.url()).origin);
      assert.deepEqual((await links.allTextContents()).map(text => text.trim()).sort(), [...titles].sort());
      await links.filter({ hasText: titles[0] }).click();
      await setDrawer(shelf, navigationMenu);
      await shelf.getByRole("button", { name: "從頭讀", exact: true }).click();
      await expectImage(shelf.locator("#pages img[data-index='1']"), expectedImage);
      await shelf.close();
    }
    // Revisit each source in a fresh tab with its images unavailable.
    // The overlay must recover the original bytes from each site's own data.
    serveImages = false;
    for (const [url, expected] of [[chapterURLs[0], pepperImages.slice(1)], [chapterURLs[1], [xkcdImage]]]) {
      const page = await context.newPage();
      await page.goto(url);
      await page.getByRole("button", { name: "直向閱讀器", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "直向閱讀器", exact: true });
      await setDrawer(dialog, settingsMenu);
      await dialog.getByRole("combobox", { name: "閱讀模式", exact: true }).selectOption("scroll");
      await setDrawer(dialog, settingsMenu, false);
      for (const [offset, original] of expected.entries()) {
        const figure = dialog.locator("figure").nth(offset);
        await figure.scrollIntoViewIfNeeded();
        await expectImage(figure.locator("img"), original);
      }
      await page.close();
    }
    await context.close();
    context = await launch();
    // Independently check durable per-origin storage after a browser restart.
    for (const [url, expected] of [
      [chapterURLs[0], pepperImages.slice(1)],
      [chapterURLs[1], [xkcdImage, followingImage, partImage]],
    ]) {
      const page = await context.newPage();
      await page.goto(url);
      const contents = await page.evaluate(async () => {
        const result = req => new Promise((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const db = await result(indexedDB.open("komaglide-library-v1"));
        try {
          const records = await result(db.transaction("pages").objectStore("pages").getAll());
          return Promise.all(records.map(async record => {
            const bytes = record.blob ? await record.blob.arrayBuffer() : record.bytes;
            const hash = await crypto.subtle.digest("SHA-256", bytes);
            return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
          }));
        } finally { db.close(); }
      });
      const hashes = expected.map(image => createHash("sha256").update(art.get(image)).digest("hex"));
      assert.deepEqual(contents.sort(), hashes.sort());
      await page.close();
    }
    console.log(JSON.stringify({ chrome, tampermonkey: manifest.version, standalone: true, origins: 2,
      persistedPagesAfterRestart: 6, rereadWithUnavailableImages: 4, eagerRevisitRequests, readingModes }, null, 2));
  } catch (error) {
    if (context) {
      for (const page of context.pages()) {
        if (!/^(?:http:\/\/(?:localhost|127\.0\.0\.1):\d+\/|chrome-extension:\/\/)/.test(page.url())) continue;
        const status = await page.locator("body").ariaSnapshot({ timeout: 1500 }).catch(() => "");
        console.error(page.url(), status.slice(0, 1800));
      }
    }
    throw error;
  } finally {
    try {
      if (context) await context.close();
    } finally {
      await Promise.all(servers.map(server => server.close()));
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
