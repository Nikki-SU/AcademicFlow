/**
 * 公式的「视觉模型」—— 让不熟 LaTeX 的人也能直接编公式
 * ------------------------------------------------------------
 * 为什么要这一层：
 *   原来公式只能在 LaTeX 源码框里敲。Word 用户（大多数人）不熟 LaTeX，
 *   他们预期的是「看到公式、点符号、在公式里直接打字」。
 *   于是把公式做成**一棵可编辑的视觉树**：分数是真的上下两格、根号是真的有根号，
 *   点进哪一格就能在哪一格里打字。
 *
 * 三条设计约束：
 *   1) **绝不改写用户已有的源码** —— 认不出来的 `\cmd` 一律存成 `raw`（用 KaTeX 渲染、
 *      不可编辑、原样存回）。所以「先解析成视觉树、再序列化回 LaTeX」是无损往返的。
 *   2) 视觉区只有**根节点**是 contenteditable，结构化构件是普通内联元素 + CSS 排版
 *      （不嵌套 contenteditable —— 嵌套编辑宿主是浏览器里最不可靠的一类东西）。
 *   3) 纯函数（parse/serialize）与 DOM 函数（render/read）分开，前者能单独测。
 */
import katex from 'katex'

export type FxNode =
  /** 字面文本（序列化时按 LaTeX 规则转义） */
  | { t: 'text'; v: string }
  /** 认不出来的控制序列：KaTeX 渲染、不可编辑、原样往返 */
  | { t: 'raw'; tex: string }
  /** 正体（\mathrm / \text / \operatorname）：内部可编辑 */
  | { t: 'up'; tex: string; body: FxNode[] }
  | { t: 'frac'; num: FxNode[]; den: FxNode[] }
  | { t: 'sqrt'; body: FxNode[] }
  /** 上下标：base 是底，sup / sub 是上标下标（都可能为空） */
  | { t: 'script'; base: FxNode[]; sup: FxNode[]; sub: FxNode[] }
  | { t: 'matrix'; env: string; rows: FxNode[][][] }

