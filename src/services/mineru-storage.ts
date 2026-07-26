/**
 * MinerU 转换结果存储服务
 * -------------------------------------------------
 * 将 PDF 解析出的 Markdown 和图片保存到 GitHub 私库：
 * - 文献：literatures/{doi}/index.md + images/
 * - 课本：textbooks/{textbook_id}/index.md + images/
 */

import { writeFileBatch, type BatchFileOp } from './github'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { assertCanWrite } from './authError'

function sanitizePath(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_')
    .replace(/__+/g, '_')
    .slice(0, 200)
}

function doiToPath(doi: string): string {
  return sanitizePath(doi.replace(/\//g, '__'))
}

function getRepoContext(): { owner: string; repo: string; token: string } | null {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.token || !auth.user || !ws.repo) return null
  return {
    owner: auth.user.login,
    repo: ws.repo.name,
    token: auth.token,
  }
}

async function batchWrite(ops: BatchFileOp[], message: string): Promise<{ commitSha?: string }> {
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) return {}
  try {
    const result = await writeFileBatch(ops, message, ctx.owner, ctx.repo, ctx.token)
    return { commitSha: result.commitSha }
  } catch (err) {
    console.warn('[mineru-storage] 批量写入失败:', err)
    throw err
  }
}

export interface MineruSaveResult {
  mdPath: string
  imageCount: number
  commitSha?: string
}

/**
 * 保存文献的 MinerU 转换结果到 GitHub
 */
export async function savePaperMineruResult(params: {
  doi: string
  markdown: string
  images: Record<string, Blob>
}): Promise<MineruSaveResult> {
  const { doi, markdown, images } = params
  const dir = `literatures/${doiToPath(doi)}`
  const mdPath = `${dir}/index.md`

  const ops: BatchFileOp[] = [
    {
      path: mdPath,
      content: markdown,
      encoding: 'utf-8',
    },
  ]

  const imgDir = `${dir}/images`
  for (const [name, blob] of Object.entries(images)) {
    const safeName = sanitizePath(name)
    const arrayBuffer = await blob.arrayBuffer()
    const uint8 = new Uint8Array(arrayBuffer)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < uint8.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(uint8.subarray(i, i + chunkSize)))
    }
    const base64 = btoa(binary)
    ops.push({
      path: `${imgDir}/${safeName}`,
      content: base64,
      encoding: 'base64',
    })
  }

  const result = await batchWrite(ops, `chore: MinerU convert literature ${doi.slice(0, 30)}`)

  return {
    mdPath,
    imageCount: Object.keys(images).length,
    commitSha: result?.commitSha,
  }
}

/**
 * 保存课本的 MinerU 转换结果到 GitHub
 */
export async function saveTextbookMineruResult(params: {
  textbookId: string
  markdown: string
  images: Record<string, Blob>
}): Promise<MineruSaveResult> {
  const { textbookId, markdown, images } = params
  const dir = `textbooks/${sanitizePath(textbookId)}`
  const mdPath = `${dir}/index.md`

  const ops: BatchFileOp[] = [
    {
      path: mdPath,
      content: markdown,
      encoding: 'utf-8',
    },
  ]

  const imgDir = `${dir}/images`
  for (const [name, blob] of Object.entries(images)) {
    const safeName = sanitizePath(name)
    const arrayBuffer = await blob.arrayBuffer()
    const uint8 = new Uint8Array(arrayBuffer)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < uint8.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(uint8.subarray(i, i + chunkSize)))
    }
    const base64 = btoa(binary)
    ops.push({
      path: `${imgDir}/${safeName}`,
      content: base64,
      encoding: 'base64',
    })
  }

  const result = await batchWrite(ops, `chore: MinerU convert textbook ${textbookId.slice(0, 30)}`)

  return {
    mdPath,
    imageCount: Object.keys(images).length,
    commitSha: result?.commitSha,
  }
}

/**
 * 兼容旧调用名：保存文献 MD
 */
export async function saveMdFileForPaper(
  doi: string,
  markdown: string,
  images?: Record<string, Blob>,
): Promise<string> {
  const result = await savePaperMineruResult({
    doi,
    markdown,
    images: images || {},
  })
  return result.mdPath
}

/**
 * 兼容旧调用名：保存课本 MD
 */
export async function saveMdFileForTextbook(
  textbookId: string,
  markdown: string,
  images?: Record<string, Blob>,
): Promise<string> {
  const result = await saveTextbookMineruResult({
    textbookId,
    markdown,
    images: images || {},
  })
  return result.mdPath
}

/**
 * 兼容旧调用名：保存文献图片
 */
export async function savePaperImages(doi: string, images: Record<string, Blob>): Promise<number> {
  const result = await savePaperMineruResult({
    doi,
    markdown: '',
    images,
  })
  return result.imageCount
}

/**
 * 兼容旧调用名：保存课本图片
 */
export async function saveTextbookImages(textbookId: string, images: Record<string, Blob>): Promise<number> {
  const result = await saveTextbookMineruResult({
    textbookId,
    markdown: '',
    images,
  })
  return result.imageCount
}
