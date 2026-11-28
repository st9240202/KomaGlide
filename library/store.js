import { t } from './i18n.js';
const DB_NAME = 'komaglide-library-v1';
const MiB = 1024 ** 2;
export const DEFAULT_LIMIT = 1024 * MiB;
const stores = ['pages', 'chapters', 'favoriteWorks', 'settings'];
let opening;
let useImageBytes = false;

function database() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const store of stores) req.result.createObjectStore(store);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        opening = undefined;
      };
      resolve(req.result);
    };
  });
  return opening;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transaction(names, mode, run) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const tables = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    let result;
    let failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error(t('writeAborted')));
    Promise.resolve().then(() => run(tables)).then(value => {
      result = value;
    }, error => {
      failure = error;
      try { tx.abort(); } catch { reject(error); }
    });
  });
}

async function readState(settings) {
  return await request(settings.get('storage')) || { used: 0, limit: DEFAULT_LIMIT, clock: 0 };
}

function touch(state, chapter) {
  state.clock = Math.max(Date.now(), state.clock + 1);
  chapter.lastRead = state.clock;
}

function identity(page) {
  if (!page || typeof page.site !== 'string' || !page.site || typeof page.chapterId !== 'string' || !page.chapterId ||
      (page.workId != null && typeof page.workId !== 'string') ||
      !Number.isSafeInteger(page.index) || page.index < 1) {
    throw new Error(t('incompletePage'));
  }
  return [page.site, page.workId || '', page.chapterId];
}

function indices(key) {
  return IDBKeyRange.bound([...key, 1], [...key, Number.MAX_SAFE_INTEGER]);
}

// Select the complete set of victims before deleting anything. The read-write
// transaction serializes selection, byte accounting and the actual Blob write.
async function makeRoom(tables, state, required, skipKey) {
  if (required <= 0) return;
  const [chapters, favorites] = await Promise.all([
    request(tables.chapters.getAll()), request(tables.favoriteWorks.getAllKeys())
  ]);
  const protectedWorks = new Set(favorites.map(key => JSON.stringify(key)));
  const candidates = chapters.filter(chapter =>
    !chapter.favorite && !(chapter.workKnown && protectedWorks.has(JSON.stringify(chapter.key.slice(0, 2)))) &&
    (!skipKey || indexedDB.cmp(chapter.key, skipKey) !== 0)
  ).sort((a, b) => a.lastRead - b.lastRead);
  let bytes = 0;
  let count = 0;
  while (count < candidates.length && bytes < required) bytes += candidates[count++].bytes;
  if (bytes < required) throw new Error(t('insufficientStorage'));
  for (const { key } of candidates.slice(0, count)) {
    tables.chapters.delete(key);
    tables.pages.delete(indices(key));
  }
  state.used -= bytes;
}

