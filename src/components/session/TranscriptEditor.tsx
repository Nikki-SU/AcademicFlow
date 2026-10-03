/**
 * 转写稿块编辑器
 * -------------------------------------------------
 * 用户要求：最终转写稿要「以一段为一块」——
 *   · 整块拖拽换位（上/下挪）
 *   · 整块删除
 *   · 块内自由修改文字（原文 / 译文各自可改）
 *   · 相邻块可「接在一起」（合并）
 *   · 识别质量极差、无法判断原意的段落 → 标红 + 原样保留
 * 英文段与中文段像阅读页的英汉对照一样逐段对应（源段一块、译文一块）。
 */
import { useRef, useState } from 'react'
import { ChevronUp, GripVertical, Plus, Trash2, AlertTriangle, Check } from 'lucide-react'
import type { TranscriptBlock } from '../../services/asr'

/** 自适应高度的 textarea：内容多少行就多高（块内自由改，不出现内滚动条） */
function AutoTextarea({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  className: string
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      rows={1}
      onChange={(e) => {
        onChange(e.target.value)
        resize()
      }}
      onFocus={resize}
      className={`w-full resize-none bg-transparent focus:outline-none ${className}`}
    />
  )
}

export default function TranscriptEditor({
  blocks,
  onChange,
}: {
  blocks: TranscriptBlock[]
  onChange: (blocks: TranscriptBlock[]) => void
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  // 整篇是否双语：有任一段带译文，就为每段都留出译文位（英汉逐段对照）
  const bilingual = blocks.some((b) => b.translation.trim() !== '')

  const patch = (i: number, p: Partial<TranscriptBlock>) => {
    onChange(blocks.map((b, k) => (k === i ? { ...b, ...p } : b)))
  }

  const remove = (i: number) => {
    onChange(blocks.filter((_, k) => k !== i))
  }

  /** 把第 i 段接进上一段（文字用空行相接，译文同理） */
  const mergeUp = (i: number) => {
    if (i <= 0) return
    const prev = blocks[i - 1]
    const cur = blocks[i]
    const joined = {
      text: `${prev.text}\n\n${cur.text}`.trim(),
      translation: [prev.translation, cur.translation].filter((t) => t.trim()).join('\n\n'),
      // 只要有一段存疑，合并后仍标存疑（不把存疑悄悄洗掉）
      unclear: prev.unclear || cur.unclear,
    }
    onChange([...blocks.slice(0, i - 1), joined, ...blocks.slice(i + 1)])
  }

  const insertAfter = (i: number) => {
    const blank: TranscriptBlock = { text: '', translation: '', unclear: false }
    onChange([...blocks.slice(0, i + 1), blank, ...blocks.slice(i + 1)])
  }

  /** 拖到第 i 段处：把拖起的那段挪到该位置（拖动期间实时换位） */
  const dragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === i) return
    const next = blocks.slice()
    const [moved] = next.splice(dragIdx, 1)
    next.splice(i, 0, moved)
    setDragIdx(i)
    onChange(next)
  }

  if (blocks.length === 0) {
    return (
      <p className="py-10 text-center text-ui-sm text-ink-400">
        还没有段落。点「AI 修饰」把转写整理成分段稿，或点下面「＋」手动加一段。
      </p>
    )
  }

  return (
    <div className="space-y-ui-gap-sm">
      {blocks.map((b, i) => (
        <div
          key={i}
          onDragOver={(e) => dragOver(e, i)}
          onDrop={() => setDragIdx(null)}
          className={`group rounded-control border px-ui-gap py-ui-gap transition ${
            dragIdx === i ? 'opacity-50' : ''
          } ${
            b.unclear
              ? 'border-red-300 bg-red-50/60'
              : 'border-ink-200 bg-paper-100 hover:border-ink-300'
          }`}
        >
          <div className="mb-1 flex items-center gap-ui-gap-sm">
            <span
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragEnd={() => setDragIdx(null)}
              title="按住拖拽整段换位"
              className="cursor-grab text-ink-300 transition hover:text-ink-500 active:cursor-grabbing"
            >
              <GripVertical className="h-ui-icon-sm w-ui-icon-sm" />
            </span>
            <span className="text-ui-2xs font-mono text-ink-400">#{i + 1}</span>
            {b.unclear && (
              <span className="inline-flex items-center gap-1 rounded-control-sm bg-red-100 px-1.5 py-0.5 text-ui-2xs font-medium text-red-600">
                <AlertTriangle className="h-3 w-3" />
                识别存疑 · 原样保留
              </span>
            )}
            <div className="ml-auto flex items-center gap-ui-gap-sm opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              {b.unclear && (
                <button
                  type="button"
                  onClick={() => patch(i, { unclear: false })}
                  title="已确认 / 修正，取消存疑标记"
                  className="rounded-control-sm p-0.5 text-ink-400 transition hover:text-emerald-600"
                >
                  <Check className="h-ui-icon-sm w-ui-icon-sm" />
                </button>
              )}
              <button
                type="button"
                onClick={() => mergeUp(i)}
                disabled={i === 0}
                title="接进上一段"
                className="rounded-control-sm p-0.5 text-ink-400 transition hover:text-seal-600 disabled:opacity-30"
              >
                <ChevronUp className="h-ui-icon-sm w-ui-icon-sm" />
              </button>
              <button
                type="button"
                onClick={() => insertAfter(i)}
                title="在下方插入一段"
                className="rounded-control-sm p-0.5 text-ink-400 transition hover:text-seal-600"
              >
                <Plus className="h-ui-icon-sm w-ui-icon-sm" />
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                title="删除这一段"
                className="rounded-control-sm p-0.5 text-ink-400 transition hover:text-red-600"
              >
                <Trash2 className="h-ui-icon-sm w-ui-icon-sm" />
              </button>
            </div>
          </div>

          {/* 原文一段 */}
          <AutoTextarea
            value={b.text}
            onChange={(v) => patch(i, { text: v })}
            placeholder="（空段，可输入内容）"
            className={`text-ui-sm leading-relaxed ${
              b.unclear ? 'text-red-700' : 'text-ink-800'
            }`}
          />

          {/* 译文一段：与原文逐段对应，独立成块 */}
          {(bilingual || b.translation.trim() !== '') && (
            <div className="mt-1.5 border-l-2 border-seal-300 pl-ui-gap">
              <AutoTextarea
                value={b.translation}
                onChange={(v) => patch(i, { translation: v })}
                placeholder="译文（可选）"
                className="text-ui-sm leading-relaxed text-ink-600"
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}