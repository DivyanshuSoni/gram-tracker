/* Gram Tracker service worker: keeps the whole app on the phone so it runs offline.
   To ship an update: change files, bump VERSION here and in app.js + version.json (release.py does all three). */
const VERSION = '1.4.2';
const APP_CACHE = 'gt-app-' + VERSION;
const VENDOR_CACHE = 'gt-vendor-tesseract-5.1.1';   // large OCR files: kept across app updates

const APP_FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'label.js', 'link.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
const VENDOR_FILES = [
  'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/core/tesseract-core-simd-lstm.wasm.js', 'vendor/core/tesseract-core-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_FILES.map(f => new Request(f, { cache: 'reload' })));
    const vendor = await caches.open(VENDOR_CACHE);
    const have = await vendor.keys();
    if (have.length < VENDOR_FILES.length) await vendor.addAll(VENDOR_FILES.map(f => new Request(f, { cache: 'reload' })));
  })());
  // No skipWaiting here: a downloaded update waits until you tap "Install update" in Settings.
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [APP_CACHE, VENDOR_CACHE];
    for (const k of await caches.keys()) if (k.startsWith('gt-') && !keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;            // always ask the server (update check)
  e.respondWith((async () => {
    if (req.mode === 'navigate') {
      const page = await caches.match('index.html', { ignoreSearch: true });
      if (page) return page;
    }
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch { return new Response('Offline and not cached', { status: 503 }); }
  })());
});
