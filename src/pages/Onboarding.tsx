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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
      {/* 顶栏 */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center gap-2">
          <div className="p-1.5 bg-indigo-100 rounded-md">
            <BookOpen className="w-5 h-5 text-indigo-600" />
          </div>
          <span className="font-bold text-slate-800">AcademicFlow</span>
          <span className="ml-auto text-sm text-slate-500">
            设置工作空间 · M2
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <div className="bg-white rounded-2xl shadow-xl p-8 md:p-10 border border-slate-200">
          {/* 标题 */}
          <div className="text-center mb-8">
            <div className="inline-flex p-3 bg-indigo-100 rounded-full mb-4">
              <Rocket className="w-8 h-8 text-indigo-600" />
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-800 mb-2">
              欢迎，{user?.name || user?.login}！
            </h1>
            <p className="text-slate-600 max-w-xl mx-auto">
              AcademicFlow 需要在你的 GitHub 创建一个
              <strong className="text-indigo-700 font-mono mx-1">
                {DEFAULT_WORKSPACE_REPO_NAME}
              </strong>
              私库作为工作区。你的所有笔记数据都会存到这个私库里，我们只是路过。
            </p>
          </div>

          {/* 数据主权说明 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-slate-700">
                <div className="font-semibold text-slate-900 mb-0.5">私库</div>
                仅你可读写，AcademicFlow 无服务器留存
              </div>
            </div>
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2">
              <Github className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-slate-700">
                <div className="font-semibold text-slate-900 mb-0.5">
                  数据自主
                </div>
                随时可在 GitHub 直接查看/迁移/删除
              </div>
            </div>
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2">
              <FileText className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-slate-700">
                <div className="font-semibold text-slate-900 mb-0.5">
                  纯文本
                </div>
                Markdown + CSV，无锁定，全永久可读
              </div>
            </div>
          </div>

          {/* 骨架清单预览 */}
          <div className="mb-8">
            <div className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-500" />
              将初始化 {WORKSPACE_SKELETON.length} 个文件（一次 commit）：
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-52 overflow-y-auto">
              <ul className="text-xs font-mono text-slate-600 space-y-1">
                {WORKSPACE_SKELETON.map((f) => (
                  <li key={f.path} className="flex items-center gap-2">
                    <span className="text-slate-400">📄</span>
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
                <div className="text-xs">{error}</div>
              </div>
            </div>
          )}

          {/* 进度显示 */}
          {isLoading && progress && (
            <div className="mb-6 p-3 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-indigo-600 animate-spin flex-shrink-0" />
              <div className="text-sm text-indigo-900 flex-1">
                <div className="font-semibold">正在初始化…</div>
                <div className="text-xs font-mono text-indigo-700 mt-0.5">
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
            className="w-full py-4 px-6 rounded-xl font-semibold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-lg hover:shadow-xl transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-lg"
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
          <p className="mt-4 text-xs text-slate-500 text-center">
            首次初始化约需 5~15 秒；期间请勿关闭页面。
          </p>
        </div>

        {/* 其他功能入口（不初始化 workspace 也能用） */}
        <div className="mt-6">
          <p className="text-sm text-slate-500 text-center mb-3">
            👀 想先看看？试试这些不需要工作区的功能：
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link
              to="/journal-format"
              className="group p-4 bg-white border border-slate-200 rounded-xl hover:shadow-md hover:border-indigo-200 transition-all"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg group-hover:bg-indigo-100 transition">
                  <FileText className="w-5 h-5 text-indigo-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 group-hover:text-indigo-700 transition">
                    AI 期刊排版
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Markdown → LaTeX，按期刊格式自动排版，DOI 引用一键解析
                  </div>
                </div>
              </div>
            </Link>
            <Link
              to="/journal-templates"
              className="group p-4 bg-white border border-slate-200 rounded-xl hover:shadow-md hover:border-indigo-200 transition-all"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-slate-50 rounded-lg group-hover:bg-indigo-50 transition">
                  <BookMarked className="w-5 h-5 text-slate-600 group-hover:text-indigo-600 transition" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 group-hover:text-indigo-700 transition">
                    期刊模板管理
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
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
