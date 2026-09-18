/**
 * 全局设置服务 — GitHub 私库持久化（非敏感设置）
 * -------------------------------------------------
 * SPEC §4.8：settings/global.md 存非敏感设置（AI 模型选择、模式开关等）。
 * API key 等敏感凭据只存 IndexedDB，不进 md 文件（SPEC §2.3 硬性禁忌）。
 *
 * 本服务只处理非敏感字段。敏感字段由 stores/settings.ts 直接读写 IndexedDB。
 */
import { readMdFile, writeMdFile } from './userData'

const SETTINGS_PATH = 'settings/global.md'

/** 非敏感设置字段（存 GitHub 私库 global.md） */
export interface GlobalSettingsData {
  advancedMode: boolean
  aiProviderMode: string
  ai1Model: string
  ai2Model: string
  ai2ProviderMode: string
  customAi1BaseUrl: string
  customAi1Model: string
  customAi2BaseUrl: string
  customAi2Model: string
  extractCoverImage: boolean
  autoExtractWords: boolean
  mineruDebugMode: boolean
  wordGenCount: number
}

/** 从 GitHub 私库读取非敏感全局设置 */
export async function loadGlobalSettings(): Promise<Partial<GlobalSettingsData> | null> {
  try {
    const doc = await readMdFile(SETTINGS_PATH)
    if (!doc?.content) return null
    return parseSettingsMd(doc.content)
  } catch (err) {
    console.warn('[globalSettings] 读取失败:', err)
    return null
  }
}

/** 保存非敏感全局设置到 GitHub 私库 */
export async function saveGlobalSettings(settings: GlobalSettingsData): Promise<void> {
  const md = serializeSettingsMd(settings)
  await writeMdFile(SETTINGS_PATH, md, 'Update global settings')
}

function parseSettingsMd(md: string): Partial<GlobalSettingsData> {
  const result: Partial<GlobalSettingsData> = {}
  const lines = md.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const content = trimmed.slice(2)
    const colonIdx = content.indexOf(': ')
    if (colonIdx < 0) continue
    const key = content.slice(0, colonIdx).trim()
    const value = content.slice(colonIdx + 2).trim()

    switch (key) {
      case 'advanced_mode':
        result.advancedMode = value === 'true'
        break
      case 'ai_provider_mode':
        result.aiProviderMode = value || 'deepseek'
        break
      case 'ai1_model':
        result.ai1Model = value
        break
      case 'ai2_model':
        result.ai2Model = value
        break
      case 'ai_2_provider_mode':
        result.ai2ProviderMode = value || 'deepseek'
        break
      case 'custom_ai_1_base_url':
        result.customAi1BaseUrl = value
        break
      case 'custom_ai_1_model':
        result.customAi1Model = value
        break
      case 'custom_ai_2_base_url':
        result.customAi2BaseUrl = value
        break
      case 'custom_ai_2_model':
        result.customAi2Model = value
        break
      case 'extract_cover_image':
        result.extractCoverImage = value === 'true'
        break
      case 'auto_extract_words':
        result.autoExtractWords = value === 'true'
        break
      case 'mineru_debug_mode':
        result.mineruDebugMode = value === 'true'
        break
      case 'word_gen_count': {
        const n = parseInt(value, 10)
        if (!isNaN(n)) result.wordGenCount = Math.min(50, Math.max(10, n))
        break
      }
    }
  }
  return result
}

function serializeSettingsMd(s: GlobalSettingsData): string {
  return `# 全局设置

## 语言
- language_mode: cn

## AI 服务
- ai_provider_mode: ${s.aiProviderMode}
- ai1_model: ${s.ai1Model}
- ai2_model: ${s.ai2Model}
- ai_2_provider_mode: ${s.ai2ProviderMode}
- advanced_mode: ${s.advancedMode}
- custom_ai_1_base_url: ${s.customAi1BaseUrl}
- custom_ai_1_model: ${s.customAi1Model}
- custom_ai_2_base_url: ${s.customAi2BaseUrl}
- custom_ai_2_model: ${s.customAi2Model}

## PDF 处理
- pdf_retention_days: 30
- extract_cover_image: ${s.extractCoverImage}
- auto_extract_words: ${s.autoExtractWords}
- mineru_debug_mode: ${s.mineruDebugMode}
- word_gen_count: ${s.wordGenCount}

## 追踪
- daily_push_time: 08:00
- push_channels: inbox

## 词典
- dict_sources: freedict, wiktionary

## 编辑器
- editor_theme: light

---

*Managed by AcademicFlow.*
`
}
