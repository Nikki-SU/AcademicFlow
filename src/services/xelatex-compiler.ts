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
 * 中文字体垫片
 * -------------------------------------------------
 * 运行时里一个 CJK 字体都没有，中文能「编译通过」（XeTeX 缺字形只警告不报错），
 * 但 PDF 里汉字是空白，日志只有 `Missing character: There is no 者 (U+8005) in font …`。
 * 这里带了一份 Noto Serif SC（OFL，8.4MB，覆盖 CJK 基本区 20992 字 + 常用标点/拉丁），
 * 随 runtime-manifest.json 一起挂到 /fonts/。
 *
 * 只能用 fontspec + \setmainfont：运行时里没有 xeCJK / ctex，也就没有
 * \setCJKmainfont 可用；而我们要的正是「中英文都出得来」，所以直接把主字体
 * 换成这套自带拉丁字形的 CJK 衬线体（Noto Serif SC 的拉丁部分本就是 Source Serif，
 * 配中文论文不违和）。只有正文里真的出现 CJK 字符时才注入，纯英文文档
 * 仍用运行时自带的 Latin Modern。
 */
const CJK_FONT_FILE = 'NotoSerifSC-Regular.otf'
const CJK_FONT_DIR = '/fonts/'

/** CJK 字符探测：汉字（含扩展 A）、中日文标点、假名、全角符号 */
const CJK_PATTERN =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

const CJK_SHIM = [
  '% ---- AcademicFlow: 中文字体（运行时不含 CJK 字体，指到自带的 Noto Serif SC）----',
  '\\usepackage{fontspec}',
  `\\setmainfont{${CJK_FONT_FILE}}[Path=${CJK_FONT_DIR},`,
  `  BoldFont={${CJK_FONT_FILE}}, ItalicFont={${CJK_FONT_FILE}}, BoldItalicFont={${CJK_FONT_FILE}},`,
  '  AutoFakeBold=1.5, AutoFakeSlant=0.2]',
].join('\n')

/**
 * 把 CJK 垫片插到 \begin{document} 之前（也就是 preamble 末尾）。
 * Latin Modern 那堆缺字体的坑不在这里修 —— 已经直接在
 * `public/xelatex/texmf/tex/latex/base/tulmr.fd` 里改掉了 shape 表，
 * 因为那个失败发生在 \documentclass 阶段（IEEEtran 载入时就用 \small），
 * 往 preamble 塞垫片根本来不及。
 */
function withRuntimeCompat(source: string): string {
  if (source.includes('AcademicFlow: 中文字体')) return source
  const shims = CJK_PATTERN.test(source) ? CJK_SHIM : ''
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
  if (params.bibtex) {
    compileOptions.additionalFiles = [
      { path: BIB_FILE_NAME, data: new TextEncoder().encode(params.bibtex) },
    ]
  }

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
