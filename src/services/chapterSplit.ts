/**
 * 课本章节切分服务
 * -------------------------------------------------
 * 将课本 Markdown 按一级/二级标题切分为章节，
 * 保存到 textbooks/{textbookId}/chapters/ 目录下，
 * 同时更新 textbooks.csv 的 chapters 字段。
 */

import { writeFileBatch, type BatchFileOp } from './github'
import { loadTextbooks, saveTextbooks } from './textbookData'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { assertCanWrite } from './authError'

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

async function batchWrite(ops: BatchFileOp[], message: string): Promise<void> {
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) return
  await writeFileBatch(ops, message, ctx.owner, ctx.repo, ctx.token)
}

export interface ChapterInfo {
  id: string
  title: string
  level: number
  index: number
  wordCount: number
}

export interface SplitResult {
  chapters: ChapterInfo[]
  totalChapters: number
  totalWords: number
}

function slugify(title: string, index: number): string {
  const clean = title
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  const paddedIndex = String(index).padStart(3, '0')
  return clean ? `${paddedIndex}-${clean}` : `chapter-${paddedIndex}`
}

/**
 * 将 Markdown 按标题切分为章节
 * 规则：
 * - 以 # 一级标题为章节分界
 * - 如果没有一级标题，则以 ## 二级标题为界
 * - 开头的前言部分作为 chapter-000
 */
export function splitMarkdownIntoChapters(
  markdown: string,
  headingLevel: 1 | 2 = 1,
): SplitResult & { chapterContents: ChapterInfo[] & { content: string }[] } {
  const lines = markdown.split('\n')
  const chapters: Array<{
    id: string
    title: string
    level: number
    index: number
    content: string
    wordCount: number
  }> = []

  let currentContent: string[] = []
  let currentTitle = '前言'
  let currentLevel = 0
  let chapterIndex = 0

  const headingPattern = headingLevel === 1 ? /^#\s+(.*)/ : /^##\s+(.*)/

  for (const line of lines) {
    const match = line.match(headingPattern)
    if (match) {
      if (currentContent.length > 0 || chapters.length === 0) {
        const content = currentContent.join('\n').trim()
        chapters.push({
          id: slugify(currentTitle, chapterIndex),
          title: currentTitle,
          level: currentLevel,
          index: chapterIndex,
          content,
          wordCount: countWords(content),
        })
        chapterIndex++
      }
      currentTitle = match[1].trim()
      currentLevel = headingLevel
      currentContent = [line]
    } else {
      currentContent.push(line)
    }
  }

  if (currentContent.length > 0) {
    const content = currentContent.join('\n').trim()
    if (content || chapters.length === 0) {
      chapters.push({
        id: slugify(currentTitle, chapterIndex),
        title: currentTitle,
        level: currentLevel,
        index: chapterIndex,
        content,
        wordCount: countWords(content),
      })
    }
  }

  const totalWords = chapters.reduce((sum, c) => sum + c.wordCount, 0)

  return {
    chapters: chapters.map(({ content, ...info }) => info),
    chapterContents: chapters as any,
    totalChapters: chapters.length,
    totalWords,
  }
}

function countWords(text: string): number {
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  return englishWords + chineseChars
}

/**
 * 切分课本并保存到 GitHub
 */
export async function splitAndSaveTextbookChapters(
  textbookId: string,
  textbookMarkdown: string,
): Promise<SplitResult> {
  const result = splitMarkdownIntoChapters(textbookMarkdown)

  const dir = `textbooks/${textbookId}`
  const chaptersDir = `${dir}/chapters`

  const ops: BatchFileOp[] = []

  for (const chapter of result.chapterContents) {
    ops.push({
      path: `${chaptersDir}/${chapter.id}.md`,
      content: chapter.content,
      encoding: 'utf-8',
    })
  }

  ops.push({
    path: `${dir}/chapters/index.json`,
    content: JSON.stringify(
      {
        textbookId,
        totalChapters: result.totalChapters,
        totalWords: result.totalWords,
        chapters: result.chapters,
      },
      null,
      2,
    ),
    encoding: 'utf-8',
  })

  await batchWrite(
    ops,
    `chore: split textbook ${textbookId.slice(0, 30)} into ${result.totalChapters} chapters`,
  )

  const textbooks = await loadTextbooks()
  const updated = textbooks.map((t) =>
    t.textbookId === textbookId
      ? {
          ...t,
          chapters: result.chapters.map((c) => c.id).join(';'),
          includedChapters: result.chapters.map((c) => c.id).join(';'),
          scope: `${result.totalChapters} chapters`,
        }
      : t,
  )
  await saveTextbooks(updated)

  return {
    chapters: result.chapters,
    totalChapters: result.totalChapters,
    totalWords: result.totalWords,
  }
}
