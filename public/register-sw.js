/**
 * PWA Service Worker 注册
 * -------------------------------------------------
 * 注册 public/sw.js，使应用支持离线 App Shell 缓存。
 * 失败时静默降级，不影响主应用运行。
 */

if ('serviceWorker' in navigator) {
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
}
