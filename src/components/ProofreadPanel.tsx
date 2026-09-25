/**
 * 文稿校对
 * ------------------------------------------------------------
 * 定位：**人来校对，工具负责跳转与呈现**。不在这里自动改内容。
 * 三类清单（图 / 表 / 公式），点一条就跳到正文对应位置并高亮：
 *   - 图：看图和图注（alt）是否对得上、有没有画错；顺手可以把尺寸调小（填百分比）
 *   - 表：看表头 / 数据 / 对齐有没有错
 *   - 公式：行内行间全拎出来（AI 识图或手打都容易错正体斜体），
 *           可以「跳过去看」也可以「就地改这一条」
 *
 * ⚠️ 勾选状态只存在当前会话（切页/刷新就没了）。要持久化勾选需要另存一份
 *    校对进度文件 —— 目前没做，避免悄悄往私库写东西。
 */
import { useMemo, useState } from 'react'
import { Image as ImageIcon, Table2, FunctionSquare, Crosshair, Pencil, Check } from 'lucide-react'
import katex from 'katex'
import { parseImages, parseTables, parseFormulas } from '../services/formula'
import { parseImageSize, type ImageSize } from '../services/editorImages'

type Kind = 'image' | 'table' | 'formula'

interface ProofreadPanelProps {
  md: string
  /**
   * 跳到正文某一条「图/表/公式」。
   *
   * `match` 是这一条的**原文内容**（公式源码 / `![alt](src)` / 表头文字），
   * 编辑器优先按它去 DOM 里认，认不到才退回 index 顺数。
   * 为什么不只给 index：见 VditorEditor 里 collectAnchors 的注释 ——
   * IR 模式下每个块在 DOM 里是「源码视图 + 渲染视图」两份，序号法一错就整体偏移，
   * 用户点第 3 条跳到第 2 条还毫无提示。
   */
  onJump: (kind: Kind, index: number, match?: string) => void
  /** 打开公式侧栏改第 index 个公式（只改这一处，可再切全局） */
  onEditFormula: (index: number) => void
  /** 改第 index 张图的尺寸（写回正文的 title 位） */
  onResize: (index: number, size: ImageSize) => void
}

function renderKatex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex || '\\;', {
      displayMode: display,
      throwOnError: false,
      strict: false,
    })
  } catch (err) {
    return `<span style="color:#dc2626">渲染失败：${err instanceof Error ? err.message : String(err)}</span>`
  }
}

