/**
 * Tectonic WASM LaTeX 编译服务
 * -------------------------------------------------
 * 在浏览器中通过 WebAssembly 运行 Tectonic，将 LaTeX 源码编译为 PDF。
 *
 * 实现方案：
 * - 使用 tectonic WASM 构建（从 CDN 加载）
 * - 虚拟文件系统挂载输入文件
 * - 编译输出 PDF Blob
 *
 * 降级方案：如果 WASM 加载失败，回退到浏览器打印方式
 */

export type CompileStatus = 'idle' | 'loading' | 'compiling' | 'done' | 'error'

export interface CompileResult {
  pdfBlob: Blob
  sizeBytes: number
  pageCount?: number
  warnings: string[]
  logs: string
}

export interface CompileProgress {
  status: CompileStatus
  message: string
  progress?: number
}

type ProgressCallback = (p: CompileProgress) => void

let tectonicModule: any = null
let tectonicLoading: Promise<any> | null = null

async function loadTectonic(onProgress?: ProgressCallback): Promise<any> {
  if (tectonicModule) return tectonicModule
  if (tectonicLoading) return tectonicLoading

  tectonicLoading = (async () => {
    onProgress?.({ status: 'loading', message: '加载 Tectonic 编译引擎...' })

    try {
      // 从 CDN 动态加载 Tectonic WASM 模块
      const resp = await fetch(
        'https://cdn.jsdelivr.net/npm/@tectonic/tectonic@0.1.0/tectonic.js',
      )
      if (!resp.ok) throw new Error(`加载失败: ${resp.status}`)
      const jsCode = await resp.text()
      // eslint-disable-next-line no-new-func
      const factory = new Function('module', 'exports', jsCode)
      const mod: any = { exports: {} }
      factory(mod, mod.exports)
      tectonicModule = mod.exports.default || mod.exports
      onProgress?.({ status: 'loading', message: 'Tectonic 引擎已就绪', progress: 100 })
      return tectonicModule
    } catch (err) {
      console.warn('[Tectonic] WASM 加载失败，将使用降级方案:', err)
      tectonicModule = null
      tectonicLoading = null
      throw err
    }
  })()

  return tectonicLoading
}

export async function compileLatexToPdf(
  latexSource: string,
  bibtexSource?: string,
  onProgress?: ProgressCallback,
): Promise<CompileResult> {
  onProgress?.({ status: 'compiling', message: '准备编译...', progress: 5 })

  try {
    const Tectonic = await loadTectonic(onProgress)

    onProgress?.({ status: 'compiling', message: '初始化编译器...', progress: 15 })

    const engine = new Tectonic.Engine()

    onProgress?.({ status: 'compiling', message: '挂载输入文件...', progress: 25 })

    engine.writeFile('main.tex', latexSource)
    if (bibtexSource) {
      engine.writeFile('main.bib', bibtexSource)
    }

    onProgress?.({ status: 'compiling', message: '第一次编译 (LaTeX)...', progress: 40 })

    const result1 = engine.compile('main.tex')
    if (result1.status !== 0) {
      throw new Error(`LaTeX 编译失败:\n${result1.stderr}`)
    }

    if (bibtexSource) {
      onProgress?.({ status: 'compiling', message: '处理参考文献 (BibTeX)...', progress: 60 })
      const bibResult = engine.bibtex('main')
      if (bibResult.status !== 0) {
        console.warn('[Tectonic] BibTeX 警告:', bibResult.stderr)
      }

      onProgress?.({ status: 'compiling', message: '第二次编译 (交叉引用)...', progress: 75 })
      engine.compile('main.tex')

      onProgress?.({ status: 'compiling', message: '第三次编译 (最终排版)...', progress: 90 })
      engine.compile('main.tex')
    }

    onProgress?.({ status: 'compiling', message: '生成 PDF...', progress: 95 })

    const pdfData = engine.readFile('main.pdf')
    if (!pdfData) {
      throw new Error('编译完成但未找到 PDF 输出')
    }

    const pdfBlob = new Blob([pdfData], { type: 'application/pdf' })

    onProgress?.({ status: 'done', message: '编译完成', progress: 100 })

    return {
      pdfBlob,
      sizeBytes: pdfBlob.size,
      warnings: [],
      logs: result1.stderr || '',
    }
  } catch (err) {
    onProgress?.({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/**
 * 降级方案：用浏览器打印方式生成 PDF
 * 当 Tectonic WASM 不可用时使用
 */
export function fallbackExportPdf(latexSource: string, title = 'manuscript'): void {
  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    throw new Error('请允许弹出窗口以导出 PDF')
  }

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title} - LaTeX Preview</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/katex.min.css">
  <style>
    body {
      font-family: 'Times New Roman', 'SimSun', serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px;
      line-height: 1.6;
      font-size: 12pt;
    }
    h1 { text-align: center; font-size: 18pt; margin-bottom: 20px; }
    h2 { font-size: 14pt; margin-top: 24px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
    h3 { font-size: 12pt; margin-top: 16px; }
    .abstract {
      background: #f8f9fa;
      padding: 16px;
      margin: 16px 0;
      border-left: 4px solid #6366f1;
    }
    .katex-display { margin: 1em 0; }
    @media print {
      body { padding: 20px; }
    }
  </style>
</head>
<body>
  <div id="content">${renderLatexToHtml(latexSource)}</div>
  <script>
    window.onload = function() {
      setTimeout(() => {
        document.title = '${title}';
        window.print();
      }, 500);
    };
  </script>
</body>
</html>`

  printWindow.document.open()
  printWindow.document.write(htmlContent)
  printWindow.document.close()
}

function renderLatexToHtml(latex: string): string {
  let body = latex
    .replace(/\\documentclass(\[.*?\])?\{.*?\}/g, '')
    .replace(/\\usepackage(\[.*?\])?\{.*?\}/g, '')
    .replace(/\\begin\{document\}/g, '')
    .replace(/\\end\{document\}/g, '')
    .replace(/\\bibliographystyle\{.*?\}/g, '')
    .replace(/\\bibliography\{.*?\}/g, '')

  body = body
    .replace(/\\title\{(.+?)\}/g, '<h1>$1</h1>')
    .replace(/\\section\{(.+?)\}/g, '<h2>$1</h2>')
    .replace(/\\subsection\{(.+?)\}/g, '<h3>$1</h3>')
    .replace(/\\textbf\{(.+?)\}/g, '<strong>$1</strong>')
    .replace(/\\textit\{(.+?)\}/g, '<em>$1</em>')
    .replace(/\\emph\{(.+?)\}/g, '<em>$1</em>')
    .replace(/\\cite\{(.+?)\}/g, '<sup>[$1]</sup>')
    .replace(/\\begin\{abstract\}([\s\S]+?)\\end\{abstract\}/g, '<div class="abstract"><strong>Abstract</strong><p>$1</p></div>')
    .replace(/\\begin\{itemize\}([\s\S]+?)\\end\{itemize\}/g, '<ul>$1</ul>')
    .replace(/\\begin\{enumerate\}([\s\S]+?)\\end\{enumerate\}/g, '<ol>$1</ol>')
    .replace(/\\item\s/g, '<li>')
    .replace(/\\par/g, '</p><p>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\\newline/g, '<br/>')

  body = body.replace(/\\([a-zA-Z]+)(\{.*?\})?/g, (_match, _cmd, arg) => {
    if (arg) return arg.slice(1, -1)
    return ''
  })

  return `<p>${body}</p>`
}
