/**
 * 中国法定节假日（在线获取）
 * -------------------------------------------------
 * 数据源：holiday-cn（GitHub：NateScarlet/holiday-cn）——每年由政府公告生成的公开数据集，
 * 每条 `{ name, date, isOffDay }`：
 *   - isOffDay = true  → 法定放假（当天不上课）
 *   - isOffDay = false → 调休补班（那天是周末但要上班/上课）
 * 优先走 jsDelivr CDN，失败退回 raw.githubusercontent.com（已在 CSP 白名单）。
 *
 * 定位：这是**公共参考数据**，不是业务数据 —— 只读、在途、不落私库（架构 §1.3 JSON 仅 HTTP 在途）；
 * 本地用 localStorage 做 7 天缓存，避免每次启动都打网络。数据缺失时一律当「普通日」放行。
 */
const YEAR_URLS = [
  (y: number) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
  (y: number) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`,
]

export interface HolidayDay {
  name: string
  /** YYYY-MM-DD */
  date: string
  /** true=放假；false=调休补班 */
  isOffDay: boolean
}

export type HolidayMap = Map<string, HolidayDay>

const CACHE_TTL = 7 * 24 * 3600 * 1000
const memCache = new Map<number, HolidayMap>()

const cacheKey = (year: number) => `af.holidays.${year}`

function readLocal(year: number): HolidayMap | null {
  try {
    const raw = localStorage.getItem(cacheKey(year))
    if (!raw) return null
    const obj = JSON.parse(raw) as { at: number; days: HolidayDay[] }
    if (!obj?.at || Date.now() - obj.at > CACHE_TTL || !Array.isArray(obj.days)) return null
    return new Map(obj.days.map((d) => [d.date, d]))
  } catch {
    return null
  }
}

function writeLocal(year: number, days: HolidayDay[]): void {
  try {
    localStorage.setItem(cacheKey(year), JSON.stringify({ at: Date.now(), days }))
  } catch {
    /* 缓存写失败无所谓 */
  }
}

/**
 * 拉取某年的节假日表（内存 → localStorage → 网络）。
 * 任何一步失败都返回空表（当作没有节假日数据），绝不抛出、不阻断课表。
 */
export async function loadYearHolidays(year: number, force = false): Promise<HolidayMap> {
  if (!force && memCache.has(year)) return memCache.get(year)!
  if (!force) {
    const local = readLocal(year)
    if (local) {
      memCache.set(year, local)
      return local
    }
  }
  for (const make of YEAR_URLS) {
    try {
      const res = await fetch(make(year), { cache: 'no-store' })
      if (!res.ok) continue
      const data = (await res.json()) as { days?: HolidayDay[] }
      const days = (data.days ?? []).filter((d) => d && d.date)
      const map: HolidayMap = new Map(days.map((d) => [d.date, d]))
      memCache.set(year, map)
      writeLocal(year, days)
      return map
    } catch (err) {
      console.warn('[holiday] 拉取节假日失败:', err)
    }
  }
  const fallback: HolidayMap = memCache.get(year) ?? new Map()
  return fallback
}

/** 今天的日期串 YYYY-MM-DD（本地时区） */
export function todayDateStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}