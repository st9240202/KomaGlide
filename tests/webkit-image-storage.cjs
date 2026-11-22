// Run with playwright-core and its WebKit installed. Exercise WebKit's ephemeral IndexedDB.
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { webkit } = require('playwright-core');

async function run() {
  const storeSource = await readFile(path.join(__dirname, '../library/store.js'), 'utf8');
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://reader.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Fixture</title>' }));
    await page.addInitScript(source => {
      window.store = import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    }, storeSource);
    await page.goto('https://reader.test/');

    const key = { site: 'https://reader.test', workId: 'work', chapterId: 'chapter' };
    const attempts = await page.evaluate(async key => {
      const attempts = [];
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (record, key) {
        if (this.name === 'pages') attempts.push(record.blob instanceof Blob ? 'blob' : 'bytes');
        return add.call(this, record, key);
      };
      try {
        const { putPage } = await window.store;
        for (const index of [1, 2, 2]) {
          const blob = new Blob([new Uint8Array([index, 255, 0])], { type: 'image/png' });
          await putPage({ ...key, index }, blob);
        }
      } finally { IDBObjectStore.prototype.add = add; }
      return attempts;
    }, key);
    // WebKit versions that accept Blobs in private storage may use the native path throughout.
    assert.deepEqual(attempts, attempts.includes('bytes') ? ['blob', 'bytes', 'bytes'] : ['blob', 'blob']);

    await page.reload();
    const result = await page.evaluate(async key => {
      const { lookupPage, readerBlob, shelf } = await window.store;
      const first = (await lookupPage({ ...key, index: 1 }, true)).blob;
      const second = await readerBlob([key.site, key.workId, key.chapterId], 2);
      const rows = await Promise.all([first, second].map(async blob => [blob.type, ...new Uint8Array(await blob.arrayBuffer())]));
      const { state, chapters } = await shelf();
      return { rows, used: state.used, count: chapters[0].count };
    }, key);
    assert.deepEqual(result, { rows: [['image/png', 1, 255, 0], ['image/png', 2, 255, 0]], used: 6, count: 2 });
    console.log('WebKit ephemeral image persistence passed (' + attempts.join(', ') + ')');
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
