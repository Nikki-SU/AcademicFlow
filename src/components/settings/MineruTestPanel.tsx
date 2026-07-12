/**
 * MinerU 全流程测试面板 - 主组件（M3.7）
 * -------------------------------------------------
 * 位置：设置页 > MinerU 卡片
 * 定位：跟 DualEngineTestPanel 平级的"一键跑通完整链路"验证工具
 * 范围：单文件（≤180 页）4 步流程 → 拆分/合并留给 Import 阶段
 *
 * 子组件：
 *   - MineruTokenStatus     JWT 状态徽章
 *   - MineruProgressTimeline 5 阶段进度
 *   - MineruResultPanel     完成后的结果 & 操作
 */
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import { parseMineruJwt, runMineruSingleFile, severity } from '../../services/mineru'
import type {
  MineruProgressEvent,
  MineruStage,
  MineruTestResult,
} from '../../types'
import { STAGE_LABEL } from './mineru-stages'
import { MineruProgressTimeline } from './MineruProgressTimeline'
import { MineruResultPanel } from './MineruResultPanel'
import { MineruTokenStatus } from './MineruTokenStatus'

export default function MineruTestPanel() {
  const { mineruToken, extractCoverImage, updateSettings } = useSettingsStore()

  const [showToken, setShowToken] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [currentStage, setCurrentStage] = useState<MineruStage>('idle')
  const [progressLog, setProgressLog] = useState<MineruProgressEvent[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MineruTestResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const jwtInfo = useMemo(() => parseMineruJwt(mineruToken), [mineruToken])
  const sev = severity(jwtInfo)

  useEffect(() => () => abortRef.current?.abort(), [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setResult(null)
    setError(null)
    setProgressLog([])
    setCurrentStage('idle')
  }

  const onProgress = useCallback((ev: MineruProgressEvent) => {
    setCurrentStage(ev.stage)
    setProgressLog((prev) => [...prev, ev])
  }, [])

  const handleRun = async () => {
    if (!mineruToken.trim()) {
      toast.error('请先填写 MinerU Token')
      return
    }
    if (jwtInfo.isExpired) {
      toast.error('Token 已过期，请到 mineru.net 重新生成')
      return
    }
    if (!file) {
      toast.error('请先选择一个 PDF 文件')
      return
    }

    setIsRunning(true)
    setError(null)
    setResult(null)
    setProgressLog([])
    setCurrentStage('applying')

    abortRef.current = new AbortController()
    try {
      const res = await runMineruSingleFile({
        token: mineruToken,
        file,
        onProgress,
        signal: abortRef.current.signal,
      })
      setResult(res)
      setCurrentStage('done')
      toast.success('MinerU 全流程测试通过')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setCurrentStage('failed')
      toast.error(`失败：${msg}`)
    } finally {
      setIsRunning(false)
    }
  }

  const handleAbort = () => {
    abortRef.current?.abort()
    setIsRunning(false)
    setCurrentStage('failed')
    setError('已被用户取消')
  }

  const totalMs = useMemo(() => {
    if (!result) return 0
    return Object.values(result.timing).reduce((s, v) => s + (v ?? 0), 0)
  }, [result])

  return (
    <div className="space-y-4">
      {/* Token 输入 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">
            MinerU Token（JWT）
          </label>
          <a
            href="https://mineru.net/apiManage/token"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-600 hover:text-indigo-800"
          >
            去获取 Token →
          </a>
        </div>
        <div className="relative">
          <input
            type={showToken ? 'text' : 'password'}
            value={mineruToken}
            onChange={(e) => updateSettings({ mineruToken: e.target.value })}
            placeholder="eyJ0eXBlIjoiSldUIi..."
            className="w-full pl-3 pr-10 py-2 text-sm font-mono border border-slate-300 rounded-md
                       focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            type="button"
            onClick={() => setShowToken((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
          >
            {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {mineruToken.trim() && <MineruTokenStatus jwtInfo={jwtInfo} sev={sev} />}
        <p className="text-xs text-slate-500">仅存本机 IndexedDB，不上传任何服务器</p>
      </div>

      {/* 提取题图开关 */}
      <label className="flex items-start gap-3 p-3 bg-slate-50 border border-slate-200 rounded-md cursor-pointer">
        <input
          type="checkbox"
          checked={extractCoverImage}
          onChange={(e) => updateSettings({ extractCoverImage: e.target.checked })}
          className="mt-0.5 w-4 h-4 accent-indigo-600"
        />
        <div className="flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
            <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
            提取题图（cover figure）
          </div>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
            论文里最能代表全文核心的那张单图，通常是第一张但不必然；
            理工科需要、社科可关。判断需要 AI 参与，具体逻辑在 Import 时启用。
          </p>
        </div>
      </label>

      {/* PDF 选择器 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-slate-700">选择 PDF 文件</label>
        <input
          type="file"
          accept=".pdf,application/pdf"
          onChange={handleFileChange}
          disabled={isRunning}
          className="block w-full text-sm text-slate-600
                     file:mr-3 file:py-1.5 file:px-3 file:border-0
                     file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700
                     hover:file:bg-indigo-100 file:cursor-pointer disabled:opacity-50"
        />
        {file && (
          <p className="text-xs text-slate-500">
            {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
          </p>
        )}
        <p className="text-xs text-amber-600 flex items-start gap-1">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          单文件测试仅支持 ≤180 页；更大 PDF 需拆分（Import 里再放开）
        </p>
      </div>

      {/* 按钮 */}
      <div className="flex gap-2">
        {!isRunning ? (
          <button
            type="button"
            onClick={handleRun}
            disabled={!file || !mineruToken.trim() || jwtInfo.isExpired}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-indigo-600 text-white
                       rounded-md hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            <Play className="w-4 h-4" />
            开始 MinerU 全流程测试
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm
                         bg-indigo-100 text-indigo-700 rounded-md"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              {STAGE_LABEL[currentStage]}
            </button>
            <button
              type="button"
              onClick={handleAbort}
              className="px-3 py-2 text-sm border border-slate-300 rounded-md hover:bg-slate-50"
            >
              取消
            </button>
          </>
        )}
      </div>

      {/* 进度 */}
      {(isRunning || result || error) && (
        <MineruProgressTimeline current={currentStage} logs={progressLog} />
      )}

      {/* 结果 */}
      {result && <MineruResultPanel result={result} totalMs={totalMs} />}

      {/* 错误 */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4" />
            全流程失败
          </div>
          <p className="whitespace-pre-wrap break-all font-mono text-xs">{error}</p>
        </div>
      )}
    </div>
  )
}
