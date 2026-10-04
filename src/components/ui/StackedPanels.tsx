/**
 * 堆叠面板的可拖拽分段套件（写作页 / 阅读页左栏共用）
 * -------------------------------------------------
 * 左栏里几个功能块（项目导航 / 文献检索 / 大纲…）以前是**贴在一起、只靠一条横线分隔**，
 * 看起来像一整块。这里改成：**每块各自一个圆角矩形卡片**，块与块之间一个可上下拖动的
 * 手柄 —— 拖动改变相邻两块的高度占比，几块加起来始终占满整列；每块内部各自滚动。
 *
 * 用法：
 *   const stack = usePanelStack(3, [0.4, 0.3, 0.3])
 *   <div ref={stack.containerRef} className="flex h-full min-h-0 flex-col">
 *     <div style={stack.flex(0, expandedA)} className="flex min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">…</div>
 *     <StackHandle enabled={expandedA && expandedB} onPointerDown={stack.onHandleDown(0)} />
 *     <div style={stack.flex(1, expandedB)} …>…</div>
 *     <StackHandle enabled={expandedB && expandedC} onPointerDown={stack.onHandleDown(1)} />
 *     <div style={stack.flex(2, expandedC)} …>…</div>
 *   </div>
 *
 * 收起（未展开）的面板传 `flex(i, false)` → `flex:none`，只占自己的标题行高。
 */
import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { getPanelWeights, setPanelWeights } from '../../services/uiState'

/** 相邻两块之间手柄的拖动上限：任一块最小不低于总高的 10% */
const MIN_RATIO = 0.1

/**
 * 相邻两块松手吸附的五档比例 a:b = 3:1 / 2:1 / 1:1 / 1:2 / 1:3
 * —— 左栏内部模块（如「搜索/列表 与 大纲」「项目导航 与 文献检索 与 大纲」）之间用这套。
 */
export const STACK_SNAP_RATIOS = [3, 2, 1, 1 / 2, 1 / 3]

/** 把第 i / i+1 两块按比例吸附到最近一档，两块合计高度不变 */
function snapPair(w: number[], i: number, ratios: number[]): number[] {
  const pair = w[i] + w[i + 1]
  const cur = w[i] / pair
  let best = ratios[0]
  for (const cand of ratios) {
    const rc = cand / (1 + cand)
    const rb = best / (1 + best)
    if (Math.abs(rc - cur) < Math.abs(rb - cur)) best = cand
  }
  const a = pair * (best / (1 + best))
  const next = [...w]
  next[i] = a
  next[i + 1] = pair - a
  return next
}

export function usePanelStack(
  count: number,
  initial?: number[],
  options?: { snapRatios?: number[]; persistKey?: string },
) {
  const snapRatios = options?.snapRatios
  const persistKey = options?.persistKey
  const containerRef = useRef<HTMLDivElement>(null)
  const [weights, setWeights] = useState<number[]>(() => {
    // 有记住的堆叠占比（且块数与当前一致）就回到那一档，否则用默认
    if (persistKey) {
      const saved = getPanelWeights(persistKey)
      if (saved && saved.length === count) return saved
    }
    return initial ?? Array.from({ length: count }, () => 1 / count)
  })
  // 拖动过程中持续更新，供松手时读取「当前」占比来吸附
  const weightsRef = useRef(weights)
  weightsRef.current = weights
  const dragRef = useRef<{
    index: number
    startY: number
    base: number[]
    height: number
  } | null>(null)

  /** 给第 i 与第 i+1 块之间的手柄绑定；拖动时在两者之间转移高度占比 */
  const onHandleDown = useCallback(
    (index: number) => (e: ReactPointerEvent) => {
      const el = containerRef.current
      if (!el) return
      e.preventDefault()
      dragRef.current = {
        index,
        startY: e.clientY,
        base: [...weights],
        height: el.clientHeight || 1,
      }
      const total = weights.reduce((s, v) => s + v, 0)
      const min = total * MIN_RATIO

      const move = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d) return
        const delta = ((ev.clientY - d.startY) / d.height) * total
        const pair = d.base[d.index] + d.base[d.index + 1]
        const a = Math.max(min, Math.min(pair - min, d.base[d.index] + delta))
        const next = [...d.base]
        next[d.index] = a
        next[d.index + 1] = pair - a
        setWeights(next)
      }
      const up = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        // 松手吸附到最近一档；拖动过程中的中间值不停留，也不落盘
        const cur = weightsRef.current
        const next =
          snapRatios && snapRatios.length ? snapPair(cur, index, snapRatios) : cur
        if (next !== cur) setWeights(next)
        if (persistKey) setPanelWeights(persistKey, next)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [weights, snapRatios, persistKey],
  )

  /** 展开时按占比分配高度；收起时只占内容高（标题行） */
  const flex = useCallback(
    (index: number, expanded: boolean): CSSProperties =>
      expanded
        ? { flexGrow: weights[index] ?? 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }
        : { flex: 'none' },
    [weights],
  )

  return { containerRef, weights, onHandleDown, flex }
}

/** 相邻面板之间的拖拽手柄 —— 同时充当两块之间的间距 */
export function StackHandle({
  enabled,
  onPointerDown,
}: {
  enabled: boolean
  onPointerDown: (e: ReactPointerEvent) => void
}) {
  return (
    <div
      onPointerDown={enabled ? onPointerDown : undefined}
      className={`group flex h-3 shrink-0 touch-none items-center justify-center ${
        enabled ? 'cursor-row-resize' : ''
      }`}
    >
      <div
        className={`h-1 w-10 rounded-full transition-colors ${
          enabled ? 'bg-ink-200 group-hover:bg-seal-400' : 'bg-transparent'
        }`}
      />
    </div>
  )
}
