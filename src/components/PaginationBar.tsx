import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * 工作台列表统一每页条数。
 * 全站列表（文献 / 图书 / 期刊模板 / 其他文档 / 单词列表）都用它，
 * 避免各页各写一个数、浏览口径走样（见 UX_DETAILS「翻页优先于滚动」）。
 */
export const PAGE_SIZE = 10

/**
 * 列表通用翻页条 —— 全站共用同一套口径。
 * 排版对齐、常驻可见；工作台里靠翻页而不是上下滚动来浏览列表（见 UX_DETAILS）。
 * 只有 totalPages > 0 才渲染。
 */
export function PaginationBar({
  total,
  page,
  totalPages,
  onPage,
}: {
  total: number
  page: number
  totalPages: number
  onPage: (p: number) => void
}) {
  if (totalPages <= 0) return null
  return (
    <div className="af-line-t flex items-center justify-between px-ui-gap py-3 bg-paper-100/50">
      <div className="text-ui-sm text-ink-500">
        共 {total} 条，第 {page} / {totalPages} 页
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
          className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-control-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            onClick={() => onPage(p)}
            className={`w-8 h-8 text-ui-sm rounded-control-sm transition ${
              page === p ? 'bg-seal-600 text-paper-50' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-700'
            }`}
          >
            {p}
          </button>
        ))}
        <button
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-control-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
