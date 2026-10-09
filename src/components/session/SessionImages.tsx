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
import { ImagePlus, Image as ImageIcon, Loader2, Trash2, Camera, Sparkles, RefreshCw, FileText } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteTaskImages,
  listSessionImages,
  uploadSessionImage,
  uploadSessionMaterial,
  listSessionMaterials,
  listSessionMaterialsMd,
  readSessionBoard,
  readSessionMaterialMd,
  saveSessionBoard,
  saveSessionMaterialMd,
  notifySessionImagesChanged,
  SESSION_IMAGES_CHANGED,
  type SessionImageFile,
  type SessionMaterialMd,
} from '../../services/sessionData'
import { forgetRepoImage, repoImageBlobUrl } from '../../services/editorImages'
import { useSessionStore } from '../../stores/session'
import { useSessionImagesStore } from '../../stores/sessionImages'
import CameraCapture from '../CameraCapture'
import VditorEditor from '../VditorEditor'
import { Panel, PanelHeader, PanelBody, EmptyState } from '../ui/Panel'
import Button from '../ui/Button'
import { PillTabs } from '../ui/Tabs'

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
    <div className="group relative overflow-hidden rounded-control-sm border border-ink-200 bg-paper-100">
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
          <ImageIcon className="h-ui-icon-sm w-ui-icon-sm text-ink-300" />
        </div>
      )}
      <button
        type="button"
        onClick={onDelete}
        title="删除这张图"
        className="absolute right-1 top-1 rounded-control-sm bg-ink-900/55 p-1 text-paper-50 opacity-0 transition group-hover:opacity-100 hover:bg-red-600"
      >
        <Trash2 className="h-ui-icon-sm w-ui-icon-sm" />
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
  const [materials, setMaterials] = useState<SessionImageFile[]>([])
  const [materialMds, setMaterialMds] = useState<SessionMaterialMd[]>([])
  const [board, setBoard] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('photos')
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [editingBoard, setEditingBoard] = useState(false)
  const [boardDraft, setBoardDraft] = useState('')
  // 保存 board / 材料 md 期间禁用「保存」并显示「保存中…」
  const [savingBoard, setSavingBoard] = useState(false)
  // 材料转换结果查看：viewingMaterial 非空时主区切到该材料的 md 视图
  const [viewingMaterial, setViewingMaterial] = useState<SessionMaterialMd | null>(null)
  const [materialMd, setMaterialMd] = useState<string | null>(null)
  const [materialDraft, setMaterialDraft] = useState('')
  const [editingMaterial, setEditingMaterial] = useState(false)
  const [savingMaterial, setSavingMaterial] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // reload 里要刷新「正在查看的材料」，但 reload 本身不该随 viewingMaterial 重建，用 ref 镜像
  const viewingRef = useRef<SessionMaterialMd | null>(null)

  const reload = useCallback(async () => {
    if (!taskId || !sessionId) {
      setImages([])
      setMaterials([])
      setMaterialMds([])
      setBoard(null)
      setViewingMaterial(null)
      return
    }
    setIsLoading(true)
    try {
      const [imgs, mats, mds, md] = await Promise.all([
        listSessionImages(taskId, sessionId),
        listSessionMaterials(taskId, sessionId),
        listSessionMaterialsMd(taskId, sessionId),
        readSessionBoard(taskId, sessionId),
      ])
      setImages(imgs)
      setMaterials(mats)
      setMaterialMds(mds)
      setBoard(md)
      // 正在查看的材料若已出转换结果（或内容有更新），一并刷新
      const cur = viewingRef.current
      if (cur) {
        setMaterialMd(await readSessionMaterialMd(taskId, sessionId, cur.name))
      }
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
    try {
      for (const file of list) {
        await uploadSessionImage(taskId, sessionId, file)
      }
      await reload()
      notifySessionImagesChanged(taskId, sessionId)
      useSessionImagesStore.getState().start(taskId, sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`照片上传失败：${msg}`, { duration: 8000 })
    } finally {
      setIsUploading(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? [])
    if (inputRef.current) inputRef.current.value = ''
    if (list.length === 0) return
    const imgs = list.filter((f) => f.type.startsWith('image/'))
    const mats = list.filter((f) => !f.type.startsWith('image/'))
    if (imgs.length > 0) await uploadImages(imgs)
    if (mats.length > 0) await uploadMaterials(mats)
  }

  /** 上传课程材料（PDF / PPT / Word 等）到 materials/，传完触发 MinerU 转换（与照片同一条管线） */
  const uploadMaterials = async (list: File[]) => {
    if (!taskId || !sessionId || list.length === 0) return
    setIsUploading(true)
    try {
      for (const file of list) {
        await uploadSessionMaterial(taskId, sessionId, file)
      }
      await reload()
      // 材料必须进 session_images 管线（PDF 直送 MinerU，Word/PPT 先转 PDF），
      // 否则只会躺在 materials/ 里不产生任何 Markdown —— 与照片上传一致地触发识别。
      useSessionImagesStore.getState().start(taskId, sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`课程材料上传失败：${msg}`, { duration: 8000 })
    } finally {
      setIsUploading(false)
    }
  }

  const handleDelete = async (file: SessionImageFile) => {
    const label = window.confirm(`删除照片「${file.name}」？此操作会提交到私库。`)
    if (!label) return
    try {
      await deleteTaskImages([file.path])
      forgetRepoImage(file.path)
      await reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`删除失败：${msg}`, { duration: 8000 })
    }
  }

  /** 删除一份课程材料（走同一 Tree 批量删除） */
  const handleDeleteMaterial = async (m: SessionImageFile) => {
    const label = window.confirm(`删除课程材料「${m.name.replace(/^\d+_/, '')}」？此操作会提交到私库。`)
    if (!label) return
    try {
      await deleteTaskImages([m.path])
      await reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`删除失败：${msg}`, { duration: 8000 })
    }
  }

  /** 进入编辑态：把当前 board 内容装进草稿 */
  const startEditBoard = () => {
    if (!taskId || !sessionId || board === null) return
    setBoardDraft(board)
    setEditingBoard(true)
  }

  /** 保存编辑后的 board.md；成功即退出编辑态并刷新 */
  const saveBoardEdit = async () => {
    if (!taskId || !sessionId || savingBoard) return
    setSavingBoard(true)
    try {
      await saveSessionBoard(taskId, sessionId, boardDraft)
      setEditingBoard(false)
      setBoard(boardDraft)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`保存识别结果失败：${msg}`, { duration: 8000 })
    } finally {
      setSavingBoard(false)
    }
  }

  /** 取消编辑：丢弃草稿回到只读 */
  const cancelBoardEdit = () => {
    setEditingBoard(false)
    setBoardDraft('')
  }

  /** 打开某份材料的转换结果视图（只读 md + 可编辑修正，与 board 一致） */
  const openMaterialView = async (m: SessionMaterialMd) => {
    viewingRef.current = m
    setViewingMaterial(m)
    setEditingMaterial(false)
    setMaterialMd(null)
    setMaterialDraft('')
    if (!taskId || !sessionId) return
    setMaterialMd(await readSessionMaterialMd(taskId, sessionId, m.name))
  }

  /** 返回材料列表（关闭查看视图） */
  const closeMaterialView = () => {
    viewingRef.current = null
    setViewingMaterial(null)
    setEditingMaterial(false)
    setMaterialMd(null)
    setMaterialDraft('')
  }

  /** 进入材料 md 编辑态 */
  const startEditMaterial = () => {
    if (materialMd === null) return
    setMaterialDraft(materialMd)
    setEditingMaterial(true)
  }

  /** 保存材料 md 编辑；写失败 toast，不静默 */
  const saveMaterialEdit = async () => {
    if (!taskId || !sessionId || !viewingMaterial || savingMaterial) return
    setSavingMaterial(true)
    try {
      await saveSessionMaterialMd(taskId, sessionId, viewingMaterial.name, materialDraft)
      setEditingMaterial(false)
      setMaterialMd(materialDraft)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`保存材料转换结果失败：${msg}`, { duration: 8000 })
    } finally {
      setSavingMaterial(false)
    }
  }

  // 识别可能跑几分钟，期间不禁用拍照/传图 —— 新图会在本轮跑完后自动补识别
  const busy = isUploading

  return (
    <Panel>
      <PanelHeader
        icon={<ImageIcon />}
        title="本节课照片"
        meta={images.length > 0 ? `${images.length} 张` : undefined}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => (canUseCamera ? setCameraOpen(true) : inputRef.current?.click())}
              disabled={!taskId || busy}
              title={taskId ? '打开相机拍照' : '先选一个任务'}
              icon={isUploading ? <Loader2 className="animate-spin" /> : <Camera />}
            >
              拍照
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={!taskId || busy}
              title={taskId ? '选择图片文件' : '先选一个任务'}
              icon={<ImagePlus />}
            >
              选择文件
            </Button>
          </>
        }
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.pdf,.ppt,.pptx,.doc,.docx"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* 两个页签：原始照片 / 识别合并后的 board.md；行尾刷新与页签同基线 */}
      <PillTabs
        items={[
          { id: 'photos', label: '照片' },
          { id: 'board', label: '识别结果', icon: <Sparkles className="h-ui-icon-sm w-ui-icon-sm" /> },
        ]}
        value={tab}
        onChange={setTab}
        trailing={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void reload()}
            disabled={!taskId || isLoading}
            title="刷新"
          >
            <RefreshCw className={isLoading ? 'animate-spin' : ''} />
          </Button>
        }
      />

      {/* 识别状态条：识别中显示进度文案，失败显示原因 */}
      {(recognizing || recError) && (
        <div
          className={`af-line-b flex shrink-0 items-center gap-ui-gap-sm px-ui-gap py-1.5 text-ui-2xs ${
            recError ? 'bg-red-50 text-red-600' : 'bg-seal-50 text-seal-700'
          }`}
        >
          {recognizing && <Loader2 className="h-ui-icon-sm w-ui-icon-sm animate-spin" />}
          <span className="min-w-0 truncate">
            {recError ? `识别失败：${recError}` : recMessage || '识别中…'}
          </span>
        </div>
      )}

      <PanelBody>
        {!taskId ? (
          <EmptyState icon={<ImageIcon />} title="先选一个任务" />
        ) : viewingMaterial ? (
          editingMaterial ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center justify-between px-ui-gap py-1.5">
                <span className="text-ui-2xs text-ink-500">编辑「{viewingMaterial.displayName}」转换结果</span>
                <div className="flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => setEditingMaterial(false)}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void saveMaterialEdit()}
                    disabled={savingMaterial}
                    icon={savingMaterial ? <Loader2 className="animate-spin" /> : undefined}
                  >
                    {savingMaterial ? '保存中…' : '保存'}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <VditorEditor
                  value={materialDraft}
                  onChange={setMaterialDraft}
                  height="100%"
                  docPath={`projects/${taskId}/sessions/${sessionId}/session.md`}
                />
              </div>
            </div>
          ) : materialMd ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center justify-between px-ui-gap py-1.5">
                <Button variant="ghost" size="sm" onClick={closeMaterialView}>
                  ← 返回
                </Button>
                <span className="min-w-0 flex-1 truncate text-center text-ui-2xs text-ink-500" title={viewingMaterial.displayName}>
                  {viewingMaterial.displayName} 的转换结果
                </span>
                <Button variant="secondary" size="sm" onClick={startEditMaterial} icon={<Sparkles />}>
                  编辑
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-ui-gap pb-ui-gap">
                <pre className="whitespace-pre-wrap break-words font-sans text-ui-sm leading-relaxed text-ink-700">
                  {materialMd}
                </pre>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Sparkles />}
              title="这份材料还没有转换结果"
              hint="上传后会自动触发识别，跑完这里就是 Markdown（可编辑修正）"
            />
          )
        ) : tab === 'photos' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {isLoading && images.length === 0 && materials.length === 0 ? (
                <p className="py-10 text-center text-ui-sm text-ink-400">加载…</p>
              ) : (
                <>
                  {images.length > 0 && (
                    <div className="p-ui-gap">
                      <div className="mb-1.5 text-ui-2xs font-medium text-ink-500">板书 / 幻灯片照片</div>
                      <div className="grid grid-cols-2 gap-ui-gap-sm">
                        {images.map((file) => (
                          <Thumb key={file.path} file={file} onDelete={() => void handleDelete(file)} />
                        ))}
                      </div>
                    </div>
                  )}
                  {materials.length > 0 && (
                    <div className="af-line-t p-ui-gap">
                      <div className="mb-1.5 text-ui-2xs font-medium text-ink-500">
                        课程材料（PDF / PPT / Word）—— 上传后自动转成 Markdown
                      </div>
                      <div className="space-y-1">
                        {materials.map((m) => {
                          const mdRes = materialMds.find((md) => md.name === `${m.name}.md`)
                          return (
                            <div
                              key={m.path}
                              className="flex items-center gap-2 rounded-control-sm border border-ink-200 bg-paper-100/60 px-2 py-1.5"
                            >
                              <FileText className="h-ui-icon-sm w-ui-icon-sm text-seal-600 flex-shrink-0" />
                              <span className="min-w-0 flex-1 truncate text-ui-xs text-ink-700" title={m.name}>
                                {m.name.replace(/^\d+_/, '')}
                              </span>
                              {mdRes ? (
                                <button
                                  type="button"
                                  onClick={() => void openMaterialView(mdRes)}
                                  title="查看这份材料转换出的 Markdown（可编辑修正）"
                                  className="shrink-0 rounded-control-sm bg-seal-50 px-1.5 py-0.5 text-ui-2xs font-medium text-seal-700 hover:bg-seal-100"
                                >
                                  已转 Markdown
                                </button>
                              ) : (
                                <span
                                  className="shrink-0 text-ui-2xs text-ink-400"
                                  title="上传后自动触发识别，跑完这里出现 Markdown"
                                >
                                  {recognizing ? '转换中…' : '待转换'}
                                </span>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title="删除这份材料"
                                onClick={() => void handleDeleteMaterial(m)}
                              >
                                <Trash2 className="h-ui-icon-sm w-ui-icon-sm" />
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {images.length === 0 && materials.length === 0 && (
                    <EmptyState
                      icon={<Camera />}
                      title="还没有照片 / 课程材料"
                      hint="点「拍照」拍板书 / 幻灯片（自动识别成板书稿），或「选择文件」传 PDF / PPT / Word 课程材料"
                    />
                  )}
                </>
              )}
            </div>
          </div>
        ) : editingBoard ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between px-ui-gap py-1.5">
              <span className="text-ui-2xs text-ink-500">编辑识别结果（保存后写回 board.md）</span>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={cancelBoardEdit}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void saveBoardEdit()}
                  disabled={savingBoard}
                  icon={savingBoard ? <Loader2 className="animate-spin" /> : undefined}
                >
                  {savingBoard ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <VditorEditor
                value={boardDraft}
                onChange={setBoardDraft}
                height="100%"
                docPath={`projects/${taskId}/sessions/${sessionId}/session.md`}
              />
            </div>
          </div>
        ) : board ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between px-ui-gap py-1.5">
              <span className="text-ui-2xs text-ink-500">
                识别结果（识别可能出错，可编辑修正）
              </span>
              <Button variant="secondary" size="sm" onClick={startEditBoard} icon={<Sparkles />}>
                编辑
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-ui-gap pb-ui-gap">
              <pre className="whitespace-pre-wrap break-words font-sans text-ui-sm leading-relaxed text-ink-700">
                {board}
              </pre>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<Sparkles />}
            title="还没有识别结果"
            hint="传上照片后会自动识别，合并成本节课的 board.md"
          />
        )}
      </PanelBody>

      {/* 应用内相机：实时取景 + 快门，拍到即入本节课并触发识别 */}
      {cameraOpen && (
        <CameraCapture
          onCapture={(file) => uploadImages([file])}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </Panel>
  )
}
