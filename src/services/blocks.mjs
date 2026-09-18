/**
 * blocks.mjs —— AcademicFlow 结构化块语法（前端与 runner 共用的唯一实现）
 * ======================================================================
 *
 * 设计目标：**内容零丢失**。
 * 旧语法用 HTML 注释当标记、标记与正文同行，前后端各自实现解析器，必然分叉，
 * 且已经出现过"标记与正文同行 → 整行被替换 → 丢 76% 正文却仍判 success"。
 * 新语法用**显式闭合的结构化块**把每一段圈起来，内容有明确边界，丢东西在结构上就不可能。
 *
 * 语法
 * ----
 *   开标记  ⟨⟨⟨元信息⟩⟩⟩
 *   闭合符  ⟨⟨⟨/⟩⟩⟩
 *   一个块 = ⟨⟨⟨元信息⟩⟩⟩内容原文⟨⟨⟨/⟩⟩⟩
 *
 * 元信息一览（· 是分隔符，U+00B7）：
 *
 *   流块（全文连续编号 1..N，标题/正文/列表共享同一序列）
 *     文字·标题·L·N    L = 标题级别 1-6
 *     文字·正文·0·N    L 恒为 0
 *     列表·L·N         L = 列表层级
 *
 *   浮动块（锚 A · 序号 S；图/表/图注/公式在**同一锚点内共享**一个 S 序列）
 *     图·A·S       A = 前面的流序号
 *     表·A·S
 *     图注·A·S
 *     公式·A·S
 *
 *   独立块（无编号）
 *     引文        正文里引用的整段话
 *     文献        参考文献章节，整段一个块
 *
 *   派生块（译文）
 *     译文@ID     ID = 源块编号（流块 "12"，浮动块 "12·3"）
 *     译文        无编号源块（引文）的译文，挂在紧邻的上一个块上
 *
 * 编号由**代码**统一重排（见 renumber），AI 只负责把内容块圈出来，不负责数对。
 *
 * 标记只存在于文件里，前端渲染时隐藏。
 */

export const OPEN = '⟨⟨⟨'
export const CLOSE = '⟩⟩⟩'
/** 闭合符：元信息为 "/" 的标记 */
export const END = `${OPEN}/${CLOSE}`

/** 匹配任意 ⟨⟨⟨...⟩⟩⟩ 标记；元信息里不允许再出现定界符 */
const MARKER_RE = /⟨⟨⟨([^⟨⟩]*)⟩⟩⟩/g

export const FLOW_TYPES = ['标题', '正文', '列表']
export const FLOAT_TYPES = ['图', '表', '图注', '公式']
export const NOTE_TYPES = ['引文', '文献']

// ============================================================
// 元信息 ⇄ 节点
// ============================================================

/**
 * 解析元信息字符串 → 节点；无法识别返回 null（调用方按普通文本保留，绝不丢字）。
 * @returns {{kind:'flow',type:string,level:number,n:number}
 *          |{kind:'float',type:string,anchor:number,s:number}
 *          |{kind:'note',type:string}
 *          |{kind:'translation',ref:string|null}
 *          |null}
 */
export function parseMeta(meta) {
  const s = String(meta).trim()
  if (s === '引文' || s === '文献') return { kind: 'note', type: s }

  let m = s.match(/^文字·(标题|正文)·(\d+)·(\d+)$/)
  if (m) {
    const level = m[1] === '正文' ? 0 : Number(m[2])
    return { kind: 'flow', type: m[1], level, n: Number(m[3]) }
  }
  m = s.match(/^列表·(\d+)·(\d+)$/)
  if (m) return { kind: 'flow', type: '列表', level: Number(m[1]), n: Number(m[2]) }
  m = s.match(/^(图|表|图注|公式)·(\d+)·(\d+)$/)
  if (m) return { kind: 'float', type: m[1], anchor: Number(m[2]), s: Number(m[3]) }
  m = s.match(/^译文(?:@(\d+(?:·\d+)?))?$/)
  if (m) return { kind: 'translation', ref: m[1] || null }
  return null
}

/** 节点 → 元信息字符串（parseMeta 的逆运算） */
export function metaOf(node) {
  switch (node.kind) {
    case 'note':
      return node.type
    case 'flow':
      return node.type === '列表'
        ? `列表·${node.level}·${node.n}`
        : `文字·${node.type}·${node.level}·${node.n}`
    case 'float':
      return `${node.type}·${node.anchor}·${node.s}`
    case 'translation':
      return node.ref ? `译文@${node.ref}` : '译文'
    default:
      return ''
  }
}

/** 块的唯一编号：流块 "12"、浮动块 "12·3"、独立块无编号返回 null */
export function blockId(node) {
  if (node.kind === 'flow') return String(node.n)
  if (node.kind === 'float') return `${node.anchor}·${node.s}`
  return null
}

/** 该块是否需要翻译：正文/标题/列表/表/图注/引文要翻；图/公式/文献不翻 */
export function isTranslatable(node) {
  if (!node) return false
  if (node.kind === 'flow') return true
  if (node.kind === 'float') return node.type === '表' || node.type === '图注'
  if (node.kind === 'note') return node.type === '引文'
  return false
}

