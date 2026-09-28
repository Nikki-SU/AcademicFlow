/**
 * 会议/课程页 · 右栏：本节课照片（板书 / 幻灯片采集）
 * -------------------------------------------------
 * 拍照 / 选图 → uploadSessionImage → projects/{taskId}/sessions/{sessionId}/images/；
 * 传完即触发 MinerU 识别 → 合并成本节课的 board.md（与录音的 transcript.md 并列）。
 * 展示走 repoImageBlobUrl（blob URL），逐张可删（deleteTaskImages + forgetRepoImage）。
 *
 * 两处入口（悬浮采集球 / 本栏）都归到**同一个 sessionId**，所以两边看到的
 * 图片与识别结果始终是一致的。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Image as ImageIcon, Loader2, Trash2, Camera, Sparkles, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteTaskImages,
  listSessionImages,
  uploadSessionImage,
  readSessionBoard,
  notifySessionImagesChanged,
  SESSION_IMAGES_CHANGED,
  type SessionImageFile,
} from '../../services/sessionData'
import { forgetRepoImage, repoImageBlobUrl } from '../../services/editorImages'
import { useSessionStore } from '../../stores/session'
import { useSessionImagesStore } from '../../stores/sessionImages'
import CameraCapture from '../CameraCapture'

/** 单个缩略图：自己负责把仓库路径换成可显示的 blob URL */
function Thumb({ file, onDelete }: { file: SessionImageFile; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    repoImageBlobUrl(file.path).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [file.path])

  return (
    <div className="group relative overflow-hidden rounded-lg border border-ink-200 bg-paper-100">
      {url ? (
        <img
          src={url}
          alt={file.name}
          title={file.name}
          className="h-24 w-full cursor-pointer object-cover"
          onClick={() => window.open(url, '_blank', 'noopener')}
        />
      ) : (
        <div className="flex h-24 items-center justify-center">
          <ImageIcon className="h-5 w-5 text-ink-300" />
        </div>
      )}
      <button
        type="button"
        onClick={onDelete}
        title="删除这张图"
        className="absolute right-1 top-1 rounded-md bg-ink-900/55 p-1 text-paper-50 opacity-0 transition group-hover:opacity-100 hover:bg-red-600"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

type Tab = 'photos' | 'board'

export default function SessionImages({ taskId }: { taskId: string | null }) {
  // 本节课 = 当前任务在 session store 里的当前课时；没有就让 store 建一个，
  // 保证「拍照 / 传图 / 识别」都落在同一节课下（与录音共用 sessionId）。
  const sessionId = useSessionStore((s) => (s.taskId === taskId ? s.sessionId : null))
  useEffect(() => {
    if (taskId) useSessionStore.getState().ensure(taskId)
  }, [taskId])

  const recKey = `${taskId ?? ''}/${sessionId ?? ''}`
  const recognizing = useSessionImagesStore((s) => (s.key === recKey ? s.running : false))
  const recMessage = useSessionImagesStore((s) => (s.key === recKey ? s.message : ''))
  const recError = useSessionImagesStore((s) => (s.key === recKey ? s.error : null))

  const [images, setImages] = useState<SessionImageFile[]>([])
  const [board, setBoard] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('photos')
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    if (!taskId || !sessionId) {
      setImages([])
      setBoard(null)
      return
    }
    setIsLoading(true)
    try {
      const [imgs, md] = await Promise.all([
        listSessionImages(taskId, sessionId),
        readSessionBoard(taskId, sessionId),
      ])
      setImages(imgs)
      setBoard(md)
    } catch (err) {
      console.error('[SessionImages] 读取照片失败:', err)
      toast.error('读取照片失败，请重试')
    } finally {
      setIsLoading(false)
    }
  }, [taskId, sessionId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 悬浮采集球在别处传来的图，也让本栏实时刷新（仅当课时一致）
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent).detail as { taskId?: string; sessionId?: string } | undefined
      if (d && (d.taskId !== taskId || d.sessionId !== sessionId)) return
      void reload()
    }
    window.addEventListener(SESSION_IMAGES_CHANGED, onChange)
    return () => window.removeEventListener(SESSION_IMAGES_CHANGED, onChange)
  }, [reload, taskId, sessionId])

  // 识别跑完（running true→false）后，自动把新的 board.md 读出来
  const prevRec = useRef(false)
  useEffect(() => {
    if (prevRec.current && !recognizing) void reload()
    prevRec.current = recognizing
  }, [recognizing, reload])

  const canUseCamera =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  /** 上传若干照片 → 广播 → 触发 MinerU 识别（与悬浮球同一条路） */
  const uploadImages = async (list: File[]) => {
    if (!taskId || !sessionId || list.length === 0) return
    setIsUploading(true)
    const toastId = toast.loading(`正在上传 ${list.length} 张照片…`)
    try {
      for (const file of list) {
        await uploadSessionImage(taskId, sessionId, file)
      }
      toast.success('照片已归到本节课', { id: toastId })
      await reload()
      notifySessionImagesChanged(taskId, sessionId)
      useSessionImagesStore.getState().start(taskId, sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`照片上传失败：${msg}`, { id: toastId, duration: 8000 })
    } finally {
      setIsUploading(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
    if (inputRef.current) inputRef.current.value = ''
    if (list.length === 0) {
      toast.warning('请选择图片文件')
      return
    }
    await uploadImages(list)
  }

  const handleDelete = async (file: SessionImageFile) => {
    const label = window.confirm(`删除照片「${file.name}」？此操作会提交到私库。`)
    if (!label) return
    try {
      await deleteTaskImages([file.path])
      forgetRepoImage(file.path)
      await reload()
      toast.success('已删除')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`删除失败：${msg}`, { duration: 8000 })
    }
  }

  // 识别可能跑几分钟，期间不禁用拍照/传图 —— 新图会在本轮跑完后自动补识别
  const busy = isUploading

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-seal-600" />
          <h2 className="text-sm font-semibold text-ink-800">本节课照片</h2>
          {images.length > 0 && <span className="text-[11px] text-ink-400">{images.length} 张</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => (canUseCamera ? setCameraOpen(true) : inputRef.current?.click())}
            disabled={!taskId || busy}
            title={taskId ? '打开相机拍照' : '先选一个任务'}
            className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-paper-100 disabled:opacity-60"
          >
            {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            拍照
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={!taskId || busy}
            title={taskId ? '选择图片文件' : '先选一个任务'}
            className="flex items-center gap-1.5 rounded-lg bg-seal-600 px-2.5 py-1.5 text-xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-60"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            选择文件
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {/* 两个页签：原始照片 / 识别合并后的 board.md */}
      <div className="flex shrink-0 items-center gap-1 border-b border-ink-100 px-2 pt-2">
        <button
          type="button"
          onClick={() => setTab('photos')}
          className={`rounded-t-md px-3 py-1.5 text-xs font-medium transition ${
            tab === 'photos' ? 'bg-paper-100 text-ink-800' : 'text-ink-400 hover:text-ink-700'
          }`}
        >
          照片
        </button>
        <button
          type="button"
          onClick={() => setTab('board')}
          className={`flex items-center gap-1 rounded-t-md px-3 py-1.5 text-xs font-medium transition ${
            tab === 'board' ? 'bg-paper-100 text-ink-800' : 'text-ink-400 hover:text-ink-700'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          识别结果
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={!taskId || isLoading}
          title="刷新"
          className="ml-auto rounded-md p-1.5 text-ink-400 transition hover:bg-paper-100 hover:text-ink-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 识别状态条：识别中显示进度文案，失败显示原因 */}
      {(recognizing || recError) && (
        <div
          className={`flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[11px] ${
            recError ? 'bg-red-50 text-red-600' : 'bg-seal-50 text-seal-700'
          }`}
        >
          {recognizing && <Loader2 className="h-3 w-3 animate-spin" />}
          <span className="min-w-0 truncate">
            {recError ? `识别失败：${recError}` : recMessage || '识别中…'}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!taskId ? (
          <p className="py-10 text-center text-sm text-ink-400">先选一个任务</p>
        ) : tab === 'photos' ? (
          isLoading && images.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-400">加载照片…</p>
          ) : images.length === 0 ? (
            <div className="py-10 text-center">
              <Camera className="mx-auto h-6 w-6 text-ink-300" />
              <p className="mt-2 text-sm text-ink-400">还没有照片</p>
              <p className="mt-1 text-xs text-ink-400">点「拍照」拍板书 / 幻灯片，拍完自动识别</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {images.map((file) => (
                <Thumb key={file.path} file={file} onDelete={() => void handleDelete(file)} />
              ))}
            </div>
          )
        ) : board ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-700">
            {board}
          </pre>
        ) : (
          <div className="py-10 text-center">
            <Sparkles className="mx-auto h-6 w-6 text-ink-300" />
            <p className="mt-2 text-sm text-ink-400">还没有识别结果</p>
            <p className="mt-1 text-xs text-ink-400">传上照片后会自动识别，合并成本节课的 board.md</p>
          </div>
        )}
      </div>

      {/* 应用内相机：实时取景 + 快门，拍到即入本节课并触发识别 */}
      {cameraOpen && (
        <CameraCapture
          onCapture={(file) => uploadImages([file])}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </section>
  )
}
