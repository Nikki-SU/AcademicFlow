/**
 * 荧光笔色板（全站唯一色源）
 * -------------------------------------------------
 * 正文高亮、批注卡、紧急死线……凡是「标注」类的地方，颜色都从这里取，
 * 不再各写一套 Tailwind class（以前 Reading 与 annotationData 就是两套，
 * 一个叫 red 一个叫 pink，取了才发现对不上）。
 *
 * 每支笔四档（取值见 index.css :root 的 --hl-*，Tailwind 里是 hl-* 一组）：
 * - `dot`    笔身实色（圆点、色条等）
 * - `bg`     落纸色（正文高亮的半透明底色）
 * - `soft`   淡底（卡片整块的极浅底色）
 * - `text`   深墨（配在淡底上的文字）
 * - `bar`    左色条（批注卡那一竖）
 * - `ring`   选中描边
 *
 * 「紧急」是语义角色，就用 red 这支笔 —— 与批注的红色同一支，
 * 于是同屏里所有的红是同一个红。
 */
export type HighlighterColor = 'yellow' | 'green' | 'blue' | 'purple' | 'red'

export interface Highlighter {
  value: HighlighterColor
  label: string
  /** 正文高亮（半透明落纸色） */
  bg: string
  /** 卡片淡底 */
  soft: string
  /** 深墨文字 */
  text: string
  /** 笔身实色圆点 */
  dot: string
  /** 卡片左色条 */
  bar: string
  /** 选中描边 */
  ring: string
  /** 整块标记描边（文字找不到、退化成整段标记时用；不占布局、不与底色打架） */
  outline: string
}

export const HIGHLIGHTERS: Highlighter[] = [
  { value: 'yellow', label: '黄', bg: 'bg-hl-yellow-ink', soft: 'bg-hl-yellow-soft', text: 'text-hl-yellow-deep', dot: 'bg-hl-yellow', bar: 'border-l-hl-yellow', ring: 'ring-hl-yellow', outline: 'outline-hl-yellow' },
  { value: 'green', label: '绿', bg: 'bg-hl-green-ink', soft: 'bg-hl-green-soft', text: 'text-hl-green-deep', dot: 'bg-hl-green', bar: 'border-l-hl-green', ring: 'ring-hl-green', outline: 'outline-hl-green' },
  { value: 'blue', label: '蓝', bg: 'bg-hl-blue-ink', soft: 'bg-hl-blue-soft', text: 'text-hl-blue-deep', dot: 'bg-hl-blue', bar: 'border-l-hl-blue', ring: 'ring-hl-blue', outline: 'outline-hl-blue' },
  { value: 'purple', label: '紫', bg: 'bg-hl-purple-ink', soft: 'bg-hl-purple-soft', text: 'text-hl-purple-deep', dot: 'bg-hl-purple', bar: 'border-l-hl-purple', ring: 'ring-hl-purple', outline: 'outline-hl-purple' },
  { value: 'red', label: '红', bg: 'bg-hl-red-ink', soft: 'bg-hl-red-soft', text: 'text-hl-red-deep', dot: 'bg-hl-red', bar: 'border-l-hl-red', ring: 'ring-hl-red', outline: 'outline-hl-red' },
]

/** 取一支笔；非法 / 缺省一律回落到黄笔 */
export function highlighterOf(color: string): Highlighter {
  return HIGHLIGHTERS.find((c) => c.value === color) || HIGHLIGHTERS[0]
}

/** 一天（毫秒）；「一周以内」的判定用它 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 死线是否「急」：截止时刻在一周（168h）以内 —— 含已经过期的（更急）。
 * 这是 DDL 条目整块淡红高亮的判据。
 */
export function isDueSoon(dueAt: number, now = Date.now()): boolean {
  return dueAt > 0 && dueAt - now <= 7 * DAY_MS
}