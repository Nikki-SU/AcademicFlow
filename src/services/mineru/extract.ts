/**
 * MinerU 产物 zip 解压 & 交叉验证（M3.7）
 * -------------------------------------------------
 * MinerU v4 返回的 zip 内部结构：
 *   full.md              主 markdown
 *   images/*.jpg|.png    图片（文件名是内容 hash，天然去重）
 *   layout.pdf/json      版面分析副产物（本项目不用）
 *   spans/*              span 详情（本项目不用）
 *   ...
 *
 * 本模块只关心：
 *   - markdown 全文（full.md，若不存在，找第一个 .md 兜底）
 *   - 所有 images/ 下的图片 Blob
 *   - markdown 里引用了但 zip 缺失的图 → missingImages（一般是致命错误）
 *   - zip 里有但 markdown 未引用的图 → orphanImages（layout 副产物，非致命）
 *
 * 已在 Python 侧（test_split_merge.py）验证过：
 *   - 186 张图 / markdown 168 处 ![](images/xxx) 引用全部对上
 *   - 18 张孤儿图（layout 副产物，符合预期）
 */
import JSZip from 'jszip'

/**
 * markdown 里 ![](images/xxx.jpg) 的图片引用正则
 * 兼容 ![](...) 和 ![alt](...) 两种写法
 */
const MD_IMAGE_REGEX = /!\[[^\]]*\]\(([^)]+)\)/g

export interface ExtractResult {
  /** 主 markdown 全文 */
  markdown: string
  /** 图片名（相对 zip 根）→ Blob */
  images: Record<string, Blob>
  /** markdown 引用但 zip 缺失（一般是致命错） */
  missingImages: string[]
  /** zip 有但 markdown 未引用（layout 副产物，非致命） */
  orphanImages: string[]
}

/**
 * 解压 MinerU 产物 zip
 * @param blob GET full_zip_url 返回的 Blob
 * @param options.imageExtensions 视为图片的扩展名（小写）；不传走默认
 */
export async function extractZip(
  blob: Blob,
  options: { imageExtensions?: string[] } = {},
): Promise<ExtractResult> {
  const imgExts = options.imageExtensions ?? [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.bmp',
    '.webp',
  ]

  const zip = await JSZip.loadAsync(blob)

  // 1) 抽出 markdown（优先 full.md，兜底任意 .md）
  let markdown = ''
  const preferMd = zip.file('full.md')
  if (preferMd) {
    markdown = await preferMd.async('string')
  } else {
    // 兜底：找第一个 .md 文件
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      if (name.toLowerCase().endsWith('.md')) {
        markdown = await entry.async('string')
        break
      }
    }
  }

  // 2) 抽出所有图片
  const images: Record<string, Blob> = {}
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const lower = name.toLowerCase()
    if (imgExts.some((ext) => lower.endsWith(ext))) {
      const buf = await entry.async('blob')
      // 存原始 zip 内路径（比如 "images/abc.jpg"）
      images[name] = buf
    }
  }

  // 3) markdown 里引用的图片路径
  const referenced = new Set<string>()
  const matches = markdown.matchAll(MD_IMAGE_REGEX)
  for (const m of matches) {
    // 引用形式一般是 images/xxx.jpg（相对路径）
    referenced.add(m[1].trim())
  }

  // 4) 交叉验证
  const imageKeys = new Set(Object.keys(images))
  const missingImages: string[] = []
  const orphanImages: string[] = []

  for (const ref of referenced) {
    if (!imageKeys.has(ref)) {
      missingImages.push(ref)
    }
  }
  for (const k of imageKeys) {
    if (!referenced.has(k)) {
      orphanImages.push(k)
    }
  }

  return {
    markdown,
    images,
    missingImages,
    orphanImages,
  }
}
