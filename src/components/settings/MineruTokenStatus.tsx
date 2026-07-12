/**
 * MinerU Token 状态徽章（M3.7 子组件）
 * -------------------------------------------------
 * 解析 JWT payload 后按 severity 展示：
 *   fresh(≥7天) / warn(2-6天) / danger(<2天) / expired / invalid
 */
import { AlertCircle, CheckCircle2, ShieldAlert } from 'lucide-react'
import type { MineruJwtInfo } from '../../types'
import type { MineruJwtSeverity } from '../../services/mineru'

const SEVERITY_STYLE: Record<
  MineruJwtSeverity,
  { badge: string; icon: JSX.Element; label: string }
> = {
  fresh: {
    badge: 'bg-green-50 border-green-300 text-green-800',
    icon: <CheckCircle2 className="w-4 h-4 text-green-600" />,
    label: '有效',
  },
  warn: {
    badge: 'bg-orange-50 border-orange-300 text-orange-800',
    icon: <AlertCircle className="w-4 h-4 text-orange-600" />,
    label: '即将过期',
  },
  danger: {
    badge: 'bg-red-50 border-red-300 text-red-800',
    icon: <ShieldAlert className="w-4 h-4 text-red-600" />,
    label: '快过期了',
  },
  expired: {
    badge: 'bg-red-100 border-red-400 text-red-900',
    icon: <ShieldAlert className="w-4 h-4 text-red-700" />,
    label: '已过期',
  },
  invalid: {
    badge: 'bg-slate-100 border-slate-300 text-slate-700',
    icon: <AlertCircle className="w-4 h-4 text-slate-500" />,
    label: '格式无效',
  },
}

export function MineruTokenStatus(props: {
  jwtInfo: MineruJwtInfo
  sev: MineruJwtSeverity
}) {
  const { jwtInfo, sev } = props
  const style = SEVERITY_STYLE[sev]
  return (
    <div
      className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-md text-xs ${style.badge}`}
    >
      {style.icon}
      {jwtInfo.parseError ? (
        <span>{jwtInfo.parseError}</span>
      ) : jwtInfo.exp ? (
        <span>
          {style.label} · 剩余 <b>{jwtInfo.remainingDays}</b> 天 · 到期{' '}
          <span className="font-mono">
            {jwtInfo.expiresAt?.toLocaleDateString('zh-CN')}
          </span>
        </span>
      ) : (
        <span>已解析但 payload 无 exp 字段（{sev}）</span>
      )}
    </div>
  )
}
