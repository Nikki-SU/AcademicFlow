/**
 * Onboarding 引导页
 * -------------------------------------------------
 * 用户首次登录且未创建 `academicflow-workspace` 私库时展示。
 * 一键触发 workspace store 的 createAndInit() → 前端调 GitHub Git Data API 创建 12 项骨架。
 */
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  FileText,
  Github,
  Loader2,
  Rocket,
  ShieldCheck,
  BookMarked,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  DEFAULT_WORKSPACE_REPO_NAME,
  WORKSPACE_SKELETON,
} from '../constants/skeleton'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'

function Onboarding() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const {
    isChecked,
    isLoading,
    repo,
    progress,
    error,
    checkAndMaybeInit,
    createAndInit,
    clearError,
  } = useWorkspaceStore()

  const [creationDone, setCreationDone] = useState(false)

  // 首次进入：如果尚未检测，先检测一次
  useEffect(() => {
    if (!isChecked && !isLoading) {
      checkAndMaybeInit()
    }
  }, [isChecked, isLoading, checkAndMaybeInit])

  // 已存在 workspace：说明用户误进本页，直接跳首页
  useEffect(() => {
    if (isChecked && repo && !creationDone) {
      // 已经初始化过，直接回首页
      navigate('/', { replace: true })
    }
  }, [isChecked, repo, creationDone, navigate])

  const handleStart = async () => {
    clearError()
    try {
      await createAndInit()
      setCreationDone(true)
      toast.success('工作区初始化成功！')
      // 让用户看一下"完成"状态再跳
      setTimeout(() => navigate('/', { replace: true }), 1500)
    } catch {
      // error 已被 store set，UI 会显示
    }
  }

  return (
    <div className="min-h-full bg-paper-100">
      {/* 顶栏 */}
      <header className="border-b border-ink-900/10 bg-paper-50">
        <div className="page-container flex items-center gap-2.5 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-seal-600">
            <BookOpen className="h-4 w-4 text-paper-50" strokeWidth={1.75} />
          </div>
          <span className="font-semibold tracking-tight text-ink-900">AcademicFlow</span>
          <span className="ml-auto text-sm text-ink-500">设置工作空间</span>
        </div>
      </header>

      <main className="page-container flex flex-col items-center gap-6 py-10">
        <div className="w-full max-w-3xl rounded-xl border border-ink-900/10 bg-paper-50 p-8 shadow-card md:p-10">
          {/* 标题 */}
          <div className="mb-8 text-center">
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-seal-600">
              <Rocket className="h-6 w-6 text-paper-50" strokeWidth={1.75} />
            </div>
            <h1 className="mb-2 text-2xl font-semibold tracking-tight text-ink-900 md:text-3xl">
              欢迎，{user?.name || user?.login}！
            </h1>
            <p className="mx-auto max-w-xl text-sm leading-relaxed text-ink-600">
              AcademicFlow 需要在你的 GitHub 创建一个
              <strong className="mx-1 font-mono text-seal-700">
                {DEFAULT_WORKSPACE_REPO_NAME}
              </strong>
              私库作为工作区。你的所有笔记数据都会存到这个私库里，我们只是路过。
            </p>
          </div>

          {/* 数据主权说明 */}
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex items-start gap-2 rounded-lg border border-ink-900/10 bg-paper-100 p-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-xs text-ink-600">
                <div className="mb-0.5 font-medium text-ink-900">私库</div>
                仅你可读写，AcademicFlow 无服务器留存
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-ink-900/10 bg-paper-100 p-3">
              <Github className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-xs text-ink-600">
                <div className="mb-0.5 font-medium text-ink-900">数据自主</div>
                随时可在 GitHub 直接查看/迁移/删除
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-ink-900/10 bg-paper-100 p-3">
              <FileText className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-xs text-ink-600">
                <div className="mb-0.5 font-medium text-ink-900">纯文本</div>
                Markdown + CSV，无锁定，全永久可读
              </div>
            </div>
          </div>

          {/* 骨架清单预览 */}
          <div className="mb-8">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-700">
              <FileText className="h-4 w-4 text-ink-400" />
              将初始化 {WORKSPACE_SKELETON.length} 个文件（一次 commit）
            </div>
            <div className="max-h-52 overflow-y-auto rounded-lg border border-ink-900/10 bg-paper-100 p-3">
              <ul className="space-y-1 font-mono text-xs text-ink-600">
                {WORKSPACE_SKELETON.map((f) => (
                  <li key={f.path} className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-ink-300" />
                    <span>{f.path}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-800 flex-1">
                <div className="font-semibold mb-0.5">初始化失败</div>
                <div className="text-xs mb-2">{error}</div>
                <button
                  onClick={handleStart}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-200 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                  重试初始化
                </button>
              </div>
            </div>
          )}

          {/* 进度显示 */}
          {isLoading && progress && (
            <div className="mb-6 p-3 bg-seal-50 border border-seal-200 rounded-lg flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-seal-600 animate-spin flex-shrink-0" />
              <div className="text-sm text-seal-900 flex-1">
                <div className="font-semibold">正在初始化…</div>
                <div className="text-xs font-mono text-seal-700 mt-0.5">
                  {progress}
                </div>
              </div>
            </div>
          )}

          {/* 完成提示 */}
          {creationDone && repo && (
            <div className="mb-6 p-3 bg-green-50 border border-green-200 rounded-lg flex items-start gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-green-800 flex-1">
                <div className="font-semibold mb-0.5">工作区已就绪！</div>
                <div className="text-xs">
                  即将跳转到首页。你的私库：
                  <a
                    href={repo.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 underline font-mono"
                  >
                    {repo.full_name}
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* 主按钮 */}
          <button
            onClick={handleStart}
            disabled={isLoading || creationDone}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink-900 px-6 py-3.5 text-base font-medium text-paper-50 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                初始化中…
              </>
            ) : creationDone ? (
              <>
                <CheckCircle2 className="w-5 h-5" />
                完成
              </>
            ) : (
              <>
                <Rocket className="w-5 h-5" />
                初始化我的工作空间
              </>
            )}
          </button>

          {/* 提示 */}
          <p className="mt-4 text-xs text-ink-500 text-center">
            首次初始化约需 5~15 秒；期间请勿关闭页面。
          </p>
        </div>

        {/* 其他功能入口（不初始化 workspace 也能用） */}
        <div className="w-full max-w-3xl">
          <p className="mb-3 text-center text-sm text-ink-500">想先看看？试试这些功能：</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link
              to="/writing"
              className="group rounded-xl border border-ink-900/10 bg-paper-50 p-4 transition hover:border-seal-200 hover:shadow-card"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-seal-50 p-2 transition group-hover:bg-seal-100">
                  <FileText className="h-5 w-5 text-seal-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink-900 transition group-hover:text-seal-700">
                    AI 期刊排版
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    Markdown → LaTeX，按期刊格式自动排版，DOI 引用一键解析
                  </div>
                </div>
              </div>
            </Link>
            <Link
              to="/management"
              className="group rounded-xl border border-ink-900/10 bg-paper-50 p-4 transition hover:border-seal-200 hover:shadow-card"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-ink-50 p-2 transition group-hover:bg-seal-50">
                  <BookMarked className="h-5 w-5 text-ink-500 transition group-hover:text-seal-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink-900 transition group-hover:text-seal-700">
                    期刊模板管理
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    粘贴投稿须知，AI 自动提取格式规范，生成可复用模板
                  </div>
                </div>
              </div>
            </Link>
          </div>
        </div>
      </main>
    </div>
  )
}

export default Onboarding