function title(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function putPage(page, blob) {
  const key = identity(page);
  if (!(blob instanceof Blob) || !blob.size) throw new Error(t('emptyImage'));
  let blobRejected = false;
  function save(image) {
    return transaction(stores, 'readwrite', async tables => {
      const pageKey = [...key, page.index];
      const [state, previous, present] = await Promise.all([
        readState(tables.settings), request(tables.chapters.get(key)), request(tables.pages.getKey(pageKey))
      ]);
      const chapter = previous || { key, favorite: false, count: 0, bytes: 0, total: null };
      if (!present) {
        if (blob.size + chapter.bytes > state.limit) {
          throw new Error(t('chapterTooLarge'));
        }
        await makeRoom(tables, state, state.used + blob.size - state.limit, key);
        try {
          await request(tables.pages.add({ ...image, imageUrl: title(page.imageUrl, '') }, pageKey));
        } catch (error) {
          blobRejected = !!image.blob && (error.name === 'UnknownError' || error.name === 'DataCloneError');
          throw error;
        }
        state.used += blob.size;
        chapter.bytes += blob.size;
        chapter.count++;
      }
      chapter.workTitle = title(page.workTitle, chapter.workTitle || key[1]);
      chapter.chapterTitle = title(page.chapterTitle, chapter.chapterTitle || key[2]);
      if (typeof page.chapterSubtitle === 'string') chapter.chapterSubtitle = page.chapterSubtitle;
      chapter.chapterUrl = title(page.chapterUrl, chapter.chapterUrl || '');
      chapter.workKnown = !!key[1] && (page.workKnown ?? chapter.workKnown ?? true);
      chapter.lastIndex = Math.max(chapter.lastIndex || 0, page.index);
      if (Number.isSafeInteger(page.total) && page.total >= chapter.lastIndex) {
        chapter.total = Math.max(chapter.total || 0, page.total);
      }
      if (chapter.total && chapter.lastIndex > chapter.total) chapter.total = null;
      if (Number.isFinite(page.chapterOrder)) chapter.order = page.chapterOrder;
      touch(state, chapter);
      tables.chapters.put(chapter, key);
      tables.settings.put(state, 'storage');
    });
  }

  if (!useImageBytes) {
    try { return await save({ blob }); }
    catch (error) { if (!blobRejected) throw error; }
  }
  // Some WebKit contexts cannot persist Blob records. Convert outside the
  // transaction, after a rejected write and its evictions have rolled back.
  const bytes = await blob.arrayBuffer();
  await save({ bytes, mime: blob.type });
  useImageBytes = true;
}

export function readNovelCatalog(workId) {
  return transaction(['settings'], 'readonly', ({settings}) => request(settings.get(['novelCatalog', workId])));
}

export function saveNovelCatalog(workId, chapters) {
  return transaction(['settings'], 'readwrite', ({settings}) =>
    request(settings.put(chapters.map(({id, title, order, url}) => ({id, title, order, url})), ['novelCatalog', workId])));
}

export async function putNovelChapter(novel, paragraphs) {
  const key = [novel.site, novel.workId, novel.chapterId];
  const bytes = new TextEncoder().encode(JSON.stringify(paragraphs)).byteLength;
  return transaction(stores, 'readwrite', async tables => {
    const [state, previous] = await Promise.all([
      readState(tables.settings), request(tables.chapters.get(key))
    ]);
    if (bytes > state.limit) throw new Error(t('chapterTooLarge'));
    const delta = bytes - (previous?.bytes || 0);
    await makeRoom(tables, state, state.used + delta - state.limit, key);
    const chapter = {
      key, kind: 'novel', workKnown: true, favorite: previous?.favorite ?? false,
      workTitle: novel.workTitle, chapterTitle: novel.chapterTitle, order: novel.order, bytes
    };
    // A novel chapter has one text record. The existing compound key range
    // lets the same eviction transaction remove either text or image records.
    tables.pages.put({ paragraphs }, [...key, 1]);
    state.used += delta;
    touch(state, chapter);
    tables.chapters.put(chapter, key);
    tables.settings.put(state, 'storage');
  });
}

// Keep saved pages readable when the browser can no longer commit recency data.
async function chapterRead(key, read) {
  async function run(tables) {
    const chapter = await request(tables.chapters.get(key));
    if (!chapter) return null;
    const result = await read(tables.pages, chapter);
    if (result && tables.settings) {
      const state = await readState(tables.settings);
      touch(state, chapter);
      tables.chapters.put(chapter, key);
      tables.settings.put(state, 'storage');
    }
    return result;
  }
  try {
    return await transaction(['pages', 'chapters', 'settings'], 'readwrite', run);
  } catch (error) {
    if (error.name !== 'QuotaExceededError') throw error;
    return transaction(['pages', 'chapters'], 'readonly', run);
  }
}

export async function lookupPage(page, includeBlob) {
  const key = identity(page);
  const pageKey = [...key, page.index];
  const data = await chapterRead(key, (pages, chapter) =>
    chapter.kind === 'novel' ? null : request(includeBlob ? pages.get(pageKey) : pages.getKey(pageKey)));
  if (!includeBlob) return { exists: !!data };
  return { exists: !!data, blob: data ? storedImage(data) : null };
}

function storedImage(data) {
  return data.blob || new Blob([data.bytes], { type: data.mime });
}

export async function readExportChapters(keys, validate, signal) {
  return transaction(['chapters', 'pages'], 'readonly', async tables => {
    const chapters = await Promise.all(keys.map(key => request(tables.chapters.get(key))));
    signal.throwIfAborted();
    if (chapters.some(chapter => !chapter?.count || chapter.kind === 'novel')) throw new Error(t('exportChapterMissing'));
    validate(chapters);
    const result = [];
    for (const chapter of chapters) {
      signal.throwIfAborted();
      const pages = await new Promise((resolve, reject) => {
        const images = [];
        const scan = tables.pages.openCursor(indices(chapter.key));
        scan.onerror = () => reject(scan.error);
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (signal.aborted) return reject(signal.reason);
          if (!cursor) return resolve(images);
          try {
            const blob = storedImage(cursor.value);
            if (!blob.size) throw new Error(t('exportChapterMissing'));
            images.push({ index: cursor.key[3], blob });
            cursor.continue();
          } catch (error) {
            reject(error);
          }
        };
      });
      if (pages.length !== chapter.count) throw new Error(t('exportChapterMissing'));
      result.push({ chapter, pages });
    }
    return result;
  });
}

