/**
 * 关键词组服务
 * -------------------------------------------------
 * SPEC §5.1：追踪用关键词组存储在 keyword_groups/keyword_groups.csv
 */

import { readCsvFile, writeCsvFile } from './userData'

export interface KeywordGroup {
  groupId: string
  groupName: string
  expression: string
  enabled: boolean
  translateAbstract: boolean
  createdAt: number
}

const KEYWORD_GROUPS_PATH = 'keyword_groups/keyword_groups.csv'
const KEYWORD_GROUP_HEADERS = [
  'group_id', 'group_name', 'expression', 'enabled',
  'translate_abstract', 'created_at',
]

export async function loadKeywordGroups(force = false): Promise<KeywordGroup[]> {
  return readCsvFile(
    KEYWORD_GROUPS_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        groupId: r[0] || '',
        groupName: r[1] || '',
        expression: r[2] || '',
        enabled: r[3] === 'true',
        translateAbstract: r[4] === 'true',
        createdAt: parseInt(r[5] || '0', 10),
      }))
    },
    force,
  )
}

export async function saveKeywordGroups(groups: KeywordGroup[]): Promise<void> {
  await writeCsvFile(
    KEYWORD_GROUPS_PATH,
    groups,
    KEYWORD_GROUP_HEADERS,
    (g) => [
      g.groupId,
      g.groupName,
      g.expression,
      String(g.enabled),
      String(g.translateAbstract),
      String(g.createdAt),
    ],
  )
}
