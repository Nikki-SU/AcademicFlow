/**
 * MinerU 阶段常量（子组件共享）
 * -------------------------------------------------
 * 与 MineruStage 类型对齐；集中定义 STAGE_ORDER + STAGE_LABEL
 * 供 MineruTestPanel / MineruProgressTimeline / MineruResultPanel 共用
 */
import type { MineruStage } from '../../types'

export const STAGE_ORDER: MineruStage[] = [
  'applying',
  'uploading',
  'polling',
  'downloading',
  'extracting',
  'done',
]

export const STAGE_LABEL: Record<MineruStage, string> = {
  idle: '未开始',
  applying: '① 申请上传 URL',
  uploading: '② 上传 PDF',
  polling: '③ 等待 MinerU 解析',
  downloading: '④ 下载产物 zip',
  extracting: '⑤ 前端解压 & 校验',
  done: '✅ 完成',
  failed: '❌ 失败',
}
