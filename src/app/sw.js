/*
 * sw.js — Web 版のサービスワーカー。scripts/build-web.js が CACHE と FILES を埋めて /sw.js に置く。
 * 全ファイルを手元に持ち、オフラインでも開けるようにする。
 * 取りに行くのはネット優先（つながっていれば常に最新）、つながらなければ手元のものを使う。
 */
'use strict';
const CACHE = '__CACHE__';
const FILES = [] /* __FILES__ */;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kamishibai-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('/') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
