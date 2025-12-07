// markdown-it 脚注支持 + 预览脚注交互增强
// 设计原则：
// - 不改动 Markdown 源，只在渲染阶段处理
// - 阅读模式 / 所见模式共用一套脚注 DOM 与悬浮逻辑

import type MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'

// 当前预览根节点与脚注映射
let _root: HTMLElement | null = null
let _footnoteMap: Map<string, string> = new Map()
let _tooltipEl: HTMLDivElement | null = null
let _hideTimer: number | null = null

// 供 main.ts 调用：为 markdown-it 启用脚注解析
export default function applyMarkdownItFootnote(md: MarkdownIt): void {
  try {
    if (!md || typeof md.use !== 'function') return
    md.use(footnote as any)
  } catch {
    // 保底：脚注失败不影响其它渲染
  }
}

function collectFootnoteMap(root: HTMLElement): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const section = root.querySelector('.footnotes') as HTMLElement | null
    if (!section) return map
    const items = section.querySelectorAll('ol > li[id]') as NodeListOf<HTMLElement>
    items.forEach((li) => {
      try {
        const id = li.id
        if (!id) return
        const cloned = li.cloneNode(true) as HTMLElement
        cloned.querySelectorAll('.footnote-backref').forEach((a) => a.remove())
        const html = cloned.innerHTML.trim()
        if (html) map.set(id, html)
      } catch {
        // 单个脚注失败不影响其它
      }
    })
  } catch {
    // 安静失败
  }
  return map
}

function isFootnoteRefAnchor(el: HTMLElement | null): el is HTMLAnchorElement {
  if (!el || el.tagName !== 'A') return false
  const href = el.getAttribute('href') || ''
  if (!href || !href.startsWith('#fn')) return false
  const parent = el.parentElement
  if (!parent) return false
  if (parent.classList.contains('footnote-ref')) return true
  return parent.closest('sup.footnote-ref') !== null
}

function findFootnoteRef(target: EventTarget | null): HTMLAnchorElement | null {
  let el = target as HTMLElement | null
  while (el && _root && el !== _root) {
    if (isFootnoteRefAnchor(el)) return el as HTMLAnchorElement
    el = el.parentElement
  }
  return null
}

function ensureTooltip(): HTMLDivElement {
  if (_tooltipEl && _tooltipEl.parentElement) return _tooltipEl
  const div = document.createElement('div')
  div.className = 'md-footnote-tooltip'
  _tooltipEl = div
  document.body.appendChild(div)
  return div
}

function hideTooltipImmediate(): void {
  try {
    if (_hideTimer != null) {
      window.clearTimeout(_hideTimer)
      _hideTimer = null
    }
    if (_tooltipEl && _tooltipEl.parentElement) {
      _tooltipEl.parentElement.removeChild(_tooltipEl)
    }
  } catch {
    // 忽略 DOM 清理错误
  } finally {
    _tooltipEl = null
  }
}

function scheduleHideTooltip(): void {
  try {
    if (_hideTimer != null) {
      window.clearTimeout(_hideTimer)
      _hideTimer = null
    }
    _hideTimer = window.setTimeout(() => {
      hideTooltipImmediate()
    }, 120)
  } catch {
    hideTooltipImmediate()
  }
}

function showTooltipFor(ref: HTMLAnchorElement, html: string): void {
  try {
    if (!html) {
      hideTooltipImmediate()
      return
    }
    if (_hideTimer != null) {
      window.clearTimeout(_hideTimer)
      _hideTimer = null
    }
    const tip = ensureTooltip()
    tip.innerHTML = html
    tip.style.position = 'fixed'
    tip.style.maxWidth = '360px'
    const rect = ref.getBoundingClientRect()
    // 先放到合适位置再测量尺寸
    tip.style.left = '0px'
    tip.style.top = '0px'
    tip.style.visibility = 'hidden'
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const tRect = tip.getBoundingClientRect()
    let top = rect.bottom + 8
    let left = rect.left + (rect.width - tRect.width) / 2
    if (left < 8) left = 8
    if (left + tRect.width > vw - 8) left = Math.max(8, vw - tRect.width - 8)
    if (top + tRect.height > vh - 8) top = Math.max(8, rect.top - tRect.height - 8)
    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.round(top)}px`
    tip.style.visibility = 'visible'
  } catch {
    // 悬浮失败不影响阅读
  }
}

function handleEnter(target: EventTarget | null): void {
  try {
    if (!_root) return
    const ref = findFootnoteRef(target)
    if (!ref) return
    const href = ref.getAttribute('href') || ''
    if (!href || !href.startsWith('#')) return
    const id = href.slice(1)
    const html = _footnoteMap.get(id)
    if (!html) return
    showTooltipFor(ref, html)
  } catch {
    // 忽略事件错误
  }
}

function handleLeave(ev: MouseEvent | FocusEvent): void {
  try {
    const related = (ev as MouseEvent).relatedTarget as Node | null
    if (_tooltipEl && related && _tooltipEl.contains(related)) return
  } catch {
    // 忽略检查错误
  }
  scheduleHideTooltip()
}

function onMouseOver(ev: MouseEvent): void {
  handleEnter(ev.target)
}

function onMouseOut(ev: MouseEvent): void {
  handleLeave(ev)
}

function onFocusIn(ev: FocusEvent): void {
  handleEnter(ev.target)
}

function onFocusOut(ev: FocusEvent): void {
  handleLeave(ev)
}

// 供 main.ts 调用：在每次预览渲染后刷新脚注映射并绑定事件
export function enhanceFootnotes(previewRoot: HTMLElement): void {
  try {
    if (!previewRoot) return
    _footnoteMap = collectFootnoteMap(previewRoot)
    if (_footnoteMap.size === 0) {
      hideTooltipImmediate()
    }
    if (_root === previewRoot) return
    if (_root) {
      try {
        _root.removeEventListener('mouseover', onMouseOver, true)
        _root.removeEventListener('mouseout', onMouseOut, true)
        _root.removeEventListener('focusin', onFocusIn, true)
        _root.removeEventListener('focusout', onFocusOut, true)
      } catch {
        // 旧 root 清理失败不致命
      }
    }
    _root = previewRoot
    try {
      _root.addEventListener('mouseover', onMouseOver, true)
      _root.addEventListener('mouseout', onMouseOut, true)
      _root.addEventListener('focusin', onFocusIn, true)
      _root.addEventListener('focusout', onFocusOut, true)
    } catch {
      // 事件绑定失败时直接放弃悬浮功能
    }
  } catch {
    // 保底：不影响主流程
  }
}

