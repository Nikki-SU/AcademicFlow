/**
 * 按钮套件（全站按钮的唯一规范，见 UX_DETAILS.md「同类控件必须全库一致」）
 * -------------------------------------------------
 * 体检发现主按钮圆角有 5 档（rounded / md / lg / xl / full）、尺寸与边框色各写各的。
 * 收敛为 4 种语义 × 3 种尺寸，圆角一律 rounded-control，图标一律 ui-icon-sm：
 *   primary    实心印章红 —— 页面主操作（开始录音 / 选择文件 / 保存）
 *   secondary  描边中性 —— 常规次级操作（拍照 / 导出）
 *   accent     描边印章红 —— 「AI 修饰」这类带强调语义的次级操作
 *   ghost      无底纯文字/图标 —— 工具图标、关闭、刷新
 * 非 button 元素要按钮观感（如 Link）用导出的 btnClass()。
 */
import type { ReactNode } from 'react'

export type BtnVariant = 'primary' | 'secondary' | 'accent' | 'ghost'
export type BtnSize = 'sm' | 'md' | 'icon' | 'icon-sm'

const VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-seal-600 text-paper-50 hover:bg-seal-700',
  secondary: 'border border-ink-200 bg-paper-50 text-ink-700 hover:bg-paper-100',
  accent: 'border border-seal-300 text-seal-700 hover:bg-seal-50',
  ghost: 'text-ink-500 hover:bg-ink-100 hover:text-ink-700',
}

const SIZE: Record<BtnSize, string> = {
  sm: 'px-2 py-1 text-ui-2xs',
  md: 'px-ui-gap-sm py-1.5 text-ui-xs',
  icon: 'p-1.5',
  'icon-sm': 'p-1',
}

export function btnClass(variant: BtnVariant = 'secondary', size: BtnSize = 'md', extra = '') {
  return `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium transition disabled:opacity-60 [&>svg]:h-ui-icon-sm [&>svg]:w-ui-icon-sm ${VARIANT[variant]} ${SIZE[size]} ${extra}`
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: {
  variant?: BtnVariant
  size?: BtnSize
  icon?: ReactNode
  children?: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={btnClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </button>
  )
}
