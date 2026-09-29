/**
 * 全局悬浮「采集球」
 * -------------------------------------------------
 * 挂在 Layout 顶层，fixed bottom-right，跨页面 / 跨任务持续可用，不绑架用户。
 * 点开球 → 两个输入功能（这是「录音 / 传图是输入环节」的统一入口，见 架构.md ADJ-45/46）：
 *   1. 开始 / 停止录音（状态全在 stores/recorder.ts，切页不中断）
 *   2. 拍照（**申请摄像头权限后应用内实时取景**，拍到的图归到「当前课时」的 images/，
 *      与课程页右栏同一处，并随即送进 MinerU 管道产出本节课的 board.md）
 *
 * 录音中球身变红并走表；展开即见本轮转写。卸载 / 切页都不影响录音。
 * 还能「弹出为悬浮窗」（Document Picture-in-Picture）：一块始终置顶的小窗，切到别的
 * 标签页 / 别的网站也照样录音、照样看得见状态（前提：这个标签页别关）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Mic, Square, ChevronDown, Loader2, Camera, RotateCw, PictureInPicture2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRecorderStore } from '../stores/recorder'
import { useTaskStore } from '../stores/task'
import { useSessionStore } from '../stores/session'
import { useSessionImagesStore } from '../stores/sessionImages'
import { uploadSessionImage, notifySessionImagesChanged } from '../services/sessionData'
import CameraCapture from './CameraCapture'

// Document Picture-in-Picture：把采集球放进一块「始终置顶」的独立小窗，用户切到别的
// 标签页 / 别的网站时录音不中断、状态始终可见。TS 的 lib.dom 尚未收录此 API，自己补一份。
declare global {
  interface DocumentPictureInPicture {
    requestWindow(options?: {
      width?: number
      height?: number
      disallowReturnToOpener?: boolean
      preferInitialWindowPlacement?: boolean
    }): Promise<Window>
    readonly window: Window | null
  }
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture
  }
}

/**
 * 把主文档的样式搬进浮窗文档 —— PiP 是全新的 document，不搬样式球会是「裸」的。
 * 同源样式表直接内联 html/cssRules；跨源（如 CDN 字体）退回复制 <link>。
 */
