/**
 * 「查看文档」只读面板
 * -------------------------------------------------
 * 写作页 IDE 的可选窗口：先选一篇已有材料（图书 / 文献 / 其他文档），再在正文里
 * 做全文检索、看大纲、逐段阅读 —— 纯阅读、纯检索，不给任何修改入口，
 * 就是为了让写作者能「边读边写」。
 *
 * 与阅读页共用同一套实现，不另起口径：
 * - 渲染 / 锚点 / 大纲：services/outline.ts + markdown-renderer.ts / translation.ts
 * - 文内检索高亮：services/text-highlight.ts
 * - 私库图片加载：services/repoImages.ts
 *
 * 文献固定按「中英对照」渲染 —— 这里不提供模式切换（用户要求：文献默认显示中文+英文）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  FileText,
  ListTree,
  Loader2,
  Newspaper,
  Search,
  X,
} from 'lucide-react'
import { listBooks, loadBookContent, type BookSummary } from '../services/textbookData'
import { listDocuments, loadDocumentContent, type DocumentSummary } from '../services/documentData'
import { loadAlignedMd, loadLiteratures, type Literature } from '../services/literatureData'
import { renderMarkdownToHtml } from '../services/markdown-renderer'
import { renderAlignedMdHtml } from '../services/translation'
import { buildOutlineAndAnchors, withBookBlockIds, type OutlineItem } from '../services/outline'
import { clearSearchHits, highlightSearchHits } from '../services/text-highlight'
import { getImageBaseUrl, getPlainImageBaseUrl, hydrateImages } from '../services/repoImages'
import { getResolvedAuthMode } from '../services/github'
import { useAuthStore } from '../stores/auth'

type DocKind = 'book' | 'literature' | 'document'

interface SelectedDoc {
  kind: DocKind
  /** 图书 / 文档 = textbooks|documents 下的目录名；文献 = DOI */
  id: string
  title: string
  subtitle: string
}

const KIND_LABEL: Record<DocKind, string> = {
  book: '图书',
  literature: '文献',
  document: '其他文档',
}

function SectionLabel({ icon, text, count }: { icon: ReactNode; text: string; count: number }) {
  return (
    <div className="text-ui-xs font-semibold text-ink-500 mb-2 px-1 flex items-center gap-1.5">
      {icon}
      {text}
      <span className="ml-auto text-ink-400 font-normal">{count}</span>
    </div>
  )
}

