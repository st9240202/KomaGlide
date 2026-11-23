import { t } from './i18n.js';
// ZIP32 reserves the maximum field values as ZIP64 markers.
const zipEntryLimit = 0xfffe;
const zipSizeLimit = 0xfffffffe;
const zipExtensions = {
  jpeg: 'jpg', png: 'png', apng: 'apng', webp: 'webp', gif: 'gif',
  avif: 'avif', bmp: 'bmp', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico',
};

export function validateComicZip(chapters) {
  let entries = 0;
  let bytes = 22;
  for (const chapter of chapters) {
    entries += chapter.count;
    bytes += chapter.bytes + chapter.count * 76;
  }
  if (entries > zipEntryLimit || bytes > zipSizeLimit) throw new Error(t('exportTooLarge'));
}

function zipTitle(title) {
  const safe = title.normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Bidi_Control}]/gu, '_')
    .trim();
  return Array.from(safe).slice(0, 28).join('').replace(/[. ]+$/u, '') || '_';
}

function zipEntries(chapters) {
  const groups = new Map();
  for (const { chapter, pages } of chapters) {
    const key = JSON.stringify(chapter.workKnown ? chapter.key.slice(0, 2) : chapter.key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ chapter, pages });
  }
  const entries = [];
  const encoder = new TextEncoder();
  const number = (index, width) => String(index).padStart(width, '0');
  let groupIndex = 0;
  for (const group of groups.values()) {
    const first = group[0].chapter;
    const groupNumber = number(++groupIndex, String(groups.size).length);
    const folder = groupNumber + ' - ' + zipTitle(first.workKnown ? first.workTitle : first.chapterTitle);
    for (const [index, { chapter, pages }] of group.entries()) {
      const path = chapter.workKnown
        ? folder + '/' + number(index + 1, String(group.length).length) + ' - ' + zipTitle(chapter.chapterTitle)
        : folder;
      const width = Math.max(3, String(pages.at(-1).index).length);
      for (const page of pages) {
        const subtype = /^image\/([a-z0-9.-]+)$/i.exec(page.blob.type)?.[1].toLowerCase();
        const extension = Object.hasOwn(zipExtensions, subtype) ? zipExtensions[subtype] : 'bin';
        const name = encoder.encode(path + '/' + number(page.index, width) + '.' + extension);
        entries.push({ name, blob: page.blob });
      }
    }
  }
  return entries;
}

const zipCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value;
});

async function zipCrc(blob, signal, yieldIfNeeded) {
  const chunkSize = 1024 ** 2;
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    for (const byte of bytes) crc = (crc >>> 8) ^ zipCrcTable[(crc ^ byte) & 0xff];
    const pause = yieldIfNeeded();
    if (pause) await pause;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipHeaders(name, size, crc, offset) {
  // APPNOTE 4.3.7 and 4.3.12. Method 0 stores the original image bytes.
  const local = new Uint8Array(30 + name.length);
  const file = new DataView(local.buffer);
  file.setUint32(0, 0x04034b50, true);
  file.setUint16(4, 10, true);
  file.setUint16(6, 1 << 11, true); // UTF-8 names.
  file.setUint16(12, 0x21, true); // DOS date 1980-01-01.
  file.setUint32(14, crc, true);
  file.setUint32(18, size, true);
  file.setUint32(22, size, true);
  file.setUint16(26, name.length, true);
  local.set(name, 30);

  const central = new Uint8Array(46 + name.length);
  const directory = new DataView(central.buffer);
  directory.setUint32(0, 0x02014b50, true);
  directory.setUint16(4, 20, true);
  central.set(local.subarray(4, 30), 6);
  directory.setUint32(42, offset, true);
  central.set(name, 46);
  return { local, central };
}

export async function makeComicZip(chapters, { signal, progress }) {
  validateComicZip(chapters.map(({ chapter }) => chapter));
  const entries = zipEntries(chapters);
  const bytes = entries.reduce((sum, { name, blob }) => sum + 76 + 2 * name.length + blob.size, 22);
  if (entries.length > zipEntryLimit || bytes > zipSizeLimit) throw new Error(t('exportTooLarge'));
  const files = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  let lastYield = performance.now();
  function yieldIfNeeded() {
    if (performance.now() - lastYield < 32) return;
    return new Promise(resolve => setTimeout(() => {
      lastYield = performance.now();
      resolve();
    }, 0));
  }
  progress(0, entries.length);
  for (const [index, { name, blob }] of entries.entries()) {
    const crc = await zipCrc(blob, signal, yieldIfNeeded);
    signal.throwIfAborted();
    const { local, central } = zipHeaders(name, blob.size, crc, offset);
    files.push(local, blob);
    directory.push(central);
    offset += local.length + blob.size;
    directorySize += central.length;
    if (index % 16 === 0 || index + 1 === entries.length) progress(index + 1, entries.length);
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...files, ...directory, end.buffer], { type: 'application/zip' });
}