/** 人类可读的块名，用于日志与报错 */
export function labelOf(node) {
  if (!node) return '?'
  const id = blockId(node)
  if (node.kind === 'translation') return `译文@${node.ref ?? '(紧邻)'}`
  return id ? `${node.type}·${id}` : node.type
}

// ============================================================
// 解析 / 序列化
// ============================================================

/**
 * 把文档拆成线性条目。块外的一切文本都原样保留为 text 条目 —— 解析器不丢任何字符。
 *
 * @returns {{items: Array<{t:'block',node:object,content:string}|{t:'text',content:string}>, warnings: string[]}}
 */
export function parseBlocks(md) {
  const src = String(md ?? '')
  const items = []
  const warnings = []

  MARKER_RE.lastIndex = 0
  let cursor = 0
  let open = null // { node, contentStart }
  let m

  while ((m = MARKER_RE.exec(src)) !== null) {
    const raw = m[0]

    // 闭合符
    if (m[1].trim() === '/') {
      if (!open) {
        warnings.push(`多余的闭合符，已按普通文本保留：${raw}`)
        continue
      }
      items.push({ t: 'block', node: open.node, content: src.slice(open.contentStart, m.index) })
      open = null
      cursor = m.index + raw.length
      continue
    }

    const node = parseMeta(m[1])
    // 无法识别的标记：不推进 cursor，让它作为普通文本留在原地
    if (!node) {
      warnings.push(`无法识别的块标记，已按普通文本保留：${raw}`)
      continue
    }

    // 开新块
    if (open) {
      warnings.push(`块缺少闭合符，已在下一个标记处截断：${metaOf(open.node)}`)
      items.push({ t: 'block', node: open.node, content: src.slice(open.contentStart, m.index) })
      open = null
      cursor = m.index
    }
    if (m.index > cursor) items.push({ t: 'text', content: src.slice(cursor, m.index) })
    open = { node, contentStart: m.index + raw.length }
    cursor = m.index + raw.length
  }

  if (open) {
    warnings.push(`文件末尾的块缺少闭合符：${metaOf(open.node)}`)
    items.push({ t: 'block', node: open.node, content: src.slice(open.contentStart) })
    cursor = src.length
  }
  if (cursor < src.length) items.push({ t: 'text', content: src.slice(cursor) })

  return { items, warnings }
}

/** 序列化回文档；parseBlocks 的逆运算（对规范输入满足 parse(serialize(x)) === x） */
export function serializeBlocks(items) {
  return items
    .map((it) =>
      it.t === 'text'
        ? it.content
        : `${OPEN}${metaOf(it.node)}${CLOSE}${it.content}${END}`,
    )
    .join('')
}

/** 顺序取所有块（含译文块） */
export function blocksIn(items) {
  return items.filter((it) => it.t === 'block')
}

// ============================================================
// 重排编号（AI 不数数，代码来数）
// ============================================================

/**
 * 按文档顺序重算所有编号：
 *   - 流块 1..N 连续
 *   - 浮动块锚定到它前面最近的流序号，且同一锚点内 图/表/图注/公式 共享一个 S 序列
 *   - 译文块的引用同步重定向（旧 id → 新 id）
 *
 * 只改元信息，**不碰任何 content**，因此天然无损。
 * @returns {Array} 新条目数组
 */
export function renumber(items) {
  const idMap = new Map()
  let flowN = 0
  const floatAt = new Map()

  const out = items.map((it) => {
    if (it.t !== 'block') return it
    const node = { ...it.node }

    if (node.kind === 'flow') {
      const oldId = node.n != null ? String(node.n) : null
      flowN++
      node.n = flowN
      if (node.type === '正文') node.level = 0
      if (oldId && oldId !== String(flowN)) idMap.set(oldId, String(flowN))
    } else if (node.kind === 'float') {
      const oldId = `${node.anchor}·${node.s}`
      node.anchor = flowN
      const c = (floatAt.get(flowN) || 0) + 1
      floatAt.set(flowN, c)
      node.s = c
      const newId = `${node.anchor}·${node.s}`
      if (oldId !== newId) idMap.set(oldId, newId)
    }

    return { ...it, node }
  })

  if (idMap.size) {
    for (const it of out) {
      if (it.t === 'block' && it.node.kind === 'translation' && it.node.ref && idMap.has(it.node.ref)) {
        it.node = { ...it.node, ref: idMap.get(it.node.ref) }
      }
    }
  }
  return out
}

// ============================================================
// 读取（译文块合并进源块）
// ============================================================

/**
 * 解析文档并把译文挂到对应源块上 —— 前端渲染与 runner 取翻译都用这一份结果。
 *
 * @returns {{items: Array<{t:'block',node:object,content:string,id:string|null,cn:string|undefined}|{t:'text',content:string}>, warnings: string[]}}
 */
