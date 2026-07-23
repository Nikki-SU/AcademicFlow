/**
 * AcademicFlow Service Worker
 * -------------------------------------------------
 * 提供 PWA 离线 App Shell 缓存。业务数据仍实时从 GitHub 私库拉取，
 * 离线时仅保证 SPA 壳可加载；写入操作在恢复网络/授权后继续。
 */

const CACHE_NAME = 'academicflow-v1'

// 基础应用壳资源（相对路径，随 GitHub Pages base 自动解析）
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './spa-recovery.js',
  './vite.svg',
  './manifest.json',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch((err) => console.warn('[SW] 预缓存失败:', err)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached

      return fetch(event.request)
        .then((response) => {
          const url = new URL(event.request.url)
          if (url.origin === self.location.origin && response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
        .catch((err) => {
          console.warn('[SW] 网络请求失败:', event.request.url, err)
          throw err
        })
    }),
  )
})
