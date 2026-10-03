/**
 * 面板套件（全站多栏页的唯一外壳，见 UX_DETAILS.md「同类控件必须全库一致」）
 * -------------------------------------------------
 * 以前每个多栏页各写一套 `<section className="... rounded-xl border ... px-3 py-2">`，
 * 结果：圆角不一、页头高度不一、内边距不一 —— 三栏横线永远对不齐。
 * 这里收敛成四个件：
 *   Panel        外壳（圆角 / 边框 / 底色）
 *   PanelHeader  页头（**固定高度 --ui-header**，图标 + 标题 + 元信息 + 右侧动作）
 *   PanelBody    内容区（唯一内边距 / 唯一滚动容器）
 *   EmptyState   空状态（图标 + 标题 + 提示，形态全站统一）
 * 页签、工具条一律放到 PanelBody 之上另起一行，**不塞进页头**，页头就不会被撑高。
 */
import type { ReactNode } from 'react'

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50 ${className}`}
    >
      {children}
    </section>
  )
}

export function PanelHeader({
  icon,
  title,
  meta,
  actions,
  className = '',
}: {
  icon: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex h-ui-header shrink-0 items-center gap-ui-gap-sm border-b border-ink-100 px-ui-gap ${className}`}
    >
      <span className="flex shrink-0 items-center text-seal-600 [&>svg]:h-ui-icon [&>svg]:w-ui-icon">
        {icon}
      </span>
      <h2 className="shrink-0 text-ui-sm font-semibold text-ink-800">{title}</h2>
      {meta != null && <span className="min-w-0 truncate text-ui-2xs text-ink-400">{meta}</span>}
      {actions != null && (
        <div className="ml-auto flex shrink-0 items-center gap-ui-gap-sm">{actions}</div>
      )}
    </div>
  )
}

export function PanelBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`min-h-0 flex-1 overflow-y-auto p-ui-gap ${className}`}>{children}</div>
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: ReactNode
  title: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-ui-gap py-ui-gap-lg text-center">
      <span className="text-ink-300 [&>svg]:h-6 [&>svg]:w-6">{icon}</span>
      <p className="mt-ui-gap-sm text-ui-sm text-ink-400">{title}</p>
      {hint != null && <p className="mt-1 max-w-[24rem] text-ui-2xs text-ink-400">{hint}</p>}
    </div>
  )
}
