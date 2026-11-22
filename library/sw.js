const root = self.registration.scope;
const prefix = 'komaglide-shell:' + root + ':';
const cacheName = prefix + '9';
const urls = ['index.html', 'library.css', 'reader-navigation.css', 'app.js', 'shelf.js', 'store.js', 'bridge.js', 'reader-controls.js', 'i18n.js'].map(path => new URL(path, root).href);
const entry = urls[0];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(urls.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  url.hash = ''; // Chapter deep links use the same cached bookshelf document.
  const asset = url.href === root ? entry : url.href;
  if (!urls.includes(asset)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(asset) || fetch(event.request);
  })());
});
