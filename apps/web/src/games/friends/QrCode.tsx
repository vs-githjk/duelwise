import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/**
 * A QR code drawn in the page from the link, with no request to anyone: the link never leaves the browser to be encoded.
 * Always dark on white with a four module quiet zone, in light and dark themes alike, because that is what phone cameras read best.
 */
export function qrPath(value: string): { size: number; d: string } {
  const qr = qrcode(0, 'M')
  qr.addData(value, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const quiet = 4
  let d = ''
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++
        continue
      }
      const start = c
      while (c < n && qr.isDark(r, c)) c++
      d += `M${start + quiet} ${r + quiet}h${c - start}v1h${-(c - start)}z`
    }
  }
  return { size: n + quiet * 2, d }
}

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => qrPath(value), [value])
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges" data-testid="qr">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#15181e" />
    </svg>
  )
}
