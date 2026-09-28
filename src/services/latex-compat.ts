/**
 * LaTeX 编译兼容层
 * -------------------------------------------------
 * 生成期（latex-converter）和编译期（xelatex-compiler.withRuntimeCompat，浏览器 WASM
 * 与云端 Actions 两条通道共用）都要走这里。分开两份就会漂移 —— 而这类问题的本质
 * 恰恰是「旧稿子里已经写死了坏内容」：前端为了不丢用户手改，会**复用已存的 LaTeX**，
 * 所以光把生成器修好，老稿子的 main.tex 还是坏的，编译照样挂。这里把这套确定性
 * 规整做成幂等函数，编译前对任何来源的源码都再跑一遍。
 */

// ---------------- 1. Unicode 标点兜底 ----------------

/**
 * 把正文里的 Unicode 标点换成 TeX 的 ASCII 写法。
 *
 * 期刊类（如 Wiley USG.cls）正文用的是 T1 编码字体，没有 – — ‘ ’ “ ” … 这些码位；
 * AI 就算拿到了第 13 条规则，也可能漏 —— 这里是**确定性的兜底**，漏了照样修。
 * 只动这几类标点，正文内容一个字不减。代码块（verbatim/lstlisting 等）跳过。
 */
const TEX_PUNCT = new Map([
  ['\u2013', '--'], // – en dash
  ['\u2014', '---'], // — em dash
  ['\u2019', "'"], // ’ right single quote
  ['\u2018', '`'], // ‘ left single quote
  ['\u201c', '``'], // “ left double quote
  ['\u201d', "''"], // ” right double quote
  ['\u2026', '\\ldots{}'], // … ellipsis
  ['\u00a0', '~'], // nbsp
])

/** 原样保留的片段：verbatim/lstlisting/minted 等环境，以及 \verb|...| */
const TEX_VERBATIM_RE =
  /(\\begin\{(?:verbatim\*?|lstlisting|Verbatim|minted|alltt|comment)\}[\s\S]*?\\end\{(?:verbatim\*?|lstlisting|Verbatim|minted|alltt|comment)\}|\\verb\*?(.)[\s\S]*?\2)/g

export function sanitizeTexPunctuation(tex: string): string {
  const convert = (s: string) =>
    s.replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00a0]/g, (c) => TEX_PUNCT.get(c) ?? c)
  const out: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  TEX_VERBATIM_RE.lastIndex = 0
  while ((m = TEX_VERBATIM_RE.exec(tex)) !== null) {
    out.push(convert(tex.slice(last, m.index)))
    out.push(m[0])
    last = m.index + m[0].length
  }
  out.push(convert(tex.slice(last)))
  return out.join('')
}

// ---------------- 2. shipout 期间改版面的兼容补丁 ----------------

/**
 * 兼容性补丁：阻止「在 shipout 钩子里改版面」把浮动体冲掉。
 *
 * 背景：LaTeX 内核（≥ 2024/06）把 \c@totalpages 重新定义成「已经 shipout 的页数」，
 * 于是每输出第 1 页时它都等于 1。可有些期刊类（Wiley USG.cls 就是）还在用
 * \ifnum\c@totalpages=1 判断「这是不是一篇单页文档」，一旦为真就 \newgeometry{...}
 * 改版面尺寸。多页文档的第 1 页之后必然误触发，正在排队的图/表浮动体随即丢失，
 * 编译直接中断在 "LaTeX Error: Float(s) lost"。
 *
 * 这里让「在 shipout 钩子执行期间调用的 \newgeometry」变成空操作：类想改也改不动，
 * 正文里正常位置的 \newgeometry 不受影响，\thetotalpages 的语义也一个字没动。
 * 内核太老（没有 shipout 钩子机制）或模板没装 geometry 时，整块补丁自动跳过。
 */
export const SHIPOUT_GEOMETRY_GUARD = [
  '% --- 兼容性补丁：屏蔽 shipout 期间改版面（避免 Float(s) lost） ---',
  '\\makeatletter',
  '\\@ifundefined{AddToHook}{}{%',
  '  \\@ifundefined{newgeometry}{}{%',
  '    \\newif\\ifAF@inshipout',
  '    \\AddToHook{shipout/before}{\\AF@inshipouttrue}%',
  '    \\AddToHook{shipout/after}{\\AF@inshipoutfalse}%',
  '    \\let\\AF@newgeometry\\newgeometry',
  '    \\renewcommand\\newgeometry{\\ifAF@inshipout\\else\\AF@newgeometry\\fi}%',
  '  }%',
  '}%',
  '\\makeatother',
  '% --- 兼容性补丁结束 ---',
].join('\n')

/** 幂等判据：补丁里独有的标记，出现过就不再插第二遍 */
const SHIPOUT_GUARD_MARKER = 'AF@inshipout'
const BEGIN_DOCUMENT = '\\begin{document}'

// ---------------- 3. 参考文献命令规整 ----------------

/**
 * Wiley NJD 那套文档类（USG.cls 等）会**自己**按期刊选项调用 \bibliographystyle，
 * 而且是在 documentclass 载入写导言区时就写好 \bibstyle —— 比正文里的调用还早。
 * 此时正文再写一条 \bibliographystyle，.aux 里就有两条 \bibstyle，BibTeX 会报
 * "Illegal, another \bibstyle command" 并以非零状态退出（latexmk 据此判失败、
 * 不产出 .bbl，全文引用又变 undefined）。所以这类样式不在正文里重复声明。
 */
export const CLASS_MANAGED_BIB_STYLE = /^wileyNJD-/i

/** 清理 \bibliography 重复后缀；去掉类已经自己写过的 Wiley NJD 样式声明 */
function normalizeBibliographyCommands(tex: string): string {
  // \bibliography{references.bib} → \bibliography{references}
  // bibtex 会自己补 .bib，写成 references.bib 会去找 references.bib.bib → 打不开数据库。
  let out = tex.replace(/(\\bibliography\{)([^}]*?)\.bib(\})/g, '$1$2$3')
  // 去掉正文里重复的 \bibliographystyle{wileyNJD-*}（类自己会写，见上）。
  out = out.replace(/^[ \t]*\\bibliographystyle\{wileyNJD-[^}]*\}[ \t]*\r?\n?/gim, '')
  return out
}

// ---------------- 4. 编译前统一规整（幂等） ----------------

/**
 * 编译前对源码做的确定性规整，浏览器 WASM 与云端 Actions 都用它：
 *   1. 修 \bibliography 的重复 .bib 后缀；
 *   2. 去掉与文档类重复的 Wiley NJD \bibliographystyle；
 *   3. Unicode 标点兜底；
 *   4. 注入 shipout/geometry 兼容补丁。
 * 全部幂等：对已经规整过的源码再跑一遍结果不变。用户手改过的老稿子也能被救回来。
 */
export function normalizeLatexForCompile(source: string): string {
  let s = normalizeBibliographyCommands(source)
  s = sanitizeTexPunctuation(s)
  if (!s.includes(SHIPOUT_GUARD_MARKER)) {
    const at = s.indexOf(BEGIN_DOCUMENT)
    s = at === -1 ? `${s}\n${SHIPOUT_GEOMETRY_GUARD}\n` : `${s.slice(0, at)}${SHIPOUT_GEOMETRY_GUARD}\n${s.slice(at)}`
  }
  return s
}