export default function DocViewPanel() {
  const [lists, setLists] = useState<{
    books: BookSummary[]
    literatures: Literature[]
    documents: DocumentSummary[]
  }>({ books: [], literatures: [], documents: [] })
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [pickerQuery, setPickerQuery] = useState('')

  const [selected, setSelected] = useState<SelectedDoc | null>(null)
  const [contentHtml, setContentHtml] = useState('')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState('')
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [activeAnchor, setActiveAnchor] = useState('')

  const [findInput, setFindInput] = useState('')
  const [findQuery, setFindQuery] = useState('')

  const bodyRef = useRef<HTMLDivElement>(null)
  const findScrolledRef = useRef('')
  const rafRef = useRef(0)

  // ── 文件清单：图书 / 文献 / 其他文档 一次拉齐 ──
  useEffect(() => {
    let cancelled = false
    setListLoading(true)
    setListError('')
    Promise.all([
      listBooks().catch(() => [] as BookSummary[]),
      loadLiteratures().catch(() => [] as Literature[]),
      listDocuments().catch(() => [] as DocumentSummary[]),
    ])
      .then(([books, literatures, documents]) => {
        if (cancelled) return
        setLists({ books, literatures, documents })
      })
      .catch((err) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openDoc = useCallback((doc: SelectedDoc) => {
    setSelected(doc)
    setPickerQuery('')
    setFindInput('')
    setFindQuery('')
    setActiveAnchor('')
    setOutlineOpen(true)
  }, [])

  // ── 读取并渲染正文（与阅读页同一套口径） ──
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setContentLoading(true)
    setContentError('')
    setContentHtml('')
    setOutline([])
    void (async () => {
      try {
        let html = ''
        if (selected.kind === 'literature') {
          const md = await loadAlignedMd(selected.id)
          if (!md.trim()) throw new Error('这篇文献还没有生成正文，先在文献库把它转成 Markdown 再来看。')
          html = renderAlignedMdHtml(md, 'bilingual', {
            imageBaseUrl: getImageBaseUrl(selected.id),
          }).html
        } else {
          const md =
            selected.kind === 'book'
              ? await loadBookContent(selected.id)
              : await loadDocumentContent(selected.id)
          if (!md.trim()) throw new Error('这篇文档还没有正文。')
          const imageBaseUrl = getPlainImageBaseUrl(
            selected.id,
            selected.kind === 'book' ? 'textbooks' : 'documents',
          )
          html = withBookBlockIds(renderMarkdownToHtml(md, { imageBaseUrl }))
        }
        if (cancelled) return
        const built = buildOutlineAndAnchors(html)
        setContentHtml(built.html)
        setOutline(built.outline)
      } catch (err) {
        if (!cancelled) setContentError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setContentLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selected])

  // ── 私库图片预加载（与阅读页同一套 blob URL 方案） ──
  useEffect(() => {
    if (!contentHtml || !bodyRef.current) return
    const token = useAuthStore.getState().token
    if (!token) return
    const mode = getResolvedAuthMode()
    const t = setTimeout(() => {
      if (bodyRef.current) void hydrateImages(bodyRef.current, token, mode)
    }, 50)
    return () => clearTimeout(t)
  }, [contentHtml])

  // ── 文内检索：打字防抖提交（回车立即提交） ──
  useEffect(() => {
    const t = setTimeout(() => setFindQuery(findInput.trim()), 250)
    return () => clearTimeout(t)
  }, [findInput])

  // ── 检索命中定位：先清、再高亮、滚到第一处；图片撑高正文时重对齐（用户一动手就撒手） ──
  useEffect(() => {
    const root = bodyRef.current
    if (!root) return
    clearSearchHits(root)
    if (!findQuery) return

    const first = highlightSearchHits(root, findQuery)
    if (!first) return

    const token = `${selected?.id ?? ''}|${findQuery}`
    const fresh = findScrolledRef.current !== token
    if (fresh) findScrolledRef.current = token

    const scrollToHit = (behavior: ScrollBehavior) => {
      bodyRef.current
        ?.querySelector<HTMLElement>('.search-hit')
        ?.scrollIntoView({ behavior, block: 'center' })
    }
    scrollToHit(fresh ? 'smooth' : 'auto')

    let alive = true
    let firstRo = true
    const box = bodyRef.current
    const giveUp = () => {
      alive = false
      ro.disconnect()
      box?.removeEventListener('wheel', giveUp)
      box?.removeEventListener('touchstart', giveUp)
      window.removeEventListener('keydown', giveUp)
    }
    const ro = new ResizeObserver(() => {
      if (firstRo) {
        firstRo = false
        return
      }
      if (alive) scrollToHit('auto')
    })
    ro.observe(root)
    box?.addEventListener('wheel', giveUp, { passive: true })
    box?.addEventListener('touchstart', giveUp, { passive: true })
    window.addEventListener('keydown', giveUp)
    const timeout = window.setTimeout(giveUp, 5000)
    return () => {
      alive = false
      ro.disconnect()
      window.clearTimeout(timeout)
    }
  }, [findQuery, contentHtml, selected])

  // ── 大纲跳转 + 滚动时高亮当前标题 ──
  const jumpToAnchor = useCallback((anchor: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[id="${anchor}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveAnchor(anchor)
  }, [])

  const handleBodyScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      const root = bodyRef.current
      if (!root) return
      const headings = root.querySelectorAll<HTMLElement>('[id^="book-h-"]')
      if (headings.length === 0) return
      const rootTop = root.getBoundingClientRect().top
      let current = ''
      headings.forEach((h) => {
        if (h.getBoundingClientRect().top - rootTop <= 8) current = h.id
      })
      setActiveAnchor((prev) => (current && current !== prev ? current : prev))
    })
  }, [])

  useEffect(
    () => () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const filtered = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    const hit = (s: string) => !q || s.toLowerCase().includes(q)
    return {
      books: lists.books.filter((b) => hit(b.title) || hit(b.id)),
      literatures: lists.literatures.filter((l) => hit(l.title) || hit(l.authors) || hit(l.doi)),
      documents: lists.documents.filter((d) => hit(d.title) || hit(d.author)),
    }
  }, [lists, pickerQuery])

  const total = filtered.books.length + filtered.literatures.length + filtered.documents.length

  // ── 第一阶段：选文件 ──
  if (!selected) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="af-line-b shrink-0 p-3 bg-paper-50">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-ui-icon w-ui-icon text-ink-400" />
            <input
              type="text"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="搜索图书 / 文献 / 文档..."
              className="w-full pl-9 pr-3 py-2 text-ui-sm border border-ink-200 rounded-control focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50"
            />
          </div>
          <div className="mt-2 text-ui-2xs text-ink-400 flex items-center gap-1.5">
            <BookOpen className="w-3 h-3" />
            选一个文件，边读边写（只读）
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
          {listLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-ui-xs text-ink-400">
              <Loader2 className="h-ui-icon w-ui-icon animate-spin" />
              正在读取文件…
            </div>
          ) : listError ? (
            <div className="p-3 rounded-control bg-red-50 border border-red-200 text-ui-xs text-red-600 flex items-start gap-2">
              <AlertTriangle className="h-ui-icon-sm w-ui-icon-sm shrink-0 mt-0.5" />
              {listError}
            </div>
          ) : total === 0 ? (
            <div className="py-8 text-center text-ui-xs text-ink-400">
              {pickerQuery ? '没有匹配的文件' : '还没有图书 / 文献 / 文档'}
            </div>
          ) : (
            <>
              {filtered.books.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<BookOpen className="h-ui-icon-sm w-ui-icon-sm" />}
                    text="图书"
                    count={filtered.books.length}
                  />
                  <div className="space-y-2">
                    {filtered.books.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => openDoc({ kind: 'book', id: b.id, title: b.title, subtitle: '' })}
                        disabled={!b.hasContent}
                        className="w-full text-left p-2.5 bg-paper-50 rounded-control border border-ink-200 hover:border-seal-200 hover:bg-seal-50/40 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div className="text-ui-xs font-medium text-ink-700 line-clamp-2 leading-snug">
                          {b.title}
                        </div>
                        {!b.hasContent && <div className="text-ui-2xs text-amber-600 mt-0.5">暂无正文</div>}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {filtered.literatures.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Newspaper className="h-ui-icon-sm w-ui-icon-sm" />}
                    text="文献"
                    count={filtered.literatures.length}
                  />
                  <div className="space-y-2">
                    {filtered.literatures.map((l) => (
                      <button
                        key={l.doi}
                        onClick={() =>
                          openDoc({
                            kind: 'literature',
                            id: l.doi,
                            title: l.title || l.doi,
                            subtitle: [l.journal, l.year ? String(l.year) : ''].filter(Boolean).join(' · '),
                          })
                        }
                        className="w-full text-left p-2.5 bg-paper-50 rounded-control border border-ink-200 hover:border-seal-200 hover:bg-seal-50/40 transition"
                      >
                        <div className="text-ui-xs font-medium text-ink-700 line-clamp-2 leading-snug">
                          {l.title || l.doi}
                        </div>
                        <div className="text-ui-2xs text-ink-500 mt-0.5 truncate">
                          {[l.journal, l.year ? String(l.year) : ''].filter(Boolean).join(' · ') || l.doi}
                        </div>
                        {l.mdStatus !== 'done' && (
                          <div className="text-ui-2xs text-amber-600 mt-0.5">正文 / 译文可能尚未就绪</div>
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {filtered.documents.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<FileText className="h-ui-icon-sm w-ui-icon-sm" />}
                    text="其他文档"
                    count={filtered.documents.length}
                  />
                  <div className="space-y-2">
                    {filtered.documents.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => openDoc({ kind: 'document', id: d.id, title: d.title, subtitle: d.author })}
                        disabled={!d.hasContent}
                        className="w-full text-left p-2.5 bg-paper-50 rounded-control border border-ink-200 hover:border-seal-200 hover:bg-seal-50/40 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div className="text-ui-xs font-medium text-ink-700 line-clamp-2 leading-snug">
                          {d.title}
                        </div>
                        {d.author && <div className="text-ui-2xs text-ink-500 mt-0.5 truncate">{d.author}</div>}
                        {!d.hasContent && <div className="text-ui-2xs text-amber-600 mt-0.5">暂无正文</div>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  // ── 第二阶段：读文档（只读） ──
  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* 顶部：返回 + 标题 + 大纲开关 */}
      <div className="af-line-b shrink-0 flex items-center gap-2 px-3 py-2 bg-paper-50">
        <button
          onClick={() => setSelected(null)}
          title="返回文件列表"
          className="-ml-1 p-1 rounded-control-sm text-ink-500 hover:bg-paper-100 hover:text-seal-600 transition"
        >
          <ChevronLeft className="h-ui-icon w-ui-icon" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-ui-xs font-semibold text-ink-700 truncate" title={selected.title}>
            {selected.title}
          </div>
          <div className="text-ui-2xs text-ink-400 truncate">
            {KIND_LABEL[selected.kind]}
            {selected.subtitle ? ` · ${selected.subtitle}` : ''}
          </div>
        </div>
        <button
          onClick={() => setOutlineOpen((o) => !o)}
          title="大纲"
          className={`p-1 rounded-control-sm transition ${
            outlineOpen ? 'text-seal-600 bg-seal-50' : 'text-ink-500 hover:bg-paper-100'
          }`}
        >
          <ListTree className="h-ui-icon w-ui-icon" />
        </button>
      </div>

      {/* 文内检索 */}
      <div className="af-line-b shrink-0 px-3 py-2 bg-paper-50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-ui-icon w-ui-icon text-ink-400" />
          <input
            type="text"
            value={findInput}
            onChange={(e) => setFindInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFindQuery(findInput.trim())
            }}
            placeholder="在文档内全文检索..."
            className="w-full pl-9 pr-8 py-1.5 text-ui-xs border border-ink-200 rounded-control focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50"
          />
          {findInput && (
            <button
              onClick={() => {
                setFindInput('')
                setFindQuery('')
              }}
              title="清除"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-control-sm text-ink-400 hover:text-ink-600"
            >
              <X className="h-ui-icon-sm w-ui-icon-sm" />
            </button>
          )}
        </div>
      </div>

      {/* 大纲（可折叠） */}
      {outlineOpen && (
        <div className="af-line-b shrink-0 max-h-[38%] overflow-y-auto px-2 py-1 space-y-0.5 bg-paper-100/40">
          {outline.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-2xs text-ink-400">（没有识别到标题）</div>
          ) : (
            outline.map((item) => (
              <button
                key={item.anchor}
                onClick={() => jumpToAnchor(item.anchor)}
                title={item.text}
                style={{ paddingLeft: `${0.5 + (item.level - 1) * 0.75}rem` }}
                className={`w-full text-left px-2 py-1.5 rounded-control-sm text-ui-xs hover:bg-seal-50 hover:text-seal-700 transition truncate ${
                  item.anchor === activeAnchor
                    ? 'bg-seal-50 text-seal-700 font-medium'
                    : item.level === 1
                      ? 'font-semibold text-ink-700'
                      : item.level === 2
                        ? 'font-medium text-ink-600'
                        : 'text-ink-500'
                }`}
              >
                {item.text}
              </button>
            ))
          )}
        </div>
      )}

      {/* 正文（只读） */}
      <div
        ref={bodyRef}
        onScroll={handleBodyScroll}
        className="flex-1 min-h-0 overflow-y-auto bg-paper-100"
      >
        <div className="w-full px-4 py-4" style={{ fontSize: '1rem' }}>
          {contentLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-ui-xs text-ink-400">
              <Loader2 className="h-ui-icon w-ui-icon animate-spin" />
              正在加载正文…
            </div>
          ) : contentError ? (
            <div className="p-3 rounded-control bg-red-50 border border-red-200 text-ui-xs text-red-600 flex items-start gap-2">
              <AlertTriangle className="h-ui-icon-sm w-ui-icon-sm shrink-0 mt-0.5" />
              {contentError}
            </div>
          ) : (
            <div className="prose-reader measure-reader" dangerouslySetInnerHTML={{ __html: contentHtml }} />
          )}
        </div>
      </div>
    </div>
  )
}
