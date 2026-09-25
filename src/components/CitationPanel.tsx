/**
 * 引用表
 * ------------------------------------------------------------
 * 正文里的引用标记只存 DOI（`[@doi:…]`），DOI 就是唯一中间表示 ——
 * 换期刊不需要在期刊之间互相映射，只需换一套样式：
 *   正文用什么符号、尾处条目什么格式，交给 LaTeX 的 natbib + .bst 在编译时决定。
 * 所以这里不另造一套前端格式（那必然和 PDF 对不上），
 * 只负责把「这篇稿子引了哪些文献、各引在哪几处、当前用哪套样式」摊开，并让你换目标期刊。
 *
 * 关于右侧那列「小点点」：
 *   同一篇文献常被引很多次（方法、结果、讨论各一次）。用户要的是「正文里到底引在哪几处」，
 *   所以**每一处一个点**，从上到下排；点一下就跳到正文那一处，点过的点会变色，
 *   再点一次还原颜色**并且把正文里那块高亮收掉**（高亮是留给「我现在在看哪一处」的）。
 */
import { useEffect, useMemo, useState } from 'react'
import { BookMarked, Loader2 } from 'lucide-react'
import { extractCitationsFromMarkdown, getCitationEntries, normalizeDoi } from '../services/citation'
import { resolveCiteCommand } from '../services/latex-converter'
import type { CitationEntry, JournalTemplate } from '../types'

interface CitationPanelProps {
  md: string
  templates: JournalTemplate[]
  currentTemplateId: string
  onSelectTemplate: (id: string) => void
  /**
   * 跳到正文里某条引用所在位置。
   * occurrence = 该文献在正文里第几次出现（从 0 开始）—— 与右侧点点的顺序一一对应。
   */
  onJump: (doi: string, occurrence: number) => void
  /** 取消正文里当前的高亮（点同一个点点的第二次） */
  onClearHighlight: () => void
}

/** 每个 DOI 在正文里出现的**次数**（同一篇文献可能引在多处） */
function countOccurrences(md: string): Map<string, number> {
  const map = new Map<string, number>()
  const re = /\[@(?:doi:)?([^\]]+)\]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    for (const part of m[1].split(/[;,]/)) {
      const doi = normalizeDoi(part.trim()).doi
      if (doi) map.set(doi, (map.get(doi) ?? 0) + 1)
    }
  }
  return map
}

export default function CitationPanel({
  md,
  templates,
  currentTemplateId,
  onSelectTemplate,
  onJump,
  onClearHighlight,
}: CitationPanelProps) {
  const dois = useMemo(() => extractCitationsFromMarkdown(md), [md])
  const counts = useMemo(() => countOccurrences(md), [md])

  const [entries, setEntries] = useState<Record<string, CitationEntry>>({})
  const [failed, setFailed] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  /** 当前「正在看」的那一处：`${doi}#${occurrence}`。null = 没有高亮 */
  const [active, setActive] = useState<string | null>(null)

  const key = dois.join('|')

  useEffect(() => {
    let alive = true
    if (dois.length === 0) {
      setEntries({})
      setFailed([])
      return
    }
    setLoading(true)
    getCitationEntries(dois)
      .then(({ entries: list, failed: bad }) => {
        if (!alive) return
        const map: Record<string, CitationEntry> = {}
        for (const e of list) map[e.doi] = e
        setEntries(map)
        setFailed(bad)
      })
      .catch(() => {
        if (alive) setFailed(dois)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // 正文改过之后原来的「第 N 处」可能已经不存在了，别留一个假的激活态
  useEffect(() => {
    setActive(null)
  }, [md])

  const template = templates.find((t) => t.id === currentTemplateId) ?? templates[0] ?? null
  const citeCommand = template ? resolveCiteCommand(template) : 'cite'

  /** 点一个点：没激活 → 跳过去并点亮；已激活 → 收掉高亮（不再重复跳） */
  const handleDot = (doi: string, occurrence: number) => {
    const id = `${doi}#${occurrence}`
    if (active === id) {
      setActive(null)
      onClearHighlight()
      return
    }
    setActive(id)
    onJump(doi, occurrence)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2.5 border-b border-ink-100 bg-paper-50 space-y-2">
        <div className="flex items-center gap-2">
          <BookMarked className="w-3.5 h-3.5 text-seal-600" />
          <span className="text-xs font-medium text-ink-700">引用表</span>
          <span className="ml-auto text-[0.625rem] text-ink-400">
            {dois.length} 篇{loading ? ' · 读取中…' : ''}
          </span>
        </div>

        <label className="flex items-center gap-2 text-[0.6875rem] text-ink-500">
          目标期刊
          <select
            value={currentTemplateId}
            onChange={(e) => onSelectTemplate(e.target.value)}
            className="flex-1 min-w-0 rounded border border-ink-200 bg-paper-50 px-1.5 py-1 text-[0.6875rem] text-ink-700 focus:outline-none focus:ring-1 focus:ring-seal-400"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {template && (
          <div className="rounded border border-ink-100 bg-paper-100/70 px-2 py-1.5 text-[0.625rem] text-ink-500 leading-relaxed">
            正文引用 <code className="font-mono text-ink-700">{`\\${citeCommand}{…}`}</code>
            <span className="text-ink-300"> · </span>
            参考文献样式 <code className="font-mono text-ink-700">{template.bibtex_style}</code>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {dois.length === 0 ? (
          <p className="text-center text-sm text-ink-400 py-10">正文里还没有引用</p>
        ) : (
          dois.map((doi, i) => {
            const e = entries[doi]
            const times = counts.get(doi) ?? 1
            const isFailed = failed.includes(doi)
            return (
              <div key={doi} className="flex items-stretch gap-2">
                {/* 主体：编号 + 文献信息 */}
                <div className="flex-1 min-w-0 rounded-lg border border-ink-200 bg-paper-50 p-2.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500">
                      #{i + 1}
                    </span>
                  </div>

                  {e ? (
                    <>
                      <div className="text-xs text-ink-800 leading-snug">{e.title}</div>
                      <div className="mt-1 text-[0.6875rem] text-ink-500">
                        {e.authors.slice(0, 3).join('、')}
                        {e.authors.length > 3 ? ' 等' : ''}
                        {e.year ? ` · ${e.year}` : ''}
                        {e.journal ? ` · ${e.journal}` : ''}
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-ink-400 flex items-center gap-1.5">
                      {loading && <Loader2 className="w-3 h-3 animate-spin" />}
                      {isFailed ? '元数据未取到（DOI 可能无效）' : '读取中…'}
                    </div>
                  )}

                  <div className="mt-1 font-mono text-[0.625rem] text-ink-400 truncate" title={doi}>
                    {doi}
                  </div>
                </div>

                {/*
                 * 右侧：这一列「小点点」= 引在正文的哪几处。
                 * 放在卡片的空白处、从上到下排，不占正文宽度。
                 */}
                <div
                  className="flex flex-col items-center gap-1 pt-2 pb-1 pr-0.5"
                  title={times > 1 ? `正文里引了 ${times} 处` : '正文里引了 1 处'}
                >
                  {Array.from({ length: times }, (_, k) => {
                    const on = active === `${doi}#${k}`
                    return (
                      <button
                        key={k}
                        onClick={() => handleDot(doi, k)}
                        className={`w-2 h-2 rounded-full transition ${
                          on ? 'bg-seal-600 scale-125' : 'bg-ink-300 hover:bg-seal-400'
                        }`}
                        title={on ? '再点一次取消高亮' : `跳到正文第 ${k + 1} 处引用`}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
