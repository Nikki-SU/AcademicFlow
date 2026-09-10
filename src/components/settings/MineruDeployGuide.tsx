/**
 * MinerU 本地代理部署指引
 * -------------------------------------------------
 * 只有本地部署，不涉及公网服务器。
 * 核心：Deno + worker/deno.js → localhost:8000
 */
import { ExternalLink, Server, Terminal, Power } from 'lucide-react'
import { useState } from 'react'

const DENO_INSTALL_URL = 'https://deno.land/#install'
const WORKER_DIR_URL = 'https://github.com/Nikki-SU/AcademicFlow/tree/main/worker'
const RUN_CMD = 'deno run --allow-net worker/deno.js'
const CLONE_CMD = 'git clone https://github.com/Nikki-SU/AcademicFlow.git'

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
        本地代理部署（Windows / macOS / Linux）
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
          <p className="mt-1 text-[0.6875rem] text-slate-400">官方一键安装，支持所有平台</p>
        </li>

        <li>
          <span className="font-semibold">下载代码</span>
          <p className="mt-1 text-[0.6875rem] text-amber-600">
            ⚠️ 先 <code className="px-0.5 bg-amber-100 rounded">cd</code> 到有写权限的目录（如 <code className="px-0.5 bg-amber-100 rounded">C:\Users\你的用户名\</code> 或 <code className="px-0.5 bg-amber-100 rounded">D:\</code>），
            别在 <code className="px-0.5 bg-amber-100 rounded">C:\WINDOWS\System32</code> 下执行
          </p>
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
          <p className="mt-1 text-[0.6875rem] text-slate-400">
            GitHub 连不上？直接下载 zip：
            <a href="https://nikki-su.github.io/AcademicFlow/AcademicFlow-latest.zip"
               className="text-indigo-600 hover:underline ml-1">浏览器下载</a>
          </p>
        </li>

        <li>
          <span className="font-semibold">启动代理</span>
          <div className="mt-1 relative">
            <pre className="px-2.5 py-1.5 bg-slate-900 text-green-400 text-[0.6875rem] font-mono rounded
                           overflow-x-auto whitespace-pre-wrap break-all">
              cd AcademicFlow{`\n`}{RUN_CMD}
            </pre>
            <button
              onClick={() => handleCopy(`cd AcademicFlow\n${RUN_CMD}`)}
              className="absolute top-1 right-1 px-1.5 py-0.5 text-[0.625rem] bg-slate-700
                         hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              {copiedCmd === `cd AcademicFlow\n${RUN_CMD}` ? '✓ 已复制' : '复制'}
            </button>
          </div>
          <p className="mt-1 text-[0.6875rem] text-slate-400">
            浏览器打开 <code className="px-1 py-0.5 bg-slate-100 rounded text-[0.625rem]">http://localhost:8000/</code>
            ，看到 "AcademicFlow 代理已启动" 就是好的
          </p>
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

      {/* ---- 开机自启 ---- */}
      <div className="border-t border-slate-200 pt-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
          <Power className="w-4 h-4 text-indigo-600" />
          开机自动启动（推荐）
        </div>

        {/* Windows */}
        <details className="group mb-2">
          <summary className="text-xs font-medium text-slate-600 cursor-pointer hover:text-indigo-600 select-none">
            ▸ Windows
          </summary>
          <div className="mt-1.5 p-2 bg-blue-50 border border-blue-200 rounded text-[0.6875rem] text-blue-700 space-y-2">
            <p>
              1) 创建文件 <code className="px-1 bg-white rounded text-[0.625rem]">start-proxy.bat</code>，内容：
            </p>
            <pre className="px-2 py-1 bg-white border border-blue-200 rounded text-[0.625rem] font-mono whitespace-pre-wrap">
{`@echo off
cd /d "C:\\path\\to\\AcademicFlow"
deno run --allow-net worker/deno.js`}
            </pre>
            <p>2) 按 <kbd className="px-1 bg-white rounded border border-blue-300 text-[0.625rem]">Win</kbd> + <kbd className="px-1 bg-white rounded border border-blue-300 text-[0.625rem]">R</kbd>，输入 <code className="px-1 bg-white rounded text-[0.625rem]">shell:startup</code> 回车</p>
            <p>3) 把 <code className="px-1 bg-white rounded text-[0.625rem]">start-proxy.bat</code> 复制到打开的文件夹里 → 搞定</p>
          </div>
        </details>

        {/* macOS */}
        <details className="group mb-2">
          <summary className="text-xs font-medium text-slate-600 cursor-pointer hover:text-indigo-600 select-none">
            ▸ macOS
          </summary>
          <div className="mt-1.5 p-2 bg-blue-50 border border-blue-200 rounded text-[0.6875rem] text-blue-700 space-y-2">
            <p>
              1) 创建 <code className="px-1 bg-white rounded text-[0.625rem]">~/Library/LaunchAgents/com.academicflow.proxy.plist</code>，内容：
            </p>
            <pre className="px-2 py-1 bg-white border border-blue-200 rounded text-[0.625rem] font-mono whitespace-pre-wrap">{`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.academicflow.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/你的用户名/.deno/bin/deno</string>
    <string>run</string>
    <string>--allow-net</string>
    <string>/path/to/AcademicFlow/worker/deno.js</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`}</pre>
            <p>2) 终端执行：<code className="px-1 bg-white rounded text-[0.625rem]">launchctl load ~/Library/LaunchAgents/com.academicflow.proxy.plist</code></p>
          </div>
        </details>

        {/* Linux (systemd) */}
        <details className="group mb-2">
          <summary className="text-xs font-medium text-slate-600 cursor-pointer hover:text-indigo-600 select-none">
            ▸ Linux（systemd）
          </summary>
          <div className="mt-1.5 p-2 bg-blue-50 border border-blue-200 rounded text-[0.6875rem] text-blue-700 space-y-2">
            <p>
              1) 创建 <code className="px-1 bg-white rounded text-[0.625rem]">~/.config/systemd/user/academicflow-proxy.service</code>：
            </p>
            <pre className="px-2 py-1 bg-white border border-blue-200 rounded text-[0.625rem] font-mono whitespace-pre-wrap">{`[Unit]
Description=AcademicFlow MinerU Proxy

[Service]
WorkingDirectory=%h/AcademicFlow
ExecStart=/root/.deno/bin/deno run --allow-net worker/deno.js
Restart=on-failure

[Install]
WantedBy=default.target`}</pre>
            <p>2) 执行：<code className="px-1 bg-white rounded text-[0.625rem]">systemctl --user enable --now academicflow-proxy</code></p>
          </div>
        </details>
      </div>

      <p className="text-[0.6875rem] text-slate-500 leading-relaxed">
        代理代码：
        <a
          href={WORKER_DIR_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 hover:underline ml-1"
        >
          worker/ 目录
        </a>
      </p>
    </div>
  )
}
