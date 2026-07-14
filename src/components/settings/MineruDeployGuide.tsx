/**
 * MinerU 代理部署方案指引块
 * -------------------------------------------------
 * 简化为 3 步：买 VPS → 一键脚本 → 填 URL
 */
import { ExternalLink, Server } from 'lucide-react'
import { useState } from 'react'

const ALIYUN_URL = 'https://www.aliyun.com/daily-act/ecs/activity_selection'
const TENCENT_URL = 'https://cloud.tencent.com/act/pro/lhsale'
const INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/Nikki-SU/AcademicFlow/main/install.sh | bash'

export default function MineruDeployGuide() {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <Server className="w-4 h-4 text-indigo-600" />
        3 步搞定代理部署
      </div>

      <ol className="text-xs text-slate-600 space-y-2.5 pl-4 list-decimal">
        <li>
          <span className="font-semibold">买一台 VPS</span>
          <div className="flex gap-1.5 mt-1">
            <a
              href={ALIYUN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 bg-orange-50 border border-orange-200
                         hover:bg-orange-100 text-orange-700 text-[11px] font-medium rounded transition-colors"
            >
              阿里云 ¥99/年起 <ExternalLink className="w-2.5 h-2.5" />
            </a>
            <a
              href={TENCENT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200
                         hover:bg-blue-100 text-blue-700 text-[11px] font-medium rounded transition-colors"
            >
              腾讯云 ¥109/年起 <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">地域选上海最佳（和 MinerU 服务器同机房）</p>
        </li>

        <li>
          <span className="font-semibold">SSH 登录后粘贴执行</span>
          <div className="mt-1 relative">
            <pre className="px-2.5 py-1.5 bg-slate-900 text-green-400 text-[11px] font-mono rounded
                            overflow-x-auto whitespace-pre-wrap break-all">
              {INSTALL_CMD}
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] bg-slate-700
                         hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              {copied ? '✓ 已复制' : '复制'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">自动装 Deno + 启动代理 + 开机自启</p>
        </li>

        <li>
          <span className="font-semibold">把输出的地址填到下面</span>
          <p className="mt-0.5 text-[11px] text-slate-400">
            脚本会打印 <code className="px-1 py-0.5 bg-slate-100 rounded text-[10px]">http://你的IP:8000</code>，
            复制粘贴即可
          </p>
        </li>
      </ol>

      <p className="text-[11px] text-amber-600 leading-relaxed">
        ⚠️ 记得在云控制台开放 8000 端口（安全组 → 添加 TCP 8000 入方向规则）
      </p>
    </div>
  )
}
