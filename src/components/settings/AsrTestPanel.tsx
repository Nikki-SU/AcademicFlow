/**
 * 会议转写（硅基流动）连通性测试
 * -------------------------------------------------
 * 就在「会议转写」设置组的 Key 旁边，点一下真跑一遍：
 *   ① Key 校验（GET /models）
 *   ② 真录 2.5 秒 → 走生产同款 MediaRecorder → 真调 /audio/transcriptions
 *   ③ 若开了翻译 → 真调 /chat/completions
 *
 * 为什么第 ② 步必须真录：只探 /models 只能证明 Key 能过，证明不了
 * 「录音能不能出字」。这里刻意复用与生产完全相同的录音链路，测试过了
 * 才敢说这套配置是能用的；失败了就当场把卡在哪一步、错在哪一句亮出来。
 */
import { useState } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, CircleDashed, TestTube2 } from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import {
  probeAsrFull,
  type AsrProbeStepKey,
  type AsrStepStatus,
} from '../../services/asr'

interface StepState {
  label: string
  status: AsrStepStatus | 'pending'
  detail?: string
}

const STEP_DEFS: { key: AsrProbeStepKey; label: string }[] = [
  { key: 'key', label: 'Key 校验（GET /models）' },
  { key: 'transcribe', label: '转写真调（录 2.5s → /audio/transcriptions）' },
  { key: 'translate', label: '翻译真调（/chat/completions）' },
]

function initSteps(): Record<AsrProbeStepKey, StepState> {
  return {
    key: { label: STEP_DEFS[0].label, status: 'pending' },
    transcribe: { label: STEP_DEFS[1].label, status: 'pending' },
    translate: { label: STEP_DEFS[2].label, status: 'pending' },
  }
}

export default function AsrTestPanel() {
  const asrApiKey = useSettingsStore((s) => s.asrApiKey)
  const asrBaseUrl = useSettingsStore((s) => s.asrBaseUrl)
  const asrModel = useSettingsStore((s) => s.asrModel)
  const asrTranslateModel = useSettingsStore((s) => s.asrTranslateModel)
  const asrTranslateToZh = useSettingsStore((s) => s.asrTranslateToZh)

  const [testing, setTesting] = useState(false)
  const [steps, setSteps] = useState<Record<AsrProbeStepKey, StepState>>(initSteps)
  const [verdict, setVerdict] = useState<'ok' | 'err' | null>(null)

  const canTest = asrApiKey.trim().length > 0 && !testing

  const run = async () => {
    if (!asrApiKey.trim()) {
      toast.error('先填硅基流动 API Key')
      return
    }
    setTesting(true)
    setVerdict(null)
    setSteps(initSteps())
    try {
      const { ok } = await probeAsrFull(
        {
          baseUrl: asrBaseUrl,
          apiKey: asrApiKey,
          asrModel,
          translateModel: asrTranslateModel,
          translateToZh: asrTranslateToZh,
        },
        (key, status, detail) =>
          setSteps((prev) => ({ ...prev, [key]: { ...prev[key], status, detail } })),
      )
      setVerdict(ok ? 'ok' : 'err')
      if (!ok) toast.error('会议转写连通性失败')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setVerdict('err')
      toast.error(`测试异常：${msg}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-ui-xs text-ink-500">
          先在这里测通，再去录音。测试会真录 2.5 秒并真调硅基流动（需要麦克风权限）。
        </p>
        <button
          type="button"
          onClick={run}
          disabled={!canTest}
          className="flex items-center gap-1.5 px-ui-gap py-1.5 text-ui-xs font-medium rounded-control-sm border border-seal-400 bg-seal-50 text-seal-700
                     hover:bg-seal-100 disabled:text-ink-300 disabled:cursor-not-allowed disabled:bg-paper-100 disabled:border-ink-200"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TestTube2 className="w-3.5 h-3.5" />}
          {testing ? '测试中…' : '测试连通性'}
        </button>
      </div>

      {(testing || verdict !== null) && (
        <div className="space-y-0.5">
          {STEP_DEFS.map((def, i) => {
            const s = steps[def.key]
            return (
              <div key={def.key} className="flex items-start gap-2">
                <span className="mt-0.5">{statusIcon(s.status)}</span>
                <div className="flex-1 min-w-0 pb-1">
                  <div className={`text-ui-xs leading-tight ${statusColor(s.status)}`}>
                    {def.label}
                    {s.detail && <span className="ml-1 text-ink-400 font-normal">{s.detail}</span>}
                  </div>
                  {i < STEP_DEFS.length - 1 && <div className="h-0" />}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {verdict === 'ok' && (
        <p className="text-ui-xs text-green-700">这套配置可用：Key、转写端点、翻译端点都真调通了。</p>
      )}
      {verdict === 'err' && (
        <p className="text-ui-xs text-red-600">
          配置不可用 —— 按上面标红的那一步去改（多数是 Key 不对、模型名不对，或浏览器录出的音频容器后端不认）。
        </p>
      )}
      {!asrApiKey.trim() && (
        <p className="text-ui-xs text-amber-600">还没填 API Key，录音会直接失败（不会出字）。</p>
      )}
    </div>
  )
}

function statusIcon(status: AsrStepStatus | 'pending') {
  switch (status) {
    case 'pending':
      return <CircleDashed className="w-3 h-3 text-ink-300" />
    case 'running':
      return <Loader2 className="w-3 h-3 text-seal-500 animate-spin" />
    case 'done':
      return <CheckCircle2 className="w-3 h-3 text-green-600" />
    case 'error':
      return <AlertTriangle className="w-3 h-3 text-red-500" />
    case 'skip':
      return <CircleDashed className="w-3 h-3 text-ink-300" />
  }
}

function statusColor(status: AsrStepStatus | 'pending') {
  switch (status) {
    case 'pending':
      return 'text-ink-400'
    case 'running':
      return 'text-seal-600 font-medium'
    case 'done':
      return 'text-green-700'
    case 'error':
      return 'text-red-600 font-medium'
    case 'skip':
      return 'text-ink-400'
  }
}
