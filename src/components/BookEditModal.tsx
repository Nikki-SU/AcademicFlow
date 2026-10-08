/**
 * 图书编辑弹窗（改书名 / 改大纲层级 / 改正文）
 * -------------------------------------------------
 * 为什么要有它：MinerU 抽取图书时，**「是不是标题」基本可信，「是几级标题」经常抽风**，
 * 而且上传时的文件名也不保证等于真正的书名。所以对一本图书必须允许人工修三件事：
 *   1) 书名 —— 物理重命名 textbooks/{书名}/ 目录（书名即主键，改 = 换主键）
 *   2) 大纲层级 —— 只改 content.md 里标题行的 `#` 数量，正文文字一字不动
 *   3) 正文 —— Markdown 源码编辑器（Vditor，全站唯一 Markdown 编辑器）
 *
 * 三类改动都落回同一份 content.md / 同一目录：
 * - 层级与正文共用一份草稿（content state），一起保存；改名走独立事务（同步全链路引用）。
 *
 * 阅读页（打开图书时）与管理页（图书库详情）两处都挂这个弹窗，保证口径唯一。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertTriangle, Save, Edit3, ListTree, Type } from 'lucide-react'
import { toast } from 'sonner'
import { loadBookContent, saveBookContent } from '../services/textbookData'
import { renameBook } from '../services/projectData'
import { parseMarkdownHeadings, rewriteHeadingLevels } from '../services/outline'
import VditorEditor from './VditorEditor'

type TabId = 'rename' | 'outline' | 'content'

const TABS: { id: TabId; label: string; icon: typeof Type }[] = [
  { id: 'rename', label: '书名', icon: Type },
  { id: 'outline', label: '大纲层级', icon: ListTree },
  { id: 'content', label: '正文', icon: Edit3 },
]

export interface BookEditModalProps {
  /** 当前书名 = 目录名 = textbook_id */
  bookId: string
  /** 打开时默认停在哪个页签 */
  initialTab?: TabId
  onClose: () => void
  /** 改名成功后回调（新书名 = 新 id），父级据此换选中项 */
  onRenamed?: (newId: string) => void
  /** 正文 / 大纲保存成功后回调（父级据此刷新列表或正文） */
  onSaved?: () => void
}