const FRAC_CMDS = ['\\frac', '\\dfrac', '\\tfrac']
/** 正体类命令：内部还能继续编辑 */
const UPRIGHT_CMDS = ['\\mathrm', '\\text', '\\operatorname', '\\mathbf', '\\mathit']
const MATRIX_ENVS = ['matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'smallmatrix']

/** 矩阵的外层括号（KaTeX 只用来渲染 raw，这里只在视觉区画括号） */
const MATRIX_BRACKETS: Record<string, [string, string]> = {
  matrix: ['', ''],
  pmatrix: ['(', ')'],
  bmatrix: ['[', ']'],
  vmatrix: ['|', '|'],
  smallmatrix: ['', ''],
}

// ────────────────────────────────────────────────────────────
// 解析：LaTeX → 视觉树
// ────────────────────────────────────────────────────────────

/** 相邻文本合并，避免一个字一个节点（序列化与比较都更省事） */
function normalize(nodes: FxNode[]): FxNode[] {
  const out: FxNode[] = []
  for (const n of nodes) {
    const prev = out[out.length - 1]
    if (n.t === 'text' && prev && prev.t === 'text') {
      prev.v += n.v
      continue
    }
    if (n.t === 'text' && n.v === '') continue
    if (n.t === 'script' && !n.base.length && !n.sup.length && !n.sub.length) continue
    out.push(n)
  }
  return out
}

class TexParser {
  i = 0
  s: string

  constructor(s: string) {
    this.s = s
  }

  private get eof() {
    return this.i >= this.s.length
  }

  /** 跳过空白：LaTeX 里源码的空白不参与排版（且 `\ ` 已由命令分支吃掉） */
  private skipWs() {
    while (!this.eof && /\s/.test(this.s[this.i])) this.i++
  }

  /** 一个「参数」：`{...}` 或单个原子 */
  parseGroup(): FxNode[] {
    this.skipWs()
    if (this.s[this.i] === '{') {
      this.i++
      const inner = this.parseUntil('}')
      if (this.s[this.i] === '}') this.i++
      return inner
    }
    const one = this.parseAtom()
    return one ? [one] : []
  }

  /** 顶层与分组共用的循环体；stop 为遇到就停的字符（不含它本身） */
  parseUntil(stop?: string): FxNode[] {
    const out: FxNode[] = []
    while (!this.eof) {
      const c = this.s[this.i]
      if (stop && c === stop) break

      if (c === '^' || c === '_') {
        // 上/下标挂到**前一个原子**上；前面没有就留个空底
        this.i++
        const arg = this.parseGroup()
        const prev = out.pop()
        if (prev && prev.t === 'script') {
          if (c === '^') prev.sup.push(...arg)
          else prev.sub.push(...arg)
          out.push(prev)
        } else {
          out.push({
            t: 'script',
            base: prev ? [prev] : [],
            sup: c === '^' ? arg : [],
            sub: c === '_' ? arg : [],
          })
        }
        continue
      }

      if (c === '\\') {
        out.push(this.parseCommand())
        continue
      }

      if (c === '{') {
        out.push(...this.parseGroup())
        continue
      }

      if (c === '}') {
        // 落单的右括号：当普通字符
        out.push({ t: 'text', v: '}' })
        this.i++
        continue
      }

      out.push({ t: 'text', v: c })
      this.i++
    }
    return normalize(out)
  }

  private parseAtom(): FxNode | null {
    this.skipWs()
    if (this.eof) return null
    const c = this.s[this.i]
    if (c === '\\') return this.parseCommand()
    if (c === '{') return { t: 'text', v: this.readBraceLiteral() }
    // 单个字符：连着的普通字符也会被 normalize 合并
    this.i++
    return { t: 'text', v: c }
  }

  /** 把 `{...}` 整段当字面量读出来（只在需要单原子时用） */
  private readBraceLiteral(): string {
    const start = this.i
    let depth = 0
    while (!this.eof) {
      const c = this.s[this.i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          this.i++
          return this.s.slice(start, this.i)
        }
      }
      this.i++
    }
    return this.s.slice(start)
  }

  /** 读 `\name` / `\x`，返回命令名与「名字结束后的位置」 */
  private readCmdName(): { name: string; isWord: boolean } {
    const start = this.i
    this.i++ // 反斜杠
    if (this.eof) return { name: '\\', isWord: false }
    if (!/[a-zA-Z]/.test(this.s[this.i])) {
      this.i++
      return { name: this.s.slice(start, this.i), isWord: false }
    }
    while (!this.eof && /[a-zA-Z]/.test(this.s[this.i])) this.i++
    return { name: this.s.slice(start, this.i), isWord: true }
  }

  private parseCommand(): FxNode {
    const { name } = this.readCmdName()

    if (FRAC_CMDS.includes(name)) {
      const num = this.parseGroup()
      const den = this.parseGroup()
      return { t: 'frac', num, den }
    }

    if (name === '\\sqrt') {
      // 可选的开方次数 [n] 认不出来 → 整条走 raw，别猜
      const save = this.i
      this.skipWs()
      if (this.s[this.i] === '[') {
        this.i = save
        return this.readRawWithArgs(name)
      }
      this.i = save
      return { t: 'sqrt', body: this.parseGroup() }
    }

    if (UPRIGHT_CMDS.includes(name)) {
      return { t: 'up', tex: name, body: this.parseGroup() }
    }

    if (name === '\\begin') {
      const env = this.tryReadEnvName()
      if (env && MATRIX_ENVS.includes(env)) {
        const m = this.tryReadMatrix(env)
        if (m) return m
      }
      return { t: 'raw', tex: `\\begin{${env ?? 'matrix'}}` }
    }

    // 其余命令：KaTeX 能渲染就渲染成不可编辑的芯片，原样往返。
    // 紧跟的 `{...}` 要一起吃掉 —— `\hat{H}` / `\overline{AB}` 这类命令的参数
    // 如果丢掉，用户原有的源码就被改写了。
    let tex = name
    if (this.s[this.i] === '{') tex += this.readBraceLiteral()
    return { t: 'raw', tex }
  }

  /** raw 芯片的 tex：命令名 + 后面跟的可选 `[...]` 与一组 `{...}`（`\sqrt[3]{x}` 这类） */
  private readRawWithArgs(name: string): FxNode {
    let tex = name
    this.skipWs()
    if (this.s[this.i] === '[') {
      const close = this.s.indexOf(']', this.i)
      if (close !== -1) {
        tex += this.s.slice(this.i, close + 1)
        this.i = close + 1
      }
    }
    this.skipWs()
    if (this.s[this.i] === '{') tex += this.readBraceLiteral()
    return { t: 'raw', tex }
  }

  private tryReadEnvName(): string | null {
    this.skipWs()
    if (this.s[this.i] !== '{') return null
    this.i++
    let out = ''
    while (!this.eof && this.s[this.i] !== '}') out += this.s[this.i++]
    if (this.s[this.i] === '}') this.i++
    return out.trim()
  }

  /** 读矩阵到 `\end{env}`；读不到就返回 null（调用方回退成 raw） */
  private tryReadMatrix(env: string): FxNode | null {
    const rows: FxNode[][][] = []
    let row: FxNode[][] = []
    let cell: FxNode[] = []

    const pushCell = () => {
      row.push(normalize(cell))
      cell = []
    }
    const pushRow = () => {
      pushCell()
      rows.push(row)
      row = []
    }

    for (;;) {
      this.skipWs()
      if (this.eof) break

      if (this.s.slice(this.i, this.i + 4) === '\\end') {
        const save = this.i
        this.readCmdName()
        const endEnv = this.tryReadEnvName()
        if (endEnv === env) {
          pushRow()
          return { t: 'matrix', env, rows }
        }
        this.i = save
        break
      }

      const c = this.s[this.i]
      if (c === '&') {
        this.i++
        pushCell()
        continue
      }
      if (c === '\\' && this.s[this.i + 1] === '\\') {
        this.i += 2
        pushRow()
        continue
      }
      // 普通内容：复用顶层解析，但要自己判终止符
      if (c === '^' || c === '_') {
        this.i++
        const arg = this.parseGroup()
        const prev = cell.pop()
        cell.push({
          t: 'script',
          base: prev ? [prev] : [],
          sup: c === '^' ? arg : [],
          sub: c === '_' ? arg : [],
        })
        continue
      }
      if (c === '{') {
        cell.push(...this.parseGroup())
        continue
      }
      if (c === '\\') {
        cell.push(this.parseCommand())
        continue
      }
      cell.push({ t: 'text', v: c })
      this.i++
    }
    return null
  }
}

