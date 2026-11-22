const { chromium, webkit } = require("playwright-core");

function launchSiteBrowser() {
  // WebKit private contexts do not persist Blob records in IndexedDB.
  if (process.env.PLAYWRIGHT_BROWSER === "webkit") return webkit.launchPersistentContext("");
  return chromium.launch({ channel: "chromium", executablePath: process.env.CHROMIUM_PATH });
}

// Read committed records from the source site's IndexedDB after running the real userscript.
async function readSavedChapter(page, workId, chapterId) {
  return page.evaluate(async ([workId, chapterId]) => {
    function result(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    const db = await result(indexedDB.open("komaglide-library-v1"));
    try {
      const tx = db.transaction(["pages", "chapters"], "readonly");
      const pages = tx.objectStore("pages");
      const chapterKey = [location.origin, workId, chapterId];
      const range = IDBKeyRange.bound([...chapterKey, 1], [...chapterKey, Number.MAX_SAFE_INTEGER]);
      const [chapter, keys, rows] = await Promise.all([
        result(tx.objectStore("chapters").get(chapterKey)), result(pages.getAllKeys(range)), result(pages.getAll(range))
      ]);
      return {
        chapter,
        pages: rows.map((row, i) => ({ index: keys[i][3], imageUrl: row.imageUrl, mime: row.blob.type }))
      };
    } finally { db.close(); }
  }, [workId, chapterId]);
}

module.exports = { launchSiteBrowser, readSavedChapter };
