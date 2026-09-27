/**
 * 追踪候选（inbox）服务
 * -------------------------------------------------
 * 「每日追踪」**不再直接把命中的文献塞进文献库**，而是写成「候选」，由用户逐条裁决：
 *   - 右滑 / 点「入库」 → 进 literatures/literatures.csv
 *   - 左滑 / 点「忽略」 → 标记 dismissed（保留行，防止第二天又被追踪命中重新冒出来）
 *
 * 落点：tracking/inbox.csv（私库，md+csv 铁律）
 *
 * 列契约（前后端共享，**改动必须两边同步**）：
 *   doi,title,journal,year,authors,keywords,abstract_en,source,tracking_group,found_at,status
 * status ∈ pending | dismissed
 * 新列一律**追加在末尾**，旧行缺列给安全默认。
 */
import { readCsvFile, writeCsvFile } from './userData'

export interface TrackingCandidate {
  doi: string
  title: string
  journal: string
  year: number
  authors: string
  keywords: string
  abstractEn: string
  source: string
  trackingGroup: string
  /** 被追踪命中的时间（Unix 秒） */
  foundAt: number
  status: 'pending' | 'dismissed'
}

export const TRACKING_INBOX_PATH = 'tracking/inbox.csv'

/** 与后端 daily_tracking.py 的 INBOX_HEADERS 必须逐字一致（顺序也一致） */
export const TRACKING_INBOX_HEADERS = [
  'doi', 'title', 'journal', 'year', 'authors', 'keywords', 'abstract_en',
  'source', 'tracking_group', 'found_at', 'status',
]

export async function loadTrackingInbox(force = false): Promise<TrackingCandidate[]> {
  return readCsvFile<TrackingCandidate>(
    TRACKING_INBOX_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows
        .slice(1)
        .filter((r) => (r[0] || '').trim())
        .map((r) => ({
          doi: r[0] || '',
          title: r[1] || '',
          journal: r[2] || '',
          year: parseInt(r[3] || '0', 10) || 0,
          authors: r[4] || '',
          keywords: r[5] || '',
          abstractEn: r[6] || '',
          source: r[7] || '',
          trackingGroup: r[8] || '',
          foundAt: parseInt(r[9] || '0', 10) || 0,
          status: r[10] === 'dismissed' ? 'dismissed' : 'pending',
        }))
    },
    force,
  )
}

export async function saveTrackingInbox(rows: TrackingCandidate[]): Promise<void> {
  await writeCsvFile(
    TRACKING_INBOX_PATH,
    rows,
    TRACKING_INBOX_HEADERS,
    (c) => [
      c.doi, c.title, c.journal, String(c.year), c.authors, c.keywords,
      c.abstractEn, c.source, c.trackingGroup, String(c.foundAt), c.status,
    ],
  )
}

/** 只取「待裁决」的候选 */
export function pendingCandidates(rows: TrackingCandidate[]): TrackingCandidate[] {
  return rows.filter((r) => r.status === 'pending')
}
