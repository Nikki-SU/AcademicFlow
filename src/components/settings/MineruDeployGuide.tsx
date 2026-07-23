/**
 * MinerU 代理部署方案指引块
 * -------------------------------------------------
 * 本地部署：装 Deno → 克隆仓库 → 运行命令
 */
import { ExternalLink, Server, Terminal } from 'lucide-react'
import { useState } from 'react'

const DENO_INSTALL_URL = 'https://deno.land/#install'
const WORKER_REPO_URL = 'https://github.com/Nikki-SU/AcademicFlow-Worker'
const RUN_CMD = 'deno run --allow-net src/deno.js'
const CLONE_CMD = 'git clone https://github.com/Nikki-SU/AcademicFlow-Worker.git'

export default function MineruDeployGuide() {
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null)

  const handleCopy = (cmd: string) => {
    navigator.clipboard.writeText(cmd)
    setCopiedCmd(cmd)
    setTimeout(() => setCopiedCmd(null), 2000)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <Server className="w-4 h-4 text-indigo-600" />
        本地代理部署（30 秒搞定）
      </div>

      <ol className="text-xs text-slate-600 space-y-2.5 pl-4 list-decimal">
        <li>
          <span className="font-semibold">安装 Deno</span>
          <a
            href={DENO_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 ml-1 px-2 py-0.5 bg-blue-50 border border-blue-200
                       hover:bg-blue-100 text-blue-700 text-[0.6875rem] font-medium rounded transition-colors"
          >
            下载 Deno <ExternalLink className="w-2.5 h-2.5" />
          </a>
          <p className="mt-1 text-[0.6875rem] text-slate-400">按页面指引安装，支持 Windows / macOS / Linux</p>
        </li>

        <li>
          <span className="font-semibold">克隆代理仓库</span>
          <div className="mt-1 relative">
            <pre className="px-2.5 py-1.5 bg-slate-900 text-green-400 text-[0.6875rem] font-mono rounded
                           overflow-x-auto whitespace-pre-wrap break-all">
              {CLONE_CMD}
            </pre>
            <button
              onClick={() => handleCopy(CLONE_CMD)}
              className="absolute top-1 right-1 px-1.5 py-0.5 text-[0.625rem] bg-slate-700
                         hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              {copiedCmd === CLONE_CMD ? '✓ 已复制' : '复制'}
            </button>
          </div>
        </li>

        <li>
          <span className="font-semibold">运行代理</span>
          <div className="mt-1 relative">
            <pre className="px-2.5 py-1.5 bg-slate-900 text-green-400 text-[0.6875rem] font-mono rounded
                           overflow-x-auto whitespace-pre-wrap break-all">
              cd AcademicFlow-Worker{`\n`}{RUN_CMD}
            </pre>
            <button
              onClick={() => handleCopy(`cd AcademicFlow-Worker\n${RUN_CMD}`)}
              className="absolute top-1 right-1 px-1.5 py-0.5 text-[0.625rem] bg-slate-700
                         hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              {copiedCmd === `cd AcademicFlow-Worker\n${RUN_CMD}` ? '✓ 已复制' : '复制'}
            </button>
          </div>
          <p className="mt-1 text-[0.6875rem] text-slate-400">启动后显示 <code className="px-1 py-0.5 bg-slate-100 rounded text-[0.625rem]">Listening on http://localhost:8000/</code></p>
        </li>
      </ol>

      <div className="flex items-start gap-2 p-2.5 bg-green-50 border border-green-200 rounded-md">
        <Terminal className="w-3.5 h-3.5 text-green-600 mt-0.5 flex-shrink-0" />
        <div className="text-[0.6875rem] text-green-700">
          <div className="font-medium">代理地址：</div>
          <code className="px-1.5 py-0.5 bg-white border border-green-200 rounded text-[0.625rem]">http://localhost:8000</code>
          <div className="mt-1">填到上面输入框，保存后一次配置长期有效</div>
        </div>
      </div>

      <div className="flex items-start gap-2 p-2.5 bg-blue-50 border border-blue-200 rounded-md">
        <Terminal className="w-3.5 h-3.5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div className="text-[0.6875rem] text-blue-700">
          <div className="font-medium">不想每次手动启动？</div>
          <div className="mt-1">
            Windows 用户可以创建 <code className="px-1 py-0.5 bg-white border border-blue-200 rounded text-[0.625rem]">start-proxy.bat</code> 文件：
            <pre className="mt-1 px-2 py-1 bg-white border border-blue-200 rounded text-[0.625rem] font-mono whitespace-pre-wrap">
@echo off
cd /d "C:\path\to\AcademicFlow-Worker"
deno run --allow-net src/deno.js
pause
            </pre>
            <div className="mt-1">放到桌面，双击即可启动，还可以加入开机启动项</div>
          </div>
        </div>
      </div>

      <p className="text-[0.6875rem] text-slate-500 leading-relaxed">
        代理代码开源：
        <a
          href={WORKER_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 hover:underline ml-1"
        >
          AcademicFlow-Worker
        </a>
      </p>
    </div>
  )
}