export default function ProofreadPanel({ md, onJump, onEditFormula, onResize }: ProofreadPanelProps) {
  const [kind, setKind] = useState<Kind>('image')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const images = useMemo(() => parseImages(md), [md])
  const tables = useMemo(() => parseTables(md), [md])
  const formulas = useMemo(() => parseFormulas(md), [md])

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const counts: Record<Kind, number> = {
    image: images.length,
    table: tables.length,
    formula: formulas.length,
  }

  const tabs: { key: Kind; label: string; icon: typeof ImageIcon }[] = [
    { key: 'image', label: '图片', icon: ImageIcon },
    { key: 'table', label: '表格', icon: Table2 },
    { key: 'formula', label: '公式', icon: FunctionSquare },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* tab */}
      <div className="px-3 pt-2.5 border-b border-ink-100 bg-paper-50">
        <div className="flex gap-1">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = kind === t.key
            return (
              <button
                key={t.key}
                onClick={() => setKind(t.key)}
                className={`px-2.5 py-1.5 text-xs rounded-lg transition flex items-center gap-1.5 ${
                  active ? 'bg-seal-100 text-seal-700 font-medium' : 'text-ink-500 hover:bg-ink-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                <span className={`text-[0.625rem] ${active ? 'text-seal-500' : 'text-ink-400'}`}>
                  {counts[t.key]}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-[0.6875rem] text-ink-400 py-1.5 leading-snug">
          点条目跳到正文对应位置；勾选只记在当前会话。图片尺寸填百分比（如 60%）或 auto，改完即时生效。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* ── 图片 ── */}
        {kind === 'image' &&
          (images.length === 0 ? (
            <Empty text="正文里还没有图片" />
          ) : (
            images.map((img) => {
              const key = `image:${img.index}`
              return (
                <Row
                  key={key}
                  done={checked.has(key)}
                  onToggle={() => toggle(key)}
                  index={img.index}
                  badge="图"
                  onJump={() => onJump('image', img.index, `![${img.alt}](${img.src})`)}
                >
                  <img
                    src={img.src}
                    alt={img.alt}
                    className="max-h-32 w-auto max-w-full rounded border border-ink-200 bg-paper-50 object-contain"
                  />
                  <div className="mt-1.5 text-xs text-ink-600">
                    <span className="text-ink-400">图注：</span>
                    {img.alt || <span className="text-amber-600">（空 —— 图注缺了？）</span>}
                  </div>
                  <ImageSizeControl
                    size={parseImageSize(img.title) ?? {}}
                    onChange={(s) => onResize(img.index, s)}
                  />
                </Row>
              )
            })
          ))}

        {/* ── 表格 ── */}
        {kind === 'table' &&
          (tables.length === 0 ? (
            <Empty text="正文里还没有表格" />
          ) : (
            tables.map((t) => {
              const key = `table:${t.index}`
              return (
                <Row
                  key={key}
                  done={checked.has(key)}
                  onToggle={() => toggle(key)}
                  index={t.index}
                  badge="表"
                  onJump={() => onJump('table', t.index, t.rows[0]?.join(' ') ?? '')}
                >
                  <div className="overflow-x-auto rounded border border-ink-200">
                    <table className="text-[0.6875rem] border-collapse">
                      <tbody>
                        {t.rows.map((row, ri) => (
                          <tr key={ri} className={ri === 0 ? 'bg-paper-100 font-medium' : ''}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="border border-ink-200 px-2 py-1 text-ink-700 whitespace-nowrap">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-1 text-[0.6875rem] text-ink-400">
                    {t.rows.length - 1} 行数据 · 原文第 {t.startLine + 1}–{t.endLine + 1} 行
                  </div>
                </Row>
              )
            })
          ))}

        {/* ── 公式 ── */}
        {kind === 'formula' &&
          (formulas.length === 0 ? (
            <Empty text="正文里还没有公式" />
          ) : (
            formulas.map((f, index) => {
              const key = `formula:${index}`
              return (
                <Row
                  key={key}
                  done={checked.has(key)}
                  onToggle={() => toggle(key)}
                  index={index}
                  badge={f.kind === 'block' ? '行间' : '行内'}
                  onJump={() => onJump('formula', index, f.tex)}
                  onEdit={() => onEditFormula(index)}
                >
                  <div
                    className="overflow-x-auto py-1 text-center"
                    dangerouslySetInnerHTML={{ __html: renderKatex(f.tex, f.kind === 'block') }}
                  />
                  <div className="font-mono text-[0.625rem] text-ink-400 mt-1 break-all" title={f.tex}>
                    {f.tex}
                  </div>
                </Row>
              )
            })
          ))}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="text-center text-sm text-ink-400 py-10">{text}</p>
}

/**
 * 图片尺寸：宽 / 高各一栏，外加几个常用档位。
 * 留空 = 交给正文流（按原图大小）；填百分比就是它在正文宽度里占多少，
 * 导出 LaTeX 时同一个百分比映射到 \textwidth，两边看到的大小一致。
 */
function ImageSizeControl({
  size,
  onChange,
}: {
  size: ImageSize
  onChange: (s: ImageSize) => void
}) {
  const set = (patch: Partial<ImageSize>) => {
    const next: ImageSize = { ...size, ...patch }
    if (!next.width?.trim()) delete next.width
    if (!next.height?.trim()) delete next.height
    onChange(next)
  }

  const inputCls =
    'w-16 rounded border border-ink-200 bg-paper-50 px-1.5 py-0.5 text-[0.6875rem] text-ink-700 ' +
    'focus:outline-none focus:ring-1 focus:ring-seal-400'

  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      <span className="text-[0.625rem] text-ink-400">尺寸</span>
      <input
        value={size.width ?? ''}
        onChange={(e) => set({ width: e.target.value })}
        placeholder="宽 auto"
        className={inputCls}
      />
      <span className="text-[0.625rem] text-ink-300">×</span>
      <input
        value={size.height ?? ''}
        onChange={(e) => set({ height: e.target.value })}
        placeholder="高 auto"
        className={inputCls}
      />
      {['100%', '75%', '50%', '25%'].map((p) => (
        <button
          key={p}
          onClick={() => set({ width: p })}
          className={`rounded px-1.5 py-0.5 text-[0.625rem] transition ${
            size.width === p ? 'bg-seal-100 text-seal-700' : 'text-ink-400 hover:bg-ink-100'
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  )
}

function Row({
  done,
  onToggle,
  index,
  badge,
  onJump,
  onEdit,
  children,
}: {
  done: boolean
  onToggle: () => void
  index: number
  badge: string
  onJump: () => void
  onEdit?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className={`p-2.5 rounded-lg border transition ${
        done ? 'border-emerald-200 bg-emerald-50/40' : 'border-ink-200 bg-paper-50'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <button
          onClick={onToggle}
          className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition ${
            done ? 'bg-emerald-500 border-emerald-500' : 'border-ink-300 hover:border-seal-400'
          }`}
          title="标记已核对"
        >
          {done && <Check className="w-3 h-3 text-paper-50" />}
        </button>
        <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500">
          #{index + 1} · {badge}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onJump}
            className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
            title="跳到正文这一处"
          >
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          {onEdit && (
            <button
              onClick={onEdit}
              className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
              title="就地改这一条"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}
