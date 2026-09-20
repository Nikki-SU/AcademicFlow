/**
 * 后端处理能力面板 —— Settings 页
 *
 * 三个按钮：
 *   1. 检测 4 个 workflow (paper_convert / ai_call / 两个 connectivity_test) 是否安装
 *   2. 重写 4 个 yml + 4 个 runner 脚本（并清理旧版 pipeline/ai-service 残留）
 *   3. 配置 GitHub Actions Secrets（打开新窗口 + 引导模板）
 */
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Server, RefreshCw, Wrench, ExternalLink, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore } from '../../stores/workspace'
import { checkPipelineInstalled, writePipelineFiles, REQUIRED_SECRETS } from '../../services/repoBootstrap'
import { getLatestRun } from '../../services/workflowClient'

export default function BackendCapabilitiesPanel() {
  const auth = useAuthStore()
  const ws = useWorkspaceStore()
  const owner = auth.user?.login ?? ''
  const repo = ws.repo?.name ?? ''
  const token = auth.token ?? ''

  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [checkResult, setCheckResult] = useState<{ installed: boolean; missing: string[]; legacy: string[]; sizes: Record<string, number> } | null>(null)
  const [runStatus, setRunStatus] = useState<{ pipeline?: string; ai?: string }>({})

  const runCheck = useCallback(async () => {
    if (!owner || !repo || !token) { toast.error('未登录或私库未配置'); return }
    setChecking(true)
    try {
      const r = await checkPipelineInstalled(owner, repo, token)
      setCheckResult(r)
      if (r.installed) {
        toast.success('后端 workflow 已安装 ✓（新版已就绪，无旧版残留）')
      } else {
        const parts: string[] = []
        if (r.missing.length > 0) parts.push(`缺 ${r.missing.length} 个新文件`)
        if (r.legacy.length > 0) parts.push(`残留 ${r.legacy.length} 个旧版文件`)
        toast.warning(parts.join('；') + '，请点"重写后端"一键修复')
      }

      // 同时查最近 run 状态
      try {
        const pRun = await getLatestRun('paper_convert', owner, repo, token)
        const aRun = await getLatestRun('ai_call', owner, repo, token)
        setRunStatus({
          pipeline: pRun ? `${pRun.conclusion || pRun.status}` : '从未运行',
          ai: aRun ? `${aRun.conclusion || aRun.status}` : '从未运行',
        })
      } catch { /* ignore run query errors */ }
    } catch (e: any) {
      toast.error(`检测失败：${e?.message || e}`)
    } finally { setChecking(false) }
  }, [owner, repo, token])

  const runInstall = useCallback(async () => {
    if (!owner || !repo || !token) { toast.error('未登录或私库未配置'); return }
    setInstalling(true)
    try {
      const r = await writePipelineFiles(owner, repo, token)
      if (r.ok) {
        const cleanMsg = r.legacyDeleted?.length
          ? `，已清理 ${r.legacyDeleted.length} 个旧版文件`
          : ''
        toast.success(`写入成功 ${r.written?.length ?? 4} 个文件${cleanMsg}`)
        await runCheck() // 重新检测
      } else {
        toast.error(`写入失败：${r.details?.filter(d => !d.ok).map(d => `${d.path}: ${d.error}`).join('; ') || 'unknown'}`)
      }
    } catch (e: any) {
      toast.error(`写入失败：${e?.message || e}`)
    } finally { setInstalling(false) }
  }, [owner, repo, token, runCheck])

  const secretsUrl = owner && repo
    ? `https://github.com/${owner}/${repo}/settings/secrets/actions`
    : '#'

  const installed = checkResult?.installed

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        后端架构改造后，MinerU 转换和 AI 任务全部跑在 GitHub Actions 上。你需要在私库安装
        <b> paper_convert.yml / book_convert.yml / ai_call.yml </b>
        三个主 workflow（外加两个连通性自测 workflow，以及「云端编译」用的
        <b> latex_compile.yml</b>），并配置 7 个 Secrets。<b>老用户</b>：点"检测"看看私库是否已经升级。
      </p>

      {/* 状态条 */}
      <div className={`flex items-center gap-2 p-3 rounded-md border text-sm ${
        installed === true ? 'bg-green-50 border-green-200 text-green-800'
        : installed === false ? 'bg-amber-50 border-amber-200 text-amber-800'
        : 'bg-slate-50 border-slate-200 text-slate-600'
      }`}>
        {installed === true ? (
          <><CheckCircle2 className="w-4 h-4 text-green-600" /> 后端已就绪（新版），最近 pipeline run: <span className="font-mono">{runStatus.pipeline}</span></>
        ) : installed === false ? (
          <><AlertTriangle className="w-4 h-4 text-amber-600" /> 后端未完全就绪（
            缺 {checkResult?.missing?.length ?? '?'} 个新文件 · 残留 {checkResult?.legacy?.length ?? '?'} 个旧版文件）
          </>
        ) : (
          <><Server className="w-4 h-4 text-slate-400" /> 状态未知，点下方"检测"按钮</>
        )}
      </div>

      {/* 三个按钮 */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={runCheck}
          disabled={checking || !owner || !repo}
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-md
                     hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
        >
          {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Server className="w-3.5 h-3.5" />}
          检测
        </button>
        <button
          type="button"
          onClick={runInstall}
          disabled={installing || !owner || !repo}
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm border border-indigo-300 bg-indigo-50 text-indigo-700 rounded-md
                     hover:bg-indigo-100 disabled:text-slate-300 disabled:cursor-not-allowed"
        >
          {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          重写后端
        </button>
        <a
          href={secretsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-md
                     hover:bg-slate-50 text-slate-700"
        >
          <Wrench className="w-3.5 h-3.5" />
          配置 Secrets
          <ExternalLink className="w-3 h-3 text-slate-400" />
        </a>
      </div>

      {/* 检测结果详情 */}
      {checkResult && !checkResult.installed && checkResult.missing.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-md space-y-1">
          <div className="text-xs font-semibold text-amber-800">缺失文件：</div>
          {checkResult.missing.map(p => (
            <div key={p} className="flex items-center gap-1 text-xs font-mono text-amber-700">
              <XCircle className="w-3 h-3" /> {p}
            </div>
          ))}
        </div>
      )}

      {checkResult && checkResult.legacy.length > 0 && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md space-y-1">
          <div className="text-xs font-semibold text-red-800">
            残留的旧版文件（会与新版重复触发 / 造成 "no jobs were run"），点"重写后端"自动清理：
          </div>
          {checkResult.legacy.map(p => (
            <div key={p} className="flex items-center gap-1 text-xs font-mono text-red-700">
              <XCircle className="w-3 h-3" /> {p}
            </div>
          ))}
        </div>
      )}

      {/* Secrets 引导模板 */}
      <details className="border border-slate-200 rounded-md overflow-hidden">
        <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
          <Wrench className="w-4 h-4 text-indigo-600" />
          7 个必需 Secrets（点击展开查看模板）
        </summary>
        <div className="p-3 space-y-2">
          <p className="text-xs text-slate-600 leading-relaxed">
            上一步"重写后端"只是把 workflow 文件塞进了你的私库。要让 pipeline 真跑起来，必须在 GitHub
            Settings → Secrets and variables → Actions 里创建下面 7 个 Repository Secret。
          </p>
          <div className="grid gap-1.5">
            {REQUIRED_SECRETS.map(s => (
              <div key={s.name} className="flex items-start gap-2 p-2 bg-slate-50 border border-slate-200 rounded text-xs">
                <code className="shrink-0 px-1.5 py-0.5 bg-indigo-100 text-indigo-800 rounded font-mono">{s.name}</code>
                <div className="flex-1">
                  <div className="text-slate-700">{s.hint}</div>
                  <div className="text-slate-500 text-[11px]">来源：{s.from}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 pt-1">
            推荐模型：AI-1（生成）Qwen2.5-32B-Instruct · AI-2（审阅）Qwen2.5-72B-Instruct。
            硅基流动的 base URL 是 https://api.siliconflow.cn/v1。
          </p>
        </div>
      </details>
    </div>
  )
}
