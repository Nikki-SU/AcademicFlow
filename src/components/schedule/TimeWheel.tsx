/**
 * 时间滚轮（时 / 分两列）——「加课 / 加定时任务 / 编辑时段 / 任务时间」共用
 * -------------------------------------------------
 * 两列都是**闭环**的（用户明确要求「条的头尾必须衔接」，不许出现断口造成误解）：
 * - 小时 0…23 首尾相接：23 再往下滚直接回到 00，00 往上滚回到 23；
 * - 分钟只取 5 的倍数（00/05/…/55）：55 再往下滚回到 00，00 往上滚回到 55。
 * 于是「55 与 00」永远相邻、不会出现断开的一格，也就不会有「到底到没到点」的视觉误解。
 * 另外满足「5 分钟一格」：分钟列压根不存在非 5 倍数，没有人做计划会设非整数时间。
 * 交互：滚轮 / 拖动 / 点选，松手吸附到最近一格；多个格子连起来即是闭环的条。
 */
import { useEffect, useRef, useState } from 'react'

/** 可见格数（中间那格为选中）。一格高度 = 容器最高 / 此值（容器高走流体变量 --ui-axis，
 *  随视口等比伸缩，代码里不写死 px；几何计算只用测出来的实际像素）。 */
const VISIBLE = 5

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

interface Option {
  value: number
  label: string
}

const HOURS: Option[] = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: String(i).padStart(2, '0'),
}))
const MINUTES: Option[] = Array.from({ length: 12 }, (_, i) => ({
  value: i * 5,
  label: String(i * 5).padStart(2, '0'),
}))

/** `HH:MM` → { h, m }；缺省 / 非法值回落到 08:00（分钟按 5 取整） */
function parseTime(v: string): { h: number; m: number } {
  const mm = /^(\d{1,2}):(\d{2})/.exec(v || '')
  if (!mm) return { h: 8, m: 0 }
  return { h: mod(parseInt(mm[1], 10), 24), m: mod(Math.round(parseInt(mm[2], 10) / 5) * 5, 60) }
}

