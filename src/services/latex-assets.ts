/**
 * 期刊模板自带资源（templates/journals/<slug>/assets/**）的引用解析
 * ----------------------------------------------------------------
 * 模板解包时把出版社整包的文件一个不丢地留在了 assets/ 下 —— 徽标、页眉图、
 * 字体、.bst/.bib 都在里面。但这些文件之前**从来没被挂进编译的虚拟文件系统**：
 * 模板 .tex 里一句 \includegraphics{head_foot/RSC_LOGO_CMYK} 就会让 XeTeX 在
 * -halt-on-error 下直接失败，用户看到的是「你们下载的官方模板都编不过」。
 *
 * 这里的原则：
 *   1. 图片这类大件只挂**源码真正引用到的**那几件 —— Wiley 那种整包 14MB，全量下载没意义；
 *   2. 出版社整包里的**宏包/文档类/参考文献样式**（.sty/.cls/.clo/.def/.bst）无条件全带上 ——
 *      它们是自洽的一套，依赖藏在类文件内部，从主 .tex 里看不出来（详见 TEMPLATE_PACKAGE_EXTS）；
 *   3. 缺件要**点名报到界面上**，不能让用户对着一句 not found 猜是哪个文件；
 *   4. references.bib 由应用单独提供，不算缺件（否则每次编译都会误报）。
 */

/** graphicx 找图时会自己试的扩展名（顺序即 TeX 的搜索顺序） */
const GRAPHIC_EXTS = ['.pdf', '.eps', '.png', '.jpg', '.jpeg', '.svg', '.ps', '.gif', '.tif', '.tiff']

/** 应用自己会提供的文件，不算「模板缺件」 */
const APP_PROVIDED = new Set(['references.bib'])

/**
 * 「出版社整包里的宏包文件」——这些**无条件**挂上，哪怕主 .tex 一个字都没提到。
 *
 * 出版社给的整包是一套自洽的目录：类文件内部还会 \usepackage 同包里的宏包、
 * \bibliographystyle 同包里的 .bst，从主 .tex 里根本看不到这层依赖。
 *
 * Wiley NJD 包就是现成的例子：主 .tex 只写 \documentclass[ASNA,twocolumn]{USG}，
 * 而 USG.cls 第 281 行 \usepackage{lettersp}（真正的文件叫 LETTERSP.STY，
 * 大小写无妨 —— TeX Live 2018 起 kpathsea 默认开启大小写折叠搜索），
 * 第 1955 行 \bibliographystyle{wileyNJD-Chicago}（.bst 同样只在包里）。
 * 只挂主 .tex 直接引到的文件，就会一直编到类文件内部才炸 not found。
 *
 * 这些文件都很小（现有全部模板加起来约 500KB），比「猜依赖猜不全」的代价小得多。
 */
const TEMPLATE_PACKAGE_EXTS = ['.sty', '.cls', '.clo', '.def', '.bst']

function isTemplatePackageFile(path: string): boolean {
  const lower = path.toLowerCase()
  return TEMPLATE_PACKAGE_EXTS.some((ext) => lower.endsWith(ext))
}

export interface TemplateAssetPlan {
  /** 要挂进虚拟文件系统的文件，路径**相对 assets/**（.tex 就是这么引用的） */
  files: string[]
  /** 源码引用了、模板 assets/ 里却没有的 —— 编译会在这些名字上 not found */
  missing: string[]
}

function normalizeRef(raw: string): string {
  return raw.trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

/** 取出某个命令的参数（跳过可选参数） */
function collectCommandArgs(tex: string, cmd: string): string[] {
  const re = new RegExp(`\\\\${cmd}\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]+)\\}`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(tex)) !== null) {
    for (const part of m[1].split(',')) {
      const n = normalizeRef(part)
      if (n) out.push(n)
    }
  }
  return out
}

/** 在 assets 路径表里查一个引用：先按原样，再按常见图片扩展名补全 */
function lookup(name: string, assetSet: Set<string>): string | null {
  const n = normalizeRef(name)
  if (!n) return null
  if (assetSet.has(n)) return n
  // 已经写了扩展名还不命中，就别再猜了（猜错反而挂错文件）
  if (/\.[a-z0-9]{1,5}$/i.test(n)) return null
  for (const ext of GRAPHIC_EXTS) {
    if (assetSet.has(n + ext)) return n + ext
  }
  return null
}

/**
 * 把「源码引用的资源」和「模板 assets 里实际有的文件」对上。
 * 纯函数，不碰网络，方便单独验证。
 */
export function planTemplateAssets(tex: string, assetPaths: string[]): TemplateAssetPlan {
  const assetSet = new Set(assetPaths.map(normalizeRef))
  // 源码里的图片引用不带扩展名，assets 里的带 —— 反转表让「带扩展名的」也能直接命中
  const files = new Set<string>()
  const missing = new Set<string>()

  // 图片与 \input/\include：缺了必然编不过，要在界面上点名
  const hardRefs = [
    ...collectCommandArgs(tex, 'includegraphics'),
    ...collectCommandArgs(tex, 'input'),
    ...collectCommandArgs(tex, 'include'),
    ...collectCommandArgs(tex, 'lstinputlisting'),
  ]
  for (const ref of hardRefs) {
    if (APP_PROVIDED.has(ref)) continue
    const hit = lookup(ref, assetSet) ?? lookup(`${ref}.tex`, assetSet)
    if (hit) files.add(hit)
    else missing.add(ref)
  }

  // 参考文献样式、.bib，以及模板自带的文档类/宏包：能找到就挂，找不到不报缺件 ——
  // \bibliographystyle{unsrt}、\usepackage{graphicx} 这类走的是 TeX 发行版自带的，
  // 不是模板的锅，报出来只会变成噪声。
  // 但 Wiley 的 USG.cls、RSC 的 NJDnatbib.sty 这类**包自带的**类文件必须挂，
  // 否则编译直接找不到类。
  const softRefs = [
    ...collectCommandArgs(tex, 'bibliographystyle').map((n) => `${n}.bst`),
    ...collectCommandArgs(tex, 'bibliography').map((n) => `${n}.bib`),
    ...collectCommandArgs(tex, 'addbibresource'),
    ...collectCommandArgs(tex, 'documentclass').map((n) => `${n}.cls`),
    ...collectCommandArgs(tex, 'usepackage').map((n) => `${n}.sty`),
  ]
  for (const ref of softRefs) {
    if (APP_PROVIDED.has(ref)) continue
    const hit = lookup(ref, assetSet)
    if (hit) files.add(hit)
  }

  // 出版社整包里的宏包 / 文档类 / 参考文献样式无条件带上（理由见 TEMPLATE_PACKAGE_EXTS）
  for (const path of assetSet) {
    if (isTemplatePackageFile(path)) files.add(path)
  }

  return { files: [...files], missing: [...missing] }
}
