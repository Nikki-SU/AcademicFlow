/**
 * AcademicFlow Service Worker
 * -------------------------------------------------
 * 提供 PWA 离线 App Shell 缓存。业务数据仍实时从 GitHub 私库拉取，
 * 离线时仅保证 SPA 壳可加载；写入操作在恢复网络/授权后继续。
 *
 * 关键：dev 模式（localhost / 127.0.0.1）下完全 pass-through，
 * 不缓存任何 Vite 编译资源，否则会挡住 HMR 和代码更新。
 */

const CACHE_NAME = 'academicflow-v2'

// Dev 检测：localhost 或 127.0.0.1 时不缓存
function isDevUrl(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
}

// 基础应用壳资源（相对路径，随 GitHub Pages base 自动解析）
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './spa-recovery.js',
  './vite.svg',
  './manifest.json',
]

self.addEventListener('install', (event) => {
  const url = new URL(self.location.href)
  if (isDevUrl(url)) {
    // dev 模式直接激活，不缓存
    self.skipWaiting()
    return
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch((err) => console.warn('[SW] 预缓存失败:', err)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  const url = new URL(self.location.href)
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

  const url = new URL(event.request.url)

  // Dev 模式：完全 pass-through，不做任何缓存
  if (isDevUrl(url)) {
    return
  }

  // ⚠️ 关键：跨域请求一律直连网络，绝不进 SW 缓存。
  // api.github.com / raw.githubusercontent.com 等是实时业务数据，
  // 一旦 cache-first，actions/runs 列表会永远返回 dispatch 前的旧快照，
  // 表现为"dispatch 成功但 30s 找不到新 run"。
  if (url.origin !== self.location.origin) {
    return
  }

  // 同源但带 query string 的请求也不缓存（SPA 内部状态/路由）
  if (url.search) {
    return
  }

  // 仅对同源静态资源（HTML 壳、hashed assets）做 cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached

      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
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
