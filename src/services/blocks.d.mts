/**
 * blocks.mjs 的类型声明 —— 实现见 blocks.mjs（前端与 runner 共用的唯一一份源码）
 */

export const OPEN: string
export const CLOSE: string
export const END: string

export const FLOW_TYPES: readonly string[]
export const FLOAT_TYPES: readonly string[]
export const NOTE_TYPES: readonly string[]

export interface FlowNode {
  kind: 'flow'
  type: '标题' | '正文' | '列表'
  /** 标题级别 1-6；正文恒为 0；列表为层级 */
  level: number
  /** 全文连续编号，标题/正文/列表共享同一序列 */
  n: number
}
export interface FloatNode {
  kind: 'float'
  type: '图' | '表' | '图注' | '公式'
  /** 锚：前面的流块编号 */
  anchor: number
  /** 同一锚点内 图/表/图注/公式 共享的序号 */
  s: number
}
export interface NoteNode {
  kind: 'note'
  type: '引文' | '文献'
}
export interface TranslationNode {
  kind: 'translation'
  /** 源块编号（"12" 或 "12·3"）；null 表示挂在紧邻的上一个块 */
  ref: string | null
}
export type BlockNode = FlowNode | FloatNode | NoteNode | TranslationNode

export interface BlockItem {
  t: 'block'
  node: BlockNode
  content: string
}
export interface TextItem {
  t: 'text'
  content: string
}
export type Item = BlockItem | TextItem

/** readDocument 的输出：译文已合并进源块 */
export interface ReadBlockItem extends BlockItem {
  id: string | null
  cn: string | undefined
}
export type ReadItem = ReadBlockItem | TextItem

export function parseMeta(meta: string): BlockNode | null
export function metaOf(node: BlockNode): string
export function blockId(node: BlockNode): string | null
export function isTranslatable(node: BlockNode | null | undefined): boolean
export function labelOf(node: BlockNode | null | undefined): string

export function parseBlocks(md: string): { items: Item[]; warnings: string[] }
export function serializeBlocks(items: Item[]): string
export function blocksIn(items: Item[]): BlockItem[]

export function renumber(items: Item[]): Item[]

export function readDocument(md: string): { items: ReadItem[]; warnings: string[] }
export function readAnyDocument(md: string): { items: ReadItem[]; warnings: string[] }
export function stripMarkers(md: string): string
export function contentFingerprint(md: string): string

export function legacyToBlocks(md: string): string | null

declare const _default: {
  OPEN: string
  CLOSE: string
  END: string
  parseMeta: typeof parseMeta
  metaOf: typeof metaOf
  blockId: typeof blockId
  isTranslatable: typeof isTranslatable
  labelOf: typeof labelOf
  parseBlocks: typeof parseBlocks
  serializeBlocks: typeof serializeBlocks
  blocksIn: typeof blocksIn
  renumber: typeof renumber
  readDocument: typeof readDocument
  stripMarkers: typeof stripMarkers
  contentFingerprint: typeof contentFingerprint
  legacyToBlocks: typeof legacyToBlocks
  readAnyDocument: typeof readAnyDocument
}
export default _default
