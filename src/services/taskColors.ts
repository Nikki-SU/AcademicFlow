/**
 * 任务配色（DDL 清单用）
 * -------------------------------------------------
 * 目的：DDL 清单是**扁平**的（按 dueAt 排序，不按层级堆叠），层级只靠缩进体现。
 * 为了让「同一棵子树」在一堆平铺的 DDL 里还能被一眼归堆，按**根任务**着色：
 * 同根同色、不同根不同色。色由 rootId 稳定映射（对 id 做 hash 取模），
 * 所以同一任务在任何设备、任何会话看到的颜色都一致。
 */
import type { Project } from './projectData'

/** 一组 Tailwind 类名（text / bg / border 三件套），页面各处共用同一份 */
export interface RootColor {
  text: string
  bg: string
  border: string
}

/**
 * 调色板：低饱和的莫兰迪 / 墨色，与 paper-* / ink-* / seal-* 的雅致基调协调。
 * ⚠️ 必须是**完整字面量类名**，不能运行时拼字符串 —— Tailwind 的 JIT 靠扫描
 *    源码里的字面量生成 CSS，拼出来的 `text-[${hex}]` 不会被收录。
 */
const PALETTE: RootColor[] = [
  { text: 'text-[#5B6B7C]', bg: 'bg-[#5B6B7C]', border: 'border-[#5B6B7C]' },
  { text: 'text-[#6E8672]', bg: 'bg-[#6E8672]', border: 'border-[#6E8672]' },
  { text: 'text-[#A07C6C]', bg: 'bg-[#A07C6C]', border: 'border-[#A07C6C]' },
  { text: 'text-[#8C7290]', bg: 'bg-[#8C7290]', border: 'border-[#8C7290]' },
  { text: 'text-[#B08A5E]', bg: 'bg-[#B08A5E]', border: 'border-[#B08A5E]' },
  { text: 'text-[#5F8585]', bg: 'bg-[#5F8585]', border: 'border-[#5F8585]' },
  { text: 'text-[#9A8A6E]', bg: 'bg-[#9A8A6E]', border: 'border-[#9A8A6E]' },
  { text: 'text-[#7B7396]', bg: 'bg-[#7B7396]', border: 'border-[#7B7396]' },
  { text: 'text-[#7C8A5E]', bg: 'bg-[#7C8A5E]', border: 'border-[#7C8A5E]' },
  { text: 'text-[#A07E7E]', bg: 'bg-[#A07E7E]', border: 'border-[#A07E7E]' },
]

/** 简单字符串 hash（djb2 变体），保证同一 rootId 稳定取到同一颜色 */
function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * 沿 parentId 上溯到根任务 id。
 * 遇到环（异常数据）或父节点缺失时兜底返回自身，绝不死循环。
 */
export function getRootId(project: Project, byId: Map<string, Project>): string {
  const seen = new Set<string>()
  let cur = project
  while (cur.parentId) {
    if (seen.has(cur.projectId)) return project.projectId // 环：兜底
    seen.add(cur.projectId)
    const parent = byId.get(cur.parentId)
    if (!parent) return project.projectId // 父节点缺失：兜底
    cur = parent
  }
  return cur.projectId
}

/** 按 rootId 稳定取色 */
export function colorForRoot(rootId: string): RootColor {
  return PALETTE[hashString(rootId) % PALETTE.length]
}
