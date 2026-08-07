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
  Bug,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import { parseMineruJwt, runMineruSingleFile, severity } from '../../services/mineru'
import {
  identifyCoverFigure,
  renameCoverImage,
  type CoverFigureIdentificationResult,
} from '../../services/cover-figure-identifier'
import type {
  MineruDebugEvent,
  MineruProgressEvent,
  MineruStage,
  MineruTestResult,
} from '../../types'
import { STAGE_LABEL } from './mineru-stages'
import { MineruDebugConsole } from './MineruDebugConsole'
import { MineruProgressTimeline } from './MineruProgressTimeline'
import { MineruResultPanel } from './MineruResultPanel'
import { MineruTokenStatus } from './MineruTokenStatus'

export default function MineruTestPanel() {
  const {
    mineruToken,
    mineruWorkerUrl,
    extractCoverImage,
    mineruDebugMode,
    updateSettings,
  } = useSettingsStore()

  const [showToken, setShowToken] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [currentStage, setCurrentStage] = useState<MineruStage>('idle')
  const [progressLog, setProgressLog] = useState<MineruProgressEvent[]>([])
  const [debugEvents, setDebugEvents] = useState<MineruDebugEvent[]>([])
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MineruTestResult | null>(null)
  const [coverFigureResult, setCoverFigureResult] = useState<CoverFigureIdentificationResult | null>(null)
  const [isIdentifyingCover, setIsIdentifyingCover] = useState(false)
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
    setDebugEvents([])
    setCurrentStage('idle')
    setRunStartedAt(null)
    setCoverFigureResult(null)
  }

  const onProgress = useCallback((ev: MineruProgressEvent) => {
    setCurrentStage(ev.stage)
    setProgressLog((prev) => [...prev, ev])
  }, [])

  const onDebug = useCallback((ev: MineruDebugEvent) => {
    setDebugEvents((prev) => [...prev, ev])
  }, [])

  const handleRun = async () => {
    if (!mineruWorkerUrl.trim()) {
      toast.error('请先在上面「MinerU 代理」区域配置代理 URL')
      return
    }
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
    setCoverFigureResult(null)
    setProgressLog([])
    setDebugEvents([])
    setCurrentStage('applying')
    setRunStartedAt(Date.now())

    abortRef.current = new AbortController()
    try {
      const res = await runMineruSingleFile({
        token: mineruToken,
        workerUrl: mineruWorkerUrl,
        file,
        onProgress,
        onDebug: mineruDebugMode ? onDebug : undefined,
        signal: abortRef.current.signal,
      })
      setResult(res)
      setCurrentStage('done')
      toast.success('MinerU 全流程测试通过')

      // 题图识别兜底（双引擎）：开关开启 + 文献有多张图片时自动跑
      if (extractCoverImage && Object.keys(res.images).length > 0) {
        setIsIdentifyingCover(true)
        try {
          const { getDualEngineConfig } = useSettingsStore.getState()
          const { ai1, ai2 } = getDualEngineConfig()
          const coverRes = await identifyCoverFigure({
            markdown: res.markdown,
            ai1,
            ai2,
          })
          setCoverFigureResult(coverRes)
          if (coverRes.chosenImage) {
            // 演示重命名效果（不修改 result.images，只展示识别结果）
            const { renamedFrom } = renameCoverImage(res.images, coverRes.chosenImage)
            toast.success(
              `题图识别命中：${renamedFrom} → graphical-abstract` +
              `（AI-2 ${coverRes.reviewPassed ? '通过' : '未通过'}，${coverRes.attempts} 轮）`,
            )
          } else {
            toast.info(`题图识别：未找到合适候选（${coverRes.reason.slice(0, 80)}）`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          toast.error(`题图识别失败：${msg}`)
        } finally {
          setIsIdentifyingCover(false)
        }
      }
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
            type="text"
            name="af-secret-mineru-token"
            value={mineruToken}
            onChange={(e) => updateSettings({ mineruToken: e.target.value })}
            placeholder="eyJ0eXBlIjoiSldUIi..."
            autoComplete="new-password"
            data-lpignore="true"
            data-form-type="other"
            data-1p-ignore="true"
            spellCheck={false}
            style={{
              WebkitTextSecurity: showToken ? 'none' : 'disc',
              textSecurity: showToken ? 'none' : 'disc',
            } as CSSProperties}
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

      {/* 调试模式开关（M3.6.3-b · 分发前 Settings 可关） */}
      <label className="flex items-start gap-3 p-3 bg-slate-50 border border-slate-200 rounded-md cursor-pointer">
        <input
          type="checkbox"
          checked={mineruDebugMode}
          onChange={(e) => updateSettings({ mineruDebugMode: e.target.checked })}
          className="mt-0.5 w-4 h-4 accent-indigo-600"
        />
        <div className="flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
            <Bug className="w-3.5 h-3.5 text-indigo-500" />
            调试模式（Debug Console）
            <span className="ml-1 px-1.5 py-0.5 text-[0.625rem] font-normal bg-indigo-100 text-indigo-700 rounded">
              开发期默认开启
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
            开启后，测试面板底部会实时打印 pipeline 每一步的 fetch 详情：
            method / URL / 状态码 / 耗时 / 错误。用于定位"上传成功但等待解析卡住"
            这类客户端侧问题；分发正式版前建议关闭以减少日志噪声。
          </p>
        </div>
      </label>

      {/* 提取题图开关（双引擎兜底：AI-1 判断 + AI-2 审 + 引证锚定） */}
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
            <span className="ml-1 px-1.5 py-0.5 text-[0.625rem] font-normal bg-emerald-100 text-emerald-700 rounded">
              双引擎兜底
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
            论文里最能代表全文核心的那张单图，通常是第一张但不必然；
            理工科需要、社科可关。开启后，MinerU 解析完成会自动跑双引擎：
            AI-1 基于 markdown 中的图片 caption/位置/上下文判断哪张是题图，
            AI-2 核查判断理由是否真实来自原文（引证锚定），命中后重命名为 graphical-abstract。
          </p>
          {isIdentifyingCover && (
            <p className="text-xs text-indigo-600 mt-1.5 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              AI-1 判断 + AI-2 审阅中…
            </p>
          )}
          {coverFigureResult && !isIdentifyingCover && (
            <div className="mt-2 p-2 bg-white border border-slate-200 rounded text-xs">
              <div className="flex items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded ${coverFigureResult.reviewPassed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  AI-2 {coverFigureResult.reviewPassed ? '通过' : '未通过'}（{coverFigureResult.attempts} 轮）
                </span>
                <span className="text-slate-700">
                  命中：{coverFigureResult.chosenImage || '（无合适候选）'}
                </span>
              </div>
              {coverFigureResult.reason && (
                <p className="text-slate-500 mt-1 line-clamp-3">{coverFigureResult.reason}</p>
              )}
            </div>
          )}
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
            disabled={!file || !mineruToken.trim() || !mineruWorkerUrl.trim() || jwtInfo.isExpired}
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

      {/* 调试控制台（M3.6.3-b · 仅 mineruDebugMode=true 时挂载） */}
      {mineruDebugMode && (
        <MineruDebugConsole
          events={debugEvents}
          onClear={() => setDebugEvents([])}
          startedAt={runStartedAt}
        />
      )}
    </div>
  )
}
