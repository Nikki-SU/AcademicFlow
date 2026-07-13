/**
 * MinerU 代理配置卡片（M3.6.2-b）
 * -------------------------------------------------
 * MinerU 服务端不返回 CORS 头 → 浏览器直连被 preflight 拒。
 * 解决方案：用户在自己的 Cloudflare 账号部署 30 行的透传代理。
 *
 * 本组件职责：
 *   1. 提供「一键部署到 Cloudflare」按钮（跳 CF 官方 Deploy Workers URL）
 *   2. Worker URL 输入框（保存到 IndexedDB mineru_worker_url）
 *   3. 输入后自动 ping /__af_health 验证连通性（500ms debounce）
 *   4. 三步流程截图/文字引导（keep it short）
 *
 * 数据流：用户浏览器 → 用户的 Worker → mineru.net（作者完全绝缘）
 *
 * 隐私：Worker URL 存在 IndexedDB，不上传服务器。
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, Rocket, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'

/** GitHub 官方 Deploy to Cloudflare Workers 按钮的 URL */
const DEPLOY_URL =
  'https://deploy.workers.cloudflare.com/?url=https://github.com/Nikki-SU/AcademicFlow-Worker'
const REPO_URL = 'https://github.com/Nikki-SU/AcademicFlow-Worker'
const HEALTH_PATH = '/__af_health'

type PingState = 'idle' | 'checking' | 'ok' | 'fail'

interface PingResult {
  state: PingState
  message: string
}

async function pingWorker(url: string, signal: AbortSignal): Promise<PingResult> {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return { state: 'idle', message: '' }
  if (!/^https?:\/\//i.test(trimmed)) {
    return { state: 'fail', message: '需要以 https:// 开头' }
  }
  try {
    const res = await fetch(trimmed + HEALTH_PATH, {
      method: 'GET',
      signal,
      // 不带任何自定义 header，避免不必要的 preflight
    })
    if (!res.ok) {
      return { state: 'fail', message: `健康检查 HTTP ${res.status}` }
    }
    const data = (await res.json()) as { ok?: boolean; service?: string }
    if (data.ok && data.service === 'academicflow-worker') {
      return { state: 'ok', message: '连通正常' }
    }
    return { state: 'fail', message: '响应格式不匹配（可能不是 AcademicFlow Worker）' }
  } catch (err) {
    if (signal.aborted) return { state: 'idle', message: '' }
    const msg = err instanceof Error ? err.message : String(err)
    return { state: 'fail', message: `无法连接：${msg}` }
  }
}

export default function MineruProxyConfig() {
  const { mineruWorkerUrl, updateSettings } = useSettingsStore((s) => ({
    mineruWorkerUrl: s.mineruWorkerUrl,
    updateSettings: s.updateSettings,
  }))
  const [draft, setDraft] = useState(mineruWorkerUrl)
  const [ping, setPing] = useState<PingResult>({ state: 'idle', message: '' })
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<number | null>(null)

  // 外部值变更时同步（比如 init 之后）
  useEffect(() => {
    setDraft(mineruWorkerUrl)
  }, [mineruWorkerUrl])

  // 用户输入 → 500ms debounce → 自动 ping
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    if (abortRef.current) abortRef.current.abort()
    if (!draft.trim()) {
      setPing({ state: 'idle', message: '' })
      return
    }
    setPing({ state: 'checking', message: '正在验证...' })
    debounceRef.current = window.setTimeout(async () => {
      const ctl = new AbortController()
      abortRef.current = ctl
      const result = await pingWorker(draft, ctl.signal)
      if (!ctl.signal.aborted) setPing(result)
    }, 500)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [draft])

  const handleSave = async () => {
    const cleaned = draft.trim().replace(/\/+$/, '')
    await updateSettings({ mineruWorkerUrl: cleaned })
    setDraft(cleaned)
    toast.success(cleaned ? 'Worker 地址已保存' : 'Worker 地址已清空')
  }

  const showSaveButton = draft.trim().replace(/\/+$/, '') !== mineruWorkerUrl

  return (
    <div className="space-y-4">
      {/* 一键部署按钮 */}
      <a
        href={DEPLOY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500
                   hover:from-orange-600 hover:to-amber-600 text-white text-sm font-medium
                   rounded-lg shadow-sm transition-all"
      >
        <Rocket className="w-4 h-4" />
        一键部署到 Cloudflare（免费）
        <ExternalLink className="w-3.5 h-3.5 opacity-80" />
      </a>

      {/* 三步指引 */}
      <ol className="text-xs text-slate-600 space-y-1.5 pl-4 list-decimal">
        <li>点上面按钮 → Cloudflare 登录（没账号会自动引导注册，仅需邮箱）</li>
        <li>页面上直接点 <span className="font-semibold">Deploy</span>，全程 CF 官方引导，无自定义步骤</li>
        <li>
          复制生成的 <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">xxx.workers.dev</code>{' '}
          URL，粘到下面的输入框
        </li>
      </ol>

      {/* URL 输入框 + 状态 */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-slate-700">
          Worker URL
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            placeholder="https://academicflow-worker.你的用户名.workers.dev"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                       focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            name="af-mineru-worker-url"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
          {showSaveButton && (
            <button
              type="button"
              onClick={handleSave}
              className="px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md
                         hover:bg-indigo-700 transition-colors"
            >
              保存
            </button>
          )}
        </div>

        {/* 连通性状态 */}
        {ping.state !== 'idle' && (
          <div className="flex items-center gap-1.5 text-xs">
            {ping.state === 'checking' && (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
                <span className="text-slate-500">{ping.message}</span>
              </>
            )}
            {ping.state === 'ok' && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                <span className="text-green-700 font-medium">{ping.message}</span>
              </>
            )}
            {ping.state === 'fail' && (
              <>
                <XCircle className="w-3.5 h-3.5 text-red-600" />
                <span className="text-red-700">{ping.message}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* 隐私说明 */}
      <p className="text-[11px] text-slate-500 leading-relaxed">
        Worker 部署在你自己的 Cloudflare 账号，作者不接触。
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 hover:underline ml-1"
        >
          查看源码（60 行）
        </a>
      </p>
    </div>
  )
}
