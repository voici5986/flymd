// anchors.ts - 构建锚点表与基于锚点的滚动同步

export type Anchor = { pos: number; top: number }

export function buildAnchors(root: HTMLElement): Anchor[] {
  const anchors: Anchor[] = []
  try {
    const nodes = root.querySelectorAll('[data-pos-start]')
    nodes.forEach((el) => {
      const pos = Number((el as HTMLElement).getAttribute('data-pos-start') || 'NaN')
      if (!Number.isFinite(pos)) return
      const top = (el as HTMLElement).offsetTop
      anchors.push({ pos, top })
    })
  } catch {}
  anchors.sort((a, b) => a.pos - b.pos)
  return anchors
}

export function syncByAnchor(editorPos: number, anchors: Anchor[], pr: number): number {
  if (!anchors || anchors.length === 0) return 0
  let i = 0
  while (i + 1 < anchors.length && anchors[i + 1].pos <= editorPos) i++
  const curr = anchors[i]
  const next = anchors[i + 1]
  if (!next) return Math.min(pr, curr.top)
  const denom = Math.max(1, next.pos - curr.pos)
  const ratio = (editorPos - curr.pos) / denom
  const est = curr.top + ratio * (next.top - curr.top)
  return Math.min(pr, Math.max(0, Math.round(est)))
}
