/**
 * 浏览器端 XeLaTeX 编译服务（ThTeX / WebAssembly）
 * -------------------------------------------------
 * 站内所有 LaTeX → PDF 都走这里。编译真正在浏览器里跑：
 * XeTeX + xdvipdfmx + bibtex 全是 WASM，跑在一个 Web Worker 里，
 * 运行时资源（引擎 / TeX 发行版 / 字体 / ICU）来自 public/xelatex，
 * 由 CLI `npx @arnon3339/thtex --to public/xelatex` 落盘 —— 全程不联网。
 *
 * 为什么不用 CDN 版编译器（tectonic 等）：本站 CSP 是 script-src 'self'，
 * 拉别家 CDN 的脚本会被拦；且墙内网络本就不可靠。
 *
 * 关于 worker 的生命周期：这里做成**会话级单例**，不随组件卸载销毁。
 * 原因是首次初始化要加载 ~48MB 运行时（实测约 1s + 下载），
 * 而 worker 本身可复用、compile() 内部自会串行排队；
 * 留着它，第二次编译只要 ~1.4s。真要释放只能靠刷新页面。
 */
import { XeLaTeXCompiler } from '@arnon3339/thtex'
import type {
  XeLaTeXCompileResult,
  XeLaTeXLogEvent,
  XeLaTeXStatusEvent,
} from '@arnon3339/thtex'

/**
 * 运行时资源根目录。
 * 注意必须自己拼 BASE_URL：ThTeX 默认值是 `/xelatex/`（根路径），
 * 而本站部署在 GitHub Pages 的项目页 `/AcademicFlow/` 下，用默认值会 404。
 */
const ASSET_BASE_URL = `${import.meta.env.BASE_URL}xelatex/`

/**
 * 中文字体垫片（xeCJK）
 * -------------------------------------------------
 * 运行时里一个 CJK 字体都没有，中文能「编译通过」（XeTeX 缺字形只警告不报错），
 * 但 PDF 里汉字是空白，日志只有 `Missing character: There is no 者 (U+8005) in font …`。
 * 这里带了一份 Noto Serif SC（OFL，8.4MB，覆盖 CJK 基本区 20992 字 + 常用标点/拉丁），
 * 随 runtime-manifest.json 一起挂到 /fonts/。
 *
 * 为什么用 xeCJK 而不是 fontspec 的 \setmainfont：
 * \setmainfont 会把**整篇**文档的主字体换掉，拉丁文跟着一起变成 Noto Serif SC
 * （acmart 的 Libertine、IEEEtran 的 Times 全丢），而且文档类内部硬编码字体的
 * 地方仍然缺字 —— acmart 的标题与节标题走 Biolinum，fontspec 根本够不着。
 * xeCJK 只在 CJK 码位切字体，拉丁文沿用文档类自己的字体，并且自动接管
 * \sffamily/\ttfamily/\bfseries，所以中文在标题里也能出来。
 * 只有正文里真的出现 CJK 字符时才注入，纯英文文档完全不受影响。
 */
const CJK_FONT_FILE = 'NotoSerifSC-Regular.otf'
const CJK_FONT_DIR = '/fonts/'

/** CJK 字符探测：汉字（含扩展 A）、中日文标点、假名、全角符号 */
const CJK_PATTERN =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

const CJK_SHIM = [
  '% ---- AcademicFlow: 中文字体（运行时不含 CJK 字体，指到自带的 Noto Serif SC）----',
  '\\usepackage{xeCJK}',
  `\\setCJKmainfont{${CJK_FONT_FILE}}[Path=${CJK_FONT_DIR},`,
  `  BoldFont={${CJK_FONT_FILE}}, ItalicFont={${CJK_FONT_FILE}}, BoldItalicFont={${CJK_FONT_FILE}},`,
  '  AutoFakeBold=1.5, AutoFakeSlant=0.2]',
  `\\setCJKsansfont{${CJK_FONT_FILE}}[Path=${CJK_FONT_DIR},`,
  `  BoldFont={${CJK_FONT_FILE}}, AutoFakeBold=1.5, AutoFakeSlant=0.2]`,
  `\\setCJKmonofont{${CJK_FONT_FILE}}[Path=${CJK_FONT_DIR},`,
  `  BoldFont={${CJK_FONT_FILE}}, AutoFakeBold=1.5, AutoFakeSlant=0.2]`,
].join('\n')

