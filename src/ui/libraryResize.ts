// 库侧栏宽度拖拽调整（内侧分界线）
// 目标：
// - 左/右侧都支持拖动（从库与工作区的分界线拖）
// - 源码/所见/阅读模式一致生效（库侧栏本身不随模式切换）
// - 仅修改 CSS 变量 --library-width，避免把“宽度状态”散落到各处
// - 宽度持久化到 localStorage（不依赖 store，启动更快）

import { applyOutlineDockUi } from './outlineDockUi'

const LS_KEY = 'flymd:library-width'
const DEFAULT_WIDTH = 240
const MIN_WIDTH = 120
const MAX_WIDTH = 640
const MIN_WORKSPACE = 260

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

function readPersistedWidth(): number | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const v = Math.floor(parseFloat(raw))
    if (!isFinite(v)) return null
    if (v < MIN_WIDTH || v > MAX_WIDTH) return null
    return v
  } catch {
    return null
  }
}

function persistWidth(w: number): void {
  try { localStorage.setItem(LS_KEY, String(Math.floor(w))) } catch {}
}

function getEls(): {
  container: HTMLDivElement | null
  library: HTMLDivElement | null
} {
  const container = document.querySelector('.container') as HTMLDivElement | null
  const library = document.getElementById('library') as HTMLDivElement | null
  return { container, library }
}

function ensureHandle(container: HTMLDivElement): HTMLDivElement {
  let el = document.getElementById('lib-resize-handle') as HTMLDivElement | null
  if (el) return el
  el = document.createElement('div') as HTMLDivElement
  el.id = 'lib-resize-handle'
  el.className = 'lib-resize-handle side-left'
  container.appendChild(el)
  return el
}

function computeBounds(container: HTMLDivElement): { min: number; max: number } {
  const rect = container.getBoundingClientRect()
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(rect.width - MIN_WORKSPACE)))
  const min = Math.min(180, max) // 宽度过窄时允许自动降低下限，避免“夹死”布局
  return { min, max }
}

function applyWidthPx(container: HTMLDivElement, w: number): void {
  try { container.style.setProperty('--library-width', `${Math.floor(w)}px`) } catch {}
}

function readCurrentWidth(container: HTMLDivElement): number {
  try {
    const v = getComputedStyle(container).getPropertyValue('--library-width').trim()
    const n = Math.floor(parseFloat(v))
    if (isFinite(n) && n > 0) return n
  } catch {}
  return DEFAULT_WIDTH
}

function syncHandleState(container: HTMLDivElement, library: HTMLDivElement, handle: HTMLDivElement): void {
  try {
    const hidden = library.classList.contains('hidden')
    handle.style.display = hidden ? 'none' : 'block'
    handle.classList.toggle('side-right', library.classList.contains('side-right'))
    handle.classList.toggle('side-left', !library.classList.contains('side-right'))
  } catch {}
}

function initLibraryResize(): void {
  const { container, library } = getEls()
  if (!container || !library) return

  // 启动即应用上次宽度（避免依赖 store 的异步时序）
  try {
    const w = readPersistedWidth()
    if (w != null) applyWidthPx(container, w)
  } catch {}

  const handle = ensureHandle(container)
  syncHandleState(container, library, handle)

  // 监听库侧栏隐藏/左右切换，更新手柄显示与位置
  try {
    const obs = new MutationObserver(() => {
      try { syncHandleState(container, library, handle) } catch {}
    })
    obs.observe(library, { attributes: true, attributeFilter: ['class'] })
  } catch {}

  let dragging = false
  let rafScheduled = false

  const requestOutlineRecalc = () => {
    if (rafScheduled) return
    rafScheduled = true
    requestAnimationFrame(() => {
      rafScheduled = false
      try { applyOutlineDockUi() } catch {}
    })
  }

  const onPointerDown = (e: PointerEvent) => {
    try {
      if ((e as any).button != null && (e as any).button !== 0) return
      if (library.classList.contains('hidden')) return
      dragging = true
      handle.classList.add('dragging')
      document.body.classList.add('lib-resizing')
      try { handle.setPointerCapture(e.pointerId) } catch {}
      try { e.preventDefault() } catch {}
    } catch {}
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    try {
      const { min, max } = computeBounds(container)
      const r = container.getBoundingClientRect()
      const isRight = library.classList.contains('side-right')
      const raw = isRight ? (r.right - e.clientX) : (e.clientX - r.left)
      const next = clamp(raw, min, max)
      applyWidthPx(container, next)
      requestOutlineRecalc()
    } catch {}
  }

  const onPointerUp = () => {
    if (!dragging) return
    dragging = false
    try {
      handle.classList.remove('dragging')
      document.body.classList.remove('lib-resizing')
      const w = readCurrentWidth(container)
      persistWidth(w)
      requestOutlineRecalc()
    } catch {}
  }

  handle.addEventListener('pointerdown', onPointerDown)
  handle.addEventListener('pointermove', onPointerMove)
  handle.addEventListener('pointerup', onPointerUp)
  handle.addEventListener('pointercancel', onPointerUp)

  // 双击分界线：快速回到默认宽度
  handle.addEventListener('dblclick', () => {
    try {
      applyWidthPx(container, DEFAULT_WIDTH)
      persistWidth(DEFAULT_WIDTH)
      requestOutlineRecalc()
    } catch {}
  })
}

// 延迟初始化：等 main.ts 把 container/library DOM 建好
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setTimeout(initLibraryResize, 600) })
} else {
  setTimeout(initLibraryResize, 600)
}

