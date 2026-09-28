/**
 * 课程表（左栏）
 * -------------------------------------------------
 * - 默认列：周一~周五；「调休日」为它们的周末日期各加一列（标题带「周X · 调休 MM-DD」）。
 * - 每列按 start_time 排序展示课程，可加课 / 删课；调休日可增删。
 * 数据落库全部交给页面（Schedule.tsx），本组件只负责呈现与收集输入。
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import type { Course, ExtraDay } from '../../services/scheduleData'
import { weekdayOfDate } from '../../services/scheduleData'
import { CourseFormModal, type CourseFormValue } from './CourseFormModal'
import { ExtraDayModal } from './ExtraDayModal'

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

interface Column {
  key: string
  weekday: number
  label: string
}

export function CourseTable({
  courses,
  extraDays,
  onAddCourse,
  onDeleteCourse,
  onAddExtraDay,
  onDeleteExtraDay,
}: {
  courses: Course[]
  extraDays: ExtraDay[]
  onAddCourse: (weekday: number, value: CourseFormValue) => void
  onDeleteCourse: (courseId: string) => void
  onAddExtraDay: (date: string, note: string) => void
  onDeleteExtraDay: (date: string) => void
}) {
  const [formWeekday, setFormWeekday] = useState<number | null>(null)
  const [showExtra, setShowExtra] = useState(false)

  const columns: Column[] = [
    ...[1, 2, 3, 4, 5].map((w) => ({ key: `w${w}`, weekday: w, label: WEEKDAY_LABELS[w] })),
    ...extraDays.map((d) => {
      const wd = weekdayOfDate(d.date)
      return {
        key: `x_${d.date}`,
        weekday: wd,
        // 调休是按具体日期加的，标题带上日期才不会和常规周列混淆
        label: `${WEEKDAY_LABELS[wd] || '调休'} · 调休 ${d.date.slice(5)}`,
      }
    }),
  ]

  const coursesOf = (weekday: number) =>
    courses
      .filter((c) => c.weekday === weekday)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))

  return (
    <section className="rounded-xl border border-ink-200 bg-paper-50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-ink-800">课程表</h2>
        <button
          onClick={() => setShowExtra(true)}
          className="text-xs text-ink-500 hover:text-seal-600 px-2 py-1 rounded border border-ink-200 hover:border-seal-300 transition"
        >
          + 添加调休日
        </button>
      </div>

      {extraDays.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {extraDays.map((d) => (
            <span
              key={d.date}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-seal-100 text-seal-700 text-xs rounded-full"
            >
              {d.date}
              {d.note ? ` · ${d.note}` : ''}
              <button
                onClick={() => onDeleteExtraDay(d.date)}
                className="hover:text-seal-900"
                aria-label={`删除调休日 ${d.date}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-1">
        {columns.map((col) => {
          const list = coursesOf(col.weekday)
          return (
            <div key={col.key} className="flex-1 min-w-[9rem] flex flex-col">
              <div className="flex items-center justify-between gap-1 mb-2">
                <span className="text-xs font-semibold text-ink-600 truncate">{col.label}</span>
                <button
                  onClick={() => setFormWeekday(col.weekday)}
                  className="shrink-0 text-xs text-ink-400 hover:text-seal-600 transition"
                  aria-label={`给 ${col.label} 加课`}
                >
                  + 加课
                </button>
              </div>
              <div className="space-y-2 flex-1">
                {list.length === 0 ? (
                  <p className="text-xs text-ink-300 py-3 text-center">暂无课程</p>
                ) : (
                  list.map((c) => (
                    <div
                      key={c.courseId}
                      className="group rounded-lg border border-ink-200 bg-paper-100 p-2.5"
                    >
                      <div className="flex items-start justify-between gap-1">
                        <span className="text-sm font-medium text-ink-800 break-words">
                          {c.title}
                        </span>
                        <button
                          onClick={() => onDeleteCourse(c.courseId)}
                          className="shrink-0 opacity-0 group-hover:opacity-100 text-ink-400 hover:text-seal-600 transition"
                          aria-label={`删除课程 ${c.title}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="mt-1 text-xs text-ink-500 font-mono">
                        {c.startTime}–{c.endTime}
                      </div>
                      {c.location && (
                        <div className="mt-0.5 text-xs text-ink-400 truncate">{c.location}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {formWeekday !== null && (
        <CourseFormModal
          weekdayLabel={WEEKDAY_LABELS[formWeekday] || `周${formWeekday}`}
          onClose={() => setFormWeekday(null)}
          onSubmit={(value) => {
            onAddCourse(formWeekday, value)
            setFormWeekday(null)
          }}
        />
      )}

      {showExtra && (
        <ExtraDayModal
          onClose={() => setShowExtra(false)}
          onSubmit={(date, note) => {
            onAddExtraDay(date, note)
            setShowExtra(false)
          }}
        />
      )}
    </section>
  )
}