/**
 * 把 CJK 垫片插到 \begin{document} 之前（也就是 preamble 末尾）。
 *
 * 用户自己配过中文（显式 \usepackage{xeCJK}，或用 ctex 系文档类）时一律不插手 ——
 * 我们的 \setCJKmainfont 会把他设的字体覆盖掉。这里用宽松的子串判断，宁可漏注入
 * 也不误覆盖。
 *
 * 另一类坑不在这里修：Latin Modern 的 TU 字体表（tulmr.fd 等）指向 lmroman9-regular
 * 这种运行时里根本没有的文件，一旦文档类在 \documentclass 阶段就 \small（IEEEtran 如此）
 * 就是致命错误。那个失败发生得太早，往 preamble 塞垫片来不及 —— 只能把被引用的
 * 字体文件真的补进运行时。
 */
function withRuntimeCompat(source: string): string {
  if (source.includes('AcademicFlow: 中文字体')) return source
  const needsCjk = CJK_PATTERN.test(source) && !/xeCJK|ctex/.test(source)
  const shims = needsCjk ? CJK_SHIM : ''
  const marker = '\\begin{document}'
  const idx = source.indexOf(marker)
  if (idx === -1) return `${source}\n${shims}\n`
  return `${source.slice(0, idx)}${shims}\n${source.slice(idx)}`
}

/** BibTeX 数据库在虚拟文件系统里的文件名，需与正文 \bibliography{...} 一致 */
export const BIB_FILE_NAME = 'references.bib'

let compiler: XeLaTeXCompiler | null = null

function getCompiler(): XeLaTeXCompiler {
  if (!compiler) {
    compiler = new XeLaTeXCompiler({
      assetBaseUrl: ASSET_BASE_URL,
      defaultPasses: 1,
    })
  }
  return compiler
}

export interface CompileLatexParams {
  /** 完整 LaTeX 源码 */
  source: string
  /** BibTeX 数据库内容；给了才会挂进虚拟文件系统并启用 bibtex */
  bibtex?: string
  /**
   * 额外挂进虚拟文件系统 /work 的文件（用户自己导入的宏包：.sty / .cls 等）。
   * 运行时环境变量 TEXINPUTS 的第一项就是 `.`，所以这些文件会被 XeTeX 直接找到，
   * 相当于把宏包装进了 TeX 发行版。
   */
  additionalFiles?: Array<{ path: string; data: Uint8Array }>
  onStatus?: (event: XeLaTeXStatusEvent) => void
  onLog?: (event: XeLaTeXLogEvent) => void
}

export interface CompileLatexResult {
  pdf: ArrayBuffer
  log: string
  passes: number
  bibtexRan: boolean
}

/**
 * 编译 LaTeX 为 PDF。
 * 编译失败会抛出 `XeLaTeXCompileError`，其 `.log` 字段带着完整 TeX 日志，
 * 调用方应把它展示给用户 —— 这是排查 LaTeX 报错的唯一线索。
 */
export async function compileLatex(
  params: CompileLatexParams,
): Promise<CompileLatexResult> {
  const instance = getCompiler()
  await instance.ready

  const compileOptions: Parameters<XeLaTeXCompiler['compile']>[1] = {
    bibtex: params.bibtex ? 'auto' : false,
    onStatus: params.onStatus,
    onLog: params.onLog,
  }
  const extraFiles = [...(params.additionalFiles ?? [])]
  if (params.bibtex) {
    extraFiles.push({
      path: BIB_FILE_NAME,
      data: new TextEncoder().encode(params.bibtex),
    })
  }
  if (extraFiles.length > 0) compileOptions.additionalFiles = extraFiles

  return (await instance.compile(withRuntimeCompat(params.source), compileOptions)) as XeLaTeXCompileResult
}

/** 从编译异常里取出 TeX 日志（不是编译错误时返回空串） */
export function getCompileErrorLog(err: unknown): string {
  if (err && typeof err === 'object' && 'log' in err) {
    const log = (err as { log?: unknown }).log
    if (typeof log === 'string') return log
  }
  return ''
}

/** 把编译产物 PDF 变成可给 <iframe> 用的 blob URL */
export function createPdfObjectUrl(pdf: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }))
}
