/**
 * 设备物理方向检测（spec §2.4）
 * -------------------------------------------------
 * 只区分横屏(landscape) / 竖屏(portrait)，不按设备类型分档。
 * window.innerWidth > window.innerHeight ⇒ 横屏样板
 * 否则 ⇒ 竖屏样板
 */
import { useState, useEffect } from 'react'

export type Orientation = 'landscape' | 'portrait'

export function useOrientation(): Orientation {
  const getOrientation = (): Orientation => {
    if (typeof window === 'undefined') return 'landscape'
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
  }

  const [orientation, setOrientation] = useState<Orientation>(getOrientation)

  useEffect(() => {
    const handleResize = () => setOrientation(getOrientation())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return orientation
}
