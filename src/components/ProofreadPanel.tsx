/**
 * 文稿校对
 * ------------------------------------------------------------
 * 定位：**人来校对，工具负责跳转与呈现**。不在这里自动改内容。
 * 三类清单（图 / 表 / 公式），点一条就跳到正文对应位置并高亮：
 *   - 图：看图和图注（alt）是否对得上、有没有画错
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

export default function ProofreadPanel({ md, onJump, onEditFormula }: ProofreadPanelProps) {
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
      <div className="px-3 pt-2.5 border-b border-slate-100 bg-white">
        <div className="flex gap-1">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = kind === t.key
            return (
              <button
                key={t.key}
                onClick={() => setKind(t.key)}
                className={`px-2.5 py-1.5 text-xs rounded-lg transition flex items-center gap-1.5 ${
                  active ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                <span className={`text-[0.625rem] ${active ? 'text-indigo-500' : 'text-slate-400'}`}>
                  {counts[t.key]}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-[0.6875rem] text-slate-400 py-1.5 leading-snug">
          点条目跳到正文对应位置；勾选只记在当前会话。
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
                    className="max-h-32 w-auto max-w-full rounded border border-slate-200 bg-white object-contain"
                  />
                  <div className="mt-1.5 text-xs text-slate-600">
                    <span className="text-slate-400">图注：</span>
                    {img.alt || <span className="text-amber-600">（空 —— 图注缺了？）</span>}
                  </div>
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
                  <div className="overflow-x-auto rounded border border-slate-200">
                    <table className="text-[0.6875rem] border-collapse">
                      <tbody>
                        {t.rows.map((row, ri) => (
                          <tr key={ri} className={ri === 0 ? 'bg-slate-50 font-medium' : ''}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="border border-slate-200 px-2 py-1 text-slate-700 whitespace-nowrap">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-1 text-[0.6875rem] text-slate-400">
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
                  <div className="font-mono text-[0.625rem] text-slate-400 mt-1 break-all" title={f.tex}>
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
  return <p className="text-center text-sm text-slate-400 py-10">{text}</p>
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
        done ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <button
          onClick={onToggle}
          className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition ${
            done ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 hover:border-indigo-400'
          }`}
          title="标记已核对"
        >
          {done && <Check className="w-3 h-3 text-white" />}
        </button>
        <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
          #{index + 1} · {badge}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onJump}
            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
            title="跳到正文这一处"
          >
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          {onEdit && (
            <button
              onClick={onEdit}
              className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
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
