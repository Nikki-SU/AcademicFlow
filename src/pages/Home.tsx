/**
 * 工作台首页
 * 功能概览 + 快捷入口 + 最近活动
 */
import {
  LayoutDashboard,
  Sparkles,
  TrendingUp,
  BookOpen,
  Clock,
  ArrowRight,
} from 'lucide-react'
import { Link } from 'react-router-dom'

export default function HomePage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* 欢迎区 */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <LayoutDashboard className="w-6 h-6 text-indigo-600" />
          工作台
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          学术工作全链路 · 追踪 → 管理 → 阅读 → 学习 → 写作 → 投稿
        </p>
      </div>

      {/* 快捷统计卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: '文献库', count: 0, icon: BookOpen, path: '/library', color: 'bg-blue-50 text-blue-600' },
          { label: '今日追踪', count: 0, icon: TrendingUp, path: '/tracking', color: 'bg-green-50 text-green-600' },
          { label: '待复习单词', count: 0, icon: Sparkles, path: '/learn', color: 'bg-amber-50 text-amber-600' },
          { label: '活跃项目', count: 0, icon: Clock, path: '/writing', color: 'bg-purple-50 text-purple-600' },
        ].map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.path}
              to={item.path}
              className="group p-4 bg-white border border-slate-200 rounded-xl hover:shadow-md hover:border-indigo-200 transition-all"
            >
              <div className="flex items-center justify-between mb-2">
                <div className={`p-1.5 rounded-lg ${item.color}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-400 transition" />
              </div>
              <div className="text-2xl font-bold text-slate-800">{item.count}</div>
              <div className="text-xs text-slate-500">{item.label}</div>
            </Link>
          )
        })}
      </div>

      {/* 最近活动 + 快速开始 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 快速开始 */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-800 mb-4">快速开始</h2>
          <div className="space-y-2">
            {[
              { label: '配置关键词组，开启文献追踪', path: '/tracking', action: '去配置' },
              { label: '上传 PDF，转换为 Markdown', path: '/pdf-to-md', action: '去上传' },
              { label: '管理期刊模板，准备投稿', path: '/compile', action: '去管理' },
              { label: '配置 AI 服务与 API Key', path: '/settings', action: '去设置' },
            ].map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 transition group"
              >
                <span className="text-sm text-slate-600">{item.label}</span>
                <span className="text-xs text-indigo-600 opacity-0 group-hover:opacity-100 transition">
                  {item.action} →
                </span>
              </Link>
            ))}
          </div>
        </div>

        {/* 最近活动 */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-800 mb-4">最近活动</h2>
          <div className="text-center py-8 text-slate-400">
            <Clock className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">暂无活动记录</p>
            <p className="text-xs mt-1">开始使用后，这里会显示最近的操作</p>
          </div>
        </div>
      </div>
    </div>
  )
}
