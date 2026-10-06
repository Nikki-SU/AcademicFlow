/**
 * 相机拍照（getUserMedia 实时取景 + 快门）
 * -------------------------------------------------
 * 点「拍照」→ **申请摄像头权限** → 在应用内实时取景 → 按快门 → 得到一张图片 File。
 *
 * 为什么不走 `<input type="file" capture>`：
 * 那个属性只在移动端才唤起相机，桌面端一律弹文件管理器 —— 用户点的是「拍照」，
 * 结果出来一个选文件的框，体验完全对不上。这里直接用 getUserMedia 拉实时画面，
 * 前后端一致：点拍照就是拍照。
 *
 * 拍到的 File 交给 onCapture（由调用方决定上传 / 入管道）；关闭时释放摄像头。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'

interface CameraCaptureProps {
  /** 拍到照片：File（image/jpeg）。调用方可上传或入处理管道。 */
  onCapture: (file: File) => void | Promise<void>
  onClose: () => void
  /** 初始朝向，默认后置（拍板书 / 幻灯片） */
  defaultFacing?: 'environment' | 'user'
}

export default function CameraCapture({
  onCapture,
  onClose,
  defaultFacing = 'environment',
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>(defaultFacing)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const openCamera = useCallback(
    async (mode: 'environment' | 'user') => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        const msg = '当前环境无法调用摄像头（需 HTTPS 或 localhost，且浏览器支持）'
        setError(msg)
        toast.error(msg)
        return
      }
      stopStream()
      setReady(false)
      setError(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setReady(true)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const text = `无法打开摄像头：${msg}`
        setError(text)
        toast.error(text, { duration: 8000 })
      }
    },
    [stopStream],
  )

  useEffect(() => {
    void openCamera(facing)
    return () => stopStream()
    // 仅初始挂载拉一次；切前后摄由 flip() 显式调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const flip = () => {
    const next = facing === 'environment' ? 'user' : 'environment'
    setFacing(next)
    void openCamera(next)
  }

  const shoot = async () => {
    const video = videoRef.current
    if (!video || !ready || busy) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) {
      toast.error('画面还没准备好，稍等一下再拍')
      return
    }
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建画布')
      ctx.drawImage(video, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92),
      )
      if (!blob) throw new Error('拍照失败：画布未产出图像')
      const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' })
      await onCapture(file)
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg, { duration: 8000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900/95 p-4">
      <div className="mb-3 flex shrink-0 items-center justify-between text-paper-50">
        <span className="flex items-center gap-2 text-ui-sm font-medium">
          <Camera className="h-4 w-4" />
          拍照
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="rounded-control-sm p-1.5 transition hover:bg-paper-50/10"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-card bg-black">
        <video ref={videoRef} playsInline muted className="max-h-full max-w-full object-contain" />
        {!ready && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-paper-100">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-ui-sm">正在打开摄像头…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-paper-100">
            <p className="text-ui-sm leading-relaxed">{error}</p>
            <button
              type="button"
              onClick={() => void openCamera(facing)}
              className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
            >
              重试
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex shrink-0 items-center justify-center gap-6">
        <button
          type="button"
          onClick={flip}
          disabled={!!error}
          title="切换前后摄像头"
          className="rounded-full border border-paper-50/40 p-3 text-paper-50 transition hover:bg-paper-50/10 disabled:opacity-40"
        >
          <RefreshCw className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => void shoot()}
          disabled={!ready || busy}
          title="拍照"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-paper-50 text-ink-800 shadow-lift transition active:scale-95 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Camera className="h-6 w-6" />}
        </button>
        <span className="w-[3.06vw]" aria-hidden />
      </div>
    </div>
  )
}
