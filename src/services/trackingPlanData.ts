/**
 * 定时追踪计划服务
 * -------------------------------------------------
 * 一个「追踪计划」= 时间规则 + 多个期刊（组内 OR）+ 一个关键词布尔表达式。
 * 与「立即追踪」共用同一套后端管线（daily_tracking.py），**不单独造管线**；
 * 但关键词表达式允许计划自己定义（可从现成关键词组拷贝，也可手写）。
 *
 * 落点：tracking/plans.csv（私库，md+csv 铁律）
 *
 * 列契约（前后端共享，**改动必须两边同步**）：
 *   plan_id,plan_name,enabled,interval,hour,minute,weekdays,day_of_month,journal_ids,expression,translate_abstract,last_run_date,created_at
 *   - interval ∈ daily | weekly | semimonthly | monthly
 *   - hour / minute 为**北京时间**
 *   - weekdays 逗号分隔（1-7，周一=1；仅 weekly 用）
 *   - day_of_month 为 1-28（仅 monthly 用）；semimonthly 固定「月初 1 日 + 月中 15 日」，不占此列
 *   - journal_ids 逗号分隔（组内 OR），引用 journals/journal_tracking.csv 的 id
 *   - last_run_date 由后端回写（YYYY-MM-DD），用于到期判断 / 当天防重
 */
import { readCsvFile, writeCsvFile } from './userData'

export type PlanInterval = 'daily' | 'weekly' | 'semimonthly' | 'monthly'

/** 「每半个月」的固定运行日：月初 1 日 + 月中 15 日（二者恰好相隔 14 天） */
export const SEMIMONTHLY_DAYS = [1, 15]

export interface TrackingPlan {
  planId: string
  planName: string
  enabled: boolean
  interval: PlanInterval
  /** 北京时间 0-23 */
  hour: number
  /** 北京时间 0-59 */
  minute: number
  /** 仅 weekly 用：1-7（周一=1）；其余场景为空数组 */
  weekdays: number[]
  /** monthly 用：1-28；其余场景为 0 */
  dayOfMonth: number
  /** 期刊 id 列表（组内 OR），引用 journals/journal_tracking.csv */
  journalIds: string[]
  /** 该计划自己的关键词布尔表达式（与 keywordGroupData 语法同源） */
  expression: string
  translateAbstract: boolean
  /** 后端回写：上次运行日期 YYYY-MM-DD；空串 = 从未运行 */
  lastRunDate: string
  createdAt: number
}

export const TRACKING_PLANS_PATH = 'tracking/plans.csv'

/** 与后端 daily_tracking.py 的 PLAN_HEADERS 必须逐字一致（顺序也一致） */
export const TRACKING_PLAN_HEADERS = [
  'plan_id', 'plan_name', 'enabled', 'interval', 'hour', 'minute',
  'weekdays', 'day_of_month', 'journal_ids', 'expression',
  'translate_abstract', 'last_run_date', 'created_at',
]

export const PLAN_INTERVALS: { value: PlanInterval; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'semimonthly', label: '每半个月' },
  { value: 'monthly', label: '每月' },
]

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function parseInterval(v: string): PlanInterval {
  const hit = PLAN_INTERVALS.find((i) => i.value === v)
  return hit ? hit.value : 'daily'
}

function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = parseInt((v || '').trim(), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function parseIntList(v: string): number[] {
  return v
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
}

function parseStrList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

export async function loadTrackingPlans(force = false): Promise<TrackingPlan[]> {
  return readCsvFile<TrackingPlan>(
    TRACKING_PLANS_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows
        .slice(1)
        .filter((r) => (r[0] || '').trim())
        .map((r) => ({
          planId: r[0] || '',
          planName: r[1] || '',
          enabled: r[2] === 'true' || r[2] === '1',
          interval: parseInterval(r[3] || ''),
          hour: clampInt(r[4], 0, 23, 9),
          minute: clampInt(r[5], 0, 59, 0),
          weekdays: parseIntList(r[6] || ''),
          dayOfMonth: (r[7] || '').trim() ? clampInt(r[7], 1, 28, 1) : 0,
          journalIds: parseStrList(r[8] || ''),
          expression: r[9] || '',
          translateAbstract: r[10] === 'true' || r[10] === '1',
          lastRunDate: r[11] || '',
          createdAt: parseInt(r[12] || '0', 10) || 0,
        }))
    },
    force,
  )
}

export async function saveTrackingPlans(plans: TrackingPlan[]): Promise<void> {
  await writeCsvFile(
    TRACKING_PLANS_PATH,
    plans,
    TRACKING_PLAN_HEADERS,
    (p) => [
      p.planId,
      p.planName,
      p.enabled ? 'true' : 'false',
      p.interval,
      String(p.hour),
      String(p.minute),
      p.interval === 'weekly' ? p.weekdays.join(',') : '',
      p.interval === 'monthly' ? String(p.dayOfMonth) : '',
      p.journalIds.join(','),
      p.expression,
      p.translateAbstract ? 'true' : 'false',
      p.lastRunDate || '',
      String(p.createdAt || Date.now()),
    ],
  )
}

export function weekdayLabel(n: number): string {
  const idx = Math.min(Math.max(n, 1), 7) - 1
  return WEEKDAY_LABELS[idx]
}

