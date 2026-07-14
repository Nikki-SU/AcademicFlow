/**
 * MinerU 代理部署方案指引块
 * -------------------------------------------------
 * 推荐使用国内 VPS 部署透传代理（无超时限制，到 OSS 内网快）。
 * Deno Deploy / Cloudflare Workers 因平台超时限制，不适合大 PDF 上传。
 */
import { ExternalLink, Server } from 'lucide-react'

const ALIYUN_URL = 'https://www.aliyun.com/product/ecs'
const TENCENT_URL = 'https://cloud.tencent.com/product/lighthouse'
const REPO_URL = 'https://github.com/Nikki-SU/AcademicFlow-Worker'

export default function MineruDeployGuide() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <Server className="w-4 h-4 text-indigo-600" />
        推荐方案：国内 VPS 部署
      </div>

      <div className="flex gap-2">
        <a
          href={ALIYUN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-orange-500 to-amber-500
                     hover:from-orange-600 hover:to-amber-600 text-white text-xs font-medium
                     rounded-lg shadow-sm transition-all"
        >
          阿里云 ECS
          <ExternalLink className="w-3 h-3 opacity-80" />
        </a>
        <a
          href={TENCENT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-blue-500 to-sky-500
                     hover:from-blue-600 hover:to-sky-600 text-white text-xs font-medium
                     rounded-lg shadow-sm transition-all"
        >
          腾讯云轻量
          <ExternalLink className="w-3 h-3 opacity-80" />
        </a>
      </div>

      <ol className="text-xs text-slate-600 space-y-1.5 pl-4 list-decimal">
        <li>
          购买一台国内 VPS（阿里云 ¥38/年起 或 腾讯云 ¥109/年起，选<span className="font-semibold">上海</span>地域最佳，
          和 MinerU OSS 同机房）
        </li>
        <li>SSH 登录 VPS，安装 Deno： <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">curl -fsSL https://deno.land/install.sh | sh</code></li>
        <li>克隆代理仓库： <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">git clone {REPO_URL}</code></li>
        <li>启动代理： <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">cd AcademicFlow-Worker && deno run --allow-net src/deno.js</code></li>
        <li>开放防火墙 8000 端口（或用 nginx 反代到 443）</li>
        <li>把 <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">http://你的VPS公网IP:8000</code> 填到下面输入框</li>
      </ol>

      <p className="text-[11px] text-amber-600 leading-relaxed">
        ⚠️ Deno Deploy / Cloudflare Workers 有 50s / 30s 超时限制，8MB 以上 PDF 上传会失败。
        国内 VPS 到 OSS 走内网，无超时限制，8MB 文件仅需 1-2 秒。
      </p>
    </div>
  )
}
