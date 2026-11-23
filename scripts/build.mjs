import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const siteFiles = (await readdir(new URL('src/sites/', root)))
  .filter(name => name.endsWith('.js') && name !== 'generic.js').sort();
siteFiles.push('generic.js');

const [metadata, template, detectors, i18n, store, events, view, controls, shell, libraryCss, navigationCss, comicZip] = await Promise.all([
  read('src/userscript.meta'), read('src/userscript.js'), Promise.all(siteFiles.map(name => read('src/sites/' + name))),
  read('library/i18n.js'),
  read('library/store.js'), read('src/shelf-events.js'), read('library/shelf.js'),
  read('library/reader-controls.js'), read('library/index.html'), read('library/library.css'),
  read('library/reader-navigation.css'), read('library/comic-zip.js')
]);

// These modules share a single userscript scope. The library markup and styles
// are embedded too, so opening the menu needs no external library assets.
function inlineModule(source) {
  return source.replace(/^import .* from ['"].*['"];\n/gm, '').replace(/^export /gm, '');
}

const shelfDocument = shell
  .replace(/^  <(?:link rel="stylesheet"|script type="module").*\n/gm, '')
  .replace('</head>', () => '<style>' + libraryCss + '\n' + navigationCss + '</style></head>')
  .replaceAll('offlineLibrary', 'siteLibrary')
  .replaceAll('離線書庫', '本站書庫')
  .replace('準備本站書庫中', '');
const parts = {
  I18N: inlineModule(i18n),
  SITE_ADAPTERS: detectors.join('\n'),
  SITE_STORE: inlineModule(store),
  SHELF_EVENTS: events,
  COMIC_ZIP: inlineModule(comicZip),
  SHELF_VIEW: inlineModule(view),
  SHELF_DOCUMENT: JSON.stringify(shelfDocument),
  READER_CONTROLS: inlineModule(controls),
  READER_NAV_CSS: navigationCss
};
const source = template.replace(/\/\* INSERT_(\w+) \*\//g, (_match, key) => {
  if (!Object.hasOwn(parts, key)) throw new Error('未知的建置欄位 ' + key);
  return parts[key];
});
// Older callers pass a deployment URL before the output directory.
const [first, second] = process.argv.slice(2);
const directory = /^https?:\/\//i.test(first || '') ? second : first;
const dist = directory ? resolve(directory) : fileURLToPath(new URL('dist/', root));
await mkdir(dist, {recursive: true});
const output = join(dist, 'komaglide.user.js');
await writeFile(output, metadata + '\n' + source);
console.log(output);