/** 人类可读的时间规则，如「每周·周一 09:00」 */
export function describeSchedule(p: TrackingPlan): string {
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  switch (p.interval) {
    case 'weekly':
      return `每周·${weekdayLabel(p.weekdays[0] || 1)} ${time}`
    case 'semimonthly':
      return `每半个月·${SEMIMONTHLY_DAYS.join('日/')}日 ${time}`
    case 'monthly':
      return `每月${p.dayOfMonth}日 ${time}`
    default:
      return `每天 ${time}`
  }
}

/**
 * 启用计划实际用到的**完整 5 段 cron**（去重、排序），形如 "0 1 * * 1"。
 * 用于前端按需重写 workflow 的 schedule —— 只在实际需要的**日子 + 时刻**排 cron，
 * 不为「今天没有任何计划到期」的日子空跑 job（省 Actions 额度、控制必要性）。
 *
 * 北京时间 = UTC+8，且无夏令时，故 utcHour = (hour + 16) % 24。
 * 若北京时间小时 < 8，则对应的 UTC 时刻落在**前一天**，因此 cron 的 dom / dow
 * 都要退 1 天（这里按此换算）。
 *
 * 边界说明：
 *   - monthly 且「退一天后退到 0」（即每月 1 日 + 凌晨）无法用 cron 表达，
 *     退回每天（`*`），再由脚本内的到期探针 is_plan_due 兜底判断；
 *   - semimonthly 同理：月初 1 日 + 凌晨退一天会退到上月末（非固定号数），无法表达，
 *     此时整体退回每天（`*`），隔日判断交给探针。
 *
 * 无论 cron 排得多准，脚本内的到期探针仍是**最终闸门**（双保险）。
 */
export function planCronSpecs(plans: TrackingPlan[]): string[] {
  const set = new Set<string>()
  for (const p of plans) {
    if (!p.enabled) continue
    const utcHour = (p.hour + 16) % 24
    const shift = p.hour < 8 ? -1 : 0
    let dom = '*'
    let dow = '*'
    if (p.interval === 'monthly') {
      const d = p.dayOfMonth + shift
      dom = d >= 1 ? String(d) : '*'
    } else if (p.interval === 'semimonthly') {
      const days = SEMIMONTHLY_DAYS.map((d) => d + shift)
      dom = days.every((d) => d >= 1) ? days.join(',') : '*'
    } else if (p.interval === 'weekly') {
      const jsDow = (p.weekdays[0] || 1) % 7 // 周一=1 … 周日=0
      dow = String(((jsDow + shift) % 7 + 7) % 7)
    }
    set.add(`${p.minute} ${utcHour} ${dom} * ${dow}`)
  }
  return [...set].sort(cronSpecCmp)
}

/** cron 排序：先小时、再分钟、再 dom、再 dow；`*` 视为 -1（排最前） */
function cronSpecCmp(a: string, b: string): number {
  const [am, ah, ad, , aw] = a.split(' ')
  const [bm, bh, bd, , bw] = b.split(' ')
  const num = (v: string) => (v === '*' ? -1 : Number(v.split(',')[0]))
  return (
    Number(ah) - Number(bh) ||
    Number(am) - Number(bm) ||
    num(ad) - num(bd) ||
    num(aw) - num(bw)
  )
}

const BJ_OFFSET_MS = 8 * 3600 * 1000

/** 把「北京墙上时间」拼回真实 UTC 时刻 */
function fromBeijingWall(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo, d, h, mi) - BJ_OFFSET_MS)
}

function beijingToday(from: Date): { y: number; mo: number; d: number } {
  const t = new Date(from.getTime() + BJ_OFFSET_MS)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() }
}

/** 该计划的「下次运行」时刻（北京墙上时间对应真实 UTC Date）；禁用返回 null */
export function nextRunAt(p: TrackingPlan, from: Date = new Date()): Date | null {
  if (!p.enabled) return null
  const { y, mo, d } = beijingToday(from)

  const jsWeekday = (p.weekdays[0] || 1) % 7 // 1-7(周一=1) → JS 0-6(周日=0)

  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(Date.UTC(y, mo, d + offset))
    const wd = day.getUTCDay()
    const dom = day.getUTCDate()

    let match = false
    if (p.interval === 'daily') match = true
    else if (p.interval === 'weekly') match = wd === jsWeekday
    else if (p.interval === 'semimonthly') match = SEMIMONTHLY_DAYS.includes(dom)
    else if (p.interval === 'monthly') match = dom === p.dayOfMonth
    if (!match) continue

    const cand = fromBeijingWall(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), p.hour, p.minute)
    if (cand.getTime() > from.getTime()) return cand
  }
  return null
}

/** 校验计划时间规则，返回可读错误信息；合法返回 null */
export function validatePlan(p: TrackingPlan): string | null {
  if (!p.planName.trim()) return '请填写计划名称'
  if (p.hour < 0 || p.hour > 23) return '小时需在 0-23 之间'
  if (p.minute < 0 || p.minute > 59) return '分钟需在 0-59 之间'
  if (p.interval === 'weekly') {
    if (!(p.weekdays[0] >= 1 && p.weekdays[0] <= 7)) return '请选择星期几'
  }
  if (p.interval === 'monthly') {
    if (!(p.dayOfMonth >= 1 && p.dayOfMonth <= 28)) return '请选择每月 1-28 之间的日期'
  }
  if (p.journalIds.length === 0 && !p.expression.trim()) {
    return '至少选择一个期刊，或填写一个关键词表达式'
  }
  return null
}

/** 生成计划 id */
export function newPlanId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
