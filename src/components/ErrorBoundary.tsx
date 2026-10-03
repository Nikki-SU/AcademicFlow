/**
 * 局部渲染的异常边界（ADJ-83）
 * -------------------------------------------------
 * 不套边界时，子树里任何一处渲染抛错都会让 React 卸载**整棵根树** ——
 * 表现为「点编辑，弹窗闪一下整页就没了 / 白屏」。
 * 这里把子树兜住：出错只替换这一块，给出可读原因 + 「重试 / 关闭」，
 * 让单点错误不再带走整页（先修根因，边界只作最后一道安全网）。
 */
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 点「关闭」时回调（通常是关掉宿主弹窗）；不给则只显示「重试」 */
  onClose?: () => void
}

interface State {
  err: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(e: unknown): State {
    return { err: e instanceof Error ? e.message : String(e) }
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[ErrorBoundary] 渲染出错:', error, info)
  }

  render() {
    if (this.state.err === null) return this.props.children
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
        <div className="w-full max-w-md rounded-card bg-paper-50 p-5 shadow-xl">
          <h3 className="font-semibold text-ink-800">这个窗口出错了</h3>
          <p className="mt-2 break-all font-mono text-ui-xs text-red-600">{this.state.err}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => this.setState({ err: null })}
              className="rounded-control px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
            >
              重试
            </button>
            {this.props.onClose && (
              <button
                onClick={this.props.onClose}
                className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
              >
                关闭
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
