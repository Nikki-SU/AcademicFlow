/**
 * MinerU 代理配置卡片
 * -------------------------------------------------
 * MinerU 服务端不返回 CORS 头 → 浏览器直连被 preflight 拒。
 * 解决方案：用户在自己的账号部署 Deno Deploy 透传代理。
 *
 * 本组件职责：
 *   1. 部署指引（Deno Deploy 6 步）
 *   2. Worker URL 输入框（保存到 mineru_worker_url）
 *   3. 500ms debounce 自动 ping /__af_health
 *
 * 数据流：用户浏览器 → 用户部署的代理 → mineru.net（作者完全绝缘）
 * 隐私：URL 存 IndexedDB，不上传服务器。
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import MineruDeployGuide from './MineruDeployGuide'

const REPO_URL = 'https://github.com/Nikki-SU/AcademicFlow-Worker'
const HEALTH_PATH = '/__af_health'

type PingState = 'idle' | 'checking' | 'ok' | 'fail'

interface PingResult {
  state: PingState
  message: string
}

interface HealthResponse {
  ok?: boolean
  service?: string
}

async function pingWorker(
  url: string,
  signal: AbortSignal,
): Promise<PingResult> {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return { state: 'idle', message: '' }
  if (!/^https?:\/\//i.test(trimmed)) {
    return { state: 'fail', message: '需要以 https:// 开头' }
  }
  try {
    const res = await fetch(trimmed + HEALTH_PATH, { method: 'GET', signal })
    if (!res.ok) return { state: 'fail', message: `健康检查 HTTP ${res.status}` }
    const data = (await res.json()) as HealthResponse
    if (!data.ok || data.service !== 'academicflow-worker') {
      return { state: 'fail', message: '响应格式不匹配（可能不是 AcademicFlow Worker）' }
    }
    return { state: 'ok', message: '连通正常' }
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

  useEffect(() => {
    setDraft(mineruWorkerUrl)
  }, [mineruWorkerUrl])

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
    toast.success(cleaned ? '代理地址已保存' : '代理地址已清空')
  }

  const showSaveButton = draft.trim().replace(/\/+$/, '') !== mineruWorkerUrl

  return (
    <div className="space-y-4">
      <MineruDeployGuide />

      <div className="space-y-2">
        <label className="block text-sm font-medium text-slate-700">代理 URL</label>
        <div className="flex gap-2">
          <input
            type="url"
            placeholder="http://你的VPS公网IP:8000"
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

      <p className="text-[11px] text-slate-500 leading-relaxed">
        代理部署在你自己的账号下，作者不接触。
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 hover:underline ml-1"
        >
          查看源码
        </a>
      </p>
    </div>
  )
}