export function parseLatex(tex: string): FxNode[] {
  try {
    // 顶层不要求花括号：整段就是一个「组」
    return new TexParser(tex).parseUntil(undefined)
  } catch {
    return [{ t: 'raw', tex }]
  }
}

// ────────────────────────────────────────────────────────────
// 序列化：视觉树 → LaTeX
// ────────────────────────────────────────────────────────────

const ESCAPES: Record<string, string> = {
  '\\': '\\backslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  '#': '\\#',
  _: '\\_',
  '^': '\\^{}',
  '~': '\\~{}',
}

function escText(s: string): string {
  return s.replace(/[\\{}$%&#_^~]/g, (c) => ESCAPES[c] ?? c)
}

export function serializeLatex(nodes: FxNode[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escText(n.v)
        case 'raw':
          return n.tex
        case 'up':
          return `${n.tex}{${serializeLatex(n.body)}}`
        case 'frac':
          return `\\frac{${serializeLatex(n.num)}}{${serializeLatex(n.den)}}`
        case 'sqrt':
          return `\\sqrt{${serializeLatex(n.body)}}`
        case 'script': {
          const base = serializeLatex(n.base)
          const sub = n.sub.length ? `_{${serializeLatex(n.sub)}}` : ''
          const sup = n.sup.length ? `^{${serializeLatex(n.sup)}}` : ''
          return `${base}${sub}${sup}`
        }
        case 'matrix':
          return (
            `\\begin{${n.env}}` +
            n.rows.map((r) => r.map((c) => serializeLatex(c)).join(' & ')).join(' \\\\ ') +
            `\\end{${n.env}}`
          )
      }
    })
    .join('')
}

