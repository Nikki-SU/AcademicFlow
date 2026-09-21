import { useState, useMemo, useEffect } from 'react'
import { PdfQuickUploadButton } from './PdfQuickUpload'
import { toast } from 'sonner'
import {
  listRecentTraces,
  getTrace,
  deleteTrace,
  clearAllTraces,
  formatDuration,
  type PipelineRunTrace,
  type StageTrace,
} from '../services/pipeline-trace'

// 颜色映射
const ENGINE_COLOR: Record<string, string> = {
  ai1: 'bg-purple-100 text-purple-700 border-purple-300',
  ai2: 'bg-blue-100 text-blue-700 border-blue-300',
  code: 'bg-green-100 text-green-700 border-green-300',
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  running: { label: '运行中', cls: 'bg-amber-100 text-amber-700' },
  done: { label: '成功', cls: 'bg-green-100 text-green-700' },
  failed: { label: '失败', cls: 'bg-red-100 text-red-700' },
}

function StageRow({ stage, index }: { stage: StageTrace; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'prompt' | 'input' | 'output'>('prompt')

  const engineCls = ENGINE_COLOR[stage.aiEngine ?? ''] ?? 'bg-slate-100 text-slate-600 border-slate-300'

  // passed 状态
  const statusIcon =
    stage.error ? '❌' : stage.passed === false ? '⚠️' : stage.passed === true ? '✅' : '⏱️'

  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      {/* 标题行 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors text-left"
      >
        <span className="text-xs font-mono text-slate-400 w-5">#{index + 1}</span>
        <span className="text-base">{statusIcon}</span>
        <span className="font-medium text-slate-800 flex-1">{stage.label}</span>
        {stage.aiEngine && (
          <span className={`text-[10px] px-2 py-0.5 rounded border ${engineCls}`}>
            {stage.aiEngine}
          </span>
        )}
        {stage.aiModel && (
          <span className="text-[0.625rem] text-slate-500 font-mono max-w-[7.5rem] truncate">
            {stage.aiModel}
          </span>
        )}
        <span className="text-xs text-slate-500 font-mono tabular-nums w-14 text-right">
          {formatDuration(stage.durationMs)}
        </span>
        <span
          className={`text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          ›
        </span>
      </button>

      {/* 展开详情 */}
      {expanded && (
        <div className="border-t border-slate-200 bg-slate-50/50">
          {/* Tab 切换 */}
          <div className="flex gap-1 px-4 pt-3">
            {stage.prompt && (
              <button
                onClick={() => setTab('prompt')}
                className={`px-3 py-1 text-xs font-medium rounded-t ${
                  tab === 'prompt'
                    ? 'bg-white text-slate-800 border border-slate-200 border-b-transparent'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Prompt
              </button>
            )}
            <button
              onClick={() => setTab('input')}
              className={`px-3 py-1 text-xs font-medium rounded-t ${
                tab === 'input'
                  ? 'bg-white text-slate-800 border border-slate-200 border-b-transparent'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              输入 {stage.inputLength != null && `(${stage.inputLength} 字符)`}
            </button>
            <button
              onClick={() => setTab('output')}
              className={`px-3 py-1 text-xs font-medium rounded-t ${
                tab === 'output'
                  ? 'bg-white text-slate-800 border border-slate-200 border-b-transparent'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              输出 {stage.outputLength != null && `(${stage.outputLength} 字符)`}
            </button>
          </div>

          {/* 内容 */}
          <div className="px-4 pb-3 pt-2">
            {stage.error ? (
              <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 font-mono whitespace-pre-wrap">
                {stage.error}
              </div>
            ) : tab === 'prompt' ? (
              <pre className="bg-slate-900 text-slate-100 rounded-md p-3 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap break-words font-mono">
                {stage.prompt}
              </pre>
            ) : tab === 'input' ? (
              <pre className="bg-white border border-slate-200 rounded-md p-3 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap break-words font-mono text-slate-700">
                {stage.inputPreview ?? '(无输入预览)'}
              </pre>
            ) : (
              <pre className="bg-white border border-slate-200 rounded-md p-3 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap break-words font-mono text-slate-700">
                {stage.outputPreview ?? '(无输出预览)'}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TraceDetail({ traceId, onBack }: { traceId: string; onBack: () => void }) {
  const [trace, setTrace] = useState<PipelineRunTrace | null>(() => getTrace(traceId))

  // 运行中时自动刷新
  useEffect(() => {
    if (!trace || trace.status !== 'running') return
    const timer = setInterval(() => {
      const fresh = getTrace(traceId)
      if (fresh) setTrace(fresh)
      else clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [traceId, trace?.status])

  if (!trace) {
    return (
      <div className="text-center py-20 text-slate-400">
        trace 不存在或已被清除
        <div className="mt-4">
          <button
            onClick={onBack}
            className="text-indigo-600 hover:underline text-sm"
          >
            ← 返回列表
          </button>
        </div>
      </div>
    )
  }

  const totalStages = trace.stages.length

  return (
    <div>
      {/* 顶部 */}
      <div className="flex items-center gap-4 mb-4 pb-4 border-b border-slate-200">
        <button onClick={onBack} className="text-slate-500 hover:text-slate-800 text-xl leading-none">
          ←
        </button>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-slate-800 truncate">
            {trace.title || trace.doi}
          </h3>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            DOI: {trace.doi} · ID: {trace.id.slice(0, 8)} ·{' '}
            {new Date(trace.startedAt).toLocaleString()}
          </div>
        </div>
        <span
          className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_BADGE[trace.status]?.cls}`}
        >
          {STATUS_BADGE[trace.status]?.label}
        </span>
        {trace.totalMs != null && (
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            总耗时 {formatDuration(trace.totalMs)}
          </span>
        )}
      </div>

      {/* 失败错误 */}
      {trace.error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <div className="text-xs font-semibold text-red-600 mb-1">❌ 失败原因</div>
          <div className="text-sm text-red-800 font-mono">{trace.error}</div>
        </div>
      )}

      {/* 阶段列表 */}
      <div className="space-y-2">
        {trace.stages.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            还没有阶段数据（可能刚开始运行）
          </div>
        ) : (
          trace.stages.map((s, i) => <StageRow key={i} stage={s} index={i} />)
        )}
      </div>

      {/* 汇总 */}
      <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
        <span>{totalStages} 个阶段</span>
        <span>数据存储在浏览器 localStorage（key: af_pipeline_traces_v1）</span>
      </div>
    </div>
  )
}

export function PipelineDebugPanel() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const traces = useMemo(() => listRecentTraces(), [refreshKey])

  // 每 2s 刷新（捕获运行中的 trace）
  useEffect(() => {
    const timer = setInterval(() => setRefreshKey((k) => k + 1), 2000)
    return () => clearInterval(timer)
  }, [])

  // 选中的 trace 也跟着刷新
  const selectedTrace = selectedId ? traces.find((t) => t.id === selectedId) : null

  const handleUploadSuccess = (_doi: string, title: string) => {
    toast.success(`已入队：${title}，刷新看板查看进度`)
    // 强制刷新 + 自动选中最新那条
    setTimeout(() => {
      setRefreshKey((k) => k + 1)
      const all = listRecentTraces()
      if (all.length > 0) setSelectedId(all[0].id)
    }, 1500)
  }

  if (selectedId && selectedTrace) {
    // 如果运行中，跳转到列表让它自动刷新选中那个
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-800">🔧 Pipeline 调试看板</h2>
          <p className="text-sm text-slate-500 mt-1">
            记录每次 PDF 转换的完整链路：每一步的 Prompt、输入、AI 输出、耗时
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 调试入口：直接上传 PDF */}
          {!selectedId && (
            <PdfQuickUploadButton onSuccess={handleUploadSuccess}>
              <span className="flex items-center gap-1.5">
                🧪 调试上传 PDF
              </span>
            </PdfQuickUploadButton>
          )}
          {!selectedId && traces.length > 0 && (
            <button
              onClick={() => {
                clearAllTraces()
                setRefreshKey((k) => k + 1)
              }}
              className="text-xs text-red-500 hover:text-red-700 hover:underline"
            >
              清空全部
            </button>
          )}
        </div>
      </div>

      {selectedId ? (
        <TraceDetail
          traceId={selectedId}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <div>
          {traces.length === 0 ? (
            <div className="text-center py-20">
              <div className="text-5xl mb-4 opacity-30">📋</div>
              <div className="text-slate-500 mb-3">还没有运行记录</div>
              <PdfQuickUploadButton onSuccess={handleUploadSuccess}>
                <span className="flex items-center gap-2 px-4 py-2">
                  🧪 直接上传 PDF 跑一次测试
                </span>
              </PdfQuickUploadButton>
              <div className="text-xs text-slate-400 mt-4">
                或去"管理"页上传，转换完成后这里会自动记录每个阶段
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {traces.map((t) => {
                const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.running
                const hasFailedStages = t.stages.some((s) => s.error)
                const latestLabel = t.stages[t.stages.length - 1]?.label ?? '等待开始'

                return (
                  <div
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className="border border-slate-200 rounded-lg p-4 hover:border-indigo-300 hover:shadow-sm cursor-pointer transition-all bg-white"
                  >
                    <div className="flex items-center gap-4">
                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${badge.cls}`}>
                        {badge.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-800 truncate">
                          {t.title || t.doi}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {new Date(t.startedAt).toLocaleString()} ·{' '}
                          {t.stages.length} 阶段 · 最后: {latestLabel}
                          {hasFailedStages && <span className="text-red-500"> · 有报错</span>}
                        </div>
                      </div>
                      {t.totalMs != null && (
                        <span className="text-xs text-slate-500 font-mono tabular-nums">
                          {formatDuration(t.totalMs)}
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteTrace(t.id)
                          setRefreshKey((k) => k + 1)
                        }}
                        className="text-xs text-slate-400 hover:text-red-500 px-2"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="mt-8 text-center text-xs text-slate-400">
            最多保留最近 20 条 · 数据存在浏览器本地（localStorage）· 关闭浏览器不会丢
          </div>
        </div>
      )}
    </div>
  )
}
