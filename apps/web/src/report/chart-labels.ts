export interface LabelIn {
  /** The marked point on the chart. */
  x: number
  y: number
  text: string
  /** True when the label prefers to sit above its point. */
  up: boolean
}

export interface LabelOut {
  x: number
  y: number
  w: number
  text: string
}

const STEP = 14
const CHAR_W = 6.8

/**
 * Places chart labels so no two overlap. Each label starts beside its point (above or below), is kept inside the chart,
 * and moves a row at a time toward its preferred side, then the other side, until it finds a free row.
 */
export function layoutLabels(items: LabelIn[], box: { w: number; h: number; top: number; bottom: number }): LabelOut[] {
  const placed: LabelOut[] = []
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.x - b.it.x)
  const out: LabelOut[] = new Array(items.length)
  for (const { it, i } of order) {
    const w = it.text.length * CHAR_W + 6
    const x = Math.min(Math.max(it.x, w / 2 + 2), box.w - w / 2 - 2)
    const dir = it.up ? -1 : 1
    const y0 = it.y + (it.up ? -12 : 16)
    const rows: number[] = []
    for (let k = 0; k <= 8; k++) rows.push(y0 + dir * k * STEP)
    for (let k = 1; k <= 8; k++) rows.push(y0 - dir * k * STEP)
    const free = (y: number) => y >= box.top && y <= box.bottom && placed.every((p) => !(Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < STEP))
    const y = rows.find(free) ?? Math.min(Math.max(y0, box.top), box.bottom)
    const label = { x, y, w, text: it.text }
    placed.push(label)
    out[i] = label
  }
  return out
}