// ────────────────────────────────────────────────────────────
// 渲染：视觉树 → DOM（只有根是 contenteditable，构件全是普通内联元素 + CSS）
// ────────────────────────────────────────────────────────────

const SLOT = 'data-afx-slot'

function el(tag: string, cls?: string, slot?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (slot) e.setAttribute(SLOT, slot)
  return e
}

function renderNode(n: FxNode): Node {
  switch (n.t) {
    case 'text':
      return document.createTextNode(n.v)
    case 'raw': {
      const s = el('span', 'afx-raw')
      s.setAttribute('data-afx-raw', n.tex)
      s.contentEditable = 'false'
      try {
        s.innerHTML = katex.renderToString(n.tex || '\\;', {
          displayMode: false,
          throwOnError: false,
          strict: false,
        })
      } catch {
        s.textContent = n.tex
      }
      return s
    }
    case 'up': {
      const s = el('span', 'afx-up')
      s.setAttribute('data-afx-up', n.tex)
      append(s, n.body)
      return s
    }
    case 'frac': {
      const box = el('span', 'afx-frac')
      const num = el('span', 'afx-num', 'num')
      const den = el('span', 'afx-den', 'den')
      append(num, n.num)
      append(den, n.den)
      box.append(num, den)
      return box
    }
    case 'sqrt': {
      const box = el('span', 'afx-sqrt')
      const body = el('span', 'afx-rad', 'body')
      append(body, n.body)
      box.appendChild(body)
      return box
    }
    case 'script': {
      const box = el('span', 'afx-script')
      const base = el('span', 'afx-base', 'base')
      const sc = el('span', 'afx-scripts')
      const sup = el('sup', 'afx-sup', 'sup')
      const sub = el('sub', 'afx-sub', 'sub')
      append(base, n.base)
      append(sup, n.sup)
      append(sub, n.sub)
      sc.append(sup, sub)
      box.append(base, sc)
      return box
    }
    case 'matrix': {
      const [open, close] = MATRIX_BRACKETS[n.env] ?? ['', '']
      const box = el('span', 'afx-matrix')
      box.setAttribute('data-afx-env', n.env)
      const left = el('span', 'afx-mbr')
      const right = el('span', 'afx-mbr')
      left.textContent = open
      right.textContent = close
      const grid = el('span', 'afx-mgrid')
      for (const row of n.rows) {
        const r = el('span', 'afx-mrow')
        for (const cell of row) {
          const c = el('span', 'afx-mcell', 'cell')
          append(c, cell)
          r.appendChild(c)
        }
        grid.appendChild(r)
      }
      box.append(left, grid, right)
      return box
    }
  }
}

function append(host: Node, nodes: FxNode[]) {
  for (const n of nodes) host.appendChild(renderNode(n))
}

/** 视觉树 → 文档片段（用于灌进 contenteditable，或在光标处插入结构） */
export function renderFragment(nodes: FxNode[]): DocumentFragment {
  const frag = document.createDocumentFragment()
  append(frag, nodes)
  return frag
}

// ────────────────────────────────────────────────────────────
// 读取：DOM → 视觉树
// ────────────────────────────────────────────────────────────