export async function shelf() {
  return transaction(['chapters', 'favoriteWorks', 'settings'], 'readonly', async tables => ({
    chapters: await request(tables.chapters.getAll()),
    favorites: await request(tables.favoriteWorks.getAllKeys()),
    state: await readState(tables.settings)
  }));
}

export async function savedPageCount(key) {
  const chapter = await transaction(['chapters'], 'readonly', tables => request(tables.chapters.get(key)));
  return chapter?.count || 0;
}

export async function readChapterSubtitle(key) {
  const chapter = await transaction(['chapters'], 'readonly', tables => request(tables.chapters.get(key)));
  return chapter?.chapterSubtitle;
}

export async function setChapterSubtitle(key, subtitle) {
  return transaction(['chapters'], 'readwrite', async ({chapters}) => {
    const chapter = await request(chapters.get(key));
    if (!chapter || chapter.chapterSubtitle === subtitle) return false;
    chapter.chapterSubtitle = subtitle;
    await request(chapters.put(chapter, key));
    return true;
  });
}

export async function readChapter(key) {
  return chapterRead(key, async (pages, chapter) => {
    if (chapter.kind === 'novel') return { chapter };
    const keys = await request(pages.getAllKeys(indices(key)));
    return { chapter, indices: keys.map(pageKey => pageKey[3]) };
  });
}

export async function readNovelChapter(key) {
  return chapterRead(key, async (pages, chapter) => {
    if (chapter.kind !== 'novel') return null;
    return (await request(pages.get([...key, 1])))?.paragraphs ?? null;
  });
}

export async function readerBlob(key, index) {
  const [site, workId, chapterId] = key;
  const result = await lookupPage({ site, workId, chapterId, index }, true);
  return result.blob;
}

export async function setLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error(t('invalidLimit'));
  return transaction(stores, 'readwrite', async tables => {
    const state = await readState(tables.settings);
    await makeRoom(tables, state, state.used - bytes);
    state.limit = bytes;
    tables.settings.put(state, 'storage');
  });
}

export async function setFavorite(key, enabled) {
  return transaction(['chapters', 'favoriteWorks'], 'readwrite', async tables => {
    if (key.length === 2) {
      if (!key[1]) throw new Error(t('noWork'));
      if (enabled) tables.favoriteWorks.put(true, key);
      else tables.favoriteWorks.delete(key);
      return;
    }
    const chapter = await request(tables.chapters.get(key));
    if (!chapter) throw new Error(t('chapterRemoved'));
    chapter.favorite = enabled;
    tables.chapters.put(chapter, key);
  });
}
