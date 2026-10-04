/**
 * 会议/课程页 · 左栏：本页「会话归属」选择器（固定，不可移动）
 * -------------------------------------------------
 * 统一口径（同管理页，见 架构.md ADJ-105 / ADJ-110）只给三类：
 *   ① 全部（全局）
 *   ② 当前任务所属大类（研究 / 课程）
 *   ③ 当前任务及其全部分支（可逐级展开子任务）
 * 关键：**在这里选分支不会改变全局「当前任务」**——只改本页会话的归属，
 * 把这边record下的东西（转写 / 图片）真实落到所选分支任务层级里。
 * 选项结构由 buildTaskFilterOptions 统一生成（全站同一真源）。
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ListTree } from 'lucide-react'
import { buildTaskFilterOptions, type Project, type TaskFilterOption } from '../../services/projectData'
import { Panel, PanelHeader, PanelBody, EmptyState } from '../ui/Panel'

export default function SessionTaskTree({
  projects,
  currentId,
  selectedScope,
  isLoading,
  onSelect,
}: {
  projects: Project[]
  currentId: string | null
  /** 本页当前选中的归属 value：'all' | 'cat:research' | 'cat:course' | 'node:<projectId>' */
  selectedScope: string
  isLoading: boolean
  onSelect: (scope: string) => void
}) {
  const options = buildTaskFilterOptions(projects, currentId)

  // 第三类（当前任务及其分支）默认展开，方便直接选到某节课 / 某个子任务
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (currentId) setExpanded(new Set([`node:${currentId}`]))
  }, [currentId])

  // 只渲染展开链路上的选项（与管理页任务面板同一套折叠算法）
  const visible: TaskFilterOption[] = []
  const collapsed = new Set<string>()
  for (const opt of options) {
    if (opt.parent && collapsed.has(opt.parent)) {
      if (opt.hasChildren) collapsed.add(opt.value)
      continue
    }
    visible.push(opt)
    if (opt.hasChildren && !expanded.has(opt.value)) collapsed.add(opt.value)
  }

  return (
    <Panel>
      <PanelHeader icon={<ListTree />} title="会话归属" />
      <PanelBody>
        {isLoading ? (
          <p className="py-6 text-center text-ui-xs text-ink-400">加载中…</p>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<ListTree />}
            title="还没有任务"
            hint={
              <Link to="/schedule" className="text-seal-600 hover:underline">
                去日程页新建 →
              </Link>
            }
          />
        ) : (
          <div className="space-y-0.5">
            {visible.map((opt) => {
              const isActive = selectedScope === opt.value
              const isExpanded = expanded.has(opt.value)
              return (
                <div
                  key={opt.value}
                  className="flex items-center gap-0.5"
                  style={{ paddingLeft: `${opt.depth * 0.75}rem` }}
                >
                  {opt.hasChildren ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(opt.value)) next.delete(opt.value)
                          else next.add(opt.value)
                          return next
                        })
                      }
                      title={isExpanded ? '折叠子任务' : '展开子任务'}
                      className="shrink-0 rounded-control-sm p-0.5 text-ink-400 transition hover:bg-paper-100 hover:text-ink-600"
                    >
                      <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    </button>
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  <button
                    type="button"
                    onClick={() => onSelect(opt.value)}
                    className={`flex min-w-0 flex-1 items-center rounded-control px-2 py-1.5 text-left transition ${
                      isActive ? 'bg-seal-50 text-seal-700 font-medium' : 'text-ink-600 hover:bg-paper-100'
                    }`}
                  >
                    <span className="flex-1 truncate text-ui-sm">{opt.label}</span>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
