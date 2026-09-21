/**
 * 阅读对象（文献 / 图书）的统一标识与存储路径
 * -------------------------------------------------
 * 阅读页同时支持两种对象，它们只在 pipeline 上有区别，阅读侧的数据结构完全对称：
 *   文献 paper → literatures/{doi-slug}/
 *   图书 book  → textbooks/{书名}/
 *
 * 每个对象目录下：
 *   notes.md                        笔记
 *   annotations/annotations.csv     批注
 *   ai-chat.md                      问 AI 的对话记录（一本书 / 一篇文献一个大对话）
 *
 * 所有阅读侧服务都通过 DocRef + 本模块的 path helper 定位文件，
 * 不再各自硬编码 literatures/ 前缀。
 */

import { readMdFile, writeMdFile } from './userData'
import { doiToSlug } from './literatureData'

export type DocKind = 'paper' | 'book'

export interface DocRef {
  kind: DocKind
  /** paper = DOI；book = 书名（同时也是 textbooks/ 下的目录名） */
  id: string
}

/** 对象在仓库里的根目录（不带尾斜杠） */
export function docBasePath(ref: DocRef): string {
  return ref.kind === 'book'
    ? `textbooks/${ref.id}`
    : `literatures/${doiToSlug(ref.id)}`
}

export function notesPath(ref: DocRef): string {
  return `${docBasePath(ref)}/notes.md`
}

export function chatPath(ref: DocRef): string {
  return `${docBasePath(ref)}/ai-chat.md`
}

// ============================================================
// 笔记
// ============================================================

export async function loadNotes(ref: DocRef): Promise<string> {
  const result = await readMdFile(notesPath(ref))
  return result?.content || ''
}

export async function saveNotes(ref: DocRef, content: string): Promise<void> {
  await writeMdFile(notesPath(ref), content, 'Update reading notes')
}

// ============================================================
// 问 AI 对话记录（整篇一个大对话，md 落盘，人可读可手改）
// ============================================================

export async function loadReadingChat(ref: DocRef): Promise<string> {
  const result = await readMdFile(chatPath(ref))
  return result?.content || ''
}

export async function saveReadingChat(ref: DocRef, content: string): Promise<void> {
  await writeMdFile(chatPath(ref), content, 'Update reading AI chat')
}
