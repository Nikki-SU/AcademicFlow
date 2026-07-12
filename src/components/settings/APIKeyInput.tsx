/**
 * 通用 API Key 输入组件
 * -------------------------------------------------
 * type=password + 显隐切换 + 复制按钮 + 描述。
 * 用于设置页所有 sk-xxx 类凭据。
 */
import { Check, Copy, Eye, EyeOff, Key } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  /** 是否禁用（loading 中） */
  disabled?: boolean
}

function APIKeyInput({ label, value, onChange, placeholder, hint, disabled }: Props) {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success('已复制到剪贴板')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <Key className="w-3.5 h-3.5 text-slate-500" />
        {label}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || 'sk-...'}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          className="w-full px-3 py-2 pr-20 text-sm font-mono border border-slate-300 rounded-md
                     focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                     disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed
                     placeholder:font-sans placeholder:text-slate-400"
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="p-1 text-slate-500 hover:text-slate-800 rounded"
            title={visible ? '隐藏' : '显示'}
          >
            {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!value}
            className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300
                       disabled:cursor-not-allowed rounded"
            title="复制"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-600" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

export default APIKeyInput
