/**
 * 会议转写 · 模型下拉选择器
 * -------------------------------------------------
 * 把「凭空手填模型名」换成真正的选择：
 *   ① 推荐组：官方免费 / 常用模型，一眼能选，且标注快慢差异
 *   ② 拉取清单组：按用户 Key 从硅基流动 GET /models 拉取后过滤出来的真实可用模型
 *   ③ 自定义：baseUrl 可换别家时保留手填兜底（默认体验仍是选择，不是手填）
 *
 * 选中的值不在任何已知清单里时，自动展开自定义输入框，不丢用户已填的值。
 */
import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'

export interface ModelPreset {
  value: string
  label: string
}

interface AsrModelPickerProps {
  label: string
  value: string
  onChange: (v: string) => void
  /** 推荐组（官方免费 / 常用模型，带快慢标注） */
  presets: ModelPreset[]
  /** 拉取清单（父组件已按 ASR / chat 过滤好） */
  fetched: string[]
  /** 能否拉取（通常 = 已填 Key） */
  canFetch: boolean
  isFetching: boolean
  /** 清单状态小字，如「未拉取」/「N 个 · HH:MM」 */
  fetchedLabel: string
  onFetch: () => void
  /** 是否允许空值（= 不启用该功能） */
  allowEmpty?: boolean
  emptyLabel?: string
  hint?: string
  customPlaceholder?: string
}

export default function AsrModelPicker({
  label,
  value,
  onChange,
  presets,
  fetched,
  canFetch,
  isFetching,
  fetchedLabel,
  onFetch,
  allowEmpty,
  emptyLabel,
  hint,
  customPlaceholder,
}: AsrModelPickerProps) {
  const presetValues = new Set(presets.map((p) => p.value))
  const fetchedSet = new Set(fetched)
  // 当前值不在推荐 / 拉取清单里、又不是空值 → 视为「自定义」（可能是用户手填过的）
  const isCustomValue = value !== '' && !presetValues.has(value) && !fetchedSet.has(value)
  const [customOpen, setCustomOpen] = useState(isCustomValue)

  // 拉取清单里去掉推荐组已有的，避免重复
  const extraFetched = Array.from(new Set(fetched.filter((id) => !presetValues.has(id)))).sort()

  const handleSelect = (v: string) => {
    if (v === '__custom__') {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    onChange(v)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-ui-sm font-medium text-ink-700">{label}</label>
        <button
          type="button"
          onClick={onFetch}
          disabled={!canFetch || isFetching}
          className="flex shrink-0 items-center gap-1 rounded-control-sm border border-ink-300 px-2 py-1 text-ui-xs
                     text-ink-600 transition hover:bg-paper-100 disabled:cursor-not-allowed disabled:text-ink-300"
        >
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {isFetching ? '拉取中…' : '拉取清单'}
        </button>
      </div>
      <p className="text-ui-xs text-ink-400">{fetchedLabel}</p>
      <select
        value={isCustomValue && !customOpen ? '__custom__' : value}
        onChange={(e) => handleSelect(e.target.value)}
        className="w-full rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-2 font-mono text-ui-sm
                   focus:border-transparent focus:outline-none focus:ring-2 focus:ring-seal-500"
      >
        {presets.length > 0 && (
          <optgroup label="推荐">
            {presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </optgroup>
        )}
        {extraFetched.length > 0 && (
          <optgroup label={`拉取清单（${extraFetched.length} 个）`}>
            {extraFetched.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </optgroup>
        )}
        <option value="__custom__">自定义…（手填模型名）</option>
        {allowEmpty && (
          <option value="">{emptyLabel ?? '留空 = 不启用'}</option>
        )}
      </select>
      {(customOpen || isCustomValue) && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={customPlaceholder ?? 'Model ID，如 Qwen/Qwen3-ASR-1.7B'}
          spellCheck={false}
          className="w-full rounded-control border border-ink-300 px-ui-gap py-2 font-mono text-ui-sm
                     focus:outline-none focus:ring-2 focus:ring-seal-500"
        />
      )}
      {hint && <p className="text-ui-xs text-ink-500">{hint}</p>}
    </div>
  )
}
