/**
 * MinerU 代理配置卡片（M3.6.2-d · 双 Runtime 版）
 * -------------------------------------------------
 * MinerU 服务端不返回 CORS 头 → 浏览器直连被 preflight 拒。
 * 解决方案：用户在自己的账号部署透传代理（同一份 Worker 代码，两种 Runtime）：
 *   - Deno Deploy       → *.deno.net（国内三大运营商基本可达，默认）
 *   - Cloudflare Workers → *.workers.dev（一键部署，但国内需代理才能访问）
 *
 * 本组件职责：
 *   1. 顶部部署方案二选一（deploy mode radio，落 IndexedDB）
 *   2. 根据所选方案显示部署按钮 + 简短指引（拆到 MineruDeployGuide）
 *   3. Worker URL 输入框（保存到 mineru_worker_url）
 *   4. 500ms debounce 自动 ping /__af_health，识别 runtime 字段回显
 *
 * 数据流：用户浏览器 → 用户部署的代理 → mineru.net（作者完全绝缘）
 * 隐私：URL / mode 存 IndexedDB，不上传服务器。
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, XCircle, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import type { SettingsData } from '../../types'
import MineruDeployGuide from './MineruDeployGuide'

type DeployMode = SettingsData['mineruDeployMode']

const REPO_URL = 'https://github.com/Nikki-SU/AcademicFlow-Worker'
const HEALTH_PATH = '/__af_health'

type PingState = 'idle' | 'checking' | 'ok' | 'fail' | 'mismatch'

interface PingResult {
  state: PingState
  message: string
  runtime?: 'deno-deploy' | 'cf-workers' | 'unknown'
}

interface HealthResponse {
  ok?: boolean
  service?: string
  runtime?: string
}

function normalizeRuntime(raw: unknown): PingResult['runtime'] {
  if (raw === 'deno-deploy') return 'deno-deploy'
  if (raw === 'cf-workers') return 'cf-workers'
  return 'unknown'
}

async function pingWorker(
  url: string,
  expectedMode: DeployMode,
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
    const runtime = normalizeRuntime(data.runtime)
    const expectedRuntime = expectedMode === 'deno' ? 'deno-deploy' : 'cf-workers'
    if (runtime !== 'unknown' && runtime !== expectedRuntime) {
      const actual = runtime === 'deno-deploy' ? 'Deno Deploy' : 'Cloudflare Workers'
      const expected = expectedMode === 'deno' ? 'Deno Deploy' : 'Cloudflare Workers'
      return {
        state: 'mismatch',
        message: `连通正常，但实际部署到 ${actual}（当前选的是 ${expected}）`,
        runtime,
      }
    }
    return { state: 'ok', message: '连通正常', runtime }
  } catch (err) {
    if (signal.aborted) return { state: 'idle', message: '' }
    const msg = err instanceof Error ? err.message : String(err)
    return { state: 'fail', message: `无法连接：${msg}` }
  }
}

function DeployModeSelector(props: {
  mode: DeployMode
  onChange: (mode: DeployMode) => void
}) {
  const { mode, onChange } = props
  const options: Array<{
    value: DeployMode
    flag: string
    title: string
    subtitle: string
    hint: string
  }> = [
    {
      value: 'deno',
      flag: '🇨🇳',
      title: '国内网络',
      subtitle: 'Deno Deploy',
      hint: '不用代理，国内三大运营商基本可达',
    },
    {
      value: 'cf-workers',
      flag: '🌍',
      title: '海外 / 有代理',
      subtitle: 'Cloudflare Workers',
      hint: '一键部署最省事，但 workers.dev 国内需代理',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((opt) => {
        const selected = mode === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
              selected
                ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200'
                : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-base leading-none">{opt.flag}</span>
              <span className="text-sm font-semibold text-slate-800">{opt.title}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500 font-mono">{opt.subtitle}</div>
            <div className="mt-1 text-[11px] text-slate-500">{opt.hint}</div>
          </button>
        )
      })}
    </div>
  )
}

export default function MineruProxyConfig() {
  const { mineruWorkerUrl, mineruDeployMode, updateSettings } = useSettingsStore((s) => ({
    mineruWorkerUrl: s.mineruWorkerUrl,
    mineruDeployMode: s.mineruDeployMode,
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
      const result = await pingWorker(draft, mineruDeployMode, ctl.signal)
      if (!ctl.signal.aborted) setPing(result)
    }, 500)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [draft, mineruDeployMode])

  const handleSave = async () => {
    const cleaned = draft.trim().replace(/\/+$/, '')
    await updateSettings({ mineruWorkerUrl: cleaned })
    setDraft(cleaned)
    toast.success(cleaned ? '代理地址已保存' : '代理地址已清空')
  }

  const handleModeChange = async (nextMode: DeployMode) => {
    if (nextMode === mineruDeployMode) return
    await updateSettings({ mineruDeployMode: nextMode })
  }

  const showSaveButton = draft.trim().replace(/\/+$/, '') !== mineruWorkerUrl
  const placeholder =
    mineruDeployMode === 'deno'
      ? 'https://academicflow-worker-xxxx.你的组织.deno.net'
      : 'https://academicflow-worker.你的用户名.workers.dev'

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="block text-sm font-medium text-slate-700">部署方案</label>
        <DeployModeSelector mode={mineruDeployMode} onChange={handleModeChange} />
      </div>

      <MineruDeployGuide mode={mineruDeployMode} />

      <div className="space-y-2">
        <label className="block text-sm font-medium text-slate-700">代理 URL</label>
        <div className="flex gap-2">
          <input
            type="url"
            placeholder={placeholder}
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
            {ping.state === 'mismatch' && (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-amber-700">{ping.message}</span>
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
        代理部署在你自己的账号下，作者不接触。两种方案用同一份代码。
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
