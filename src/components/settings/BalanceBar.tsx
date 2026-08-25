/**
 * 硅基流动账户余额条（M3.5.1）
 * -------------------------------------------------
 * 双引擎面板顶部显示：账户余额 / 拉取状态 / 刷新按钮 / 错误提示。
 * 目标：让"半天不出结果"和"账户没钱"从画面上就区分开 —— 余额为 0 或极低时红字警告。
 *
 * 交互：
 *   - 进入面板 + 已配置 Key → 自动首次拉取一次
 *   - 用户点刷新按钮 → 强制重拉
 *   - 401 → 提示 Key 无效；402/403 → 提示权限受限；其他 → 通用错误
 */
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, Wallet } from 'lucide-react'
import type { UserAccountInfo } from '../../types'

interface Props {
  account: UserAccountInfo | null
  isLoading: boolean
  error: string | null
  canFetch: boolean
  onRefresh: () => void
}

/** M3.7.2: 识别"端点已废弃"文案，呈现与普通请求失败不同的 UI。 */
function isDeprecatedEndpointError(msg: string | null): boolean {
  if (!msg) return false
  return (
    msg.includes('2026-08-14') ||
    msg.includes('endpoint is deprecated') ||
    msg.includes('no longer available')
  )
}

/** 余额是否偏低（< 0.5 元，界定标准偏保守，避免临界抖动） */
function isBalanceLow(totalBalance: string): boolean {
  const n = Number(totalBalance)
  if (!Number.isFinite(n)) return false
  return n < 0.5
}

function formatBalance(totalBalance: string): string {
  const n = Number(totalBalance)
  if (!Number.isFinite(n)) return totalBalance
  return `¥ ${n.toFixed(2)}`
}

function formatFetchedAt(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function BalanceBar({ account, isLoading, error, canFetch, onRefresh }: Props) {
  if (!canFetch) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-500">
        <Wallet className="w-4 h-4" />
        <span>普通模式需先配置硅基流动 API Key 才能显示余额</span>
      </div>
    )
  }

  if (isLoading && !account) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-600">
        <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
        <span>正在查询硅基流动余额…</span>
      </div>
    )
  }

  if (error && !account) {
    const deprecated = isDeprecatedEndpointError(error)
    if (deprecated) {
      return (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0 leading-relaxed">
            <div className="font-medium">余额查询接口已下线</div>
            <div className="mt-0.5 text-[0.6875rem] break-all">
              硅基流动已于 2026-08-14 正式下线 /v1/user/info 接口，官方替代 API 尚未上线，模型调用不受影响。请点击右侧按钮前往官网账户中心查看余额。
            </div>
          </div>
          <a
            href="https://cloud.siliconflow.cn/account/balance"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 bg-white border border-amber-300 rounded hover:bg-amber-100 text-amber-800 font-medium"
          >
            前往账户中心
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )
    }
    return (
      <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium">余额查询失败</div>
          <div className="text-[0.6875rem] mt-0.5 text-red-700 leading-relaxed break-all">
            {error}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 border border-red-300 rounded hover:bg-red-100"
        >
          <RefreshCw className="w-3 h-3" />
          重试
        </button>
      </div>
    )
  }

  if (!account) return null

  const low = isBalanceLow(account.totalBalance)
  const wrapCls = low
    ? 'bg-red-50 border-red-300 text-red-800'
    : 'bg-emerald-50 border-emerald-200 text-emerald-800'

  return (
    <div className={`flex items-center gap-3 px-3 py-2 border rounded-md text-xs ${wrapCls}`}>
      <Wallet className="w-4 h-4 flex-shrink-0" />
      <div className="flex items-baseline gap-1.5">
        <span className="font-medium">硅基流动余额</span>
        <span className="font-mono text-sm font-semibold">
          {formatBalance(account.totalBalance)}
        </span>
      </div>
      {account.chargeBalance !== undefined && (
        <span className="text-[0.6875rem] opacity-70 font-mono">
          (充值 ¥ {Number(account.chargeBalance).toFixed(2)})
        </span>
      )}
      {account.status && account.status !== 'normal' && (
        <span className="px-1.5 py-0.5 bg-white/60 border border-current rounded text-[0.6875rem] font-mono">
          状态 {account.status}
        </span>
      )}
      <span className="ml-auto text-[0.6875rem] opacity-60">
        更新于 {formatFetchedAt(account.fetchedAt)}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={isLoading}
        title="刷新余额"
        className="flex-shrink-0 p-1 rounded hover:bg-white/50 disabled:opacity-50"
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
      </button>
      {low && (
        <a
          href="https://cloud.siliconflow.cn/account/balance"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 bg-white border border-red-400 text-red-700 rounded font-medium hover:bg-red-100"
        >
          去充值
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  )
}

export default BalanceBar
