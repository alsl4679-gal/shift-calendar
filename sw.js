// 앱 화면 파일만 캐시 (Supabase 데이터는 캐시하지 않음 — 항상 최신)
// 네트워크 우선이라 온라인이면 항상 최신 파일을 받습니다. 캐시 정리가 필요하면 VERSION을 올리세요.
const VERSION = 'v11';
const CACHE = `shift-calendar-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/shift.js',
  './js/config.js',
  './js/holidays.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Supabase 요청은 그대로 통과
  // 네트워크 우선, 실패하면 캐시 (오프라인에서도 화면은 뜸)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});