function copyStylesInto(dest: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n')
      const style = dest.createElement('style')
      style.textContent = css
      dest.head.appendChild(style)
    } catch {
      if (sheet.href) {
        const link = dest.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        dest.head.appendChild(link)
      }
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 已录时长 → HH:MM:SS */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** 片段时刻 → 本地 HH:MM:SS */
function formatClock(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 语种徽标文案 */
function langLabel(lang: string): string {
  const l = lang.trim().toLowerCase()
  if (l === 'zh' || l.startsWith('zh-')) return '中'
  if (l === 'en' || l.startsWith('en-')) return 'EN'
  return lang.trim().slice(0, 6).toUpperCase() || '—'
}

export default function RecorderBall() {
  const status = useRecorderStore((s) => s.status)
  const startedAt = useRecorderStore((s) => s.startedAt)
  const segments = useRecorderStore((s) => s.segments)
  const error = useRecorderStore((s) => s.error)
  const pendingCount = useRecorderStore((s) => s.pendingCount)
  const start = useRecorderStore((s) => s.start)
  const stop = useRecorderStore((s) => s.stop)
  const retryPending = useRecorderStore((s) => s.retryPending)
  const resume = useRecorderStore((s) => s.resume)

  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [uploading, setUploading] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const pipSupported = typeof window !== 'undefined' && !!window.documentPictureInPicture

  /**
   * 弹出「始终置顶」悬浮窗。录音仍在主文档里跑（MediaRecorder / store 都没动），
   * 浮窗只是换一块屏幕来显示球与转写 —— 所以切标签页、切到别的网站都不中断。
   * 必须在用户点击的手势里同步调用（transient activation）。
   */
  const openPip = useCallback(async () => {
    const api = window.documentPictureInPicture
    if (!api) return
    try {
      const win = await api.requestWindow({ width: 360, height: 520 })
      copyStylesInto(win.document)
      win.document.documentElement.lang = 'zh-CN'
      win.document.body.classList.add('bg-paper-100')
      // 用户点浮窗右上角的关闭叉 → 把球收回主页面
      win.addEventListener('pagehide', () => setPipWindow(null))
      setExpanded(true)
      setPipWindow(win)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`打开悬浮窗失败：${msg}`)
    }
  }, [])

  /** 收回主页面：先让 React 把球搬回主文档，再关浮窗（免得中间闪一下空白）。 */
  const closePip = useCallback(() => {
    const win = pipWindow
    setPipWindow(null)
    win?.close()
  }, [pipWindow])

  const isRecording = status === 'recording'
  const isBusy = status === 'stopping'

  // 录音中每秒走表
  useEffect(() => {
    if (!isRecording) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isRecording])

  // App 启动即续转：上次没转成、暂存在 IndexedDB 里的片，刷新后自动接着转
  useEffect(() => {
    void resume()
  }, [resume])

  // 点面板外 / 按 Esc 收起（浮窗开着就监听浮窗文档）
  useEffect(() => {
    if (!expanded) return
    const doc = pipWindow ? pipWindow.document : document
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    doc.addEventListener('mousedown', onDown)
    doc.addEventListener('keydown', onKey)
    return () => {
      doc.removeEventListener('mousedown', onDown)
      doc.removeEventListener('keydown', onKey)
    }
  }, [expanded, pipWindow])

  /** 取当前任务；没有就提示并返回 null（录音与拍照都必须归属到一个任务） */
  const requireTask = (): string | null => {
    const id = useTaskStore.getState().currentProjectId
    if (!id) {
      toast.error('先选一个任务')
      return null
    }
    return id
  }

  const handleRecordToggle = async () => {
    if (isBusy) return
    if (isRecording) {
      setExpanded(false)
      await stop()
      return
    }
    const id = requireTask()
    if (!id) return
    await start(id)
  }

  /** 是否有摄像头可用（决定走应用内相机还是退回文件选择） */
  const canUseCamera =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  const handlePickPhoto = () => {
    if (!requireTask()) return
    // 点「拍照」就真开相机（申请摄像头权限）；只有环境不支持时才退回文件选择
    if (canUseCamera) setCameraOpen(true)
    else fileRef.current?.click()
  }

  /** 把若干图片上传到**当前课时**，随后直接送进 MinerU 管道产出 board.md */
  const uploadImages = async (list: File[]) => {
    const id = useTaskStore.getState().currentProjectId
    if (!id || list.length === 0) return
    const sessionId = useSessionStore.getState().ensure(id)
    setUploading(true)
    const toastId = toast.loading(`正在上传 ${list.length} 张图片…`)
    try {
      for (const file of list) {
        await uploadSessionImage(id, sessionId, file)
      }
      toast.success('图片已归到本节课', { id: toastId })
      // 通知课程页右栏重载，两处图片列表保持一致
      notifySessionImagesChanged(id, sessionId)
      // 拍完即入管道：照片交给 MinerU，识别结果合并成本节课的 board.md
      useSessionImagesStore.getState().start(id, sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`图片上传失败：${msg}`, { id: toastId, duration: 8000 })
    } finally {
      setUploading(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
    if (fileRef.current) fileRef.current.value = ''
    if (list.length === 0) {
      toast.warning('请选择图片文件')
      return
    }
    await uploadImages(list)
  }

  /** 重试停止时仍没转成的片：音频还在内存里，补转后写回私库 */
  const handleRetryPending = async () => {
    setRetrying(true)
    try {
      await retryPending()
    } finally {
      setRetrying(false)
    }
  }

  const elapsed = startedAt ? now - startedAt : 0
  const latest = segments.length > 0 ? segments[segments.length - 1].text : ''

  const content = (
    <div
      ref={rootRef}
      className="fixed bottom-6 right-6 z-40 flex max-w-[calc(100vw-3rem)] flex-col items-end gap-2"
    >
      {expanded && (
        <div className="w-80 max-w-full overflow-hidden rounded-xl border border-ink-200 bg-paper-50 shadow-lift">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <span className="text-xs font-semibold text-ink-700">
              {isRecording ? '本轮转写' : '采集'}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-400">
                {isRecording ? `${segments.length} 条` : '归到「当前任务」'}
              </span>
              {/* 弹出为「始终置顶」悬浮窗：切到别的标签页 / 别的网站也照样录音、照样看得见 */}
              {pipSupported &&
                (pipWindow ? (
                  <button
                    type="button"
                    onClick={closePip}
                    title="收回页面"
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-500 transition hover:bg-paper-100 hover:text-ink-700"
                  >
                    <Minimize2 className="h-3.5 w-3.5" />
                    收回
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void openPip()}
                    title="弹出为悬浮窗：切到别的标签页 / 别的网站也能继续录音"
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-seal-600 transition hover:bg-seal-50"
                  >
                    <PictureInPicture2 className="h-3.5 w-3.5" />
                    悬浮窗
                  </button>
                ))}
            </div>
          </div>

          {/* 录音中：实时转写列表 */}
          {isRecording && (
            <div className="max-h-72 overflow-y-auto px-3 py-2">
              {segments.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-400">等待第一片转写…</p>
              ) : (
                <ul className="space-y-3">
                  {segments.map((seg) => (
                    <li key={seg.id} className="border-b border-ink-100 pb-2 last:border-0">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono text-ink-400">{formatClock(seg.at)}</span>
                        <span className="rounded bg-seal-50 px-1.5 py-0.5 text-[10px] font-medium text-seal-700">
                          {langLabel(seg.language)}
                        </span>
                      </div>
                      {/* 原文一块、译文一块（同文献页）：原文始终保留，译文另起一段 */}
                      <p className="mt-1 text-sm leading-snug text-ink-800">{seg.text}</p>
                      {seg.translation && (
                        <p className="mt-1 border-l-2 border-seal-300 bg-seal-50/30 py-0.5 pl-2 pr-1.5 text-sm leading-snug text-ink-700">
                          {seg.translation}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 未录音：简短说明 */}
          {!isRecording && (
            <p className="px-3 py-2.5 text-xs text-ink-500">
              录音与拍照都会归到「当前任务」下，随时可切走。
            </p>
          )}

          {/* 两个输入功能 */}
          <div className="flex gap-2 border-t border-ink-100 p-2">
            <button
              type="button"
              onClick={handleRecordToggle}
              disabled={isBusy}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-paper-50 transition disabled:opacity-60 ${
                isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-seal-600 hover:bg-seal-700'
              }`}
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isRecording ? (
                <Square className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
              {isBusy ? '保存中…' : isRecording ? '停止并保存' : '开始录音'}
            </button>
            <button
              type="button"
              onClick={handlePickPhoto}
              disabled={uploading}
              title="打开相机拍照，拍完归到当前任务"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-paper-100 disabled:opacity-60"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              {uploading ? '上传中…' : '拍照'}
            </button>
          </div>
        </div>
      )}

      {/* 球身：未录音=墨绿；录音中=红 + 计时 */}
      {isRecording ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? '收起' : '展开本轮转写'}
          className="flex items-center gap-2 rounded-full bg-red-500 py-2 pl-3 pr-4 text-paper-50 shadow-lift transition hover:bg-red-600"
        >
          <span className="relative flex h-3 w-3 items-center justify-center">
            <span className="absolute h-3 w-3 animate-ping rounded-full bg-paper-50 opacity-75" />
            <span className="h-3 w-3 rounded-full bg-paper-50" />
          </span>
          <span className="font-mono text-sm tabular-nums">{formatElapsed(elapsed)}</span>
          {latest && (
            <span className="hidden max-w-[10rem] truncate text-xs text-paper-100 sm:block">
              {latest}
            </span>
          )}
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title="采集：录音 / 拍照"
          disabled={isBusy}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-seal-600 text-paper-50 shadow-lift transition hover:bg-seal-700 active:scale-95 disabled:opacity-60"
        >
          {expanded ? <ChevronDown className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
        </button>
      )}

      {error && (
        <span className="max-w-xs truncate rounded bg-red-50 px-2 py-0.5 text-[11px] text-red-600">
          {error}
        </span>
      )}

      {/* 停止后仍有没转成的片：音频还在内存里，给一个明确的重试入口（别让用户无从下手） */}
      {pendingCount > 0 && !isRecording && (
        <button
          type="button"
          onClick={() => void handleRetryPending()}
          disabled={retrying}
          title="音频仍在内存中，重试后会把新转出的内容补写进私库；重试前别关页面"
          className="flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1.5 text-[11px] font-medium text-paper-50 shadow-lift transition hover:bg-amber-600 disabled:opacity-60"
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" />
          )}
          {retrying ? '重试中…' : `重试未完成的 ${pendingCount} 片`}
        </button>
      )}

      {/* 无摄像头环境的兜底：文件选择（正常走上面的应用内相机） */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* 应用内相机：实时取景 + 快门，拍到即归到当前任务 */}
      {cameraOpen && (
        <CameraCapture
          onCapture={(file) => uploadImages([file])}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </div>
  )

  // 浮窗开着就渲染进浮窗文档，否则留在主页面（fixed 定位两边都成立）
  return pipWindow ? createPortal(content, pipWindow.document.body) : content
}
