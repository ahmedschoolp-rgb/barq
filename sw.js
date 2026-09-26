/* برق — service worker:
   1) يخزّن واجهة التطبيق والمحرك أول مرة، وبعدها التطبيق يفتح حتى بدون إنترنت.
   2) يستقبل الملفات المشاركة من واتساب/المعرض (share_target) ويحفظها في مجلد inbox جوه الجهاز.
   بيانات الملفات نفسها محفوظة في OPFS، مش في الكاش. */
const CACHE = 'barq-v4';
const SHELL = ['./', './index.html', './worker.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function storeShared(request) {
  const fd = await request.formData();
  const files = fd.getAll('files').filter((f) => f && typeof f.size === 'number' && f.size > 0);
  if (!files.length) return 0;
  let root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('inbox', { create: true });
  for (const f of files) {
    // أسماء الملفات بالعربي/أي غير ASCII بنخزّنها percent-encoded لأن بعض نُسَخ المتصفح بترفض الأسماء غيرASCII جوه التخزين
    let clean = (f.name || 'shared').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
    let name = encodeURIComponent(clean);
    while (name.length > 200 && clean.length > 1) { clean = clean.slice(0, -1); name = encodeURIComponent(clean); }
    if (!name) name = 'shared';
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(f);
    await w.close();
  }
  return files.length;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // مشاركة ملفات من خارج التطبيق (واتساب / المعرض / مدير الملفات)
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(
      storeShared(e.request)
        .then(() => Response.redirect(new URL('./index.html?shared=1', url).href, 302))
        .catch(() => Response.redirect(new URL('./index.html', url).href, 302))
    );
    return;
  }

  if (e.request.method !== 'GET') return;
  // الشبكة أولًا، والكاش لو الإنترنت مقطوع
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
