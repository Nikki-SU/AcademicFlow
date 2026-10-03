/**
 * 页签套件（全站只允许这两种形态，见 UX_DETAILS.md「同类控件必须全库一致」）
 * -------------------------------------------------
 * 体检发现全站有 **7 种页签皮肤**（灰底段控件大/小、白底盒、下划线、圆角顶 A/B、
 * 内联胶囊、顶部导航），同一种「切换视图」到处长得不一样。收敛为两种：
 *   SegmentedTabs  灰底段控件 —— 用于「页内视图模式切换」（躲在页头右侧或内容上方一行）
 *   UnderlineTabs  下划线页签 —— 用于「内容分区切换」（贴在面板内容顶部，自带分隔线）
 * 选中态一律 seal 色；圆角一律取 control / control-sm。新增切换一律从这两种里选，不得再发明。
 */
import type { ReactNode } from 'react'

export type TabItem<T extends string> = { id: T; label: ReactNode; icon?: ReactNode }

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  className = '',
}: {
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
}) {
  return (
    <div className={`flex shrink-0 gap-0.5 rounded-control bg-ink-100 p-0.5 ${className}`}>
      {items.map((it) => {
        const active = it.id === value
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={`flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-control-sm px-ui-gap-sm py-0.5 text-ui-2xs font-medium transition ${
              active ? 'bg-paper-50 text-seal-600 shadow-sm' : 'text-ink-500 hover:text-ink-700'
            }`}
          >
            {it.icon}
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

export function UnderlineTabs<T extends string>({
  items,
  value,
  onChange,
  trailing,
  className = '',
}: {
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** 行尾附加的操作（如刷新），与页签同处一条基线，不另起一行、不撑高页头 */
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex shrink-0 items-stretch border-b border-ink-200 ${className}`}>
      {items.map((it) => {
        const active = it.id === value
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={`flex flex-1 items-center justify-center gap-1 whitespace-nowrap border-b-2 px-ui-gap-sm py-ui-gap-sm text-ui-xs font-medium transition ${
              active
                ? 'border-seal-600 text-seal-600'
                : 'border-transparent text-ink-500 hover:text-ink-700'
            }`}
          >
            {it.icon}
            {it.label}
          </button>
        )
      })}
      {trailing != null && (
        <div className="flex shrink-0 items-center border-b-2 border-transparent pr-ui-gap-sm">
          {trailing}
        </div>
      )}
    </div>
  )
}
