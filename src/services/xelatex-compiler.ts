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

  return (await instance.compile(params.source, compileOptions)) as XeLaTeXCompileResult
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