function slotOf(node: Element, name: string): FxNode[] {
  const found = node.querySelector(`:scope > [${SLOT}="${name}"]`)
  return found ? readNodes(found) : []
}

function readNodes(host: Node): FxNode[] {
  const out: FxNode[] = []
  host.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push({ t: 'text', v: (child as Text).data })
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const e = child as HTMLElement
    // 视觉区里的换行（点回车产生的 <br>）在公式里没有意义，丢掉
    if (e.tagName === 'BR') return

    if (e.hasAttribute('data-afx-raw')) {
      out.push({ t: 'raw', tex: e.getAttribute('data-afx-raw') || '' })
      return
    }
    if (e.hasAttribute('data-afx-up')) {
      out.push({
        t: 'up',
        tex: e.getAttribute('data-afx-up') || '\\mathrm',
        body: readNodes(e),
      })
      return
    }
    if (e.classList.contains('afx-frac')) {
      out.push({ t: 'frac', num: slotOf(e, 'num'), den: slotOf(e, 'den') })
      return
    }
    if (e.classList.contains('afx-sqrt')) {
      out.push({ t: 'sqrt', body: slotOf(e, 'body') })
      return
    }
    if (e.classList.contains('afx-script')) {
      out.push({
        t: 'script',
        base: slotOf(e, 'base'),
        sup: slotOf(e, 'sup'),
        sub: slotOf(e, 'sub'),
      })
      return
    }
    if (e.classList.contains('afx-matrix')) {
      const rows: FxNode[][][] = []
      e.querySelectorAll(':scope > .afx-mgrid > .afx-mrow').forEach((r) => {
        const cells: FxNode[][] = []
        r.querySelectorAll(`:scope > [${SLOT}="cell"]`).forEach((c) => cells.push(readNodes(c)))
        rows.push(cells)
      })
      out.push({ t: 'matrix', env: e.getAttribute('data-afx-env') || 'matrix', rows })
      return
    }
    // 未知元素（浏览器自己插的 <b> 之类）：往下钻，别丢内容
    out.push(...readNodes(e))
  })
  return normalize(out)
}

export function readFragment(root: HTMLElement): FxNode[] {
  return readNodes(root)
}

/** DOM → LaTeX 的快捷方式 */
export function readLatex(root: HTMLElement): string {
  return serializeLatex(readFragment(root))
}

/** LaTeX → DOM（灌进 contenteditable） */
export function renderInto(root: HTMLElement, tex: string): void {
  root.textContent = ''
  root.appendChild(renderFragment(parseLatex(tex)))
}

// ────────────────────────────────────────────────────────────
// 光标：插入结构 / 符号，并把光标送进新结构的第一格
// ────────────────────────────────────────────────────────────

/** 空的槽位（连一个字符都没有）——用来决定插完结构后光标该去哪 */
function slotByName(root: HTMLElement, name: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`:scope [${SLOT}="${name}"]`)
}

function firstEmptySlot(root: HTMLElement): HTMLElement | null {
  for (const s of Array.from(root.querySelectorAll<HTMLElement>(`[${SLOT}]`))) {
    if (!(s.textContent || '').trim()) return s
  }
  return null
}

function placeCaret(node: Node, atStart = true) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(atStart)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** 在 root 的当前光标处插入一个节点；光标没落在 root 里时插到末尾 */
export function insertNodeAtCaret(root: HTMLElement, node: Node): void {
  const sel = window.getSelection()
  const inRoot = sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)
  if (!inRoot) {
    root.appendChild(node)
    return
  }
  const range = sel.getRangeAt(0)
  range.deleteContents()
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * 在 root 的当前光标处插入纯文本（点符号按钮走这里 —— 用文本节点，中文/希腊字母都安全）。
 *
 * 注意：点按钮会让看板失焦，但**选区通常还留在原处**，所以直接按选区插；
 * 只有当选区已经不在看板里时，才退回「追加到末尾 + 把光标放到末尾」。
 * （反过来先 focus() 再插会把光标重置到开头，等于每次都插错位置。）
 */