export function readDocument(md) {
  const { items, warnings } = parseBlocks(md)
  const out = []
  const byId = new Map()

  for (const it of items) {
    if (it.t === 'block' && it.node.kind === 'translation') {
      if (it.node.ref) {
        const target = byId.get(it.node.ref)
        if (target) target.cn = it.content
        else warnings.push(`译文@${it.node.ref} 找不到对应的源块，已忽略`)
      } else {
        // 无编号源块（引文）的译文：挂到紧邻的上一个块
        let attached = false
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].t === 'block') { out[i].cn = it.content; attached = true; break }
        }
        if (!attached) warnings.push('译文块之前没有任何块，已忽略')
      }
      continue
    }
    if (it.t === 'block') {
      const rec = { t: 'block', node: it.node, content: it.content, id: blockId(it.node), cn: undefined }
      if (rec.id) byId.set(rec.id, rec)
      out.push(rec)
    } else {
      out.push(it)
    }
  }
  return { items: out, warnings }
}

/** 文档里的纯文本（去掉所有标记），用于前后端一致性校验 */
export function stripMarkers(md) {
  return String(md ?? '').replace(MARKER_RE, (raw) => {
    if (raw === END) return ''
    return parseMeta(raw.slice(OPEN.length, -CLOSE.length)) ? '' : raw
  })
}

/** 内容指纹：所有块内容拼接（忽略空白差异），用于"内容守恒"断言 */
export function contentFingerprint(md) {
  const { items } = parseBlocks(md)
  return items
    .filter((it) => it.t === 'block')
    .map((it) => it.content)
    .join('')
    .replace(/\s+/g, '')
}

// ============================================================
// 旧格式（<!-- PARA en i/N --> 等）读取兼容
// ============================================================

/**
 * 旧标记 → 新块语法的字面转换，供读取历史数据。
 * 只读不写：runner 再也不会产出旧格式。
 */
export function legacyToBlocks(md) {
  const src = String(md ?? '')
  if (!/<!--\s*(PARA\s+(en|cn)\s+\d+\/\d+|IMG\s+between|TABLE\s+(between|cn)|REF\s+ALL)\s*-->/.test(src)) {
    return null
  }

  const MARK =
    /<!--\s*(PARA\s+(en|cn)\s+(\d+)\/(\d+)|IMG\s+between\s+(\d+)\s+and\s+(\d+)|TABLE\s+between\s+(\d+)\s+and\s+(\d+)|TABLE\s+cn\s+(\d+)-(\d+)|REF\s+ALL)\s*-->/g

  const hits = []
  let m
  MARK.lastIndex = 0
  while ((m = MARK.exec(src)) !== null) {
    const full = m[1]
    let node = null
    if (full.startsWith('PARA en')) node = { kind: 'flow', type: '正文', level: 0, n: Number(m[3]) }
    else if (full.startsWith('PARA cn')) node = { kind: 'translation', ref: String(m[3]) }
    else if (full.startsWith('IMG')) node = { kind: 'float', type: '图', anchor: Number(m[5]), s: 0 }
    else if (full.startsWith('TABLE cn')) node = { kind: 'translation', ref: `TABLE:${m[9]}` }
    else if (full.startsWith('TABLE')) node = { kind: 'float', type: '表', anchor: Number(m[7]), s: 0 }
    else node = { kind: 'note', type: '文献' }
    hits.push({ node, start: m.index, end: m.index + m[0].length })
  }
  if (!hits.length) return null

  // 浮动块：同一锚点内共享 S 序列（与 runner 旧语义一致：S 按出现顺序递增）
  const floatAt = new Map()
  const anchorS = new Map() // `TABLE:${anchor}` → id，供译表引用
  for (const h of hits) {
    if (h.node.kind !== 'float') continue
    const c = (floatAt.get(h.node.anchor) || 0) + 1
    floatAt.set(h.node.anchor, c)
    h.node.s = c
    if (h.node.type === '表') anchorS.set(`TABLE:${h.node.anchor}`, `${h.node.anchor}·${c}`)
  }
  // 译表引用：旧格式 TABLE cn a-b 只带 beforeIdx，落到该锚点第一个表上
  for (const h of hits) {
    if (h.node.kind === 'translation' && h.node.ref?.startsWith('TABLE:')) {
      h.node.ref = anchorS.get(h.node.ref) ?? null
    }
  }

  let out = ''
  let cursor = 0
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const contentEnd = i + 1 < hits.length ? hits[i + 1].start : src.length
    if (h.start > cursor) out += src.slice(cursor, h.start)
    out += `${OPEN}${metaOf(h.node)}${CLOSE}${src.slice(h.end, contentEnd)}${END}`
    cursor = contentEnd
  }
  if (cursor < src.length) out += src.slice(cursor)
  return out
}

/** 读任意格式：新语法直接用；旧标记先字面转换；纯文本按单块之外的原样文本处理 */
export function readAnyDocument(md) {
  const src = String(md ?? '')
  if (src.includes(OPEN)) return readDocument(src)
  const converted = legacyToBlocks(src)
  return readDocument(converted ?? src)
}

export default {
  OPEN, CLOSE, END,
  parseMeta, metaOf, blockId, isTranslatable, labelOf,
  parseBlocks, serializeBlocks, blocksIn,
  renumber,
  readDocument, stripMarkers, contentFingerprint,
  legacyToBlocks, readAnyDocument,
}
