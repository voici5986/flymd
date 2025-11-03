// 滚轮接管（所见模式）：在容器层统一处理滚轮，选择“编辑优先/预览优先”，并保持光标/高亮同步
// 说明：此处不直接引用主模块的内部变量，通过参数回调获取/修改所需状态，便于解耦与单测

export type WheelDeps = {
  isWysiwyg: () => boolean
  moveCaretByLines: (delta: number, preferredColumn: number) => number
  applyCaretMoved: (delta: number) => void
  getCaretVisualColumn: () => number
  updateLineHighlight: () => void
  updateCaretDot: () => void
  ensureCaretDotInView: () => void
  scheduleRenderIfNeeded: () => void
}

function lineHeightOf(el: HTMLElement): number {
  const st = window.getComputedStyle(el)
  const fs = parseFloat(st.fontSize || '14') || 14
  const lh = parseFloat(st.lineHeight || '')
  return Number.isFinite(lh) && lh > 0 ? lh : fs * 1.6
}

export function createWysiwygWheelHandler(
  editor: HTMLElement,
  preview: HTMLElement,
  deps: WheelDeps,
) {
  let lastTarget: 'editor' | 'preview' = 'editor'
  let lastSwitchTs = 0
  const THRESHOLD_PX = 200 // 预览可滚空间比编辑器多出该阈值时，优先滚预览
  const SWITCH_DEBOUNCE_MS = 180

  return (e: WheelEvent) => {
    if (!deps.isWysiwyg()) return
    try {
      // 1) 归一化 dy
      let dy = Number.isFinite(e.deltaY) ? e.deltaY : 0
      if (dy === 0) return
      const lh = lineHeightOf(editor)
      if (e.deltaMode === 1) dy *= lh
      else if (e.deltaMode === 2) dy *= (editor.clientHeight || window.innerHeight || 400)

      if (!Number.isFinite(dy) || dy === 0) return
      const er = Math.max(0, editor.scrollHeight - editor.clientHeight)
      const pr = Math.max(0, preview.scrollHeight - preview.clientHeight)
      const now = Date.now()

      // 2) 选择滚动目标：无编辑滚动空间 → 预览；或预览比编辑器可滚空间多出阈值且通过去抖 → 预览
      if (er <= 0 && pr > 0) lastTarget = 'preview'
      else if ((pr - er) > THRESHOLD_PX && (now - lastSwitchTs) > SWITCH_DEBOUNCE_MS) {
        lastTarget = 'preview'
        lastSwitchTs = now
      }

      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

      if (lastTarget === 'preview') {
        const pmax = Math.max(0, preview.scrollHeight - preview.clientHeight)
        const pcur = (preview.scrollTop || 0) >>> 0
        const pnext = clamp(pcur + dy, 0, pmax)
        if (Math.abs(pnext - pcur) < 0.5) return
        e.preventDefault()
        preview.scrollTop = pnext
        // 反推编辑器滚动，保持大致比例（若 er>0）
        if (er > 0) {
          const enext = Math.round((pnext / (pmax || 1)) * er)
          ;(editor as any).scrollTop = enext
        } else {
          ;(editor as any).scrollTop = 0
          // 推动光标随滚轮移动，避免 keep-in-view 拉回
          try {
            let lines = Math.round(dy / (lh || 16))
            if (lines === 0) lines = (dy > 0 ? 1 : -1)
            const moved = deps.moveCaretByLines(lines, deps.getCaretVisualColumn())
            if (moved !== 0) deps.applyCaretMoved(moved)
          } catch {}
        }
        deps.updateLineHighlight(); deps.updateCaretDot(); deps.ensureCaretDotInView()
        deps.scheduleRenderIfNeeded()
        return
      }

      // editor 优先
      const emax = Math.max(0, editor.scrollHeight - editor.clientHeight)
      const ecur = ((editor as any).scrollTop || 0) >>> 0
      const enext = clamp(ecur + dy, 0, emax)
      if (Math.abs(enext - ecur) < 0.1) return
      e.preventDefault()
      ;(editor as any).scrollTop = enext
      // 同步预览（由上层的 syncScrollEditorToPreview 做精准映射，这里用比例兜底）
      const pmax = Math.max(0, preview.scrollHeight - preview.clientHeight)
      if (emax > 0) preview.scrollTop = Math.round((enext / emax) * pmax)

      // 光标随滚轮移动（保持当前行视口位置变动时不突兀）
      try {
        let lines = Math.round(dy / (lh || 16))
        if (lines === 0) lines = (dy > 0 ? 1 : -1)
        const moved = deps.moveCaretByLines(lines, deps.getCaretVisualColumn())
        if (moved !== 0) deps.applyCaretMoved(moved)
      } catch {}
      deps.updateLineHighlight(); deps.updateCaretDot()
      deps.scheduleRenderIfNeeded()
    } catch {}
  }
}
