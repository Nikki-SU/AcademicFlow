/**
 * 设置页
 * -------------------------------------------------
 * 对应 SPEC v0.3 §5.2 / §7.3 / §8。M3 阶段核心页面。
 *
 * 功能：
 * - 硅基流动 API Key 填写
 * - AI-1 / AI-2 模型选择（从 /v1/models 拉取真实清单，24h 缓存）
 * - 高级模式 toggle → 展开自定义端点（AI-1 / AI-2 各自 base_url + key + model）
 * - AI 双引擎试运行（fact_check）
 */
import {
  ArrowLeft,
  BookOpen,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import APIKeyInput from '../components/settings/APIKeyInput'
import DualEngineTestPanel from '../components/settings/DualEngineTestPanel'
import MineruTestPanel from '../components/settings/MineruTestPanel'
import { isChatModel } from '../services/ai/models'
import { useSettingsStore } from '../stores/settings'
import type { AIProviderMode } from '../types'

function formatFetchedAt(ts: number | null): string {
  if (!ts) return '未拉取'
  const diffMs = Date.now() - ts
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return new Date(ts).toLocaleString()
}

function Settings() {
  const store = useSettingsStore()
  const {
    isInitialized,
    advancedMode,
    aiProviderMode,
    siliconflowApiKey,
    ai1Model,
    ai2Model,
    customAi1BaseUrl,
    customAi1ApiKey,
    customAi1Model,
    customAi2BaseUrl,
    customAi2ApiKey,
    customAi2Model,
    siliconflowModels,
    siliconflowModelsFetchedAt,
    isLoadingModels,
    updateSettings,
    refreshModels,
    init,
  } = store

  useEffect(() => {
    if (!isInitialized) init()
  }, [isInitialized, init])

  /** 监听 settings store 触发的凭据清洗事件：向用户解释一次为什么 Key 被清空 */
  useEffect(() => {
    const onCleaned = (e: Event) => {
      const detail = (e as CustomEvent<{ fields: string[] }>).detail
      const fieldLabelMap: Record<string, string> = {
        siliconflowApiKey: '硅基流动 API Key',
        customAi1ApiKey: '自定义 AI-1 API Key',
        customAi2ApiKey: '自定义 AI-2 API Key',
        mineruToken: 'MinerU Token',
      }
      const labels = detail.fields.map((f) => fieldLabelMap[f] ?? f).join('、')
      toast.warning(
        `检测到浏览器密码管理器将 GitHub PAT 误填到 ${labels}，已自动清空。请重新填写正确的 Key。`,
        { duration: 8000 },
      )
    }
    window.addEventListener('af:credential-cleaned', onCleaned)
    return () => window.removeEventListener('af:credential-cleaned', onCleaned)
  }, [])

  /** 过滤后的 chat 类模型清单（用于 UI 下拉） */
  const chatModels = useMemo(() => {
    const filtered = siliconflowModels
      .map((m) => m.id)
      .filter(isChatModel)
      .sort()
    // 若下拉里没当前选中的模型，补进去让 UI 不出现空选中
    const augmented = new Set(filtered)
    if (ai1Model && !augmented.has(ai1Model)) augmented.add(ai1Model)
    if (ai2Model && !augmented.has(ai2Model)) augmented.add(ai2Model)
    return Array.from(augmented).sort()
  }, [siliconflowModels, ai1Model, ai2Model])

  const handleRefresh = async () => {
    try {
      const models = await refreshModels(true)
      toast.success(`已拉取 ${models.length} 个模型`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`拉取失败：${msg}`)
    }
  }

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-600">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
          <span className="text-sm">正在加载设置…</span>
        </div>
      </div>
    )
  }

  const showCustom = advancedMode && aiProviderMode === 'custom'

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
      {/* 顶栏 */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-100 rounded-md">
              <BookOpen className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="font-bold text-slate-800">AcademicFlow</span>
            <span className="text-slate-300">/</span>
            <span className="text-sm text-slate-600 flex items-center gap-1">
              <SettingsIcon className="w-4 h-4" />
              设置
            </span>
          </div>
          <Link
            to="/"
            className="flex items-center gap-1 px-2.5 py-1.5 text-sm text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
          >
            <ArrowLeft className="w-4 h-4" />
            返回首页
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-5">
        {/* 高级模式 toggle */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <button
            type="button"
            onClick={() => updateSettings({ advancedMode: !advancedMode })}
            className="w-full flex items-center justify-between text-left"
          >
            <div>
              <div className="flex items-center gap-2 mb-1">
                {advancedMode ? (
                  <ToggleRight className="w-6 h-6 text-indigo-600" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-slate-400" />
                )}
                <span className="font-semibold text-slate-800">高级模式</span>
              </div>
              <p className="text-xs text-slate-500 pl-8">
                {advancedMode
                  ? '已解锁自定义 OpenAI 兼容端点、MinerU / 词典高级选项'
                  : '关闭时使用预置的硅基流动配置，最省心；开启后可自定义 AI 端点'}
              </p>
            </div>
          </button>
        </section>

        {/* AI 服务提供方（高级模式时可切） */}
        {advancedMode && (
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-600" />
              AI 服务提供方
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {(['siliconflow', 'custom'] as AIProviderMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => updateSettings({ aiProviderMode: mode })}
                  className={`px-3 py-2 text-sm rounded-md border transition ${
                    aiProviderMode === mode
                      ? 'bg-indigo-50 border-indigo-400 text-indigo-800 font-medium'
                      : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
                  }`}
                >
                  {mode === 'siliconflow' ? '硅基流动（预置）' : '自定义端点'}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* 硅基流动配置 */}
        {aiProviderMode === 'siliconflow' && (
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                硅基流动（AI-1 + AI-2 共用）
              </h2>
              <a
                href="https://cloud.siliconflow.cn/account/ak"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-indigo-600 hover:text-indigo-800"
              >
                去获取 API Key →
              </a>
            </div>

            <APIKeyInput
              label="硅基流动 API Key"
              fieldId="siliconflow"
              value={siliconflowApiKey}
              onChange={(v) => updateSettings({ siliconflowApiKey: v })}
              hint="仅存在你浏览器的 IndexedDB，不上传任何服务器"
            />

            {/* 拉取模型清单 */}
            <div className="flex items-center justify-between pt-1">
              <div className="text-xs text-slate-500">
                模型清单：{chatModels.length} 个 chat 类 · 上次更新{' '}
                <span className="font-mono">{formatFetchedAt(siliconflowModelsFetchedAt)}</span>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isLoadingModels || !siliconflowApiKey.trim()}
                className="flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-300 rounded-md
                           hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
              >
                {isLoadingModels ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                拉取
              </button>
            </div>

            {/* AI-1 / AI-2 模型下拉 */}
            <div className="grid md:grid-cols-2 gap-3">
              <ModelSelect
                label="AI-1（生成位）"
                value={ai1Model}
                options={chatModels}
                onChange={(v) => updateSettings({ ai1Model: v })}
              />
              <ModelSelect
                label="AI-2（审阅位）"
                value={ai2Model}
                options={chatModels}
                onChange={(v) => updateSettings({ ai2Model: v })}
              />
            </div>
            <p className="text-xs text-slate-500">
              按 SPEC §9.2，AI-1 负责生成，AI-2 全量审阅 AI-1 输出。推荐生成位用 Qwen2.5-72B、审阅位用 DeepSeek-R1（可切换）。
            </p>
          </section>
        )}

        {/* 自定义端点 */}
        {showCustom && (
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-600" />
              自定义 OpenAI 兼容端点
            </h2>

            {/* AI-1 */}
            <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-md">
              <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                AI-1（生成位）
              </div>
              <input
                type="text"
                value={customAi1BaseUrl}
                onChange={(e) => updateSettings({ customAi1BaseUrl: e.target.value })}
                placeholder="Base URL，如 https://api.openai.com/v1"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <APIKeyInput
                label="API Key"
                fieldId="custom-ai1"
                value={customAi1ApiKey}
                onChange={(v) => updateSettings({ customAi1ApiKey: v })}
              />
              <input
                type="text"
                value={customAi1Model}
                onChange={(e) => updateSettings({ customAi1Model: e.target.value })}
                placeholder="Model ID，如 gpt-4o-mini"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* AI-2 */}
            <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-md">
              <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                AI-2（审阅位）
              </div>
              <input
                type="text"
                value={customAi2BaseUrl}
                onChange={(e) => updateSettings({ customAi2BaseUrl: e.target.value })}
                placeholder="Base URL"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <APIKeyInput
                label="API Key"
                fieldId="custom-ai2"
                value={customAi2ApiKey}
                onChange={(v) => updateSettings({ customAi2ApiKey: v })}
              />
              <input
                type="text"
                value={customAi2Model}
                onChange={(e) => updateSettings({ customAi2Model: e.target.value })}
                placeholder="Model ID"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </section>
        )}

        {/* 双引擎试运行 */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-green-600" />
            双引擎试运行（fact_check）
          </h2>
          <p className="text-xs text-slate-500">
            用当前配置跑一次事实核查任务，验证 AI-1 生成 + AI-2 审阅链路。
          </p>
          <DualEngineTestPanel />
        </section>

        {/* MinerU 全流程测试（M3.7） */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            MinerU 全流程测试（PDF → Markdown）
          </h2>
          <p className="text-xs text-slate-500">
            填入 Token → 选一份 PDF → 一键跑完申请上传 URL / 上传 / 轮询解析 / 下载 / 前端解压 5 步。
            用于验证 MinerU 服务可用性和网络链路，产物可预览下载。
          </p>
          <MineruTestPanel />
        </section>

        <div className="text-center text-xs text-slate-400 pt-4">
          所有凭据仅存本机 IndexedDB · License AGPL-3.0-or-later · Stage M3
        </div>
      </main>
    </div>
  )
}

/** 模型下拉子组件 */
function ModelSelect(props: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-700">{props.label}</label>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                   focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
      >
        {props.options.length === 0 ? (
          <option value={props.value}>{props.value || '（点击右上"拉取"载入模型清单）'}</option>
        ) : (
          props.options.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))
        )}
      </select>
    </div>
  )
}

export default Settings