/** 单列滚轮：闭环、吸附、可拖可滚可点 */
function Wheel({
  options,
  index,
  onIndex,
  ariaLabel,
}: {
  options: Option[]
  index: number
  onIndex: (i: number) => void
  ariaLabel: string
}) {
  const n = options.length
  const [pos, setPos] = useState(index)
  const posRef = useRef(pos)
  posRef.current = pos
  const dragRef = useRef<{ startY: number; startPos: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 一格实际高度（px）：量容器实际高度得到，随视口等比伸缩，不在代码里写死 */
  const [itemH, setItemH] = useState(32)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => {
      const h = el.clientHeight / VISIBLE
      if (Number.isFinite(h) && h > 0) setItemH(h)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 外部值变化（含初始同步）时对齐到最近的一圈代表位
  useEffect(() => {
    setPos((p) => (mod(Math.round(p), n) === mod(index, n) ? p : index))
  }, [index, n])

  const commit = (p: number) => {
    if (!Number.isFinite(p)) return
    const snapped = Math.round(p)
    posRef.current = snapped
    setPos(snapped)
    onIndex(mod(snapped, n))
  }

  // 拖动 / 滚轮中：立刻写回 posRef，避免连续事件基于旧值累积（否则一次拖动只算一格）
  const applyPos = (p: number) => {
    posRef.current = p
    setPos(p)
  }

  // 滚轮：原生监听才能 preventDefault（React 的 onWheel 多为 passive）
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!Number.isFinite(itemH) || itemH <= 0) return
      commit(posRef.current + e.deltaY / itemH)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, itemH])

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startPos: posRef.current, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (!Number.isFinite(itemH) || itemH <= 0) return
    const dy = e.clientY - d.startY
    if (Math.abs(dy) > itemH / 8) d.moved = true
    applyPos(d.startPos - dy / itemH)
  }
  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) {
      suppressClick.current = true
      commit(posRef.current)
    }
  }

  // pos 正常只可能是有限数（commit / 拖动 / 测量都已守卫）；这里再兜一层，
  // 万一非有限就用 index 回退，避免 for 循环因 Infinity 死循环、或 options[NaN] 取空崩溃
  const safePos = Number.isFinite(pos) ? pos : index
  const from = Math.floor(safePos) - VISIBLE
  const to = Math.ceil(safePos) + VISIBLE
  const cells: number[] = []
  for (let i = from; i <= to; i++) cells.push(i)

  return (
    <div
      ref={rootRef}
      role="listbox"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="relative min-w-ui-axis flex-1 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing h-[calc(var(--ui-axis)*5)]"
    >
      {/* 选中高亮带 */}
      <div
        className="pointer-events-none absolute inset-x-ui-gap-sm z-0 rounded-control bg-seal-50 ring-1 ring-seal-200"
        style={{ top: '50%', height: itemH, transform: 'translateY(-50%)' }}
      />
      {cells.map((i) => {
        const d = i - safePos
        if (Math.abs(d) > VISIBLE) return null
        const opt = options[mod(i, n)]
        if (!opt) return null
        const selected = mod(Math.round(safePos), n) === mod(i, n)
        return (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              commit(i)
            }}
            className={`absolute inset-x-0 z-10 flex items-center justify-center font-mono text-ui-sm tabular-nums transition-opacity ${
              selected ? 'font-semibold text-seal-700' : 'text-ink-500'
            }`}
            style={{
              top: '50%',
              height: itemH,
              transform: `translateY(calc(${d * itemH}px - 50%))`,
              opacity: Math.max(0.25, 1 - Math.abs(d) * 0.28),
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 日期 + 时分滚轮：值以 `YYYY-MM-DDTHH:MM`（datetime-local 同格式）进出，空串 = 未设。
 * -------------------------------------------------
 * 与「时段」共用同一个 TimeWheel —— 凡是「要选到具体几点」的地方都用这一套，
 * 不允许再出现原生 time / datetime-local 的第二种时间控件（否则又是各写一份）。
 * 日期用原生 date 选择器（只选到天，没有原生时间 spinner），时间交给滚轮。
 */
export function DateTimeField({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const datePart = value ? value.slice(0, 10) : ''
  const timePart = value.length >= 16 ? value.slice(11, 16) : '08:00'

  // 没选日期就是「未设」；选了日期才拼出完整值
  const emit = (date: string, time: string) => onChange(date ? `${date}T${time}` : '')

  return (
    <div className="grid grid-cols-3 items-center gap-ui-gap-sm">
      <input
        type="date"
        value={datePart}
        onChange={(e) => emit(e.target.value, timePart)}
        className="col-span-2 min-w-0 rounded-control border border-ink-300 px-ui-gap py-ui-gap-sm text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
      />
      {/* 宽度按 2:1 分配：日期占 2/3、时间占 1/3（不让日期独吞整行、时间被挤窄）。
          滚轮是 flex 子项、内部格子又绝对定位（无固有宽度），必须由外层给定宽度。 */}
      <div className="col-span-1 min-w-0">
        {/*
          只转时分滚轮、还没选日期时：默认落到「今天」，别把用户刚拨的时分丢掉。
          （原先这里 emit('', t) 会把整个值变成 ''，于是「我只给了个时间」提交时是空的 —— 用户踩过。）
          只有日期框被清空时才允许回到「未设」。
        */}
        <TimeWheel
          value={timePart}
          onChange={(t) => onChange(`${datePart || todayStr()}T${t}`)}
        />
      </div>
    </div>
  )
}

/** 本地时区的今天，YYYY-MM-DD */
function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 时分滚轮组合：值以 `HH:MM` 进出 */
export function TimeWheel({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { h, m } = parseTime(value)
  const hourIndex = h
  const minuteIndex = m / 5

  // 值为空 / 非法时，把回落值（08:00）同步回父级，保证提交时不是空的
  useEffect(() => {
    const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    if (formatted !== value) onChange(formatted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex items-center gap-ui-gap-sm rounded-control border border-ink-300 bg-paper-50 px-ui-gap-sm py-ui-gap-sm">
      <Wheel
        options={HOURS}
        index={hourIndex}
        ariaLabel="小时"
        onIndex={(i) => onChange(`${String(HOURS[i].value).padStart(2, '0')}:${String(m).padStart(2, '0')}`)}
      />
      <span className="font-mono text-ui-sm text-ink-400">:</span>
      <Wheel
        options={MINUTES}
        index={minuteIndex}
        ariaLabel="分钟"
        onIndex={(i) =>
          onChange(`${String(h).padStart(2, '0')}:${String(MINUTES[i].value).padStart(2, '0')}`)
        }
      />
    </div>
  )
}