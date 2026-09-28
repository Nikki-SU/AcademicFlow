/**
 * 会议/课程页 · 右栏：传图片（材料采集）
 * -------------------------------------------------
 * 选图 → uploadTaskImage → 仓库 projects/{taskId}/session-images/；
 * 展示走 repoImageBlobUrl（blob URL），逐张可删（deleteTaskImages + forgetRepoImage）。
 * 图片是「挂在当前任务分支下」的材料，与录音解耦 —— 不录音也能传图。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteTaskImages,
  listTaskImages,
  uploadTaskImage,
  type SessionImageFile,
} from '../../services/sessionData'
import { forgetRepoImage, repoImageBlobUrl } from '../../services/editorImages'

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

export default function SessionImages({ taskId }: { taskId: string | null }) {
  const [images, setImages] = useState<SessionImageFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    if (!taskId) {
      setImages([])
      return
    }
    setIsLoading(true)
    try {
      setImages(await listTaskImages(taskId))
    } catch (err) {
      console.error('[SessionImages] 读取图片失败:', err)
      toast.error('读取图片失败，请重试')
    } finally {
      setIsLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleFiles = async (files: FileList | null) => {
    if (!taskId || !files || files.length === 0) return
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (inputRef.current) inputRef.current.value = ''
    if (list.length === 0) {
      toast.warning('请选择图片文件')
      return
    }

    setIsUploading(true)
    const toastId = toast.loading(`正在上传 ${list.length} 张图片…`)
    try {
      for (const file of list) {
        await uploadTaskImage(taskId, file)
      }
      toast.success('图片已上传', { id: toastId })
      await reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`图片上传失败：${msg}`, { id: toastId, duration: 8000 })
    } finally {
      setIsUploading(false)
    }
  }

  const handleDelete = async (file: SessionImageFile) => {
    const label = window.confirm(`删除图片「${file.name}」？此操作会提交到私库。`)
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

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-seal-600" />
          <h2 className="text-sm font-semibold text-ink-800">传图片</h2>
          {images.length > 0 && <span className="text-[11px] text-ink-400">{images.length} 张</span>}
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={!taskId || isUploading}
          title={taskId ? '选择图片上传' : '先选一个任务'}
          className="flex items-center gap-1.5 rounded-lg bg-seal-600 px-3 py-1.5 text-xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-60"
        >
          {isUploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ImagePlus className="h-3.5 w-3.5" />
          )}
          {isUploading ? '上传中…' : '选择文件'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!taskId ? (
          <p className="py-10 text-center text-sm text-ink-400">先选一个任务，再传图片</p>
        ) : isLoading ? (
          <p className="py-10 text-center text-sm text-ink-400">加载图片…</p>
        ) : images.length === 0 ? (
          <div className="py-10 text-center">
            <ImagePlus className="mx-auto h-6 w-6 text-ink-300" />
            <p className="mt-2 text-sm text-ink-400">还没有图片</p>
            <p className="mt-1 text-xs text-ink-400">拍到的板书 / 幻灯片传这里，归到当前任务下</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {images.map((file) => (
              <Thumb key={file.path} file={file} onDelete={() => void handleDelete(file)} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
