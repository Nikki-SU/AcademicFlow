/**
 * MinerU 代理部署方案指引块（M3.6.2-d）
 * -------------------------------------------------
 * 根据 mineruDeployMode 渲染对应的部署按钮 + 步骤引导。
 * 拆出独立文件是为了让 MineruProxyConfig 主组件控在 300 行以内。
 */
import { ExternalLink, Rocket } from 'lucide-react'
import type { SettingsData } from '../../types'

type DeployMode = SettingsData['mineruDeployMode']

const CF_DEPLOY_URL =
  'https://deploy.workers.cloudflare.com/?url=https://github.com/Nikki-SU/AcademicFlow-Worker'
const DENO_DEPLOY_URL = 'https://dash.deno.com/new'

export default function MineruDeployGuide({ mode }: { mode: DeployMode }) {
  if (mode === 'deno') {
    return (
      <div className="space-y-3">
        <a
          href={DENO_DEPLOY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600
                     hover:from-green-700 hover:to-emerald-700 text-white text-sm font-medium
                     rounded-lg shadow-sm transition-all"
        >
          <Rocket className="w-4 h-4" />
          去 Deno Deploy 部署（免费）
          <ExternalLink className="w-3.5 h-3.5 opacity-80" />
        </a>
        <ol className="text-xs text-slate-600 space-y-1.5 pl-4 list-decimal">
          <li>点上面按钮 → GitHub 登录 Deno Deploy（首次注册也走 GitHub，无需邮箱验证）</li>
          <li>
            选择 <span className="font-mono text-[11px]">Deploy from GitHub repository</span> →
            授权 Deno 访问你的 Nikki-SU/AcademicFlow-Worker 仓库
          </li>
          <li>
            Entrypoint 填 <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">src/deno.js</code>
            ，其他保持默认，点 <span className="font-semibold">Deploy Project</span>
          </li>
          <li>
            复制生成的 <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">xxx.deno.dev</code>{' '}
            URL，粘到下面输入框
          </li>
        </ol>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <a
        href={CF_DEPLOY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500
                   hover:from-orange-600 hover:to-amber-600 text-white text-sm font-medium
                   rounded-lg shadow-sm transition-all"
      >
        <Rocket className="w-4 h-4" />
        一键部署到 Cloudflare（免费）
        <ExternalLink className="w-3.5 h-3.5 opacity-80" />
      </a>
      <ol className="text-xs text-slate-600 space-y-1.5 pl-4 list-decimal">
        <li>点上面按钮 → Cloudflare 登录（没账号会自动引导注册，仅需邮箱）</li>
        <li>页面上直接点 <span className="font-semibold">Deploy</span>，全程 CF 官方引导</li>
        <li>
          复制生成的 <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">xxx.workers.dev</code>{' '}
          URL，粘到下面输入框（国内访问需代理）
        </li>
      </ol>
    </div>
  )
}
