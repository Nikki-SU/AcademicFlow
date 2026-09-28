/**
 * 答题音效（仅语音/朗读模式用）
 * -------------------------------------------------
 * 用 Web Audio 现场合成，不依赖任何音频文件：
 * - 答对：两声上扬的清脆「叮咚」
 * - 答错：两声下沉的低音「嘟」
 *
 * 浏览器的自动播放策略要求音频必须在用户手势之后才能出声，
 * 所以 AudioContext 懒创建、每次播放前尝试 resume（首次点击选项时即解锁）。
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC: typeof AudioContext | undefined =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try {
    if (!ctx) ctx = new AC()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** 在时间轴 at 处放一个带包络的单音（起音快、尾音衰减，避免咔哒声） */
function blip(
  audio: AudioContext,
  opts: { freq: number; at: number; dur: number; type: OscillatorType; peak: number },
) {
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = opts.type
  osc.frequency.setValueAtTime(opts.freq, opts.at)
  gain.gain.setValueAtTime(0.0001, opts.at)
  gain.gain.exponentialRampToValueAtTime(opts.peak, opts.at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.at + opts.dur)
  osc.connect(gain)
  gain.connect(audio.destination)
  osc.start(opts.at)
  osc.stop(opts.at + opts.dur + 0.03)
}

/** 答对：A5 → E6 上行，明亮轻快 */
export function playCorrectSfx() {
  try {
    const audio = getCtx()
    if (!audio) return
    const t = audio.currentTime
    blip(audio, { freq: 880, at: t, dur: 0.14, type: 'sine', peak: 0.22 })
    blip(audio, { freq: 1318.51, at: t + 0.11, dur: 0.2, type: 'sine', peak: 0.22 })
  } catch {
    /* 音效失败不影响答题 */
  }
}

/** 答错：300 → 170Hz 下行，低沉短促，一听就与答对区分开 */
export function playWrongSfx() {
  try {
    const audio = getCtx()
    if (!audio) return
    const t = audio.currentTime
    blip(audio, { freq: 300, at: t, dur: 0.16, type: 'triangle', peak: 0.2 })
    blip(audio, { freq: 170, at: t + 0.13, dur: 0.26, type: 'triangle', peak: 0.2 })
  } catch {
    /* 音效失败不影响答题 */
  }
}
