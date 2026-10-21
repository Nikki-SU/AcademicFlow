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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, AlertTriangle, Save, Edit3, ListTree, Type } from 'lucide-react'
import { loadBookContent, saveBookContent } from '../services/textbookData'
import { renameBook } from '../services/projectData'
import { parseMarkdownHeadings, rewriteHeadingLevels } from '../services/outline'
import { runOptimistic, errText } from '../services/optimistic'
import VditorEditor from './VditorEditor'

type TabId = 'rename' | 'outline' | 'content'

const TABS: { id: TabId; label: string; icon: typeof Type }[] = [
  { id: 'rename', label: '书名', icon: Type },
  { id: 'outline', label: '大纲层级', icon: ListTree },
  { id: 'content', label: '正文', icon: Edit3 },
]

/** 落库失败时回填的草稿：父级持有它，重新挂载弹窗时把用户刚编辑的内容还回来 */
export interface BookEditDraft {
  /** 失败时这本书的 id（失败即未改名，故仍是旧书名） */
  bookId: string
  tab: TabId
  content: string
  renameValue: string
}

export interface BookEditModalProps {
  /** 当前书名 = 目录名 = textbook_id */
  bookId: string
  /** 打开时默认停在哪个页签 */
  initialTab?: TabId
  /** 失败回填草稿（有它就跳过重新拉正文，否则仓库旧值会盖掉用户刚编的内容） */
  initialDraft?: BookEditDraft
  onClose: () => void
  /** 改名成功后回调（新书名 = 新 id），父级据此换选中项 */
  onRenamed?: (newId: string) => void
  /** 正文 / 大纲保存成功后回调（父级据此刷新列表或正文） */
  onSaved?: () => void
  /** 落库失败时把草稿交回父级，由父级重新打开弹窗回填 */
  onSaveFailed?: (draft: BookEditDraft) => void
}

export default function BookEditModal({
  bookId,
  initialTab = 'content',
  initialDraft,
  onClose,
  onRenamed,
  onSaved,
  onSaveFailed,
}: BookEditModalProps) {
  const [tab, setTab] = useState<TabId>(initialDraft?.tab ?? initialTab)
  const [content, setContent] = useState(initialDraft?.content ?? '')
  const [contentLoading, setContentLoading] = useState(!initialDraft)
  const [contentError, setContentError] = useState('')
  const [renameValue, setRenameValue] = useState(initialDraft?.renameValue ?? bookId)
  /** 防重入闸门：只拦重复点击，不驱动任何灰态 / 转圈 */
  const savingRef = useRef(false)

  // 打开即拉最新正文（force 绕过缓存）：编辑必须基于仓库现状，不能基于旧缓存
  useEffect(() => {
    if (initialDraft) return
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
  }, [bookId, initialDraft])

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
    if (savingRef.current) return
    savingRef.current = true
    const draft: BookEditDraft = { bookId, tab, content, renameValue }
    try {
      await runOptimistic({
        // 点下即生效：先关窗（安静退出），写盘在后台跑；成功不弹任何提示，失败才由执行器回滚并报错
        apply: () => {
          onClose()
        },
        commit: async () => {
          await saveBookContent(bookId, content)
          onSaved?.()
        },
        rollback: () => onSaveFailed?.(draft),
        errorMessage: (err) => `保存失败：${errText(err)}（内容已保留，可直接重试）`,
      })
    } finally {
      savingRef.current = false
    }
  }

  const doRename = async () => {
    if (savingRef.current) return
    const next = renameValue.trim()
    if (!next || next === bookId) return
    savingRef.current = true
    const draft: BookEditDraft = { bookId, tab: 'rename', content, renameValue: next }
    try {
      await runOptimistic({
        // 点下即生效：关窗（安静退出）；列表与选中项在物理改名完成后跟随新路径切换
        // （新目录在改名完成前还不存在，提前切过去会把用户甩到一个读不到的路径上）
        apply: () => {
          onClose()
        },
        commit: async () => {
          const res = await renameBook(bookId, next)
          onRenamed?.(res.id)
        },
        rollback: () => onSaveFailed?.(draft),
        errorMessage: (err) => `改名失败：${errText(err)}（书名已还原，可直接重试）`,
      })
    } finally {
      savingRef.current = false
    }
  }

  const renameHint = !renameValue.trim()
    ? '书名不能为空'
    : renameValue.trim() === bookId
      ? '与当前书名一致，无需改名'
      : ''

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
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
              <p className="mt-2 text-ui-xs text-ink-400 leading-relaxed">
                书名就是图书目录名（也是主键）。改名会物理重命名目录，并同步索引表、任务归属、分类与各任务引用。
              </p>
              {renameHint && (
                <p className="mt-1.5 text-ui-xs text-ink-400">{renameHint}</p>
              )}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="af-line-t flex items-center justify-end gap-2 p-5 shrink-0">
          <button
            onClick={onClose}
            className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
          >
            取消
          </button>
          {tab === 'rename' ? (
            <button
              onClick={doRename}
              disabled={!!renameHint}
              title={renameHint || undefined}
              className="flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-seal-600"
            >
              <Type className="w-4 h-4" />
              改书名
            </button>
          ) : (
            <button
              onClick={doSaveContent}
              disabled={contentLoading || !!contentError}
              className="flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              保存
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
