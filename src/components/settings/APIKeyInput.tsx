/**
 * 通用 API Key 输入组件
 * -------------------------------------------------
 * anti-autofill + 显隐切换 + 复制按钮 + 描述。
 * 用于设置页所有 sk-xxx 类凭据。
 *
 * 关键设计（v2 修复：GitHub PAT 污染 SiliconFlow key）：
 * - 不使用 type="password"（Chrome/Edge 会强制启动密码管理器 autofill，
 *   把 Login 页保存的 GitHub PAT 灌进来）
 * - 改用 type="text" + CSS text-security 遮罩字符达到密码显示效果
 * - 配合 autoComplete=new-password / data-lpignore / data-form-type=other
 *   降低密码管理器插件（LastPass / 1Password / Bitwarden）介入
 * - name 用业务化名字 af-secret-{fieldId}，避免命中通用密码字段规则
 */
import { Check, Copy, Eye, EyeOff, Key } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { toast } from 'sonner'

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  /** 是否禁用（loading 中） */
  disabled?: boolean
  /** 业务字段名，用于绕过浏览器密码管理器 autofill（避免与其他 password 字段串扰） */
  fieldId?: string
}

function APIKeyInput({ label, value, onChange, placeholder, hint, disabled, fieldId }: Props) {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  /**
   * anti-autofill 策略（防止 Chrome/Edge 把最近保存的密码（如 GitHub PAT）
   * 自动填到 SiliconFlow / MinerU key 输入框，覆盖 IndexedDB 里的真实值）：
   * 1. type 默认用 text，通过 css 掩码遮盖字符；显示切换时切到真 text
   *    → 不用 type=password，浏览器不会当成密码字段处理
   * 2. name 用业务特定名字 + fieldId，避免和"password / api_key"这类通用词撞上
   * 3. autoComplete=new-password / off，配合 data-lpignore / data-form-type=other
   *    降低 LastPass / Bitwarden / 1Password 的介入概率
   */
  const inputName = `af-secret-${fieldId ?? label.replace(/\s+/g, '-').toLowerCase()}`

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
          type={visible ? 'text' : 'text'}
          name={inputName}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || 'sk-...'}
          disabled={disabled}
          spellCheck={false}
          autoComplete="new-password"
          data-lpignore="true"
          data-form-type="other"
          data-1p-ignore="true"
          style={{
            // 未显示时用 CSS 遮罩字符，避免用 type=password 触发浏览器密码管理器
            WebkitTextSecurity: visible ? 'none' : 'disc',
            textSecurity: visible ? 'none' : 'disc',
            fontFamily: visible ? 'ui-monospace, monospace' : 'text-security-disc, ui-monospace, monospace',
          } as CSSProperties}
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
