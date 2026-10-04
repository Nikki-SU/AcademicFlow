/**
 * 阅读页「笔记」侧栏 —— 一篇文献 / 一本书可以有**多篇命名笔记**
 * ------------------------------------------------------------
 * 存储：{docBasePath}/notes/{名称}.md；图片在 {docBasePath}/notes/images/。
 *
 * 为什么单独一个组件：笔记的「列表 / 切换 / 新建 / 重命名 / 删除 / 上传 / 导出」是一整套
 * 自洽的交互，塞回 Reading.tsx（那一屏本来就有正文、批注、问 AI、进度、编辑模式）只会更乱。
 *
 * 与外部（Reading）的契约：
 *   - value / onChange：当前笔记的 markdown。Reading 顶部的「导出笔记」按钮也要用，
 *     所以内容状态仍留在 Reading，这里只负责加载 / 保存。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronDown,
  Download,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Save,
  StickyNote,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import VditorEditor from './VditorEditor'
import {
  NOTE_IMAGE_SUBDIR,
  createNote,
  deleteNote,
  docBasePath,
  extractNoteAttachmentsFor,
  invalidateNoteTree,
  isPipelineAttachment,
  listNotes,
  loadNote,
  noteHasContent,
  notePath,
  renameNote,
  saveImportedNote,
  saveNote,
  sanitizeNoteName,
  type DocRef,
} from '../services/readingDocData'
import { enqueueNoteConvertBatch } from '../services/notePipeline'
import { pollNoteConvertProgress, type PipelineProgress } from '../services/workflowClient'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'

interface SaveState {
  status: 'saved' | 'saving' | 'idle' | 'error'
  lastSaved: number | null
}

/** 一篇走云端转换管线（Word / PDF → markdown）的笔记的就地进度 */
interface NoteConvert {
  /** 目标笔记名（去扩展名，已去重） */
  name: string
  /** 原始附件名（提示用） */
  sourceName: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  error?: string
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface Props {
  docRef: DocRef
  placeholder: string
  /** 当前笔记 markdown（由 Reading 持有，顶部「导出笔记」也要用） */
  value: string
  onChange: (md: string) => void
  /** 导出当前笔记（交给 Reading，复用它的导出实现） */
  onExport: () => void
}

export default function ReadingNotesPanel({
  docRef,
  placeholder,
  value,
  onChange,
  onExport,
}: Props) {
  const [names, setNames] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle', lastSaved: null })
  /** 新建 / 重命名的内联输入（不用 window.prompt） */
  const [editing, setEditing] = useState<{ mode: 'create' | 'rename'; value: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [listOpen, setListOpen] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 待保存的 {笔记名, 内容} —— 切换笔记前必须先把它落盘，否则这篇的编辑会丢 */
  const pendingRef = useRef<{ name: string; md: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * 本地跟踪的管线转换任务（Word / PDF）。
   * 阅读页不会跑「管理页」那套全局 taskQueue 轮询，所以这里自成一体：
   * 只盯本 doc 的 {base_path}/notes/{name}.md 产物是否出现，出现即完成。
   */
  const [converts, setConverts] = useState<NoteConvert[]>([])
  const convertsRef = useRef(converts)
  convertsRef.current = converts

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // docRef 每次渲染都是新对象；用 key 当依赖
  const refKey = `${docRef.kind}:${docRef.id}`
  const docRefRef = useRef(docRef)
  docRefRef.current = docRef
  const basePath = docBasePath(docRef)

  /** 载入某一篇笔记的内容到外部状态 */
  const loadInto = useCallback(async (name: string | null) => {
    if (!name) {
      onChangeRef.current('')
      return
    }
    try {
      onChangeRef.current(await loadNote(docRefRef.current, name))
    } catch (err) {
      console.error('[笔记] 加载失败:', err)
      onChangeRef.current('')
    }
  }, [])

  /** 重拉列表，落到 prefer（存在时）否则第一篇 */
  const reload = useCallback(
    async (prefer?: string | null) => {
      const list = await listNotes(docRefRef.current)
      setNames(list)
      const next = prefer && list.includes(prefer) ? prefer : list[0] ?? null
      setActive(next)
      await loadInto(next)
    },
    [loadInto],
  )

  // 切换文档时，丢掉上一个文档的转换进度
  useEffect(() => {
    setConverts((prev) => (prev.length ? [] : prev))
  }, [refKey])

  /**
   * 转换完成 → 文件树缓存失效 + 重拉列表，把新笔记切到前台。
   * 判据是「产物出现」（noteHasContent / 后端 done），不是 taskQueue 状态，
   * 因为阅读页不跑全局轮询。
   */
  useEffect(() => {
    const justDone = converts.filter((c) => c.status === 'done')
    if (justDone.length === 0) return
    setConverts((prev) => prev.filter((c) => c.status !== 'done'))
    invalidateNoteTree()
    const target = justDone[justDone.length - 1].name
    void reload(target)
  }, [converts, reload])

  /**
   * 轮询管线进度：
   *   1) 先读共享的 {base_path}/.progress.json —— 后端 stage=failed 时立刻如实报错，
   *      不再傻等产物、让用户干等十几分钟；
   *   2) 再看产物 {base_path}/notes/{name}.md 是否出现（出现即完成）。
   * 产物兜底 + 12 分钟上限，覆盖 runner 完全没写 progress 的极端情况。
   */
  useEffect(() => {
    if (!converts.some((c) => c.status === 'running')) return
    let cancelled = false
    const tick = async () => {
      const running = convertsRef.current.filter((c) => c.status === 'running')
      if (running.length === 0) return

      // 一次读共享进度文件：一次 dispatch 的多篇共用同一个 .progress.json
      const auth = useAuthStore.getState()
      const ws = useWorkspaceStore.getState()
      const owner = auth.user?.login
      const repo = ws.repo?.name
      const token = auth.token
      let prog: PipelineProgress | null = null
      if (owner && repo && token) {
        prog = await pollNoteConvertProgress(basePath, owner, repo, token).catch(() => null)
      }

      for (const c of running) {
        if (cancelled) return
        const elapsed = Date.now() - c.startedAt
        // 后端已明确失败：立刻按真实 error 置失败（仅认本次转换开始之后写的失败，
        // 免得把上一次残留的 .progress.json 误判成这一次）。
        const isFreshFailure =
          prog?.stage === 'failed' &&
          (!prog.updated_at || Date.parse(prog.updated_at) >= c.startedAt - 5000)
        if (isFreshFailure) {
          const detail = prog?.error || prog?.message || '后端转换失败'
          setConverts((prev) =>
            prev.map((x) =>
              x.name === c.name && x.status === 'running' ? { ...x, status: 'failed', error: detail } : x,
            ),
          )
          continue
        }
        // 后端 runner 失败 / 卡住时产物永远不会出现，给个上限，别让用户干等
        if (elapsed > 12 * 60 * 1000) {
          setConverts((prev) =>
            prev.map((x) =>
              x.name === c.name && x.status === 'running'
                ? { ...x, status: 'failed', error: '转换超时，请到 GitHub Actions 或「管理 → 后端监控」查看日志' }
                : x,
            ),
          )
          continue
        }
        const has = await noteHasContent(basePath, c.name)
        if (has === true) {
          setConverts((prev) =>
            prev.map((x) => (x.name === c.name && x.status === 'running' ? { ...x, status: 'done' } : x)),
          )
        }
      }
    }
    const id = setInterval(() => void tick(), 6000)
    void tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [converts, basePath])

  const dismissConvert = (name: string) =>
    setConverts((prev) => prev.filter((c) => c.name !== name))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSaveState({ status: 'idle', lastSaved: null })
    ;(async () => {
      try {
        const list = await listNotes(docRefRef.current)
        if (cancelled) return
        setNames(list)
        const first = list[0] ?? null
        setActive(first)
        if (first) {
          const md = await loadNote(docRefRef.current, first)
          if (!cancelled) onChangeRef.current(md)
        } else if (!cancelled) {
          onChangeRef.current('')
        }
      } catch (err) {
        console.error('[笔记] 加载列表失败:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey])

  // 点空白处收起笔记下拉
  useEffect(() => {
    if (!listOpen) return
    const onDown = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [listOpen])

  /** 立刻把待保存内容落盘（切换 / 删除笔记前调用，避免丢编辑） */
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    try {
      await saveNote(docRefRef.current, pending.name, pending.md)
      setSaveState({ status: 'saved', lastSaved: Date.now() })
    } catch (err) {
      console.error('[笔记] 保存失败:', err)
      setSaveState({ status: 'error', lastSaved: null })
      toast.error(`笔记保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const scheduleSave = (md: string, name: string) => {
    pendingRef.current = { name, md }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setSaveState({ status: 'saving', lastSaved: null })
    saveTimerRef.current = setTimeout(() => {
      void flushSave()
    }, 800)
  }

  const handleChange = (md: string) => {
    onChangeRef.current(md)
    if (active) scheduleSave(md, active)
  }

  const selectNote = async (name: string) => {
    setListOpen(false)
    if (name === active) return
    await flushSave()
    setActive(name)
    await loadInto(name)
  }

  const beginCreate = () => {
    setEditing({ mode: 'create', value: '' })
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const beginRename = () => {
    if (!active) return
    setEditing({ mode: 'rename', value: active })
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const commitEditing = async () => {
    const draft = editing
    if (!draft) return
    const name = sanitizeNoteName(draft.value)
    setEditing(null)
    if (!name) return
    try {
      if (draft.mode === 'create') {
        if (names.includes(name)) {
          toast.error('已有同名笔记', { description: `「${name}」已存在，换个名字。` })
          return
        }
        await flushSave()
        await createNote(docRefRef.current, name, '')
        await reload(name)
      } else if (active && name !== active) {
        if (names.includes(name)) {
          toast.error('已有同名笔记', { description: `「${name}」已存在，换个名字。` })
          return
        }
        await flushSave()
        await renameNote(docRefRef.current, active, name)
        await reload(name)
      }
    } catch (err) {
      console.error('[笔记] 保存名称失败:', err)
      toast.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const removeActive = async () => {
    if (!active) return
    if (!confirm(`确定删除笔记「${active}」吗？此操作不可撤销。`)) return
    try {
      // 这篇马上就要删了，待保存的内容别再写回去
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      pendingRef.current = null
      await deleteNote(docRefRef.current, active)
      await reload(null)
    } catch (err) {
      console.error('[笔记] 删除失败:', err)
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 上传附件成为笔记。两类分流：
   *   1) 本地直读：.md / .txt / .zip（内含 md 与图片）—— 当场落盘成笔记；
   *   2) 云端管线：.doc / .docx / .pdf —— 上传私库后触发 note_convert（Word→PDF→MinerU）。
   * 同名笔记自动加 -2/-3 后缀，绝不覆盖已有笔记。
   */
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const all = Array.from(files)
      const localFiles = all.filter((f) => !isPipelineAttachment(f))
      const pipelineFiles = all.filter((f) => isPipelineAttachment(f))

      const used = new Set(names)
      const uniqueName = (raw: string) => {
        const base = sanitizeNoteName(raw)
        let name = base
        let n = 2
        while (used.has(name)) name = `${base}-${n++}`
        used.add(name)
        return name
      }

      // 1) 本地直读附件
      let importedCount = 0
      let firstName: string | null = null
      if (localFiles.length > 0) {
        const imported = await extractNoteAttachmentsFor(docRefRef.current, localFiles)
        if (imported.length === 0 && pipelineFiles.length === 0) {
          toast.error('没解析出任何带文字的笔记')
          return
        }
        for (const note of imported) {
          const name = uniqueName(note.name)
          await saveImportedNote(docRefRef.current, { ...note, name })
          if (!firstName) firstName = name
          importedCount++
        }
      }
      if (importedCount > 0) {
        await reload(firstName)
      }

      // 2) 云端管线附件（判据是产物出现，见 converts 轮询）
      //    一批附件只 dispatch 一次：runner 只装一次 LibreOffice、一次 MinerU batch
      if (pipelineFiles.length > 0) {
        const items = pipelineFiles.map((file) => ({
          file,
          name: uniqueName(file.name.replace(/\.[^.]+$/, '')),
        }))
        const startedAt = Date.now()
        const { results } = await enqueueNoteConvertBatch(
          docRefRef.current,
          items.map((it) => ({ file: it.file, noteName: it.name })),
        )
        const started: NoteConvert[] = []
        items.forEach((it, i) => {
          if (results[i]?.ok) {
            started.push({ name: it.name, sourceName: it.file.name, status: 'running', startedAt })
          }
        })
        if (started.length > 0) setConverts((prev) => [...prev, ...started])
      }
    } catch (err) {
      console.error('[笔记] 上传失败:', err)
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 })
    } finally {
      setUploading(false)
    }
  }

  const wordCount = value.replace(/\s/g, '').length

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶栏：笔记切换 + 新建 / 重命名 / 删除 / 上传 / 导出 */}
      <div className="af-line-b px-ui-gap py-2 flex-shrink-0 bg-paper-100/50">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="text"
              value={editing.value}
              placeholder={editing.mode === 'create' ? '新笔记名' : '重命名'}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitEditing()
                if (e.key === 'Escape') setEditing(null)
              }}
              className="flex-1 min-w-0 px-2 py-1 text-ui-xs border border-ink-300 rounded-control-sm focus:outline-none focus:border-seal-400"
            />
            <button
              onClick={() => void commitEditing()}
              className="px-2 py-1 text-ui-xs bg-seal-600 text-paper-50 rounded-control-sm hover:bg-seal-700 transition"
            >
              确定
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-2 py-1 text-ui-xs text-ink-500 hover:bg-ink-100 rounded-control-sm transition"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {/* 笔记下拉（含切换） */}
            <div className="relative flex-1 min-w-0" ref={listRef}>
              <button
                onClick={() => setListOpen((v) => !v)}
                disabled={names.length === 0}
                className="w-full flex items-center gap-1 px-2 py-1 text-ui-xs text-ink-700 bg-paper-50 border border-ink-200 rounded-control-sm hover:border-seal-300 transition disabled:opacity-50"
              >
                <FileText className="w-3.5 h-3.5 flex-shrink-0 text-seal-500" />
                <span className="truncate flex-1 text-left">
                  {active ?? (loading ? '加载中…' : '暂无笔记')}
                </span>
                <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-ink-400" />
              </button>
              {listOpen && names.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-paper-50 border border-ink-200 rounded-control shadow-xl py-1 max-h-64 overflow-y-auto">
                  {names.map((name) => (
                    <button
                      key={name}
                      onClick={() => void selectNote(name)}
                      className={`w-full text-left px-ui-gap py-1.5 text-ui-xs truncate transition ${
                        name === active
                          ? 'bg-seal-50 text-seal-700 font-medium'
                          : 'text-ink-600 hover:bg-paper-100'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={beginCreate}
              title="新建笔记"
              className="p-1.5 text-ink-500 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={beginRename}
              disabled={!active}
              title="重命名当前笔记"
              className="p-1.5 text-ink-500 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition disabled:opacity-40"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => void removeActive()}
              disabled={!active}
              title="删除当前笔记"
              className="p-1.5 text-ink-500 hover:text-red-600 hover:bg-red-50 rounded-control-sm transition disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="上传笔记（md / txt / docx / pdf / zip）"
              className="p-1.5 text-ink-500 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition disabled:opacity-40"
            >
              {uploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={onExport}
              disabled={!value.trim()}
              title="导出当前笔记"
              className="p-1.5 text-ink-500 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.markdown,.txt,.doc,.docx,.pdf,.zip"
              className="hidden"
              onChange={(e) => {
                void handleUpload(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        )}
      </div>

      {/* 管线转换进度（Word / PDF → markdown 笔记） */}
      {converts.length > 0 && (
        <div className="af-line-b px-ui-gap py-2 flex-shrink-0 bg-seal-50/40 space-y-1.5">
          {converts.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-ui-xs">
              {c.status === 'running' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-seal-500 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
              )}
              <span className="truncate flex-1 text-ink-600" title={c.sourceName}>
                {c.name}
              </span>
              {c.status === 'running' ? (
                <span className="text-seal-600 flex-shrink-0">转换中…</span>
              ) : (
                <>
                  <span className="text-red-500 flex-shrink-0" title={c.error}>
                    转换失败
                  </span>
                  <button
                    onClick={() => dismissConvert(c.name)}
                    title={c.error ?? '移除'}
                    className="p-0.5 text-ink-400 hover:text-ink-700 flex-shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 编辑区 */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="h-full flex items-center justify-center text-ink-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : active ? (
          <VditorEditor
            value={value}
            onChange={handleChange}
            height="100%"
            placeholder={placeholder}
            className="h-full"
            docPath={notePath(docRef, active)}
            imageSubDir={NOTE_IMAGE_SUBDIR}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center text-ink-400 px-6">
            <StickyNote className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-ui-sm text-ink-500">还没有笔记</p>
            <p className="text-ui-xs mt-1 mb-4">新建一篇，或上传已有的 md / docx / pdf 笔记</p>
            <div className="flex items-center gap-2">
              <button
                onClick={beginCreate}
                className="flex items-center gap-1 px-ui-gap py-1.5 text-ui-xs bg-seal-600 text-paper-50 rounded-control-sm hover:bg-seal-700 transition"
              >
                <Plus className="w-3.5 h-3.5" />
                新建笔记
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-ui-gap py-1.5 text-ui-xs border border-ink-200 text-ink-600 rounded-control-sm hover:bg-paper-100 transition"
              >
                <Upload className="w-3.5 h-3.5" />
                上传笔记
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 底栏：保存状态 + 字数 */}
      <div className="af-line-t px-ui-gap py-2 flex items-center justify-between flex-shrink-0 bg-paper-100/50">
        <div className="flex items-center gap-1.5 text-ui-xs text-ink-400">
          {saveState.status === 'saving' && (
            <>
              <span className="w-2.5 h-2.5 border border-ink-300 border-t-seal-500 rounded-full animate-spin" />
              <span className="text-seal-600">保存中...</span>
            </>
          )}
          {saveState.status === 'saved' && (
            <>
              <Save className="w-3.5 h-3.5 text-green-500" />
              <span className="text-green-600 font-medium">
                已自动保存
                {saveState.lastSaved && ` ${formatTime(saveState.lastSaved)}`}
              </span>
            </>
          )}
          {saveState.status === 'idle' && (
            <>
              <Save className="w-3.5 h-3.5" />
              <span>自动保存</span>
            </>
          )}
          {saveState.status === 'error' && <span className="text-red-500">保存失败</span>}
        </div>
        <span className="text-ui-xs text-ink-400 font-mono">{wordCount} 字</span>
      </div>
    </div>
  )
}