export default function BookEditModal({
  bookId,
  initialTab = 'content',
  onClose,
  onRenamed,
  onSaved,
}: BookEditModalProps) {
  const [tab, setTab] = useState<TabId>(initialTab)
  const [content, setContent] = useState('')
  const [contentLoading, setContentLoading] = useState(true)
  const [contentError, setContentError] = useState('')
  const [renameValue, setRenameValue] = useState(bookId)
  const [busy, setBusy] = useState(false)

  // 打开即拉最新正文（force 绕过缓存）：编辑必须基于仓库现状，不能基于旧缓存
  useEffect(() => {
    let cancelled = false
    setContentLoading(true)
    setContentError('')
    loadBookContent(bookId, true)
      .then((md) => {
        if (!cancelled) setContent(md)
      })
      .catch((err) => {
        if (!cancelled) setContentError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bookId])

  const headings = useMemo(() => parseMarkdownHeadings(content), [content])

  /** 只改第 index 个标题的层级：其余标题层级与全部正文原样保留 */
  const changeHeadingLevel = useCallback((index: number, level: number) => {
    setContent((prev) => {
      const hs = parseMarkdownHeadings(prev)
      const levels = hs.map((h, i) => (i === index ? level : h.level))
      return rewriteHeadingLevels(prev, levels)
    })
  }, [])

  const doSaveContent = async () => {
    setBusy(true)
    try {
      await saveBookContent(bookId, content)
      toast.success('已保存到 content.md')
      onSaved?.()
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const doRename = async () => {
    const next = renameValue.trim()
    if (!next) {
      toast.error('书名不能为空')
      return
    }
    if (next === bookId) {
      toast.info('书名没有变化')
      return
    }
    setBusy(true)
    try {
      const res = await renameBook(bookId, next)
      toast.success(`已改名为「${res.id}」，同步搬迁 ${res.movedFiles} 个文件`)
      onRenamed?.(res.id)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const loadingNode = (
    <div className="flex-1 flex items-center justify-center gap-2 py-10 text-ui-xs text-ink-400">
      <Loader2 className="h-ui-icon w-ui-icon animate-spin" />
      正在读取正文…
    </div>
  )

  const errorNode = (
    <div className="p-3 rounded-control bg-red-50 border border-red-200 text-ui-xs text-red-600 flex items-start gap-2">
      <AlertTriangle className="h-ui-icon-sm w-ui-icon-sm shrink-0 mt-0.5" />
      {contentError}
    </div>
  )

  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
      <div className="bg-paper-50 rounded-card shadow-xl w-full max-w-2xl max-h-[88vh] flex flex-col">
        {/* 头部 */}
        <div className="af-line-b flex items-center justify-between p-5 shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-ink-800 truncate">编辑图书</h3>
            <p className="text-ui-xs text-ink-400 truncate">当前：{bookId}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-ink-400 hover:text-ink-600 transition"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 页签 */}
        <div className="af-line-b flex items-center gap-1 px-3 shrink-0">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-ui-xs border-b-2 -mb-px transition ${
                  active
                    ? 'border-seal-500 text-seal-700 font-medium'
                    : 'border-transparent text-ink-500 hover:text-ink-700'
                }`}
              >
                <Icon className="h-ui-icon-sm w-ui-icon-sm" />
                {t.label}
              </button>
            )
          })}
        </div>

        {/* 主体 */}
        <div className="flex-1 min-h-0 flex flex-col p-5">
          {tab === 'content' ? (
            contentLoading ? (
              loadingNode
            ) : contentError ? (
              errorNode
            ) : (
              <div className="flex-1 min-h-0">
                <VditorEditor
                  value={content}
                  onChange={setContent}
                  height="100%"
                  placeholder="编辑图书正文…"
                  className="h-full"
                />
              </div>
            )
          ) : tab === 'outline' ? (
            contentLoading ? (
              loadingNode
            ) : contentError ? (
              errorNode
            ) : headings.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-ui-xs text-ink-400">
                这篇正文里没有识别到标题
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <p className="text-ui-xs text-ink-400 mb-3 leading-relaxed">
                  只调层级、不动标题文字。MinerU 常常把层级抽错，按你认为对的结构改；保存后直接改写
                  content.md 里标题行的 # 数量。
                </p>
                <div className="space-y-1">
                  {headings.map((h, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 p-2 rounded-control border border-ink-200 bg-paper-100/40"
                    >
                      <select
                        value={h.level}
                        onChange={(e) => changeHeadingLevel(i, Number(e.target.value))}
                        title="标题层级"
                        className="shrink-0 px-2 py-1 text-ui-xs border border-ink-200 rounded-control-sm bg-paper-50 focus:outline-none focus:border-seal-400"
                      >
                        {[1, 2, 3, 4, 5, 6].map((lv) => (
                          <option key={lv} value={lv}>{`H${lv}`}</option>
                        ))}
                      </select>
                      <span
                        className="min-w-0 flex-1 truncate text-ui-xs text-ink-700"
                        title={h.text}
                        style={{ paddingLeft: `${(h.level - 1) * 0.75}rem` }}
                      >
                        {h.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">书名</label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                disabled={busy}
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 disabled:opacity-50"
              />
              <p className="mt-2 text-ui-xs text-ink-400 leading-relaxed">
                书名就是图书目录名（也是主键）。改名会物理重命名目录，并同步索引表、任务归属、分类与各任务引用。
              </p>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="af-line-t flex items-center justify-end gap-2 p-5 shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition disabled:opacity-50"
          >
            取消
          </button>
          {tab === 'rename' ? (
            <button
              onClick={doRename}
              disabled={busy}
              className="flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Type className="w-4 h-4" />}
              改书名
            </button>
          ) : (
            <button
              onClick={doSaveContent}
              disabled={busy || contentLoading || !!contentError}
              className="flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {busy ? '保存中…' : '保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
