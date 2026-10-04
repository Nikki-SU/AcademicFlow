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

// ============================================================
// 关键词布尔表达式：语法与后端 daily_tracking.py 的
// tokenize_expression / evaluate_expression **逐字对齐**。
//   expr := or
//   or   := and ( OR and )*
//   and  := not ( AND? not )*      # 相邻词之间省略 AND 也视为 AND
//   not  := NOT not | atom
//   atom := '(' expr ')' | TERM
// 运算符须大写；TERM 为不含空白/括号/引号的裸词，或双引号包裹的短语。
// 前端只负责「拼装 / 序列化 / 约束校验」，真正的求值在后端做，
// 保证界面所见与检索端语义一致（先约束，再容错）。
// ============================================================

export type ExprToken =
  | { kind: 'term'; value: string }
  | { kind: 'op'; value: 'AND' | 'OR' | 'NOT' | '(' | ')' }

const OPERATOR_WORDS = ['AND', 'OR', 'NOT']

/** 表达式字符串 → token 序列（同后端 tokenize_expression） */
export function parseExpression(expr: string): ExprToken[] {
  const tokens: ExprToken[] = []
  const s = expr
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'op', value: '(' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'op', value: ')' })
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let buf = ''
      while (j < s.length && s[j] !== '"') {
        buf += s[j]
        j++
      }
      const value = buf.trim()
      if (value) tokens.push({ kind: 'term', value })
      i = j + 1
      continue
    }
    let j = i
    let buf = ''
    while (j < s.length && !/\s/.test(s[j]) && !'()"'.includes(s[j])) {
      buf += s[j]
      j++
    }
    i = j
    if (!buf) continue
    if (OPERATOR_WORDS.includes(buf)) {
      tokens.push({ kind: 'op', value: buf as 'AND' | 'OR' | 'NOT' })
    } else {
      tokens.push({ kind: 'term', value: buf })
    }
  }
  return tokens
}

/** token 序列 → 表达式字符串（含空白/括号的词用双引号包裹） */
export function serializeExpression(tokens: ExprToken[]): string {
  return tokens
    .map((t) => {
      if (t.kind === 'op') return t.value
      const v = t.value.trim()
      if (!v) return ''
      return /[\s()"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v
    })
    .filter((s) => s !== '')
    .join(' ')
}

/** 表达式里的全部关键词（用于去重 / 广搜构造） */
export function expressionTerms(tokens: ExprToken[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (t.kind === 'term' && t.value.trim()) out.push(t.value.trim())
  }
  return out
}

/** 校验表达式结构，返回可读错误信息；合法返回 null */
export function validateExpression(tokens: ExprToken[]): string | null {
  if (expressionTerms(tokens).length === 0) return '请至少添加一个关键词'

  let pos = 0
  const peek = (): ExprToken | undefined => tokens[pos]

  function parseOr(): void {
    parseAnd()
    for (;;) {
      const t = peek()
      if (t?.kind === 'op' && t.value === 'OR') {
        pos++
        parseAnd()
      } else break
    }
  }
  function parseAnd(): void {
    parseNot()
    for (;;) {
      const t = peek()
      if (t?.kind === 'op' && t.value === 'AND') {
        pos++
        parseNot()
      } else if (t?.kind === 'term' || (t?.kind === 'op' && (t.value === 'NOT' || t.value === '('))) {
        parseNot()
      } else break
    }
  }
  function parseNot(): void {
    const t = peek()
    if (t?.kind === 'op' && t.value === 'NOT') {
      pos++
      parseNot()
      return
    }
    parseAtom()
  }
  function parseAtom(): void {
    const t = peek()
    if (!t) throw new Error('表达式不完整：缺少关键词或「）」')
    if (t.kind === 'term') {
      pos++
      return
    }
    if (t.value === '(') {
      pos++
      parseOr()
      const c = peek()
      if (!(c?.kind === 'op' && c.value === ')')) throw new Error('括号不匹配：缺少「）」')
      pos++
      return
    }
    if (t.value === ')') throw new Error('括号不匹配：多了一个「）」')
    throw new Error('运算符位置不对：AND / OR 两侧都需要关键词')
  }

  try {
    parseOr()
    if (pos !== tokens.length) {
      const t = tokens[pos]
      if (t.kind === 'op' && t.value === ')') throw new Error('括号不匹配：多了一个「）」')
      throw new Error('运算符位置不对：表达式结构不完整')
    }
    return null
  } catch (e) {
    return (e as Error).message
  }
}
