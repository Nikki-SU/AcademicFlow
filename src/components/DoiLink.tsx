/**
 * DOI 统一链接组件
 * -------------------------------------------------
 * 依据 TECH_SPEC.md §1.2 / §5.2 / §5.6：
 * - 存储层归一化为纯 DOI（10.xxx/xxx）
 * - 展示层统一渲染为可点击的完整 DOI 链接 https://doi.org/{doi}
 * - 表格列头文案统一叫"DOI 链接"
 */
import { ExternalLink } from 'lucide-react'
import { normalizeDoi } from '../services/citation'

interface DoiLinkProps {
  /** 纯 DOI 或 DOI 链接均可；组件内部会先归一化 */
  doi: string | null | undefined
  /** 链接文本模式：full=https://doi.org/... short=doi.org/... label=只显示"DOI 链接" */
  mode?: 'full' | 'short' | 'label'
  /** 是否显示外部链接图标 */
  showIcon?: boolean
  className?: string
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void
}

export function DoiLink({
  doi,
  mode = 'full',
  showIcon = false,
  className = '',
  onClick,
}: DoiLinkProps) {
  if (!doi || !doi.trim()) return <span className="text-slate-400">—</span>

  const normalized = normalizeDoi(doi)
  if (!normalized.valid || !normalized.doi) {
    return <span className="text-slate-400" title={doi}>—</span>
  }

  const href = `https://doi.org/${normalized.doi}`
  let text: string
  switch (mode) {
    case 'short':
      text = `doi.org/${normalized.doi}`
      break
    case 'label':
      text = 'DOI 链接'
      break
    case 'full':
    default:
      text = href
      break
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-indigo-600 hover:text-indigo-800 hover:underline ${className}`}
      onClick={onClick}
      title={href}
    >
      {text}
      {showIcon && <ExternalLink className="inline w-3 h-3 ml-0.5 align-text-bottom" />}
    </a>
  )
}