export function insertTextAtCaret(root: HTMLElement, text: string): void {
  const sel = window.getSelection()
  const inRoot = sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)
  const tn = document.createTextNode(text)
  if (!inRoot) {
    root.appendChild(tn)
    root.focus()
    placeCaret(tn, false)
    return
  }
  const range = sel.getRangeAt(0)
  range.deleteContents()
  range.insertNode(tn)
  range.setStartAfter(tn)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  root.focus()
}

/**
 * 插入一个「结构」（分数 / 根号 / 上下标 / 矩阵…）。
 *
 * 选中了东西就把它**包进结构里**（Word 的行为：选中 x → 点分数 → x 成了分子）；
 * 没选就插一个空格子，光标直接落进第一个格子。
 */
export function insertStructureAtCaret(
  root: HTMLElement,
  make: (seed: FxNode[]) => FxNode,
  caretSlot?: string,
): void {
  const sel = window.getSelection()
  const range =
    sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)
      ? sel.getRangeAt(0)
      : null

  let seed: FxNode[] = []
  if (range) {
    if (!range.collapsed) seed = readNodes(range.cloneContents())
    range.deleteContents()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  const node = make(seed)
  const frag = renderFragment([node])
  const first = frag.firstChild
  if (!first) return
  insertNodeAtCaret(root, frag)

  const host = first.nodeType === Node.ELEMENT_NODE ? (first as HTMLElement) : root
  const target = (caretSlot ? slotByName(host, caretSlot) : null) ?? firstEmptySlot(host)
  if (target) placeCaret(target, true)
  else placeCaret(host, false)
  root.focus()
}

/**
 * 底部工具条的「结构」按钮。
 * seed = 当前选中的内容（会被填进结构的主要格子）。
 */
export const FORMULA_STRUCTURES: {
  label: string
  /** 插完后光标落在哪个格子 */
  caret?: string
  make: (seed: FxNode[]) => FxNode
}[] = [
  {
    label: '分数',
    caret: 'den',
    make: (seed) => ({ t: 'frac', num: seed, den: [] }),
  },
  {
    label: '根号',
    caret: 'body',
    make: (seed) => ({ t: 'sqrt', body: seed }),
  },
  {
    label: '上标',
    caret: 'sup',
    make: (seed) => ({ t: 'script', base: seed, sup: [], sub: [] }),
  },
  {
    label: '下标',
    caret: 'sub',
    make: (seed) => ({ t: 'script', base: seed, sup: [], sub: [] }),
  },
  {
    label: '上下标',
    caret: 'sup',
    make: (seed) => ({ t: 'script', base: seed, sup: [], sub: [] }),
  },
  {
    label: '求和',
    caret: 'sub',
    make: (seed) => ({ t: 'script', base: seed.length ? seed : [{ t: 'raw', tex: '\\sum' }], sup: [], sub: [] }),
  },
  {
    label: '积分',
    caret: 'sub',
    make: (seed) => ({ t: 'script', base: seed.length ? seed : [{ t: 'raw', tex: '\\int' }], sup: [], sub: [] }),
  },
  {
    label: '极限',
    caret: 'sub',
    make: (seed) => ({ t: 'script', base: seed.length ? seed : [{ t: 'raw', tex: '\\lim' }], sup: [], sub: [] }),
  },
  {
    label: '正体',
    caret: 'body',
    make: (seed) => ({ t: 'up', tex: '\\mathrm', body: seed }),
  },
  {
    label: '矩阵',
    caret: 'cell',
    make: (seed) => ({
      t: 'matrix',
      env: 'matrix',
      rows: [
        [seed, []],
        [[], []],
      ],
    }),
  },
]
