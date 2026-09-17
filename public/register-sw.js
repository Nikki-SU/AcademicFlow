/**
 * PWA Service Worker 注册
 * -------------------------------------------------
 * 只在生产环境（非 localhost / 非 127.0.0.1）注册 SW。
 * dev 模式下主动卸载任何已存在的 SW，防止缓存 Vite 编译产物。
 */

const isDev = (() => {
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
})()

if (!isDev && 'serviceWorker' in navigator) {
  // 旧版 SW 曾错误地 cache-first 缓存了 api.github.com 的实时响应 (v1),
  // v2 又会缓存 index.html 导致新部署不生效。
  // 新 JS 一加载就无条件清掉所有非 v3 缓存, 兜底。
  if ('caches' in window) {
    caches.keys().then(function (keys) {
      keys.forEach(function (k) {
        if (k !== 'academicflow-v3') {
          caches.delete(k).then(function () {
            console.log('[SW] 已清理旧缓存:', k)
          })
        }
      })
    })
  }

  // 新 SW (skipWaiting) 接管后自动刷新一次, 保证用户拿到修复版
  var reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!reloaded) { reloaded = true; window.location.reload() }
  })

  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('sw.js')
      .then(function (registration) {
        console.log('[SW] 注册成功:', registration.scope)
        // 立即检查 sw.js 更新, 不等浏览器默认周期
        return registration.update()
      })
      .catch(function (err) {
        console.warn('[SW] 注册失败:', err)
      })
  })
} else if (isDev && 'serviceWorker' in navigator) {
  // dev 模式：主动卸载任何已存在的 SW（之前可能注册过）
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    for (const reg of registrations) {
      reg.unregister().then(function () {
        console.log('[SW] dev 模式已卸载 Service Worker:', reg.scope)
      })
    }
  })
  // 同时清掉所有 caches（SW 缓存的旧 bundle）
  if ('caches' in window) {
    caches.keys().then(function (keys) {
      Promise.all(keys.map(function (k) { return caches.delete(k) })).then(function () {
        if (keys.length > 0) console.log('[SW] dev 模式已清 ' + keys.length + ' 个 cache')
      })
    })
  }
}
