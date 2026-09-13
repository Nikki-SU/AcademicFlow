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
  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('sw.js')
      .then(function (registration) {
        console.log('[SW] 注册成功:', registration.scope)
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
