// Run node tests/library-capacity.cjs with playwright-core and matching Chromium.
// Writes a little over 1 GiB to a temporary profile. All URLs are test fixtures.
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

const GiB = 1024 ** 3;
const firstSite = "https://reader.example";
const secondSite = "https://other.example";
const storePath = path.resolve(__dirname, "../library/store.js");

async function run() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "komaglide-capacity-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", executablePath: process.env.CHROMIUM_PATH || process.env.CHROME_BIN,
    });
    await context.route("**/*", route => {
      const { origin, pathname } = new URL(route.request().url());
      if (origin !== firstSite && origin !== secondSite) return route.abort();
      if (pathname === "/store.js") return route.fulfill({ path: storePath, contentType: "application/javascript" });
      if (pathname === "/") return route.fulfill({ body: "<!doctype html><title>Capacity test</title>", contentType: "text/html" });
      return route.abort();
    });

    const page = await context.newPage();
    await page.goto(firstSite);
    const results = await page.evaluate(async () => {
      const { putPage, lookupPage, shelf } = await import("/store.js");
      const sample = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVMkAAAAASUVORK5CYII="),
        char => char.charCodeAt(0),
      );
      const makePage = (chapterId, index) => ({
        site: location.origin, workId: "load-test", workTitle: "容量測試",
        chapterId, chapterTitle: chapterId, chapterUrl: location.origin + "/" + chapterId,
        index, imageUrl: location.origin + "/" + chapterId + "/" + index + ".png",
      });
      const size = 8 * 1024 * 1024;
      for (const chapter of ["old", "recent"]) {
        for (let i = 1; i <= 64; i++) {
          const bytes = new Uint8Array(size);
          bytes.set(sample);
          bytes[size - 1] = i;
          await putPage(makePage(chapter, i), new Blob([bytes], { type: "image/png" }));
        }
      }
      const before = await shelf();
      await putPage(makePage("incoming", 1), new Blob([sample], { type: "image/png" }));
      const after = await shelf();
      const present = async (chapter, i) => (await lookupPage(makePage(chapter, i), false)).exists;
      let oldPages = 0, recentPages = 0;
      for (let i = 1; i <= 64; i++) {
        if (await present("old", i)) oldPages++;
        if (await present("recent", i)) recentPages++;
      }
      return {
        limit: before.state.limit, atLimit: before.state.used, oldPages, recentPages,
        incoming: await present("incoming", 1), remainingImageBytes: after.state.used - sample.length,
      };
    });
    assert.deepEqual(results, {
      limit: GiB, atLimit: GiB, oldPages: 0, recentPages: 64, incoming: true, remainingImageBytes: GiB / 2,
    });

    await page.goto(secondSite);
    const other = await page.evaluate(async () => {
      const { shelf } = await import("/store.js");
      const { state, chapters } = await shelf();
      return { used: state.used, limit: state.limit, chapters: chapters.length };
    });
    assert.deepEqual(other, { used: 0, limit: GiB, chapters: 0 });
    console.log("Capacity passed: 1 GiB filled, oldest 64 pages evicted, newest 64 retained, second site's store empty");
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
