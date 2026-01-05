// 右键菜单 UI 模块：渲染 + 排序 + 拖拽

import { escapeAttrValue } from '../utils/escape'
import { getPluginMenuVisibility } from '../extensions/pluginMenuConfig'

export type ContextMenuContext = {
  selectedText: string
  cursorPosition: number
  mode: 'edit' | 'preview' | 'wysiwyg'
  filePath: string | null
  // 右键命中的原始 DOM 元素（用于判断是否点在图片等特殊节点上）
  targetElement?: HTMLElement | null
}

export type ContextMenuItemConfig = {
  label: string
  icon?: string
  condition?: (ctx: ContextMenuContext) => boolean
  onClick?: (ctx: ContextMenuContext) => void | Promise<void>
  children?: ContextMenuItemConfig[]
  divider?: boolean
  disabled?: boolean
  type?: 'group' | 'divider'
  note?: string
  tooltip?: string
}

export type PluginContextMenuItem = {
  pluginId: string
  config: ContextMenuItemConfig
}

// 当前显示的右键菜单元素与键盘事件处理器
let _contextMenuEl: HTMLDivElement | null = null
let _contextMenuKeyHandler: ((e: KeyboardEvent) => void) | null = null

// 排序配置：key = `${pluginId}::${label}`, value = order
type ContextMenuOrderConfig = { [key: string]: number }
const CONTEXT_MENU_ORDER_KEY = 'flymd_contextMenuOrder'

// 生成菜单项的唯一键
function getContextMenuItemKey(pluginId: string, label: string): string {
  return `${pluginId}::${label}`
}

// 读取排序配置
function loadContextMenuOrder(): ContextMenuOrderConfig {
  try {
    const raw = localStorage.getItem(CONTEXT_MENU_ORDER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {}
  return {}
}

// 保存排序配置
function saveContextMenuOrder(config: ContextMenuOrderConfig): void {
  try {
    localStorage.setItem(CONTEXT_MENU_ORDER_KEY, JSON.stringify(config))
  } catch (err) {
    console.error('保存右键菜单排序失败:', err)
  }
}

// 根据配置对菜单项排序
function sortContextMenuItems(items: PluginContextMenuItem[]): PluginContextMenuItem[] {
  const orderConfig = loadContextMenuOrder()
  return [...items].sort((a, b) => {
    const keyA = getContextMenuItemKey(a.pluginId, a.config.label || '')
    const keyB = getContextMenuItemKey(b.pluginId, b.config.label || '')
    const orderA = orderConfig[keyA] ?? Infinity
    const orderB = orderConfig[keyB] ?? Infinity
    if (orderA === Infinity && orderB === Infinity) return 0
    return orderA - orderB
  })
}

// 移除右键菜单
export function removeContextMenu(): void {
  try {
    if (_contextMenuEl) {
      _contextMenuEl.remove()
      _contextMenuEl = null
    }
    if (_contextMenuKeyHandler) {
      document.removeEventListener('keydown', _contextMenuKeyHandler)
      _contextMenuKeyHandler = null
    }
  } catch {}
}

// 渲染右键菜单项
// dragKey: 拖拽标识（仅插件菜单项有）; isBuiltin: 是否为内置项（内置项不可拖拽）
function renderContextMenuItem(
  item: ContextMenuItemConfig,
  ctx: ContextMenuContext,
  callbacks: Map<string, () => void>,
  idCounter: { value: number },
  dragKey: string = '',
  isBuiltin: boolean = false,
): string {
  if (!item) return ''

  // 分隔线
  if (item.divider || item.type === 'divider') {
    return '<div class="context-menu-divider"></div>'
  }

  // 分组标题
  if (item.type === 'group') {
    return `<div class="context-menu-group">${item.label || ''}</div>`
  }

  // 检查条件
  if (item.condition && typeof item.condition === 'function') {
    try {
      if (!item.condition(ctx)) return ''
    } catch {
      return ''
    }
  }

  // 是否可拖拽：非内置且有 dragKey（使用鼠标事件实现拖拽，不需要 draggable 属性）
  const canDrag = !isBuiltin && !!dragKey
  const dragKeyAttr = canDrag ? `data-drag-key="${dragKey}"` : ''
  const dragClass = canDrag ? ' draggable-item' : ''
  const tooltipAttr = item.tooltip ? `title="${escapeAttrValue(item.tooltip)}"` : ''
  const extraAttrs: string[] = []
  if (dragKeyAttr) extraAttrs.push(dragKeyAttr)
  if (tooltipAttr) extraAttrs.push(tooltipAttr)
  const extraAttrStr = extraAttrs.length > 0 ? ' ' + extraAttrs.join(' ') : ''

  // 子菜单
  if (item.children && item.children.length > 0) {
    const id = `ctx-menu-${idCounter.value++}`
    const icon = item.icon ? `<span class="context-menu-icon">${item.icon}</span>` : ''
    const note = item.note ? `<span class="context-menu-note">${item.note}</span>` : ''
    const disabled = item.disabled ? ' disabled' : ''

    let childrenHtml = ''
    for (const child of item.children) {
      // 子菜单项不支持拖拽
      childrenHtml += renderContextMenuItem(child, ctx, callbacks, idCounter, '', true)
    }

    if (!childrenHtml.trim()) {
      childrenHtml =
        '<div class="context-menu-item disabled" style="font-style:italic;opacity:0.6;">暂无可用选项</div>'
    }

    return `
      <div class="context-menu-item has-children${disabled}${dragClass}" data-id="${id}"${extraAttrStr}>
        ${icon}<span class="context-menu-label">${item.label || ''}</span>${note}
        <span class="context-menu-arrow">▸</span>
        <div class="context-menu-submenu">${childrenHtml}</div>
      </div>
    `
  }

  // 普通菜单项
  const id = `ctx-menu-${idCounter.value++}`
  const icon = item.icon ? `<span class="context-menu-icon">${item.icon}</span>` : ''
  const note = item.note ? `<span class="context-menu-note">${item.note}</span>` : ''
  const disabled = item.disabled ? ' disabled' : ''

  if (item.onClick && typeof item.onClick === 'function') {
    callbacks.set(id, () => item.onClick!(ctx))
  }

  return `
    <div class="context-menu-item${disabled}${dragClass}" data-id="${id}"${extraAttrStr}>
      ${icon}<span class="context-menu-label">${item.label || ''}</span>${note}
    </div>
  `
}

export async function showContextMenu(
  x: number,
  y: number,
  ctx: ContextMenuContext,
  opts: {
    pluginItems: PluginContextMenuItem[]
    buildBuiltinItems: (ctx: ContextMenuContext) => Promise<ContextMenuItemConfig[]>
  },
): Promise<void> {
  try {
    removeContextMenu()

    // 根据插件菜单可见性过滤右键菜单项
    const visiblePluginItems = opts.pluginItems.filter((item) => {
      try {
        const vis = getPluginMenuVisibility(item.pluginId)
        return vis.contextMenu !== false
      } catch {
        return true
      }
    })

    const sortedPluginItems = sortContextMenuItems(
      visiblePluginItems.filter((item) => item && item.config),
    )

    type ExtendedMenuItem = {
      config: ContextMenuItemConfig
      pluginId?: string
      isBuiltin?: boolean
    }
    const allItems: ExtendedMenuItem[] = sortedPluginItems.map((item) => ({
      config: item.config,
      pluginId: item.pluginId,
    }))

    const builtinItems = await opts.buildBuiltinItems(ctx)
    if (builtinItems.length > 0) {
      if (allItems.length > 0) {
        allItems.push({ config: { label: '', divider: true }, isBuiltin: true })
      }
      for (const bi of builtinItems) {
        allItems.push({ config: bi, isBuiltin: true })
      }
    }

    if (allItems.length === 0) return

    const menu = document.createElement('div')
    menu.className = 'flymd-context-menu'
    menu.style.position = 'fixed'
    menu.style.zIndex = '10000'

    const callbacks = new Map<string, () => void>()
    const idCounter = { value: 0 }
    let menuHtml = ''

    for (const item of allItems) {
      const dragKey = item.pluginId
        ? getContextMenuItemKey(item.pluginId, item.config.label || '')
        : ''
      menuHtml += renderContextMenuItem(
        item.config,
        ctx,
        callbacks,
        idCounter,
        dragKey,
        !!item.isBuiltin,
      )
    }

    const tipHtml =
      '<div class="context-menu-tip">按住 Shift 再次右键可打开原生菜单</div>'
    menu.innerHTML = menuHtml + tipHtml
    document.body.appendChild(menu)
    _contextMenuEl = menu

    const rect = menu.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - 10
    const maxY = window.innerHeight - rect.height - 10
    menu.style.left = Math.min(x, maxX) + 'px'
    menu.style.top = Math.min(y, maxY) + 'px'

    // 子菜单展开方向调整
    menu.querySelectorAll('.context-menu-item.has-children').forEach((item) => {
      item.addEventListener('mouseenter', function (this: HTMLElement) {
        const submenu = this.querySelector(
          '.context-menu-submenu',
        ) as HTMLElement
        if (!submenu) return
        requestAnimationFrame(() => {
          const itemRect = this.getBoundingClientRect()
          const submenuRect = submenu.getBoundingClientRect()
          const viewportWidth = window.innerWidth
          const viewportHeight = window.innerHeight

          // 水平方向调整
          const wouldOverflowRight =
            itemRect.right + submenuRect.width > viewportWidth - 10
          if (wouldOverflowRight) submenu.classList.add('expand-left')
          else submenu.classList.remove('expand-left')

          // 垂直方向调整
          const wouldOverflowBottom =
            itemRect.top + submenuRect.height > viewportHeight - 10
          if (wouldOverflowBottom) {
            submenu.style.top = 'auto'
            submenu.style.bottom = '-4px'
          } else {
            submenu.style.top = '-4px'
            submenu.style.bottom = 'auto'
          }
        })
      })
    })

    // ========== 拖拽排序功能（使用鼠标事件实现） ==========
    let dragState:
      | { item: HTMLElement; key: string; startY: number; isDragging: boolean }
      | null = null

    const getDraggableItems = (): HTMLElement[] => {
      return Array.from(
        menu.querySelectorAll(
          ':scope > .context-menu-item.draggable-item',
        ) as NodeListOf<HTMLElement>,
      )
    }

    const clearDragIndicators = () => {
      menu.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((el) =>
        el.classList.remove('drag-over-top', 'drag-over-bottom'),
      )
    }

    const finishDrag = (targetItem: HTMLElement | null, clientY: number) => {
      if (!dragState || !dragState.isDragging) return
      const { item: draggedItem, key: draggedKey } = dragState

      if (targetItem && targetItem !== draggedItem) {
        const targetKey = targetItem.getAttribute('data-drag-key')
        if (targetKey) {
          const rect = targetItem.getBoundingClientRect()
          const midY = rect.top + rect.height / 2
          const insertBefore = clientY < midY

          const items = getDraggableItems()
          const keys = items
            .map((el) => el.getAttribute('data-drag-key') || '')
            .filter((k) => k)

          const draggedIndex = keys.indexOf(draggedKey)
          if (draggedIndex >= 0) keys.splice(draggedIndex, 1)

          let targetIndex = keys.indexOf(targetKey)
          if (!insertBefore) targetIndex += 1
          keys.splice(targetIndex, 0, draggedKey)

          const newOrder: ContextMenuOrderConfig = {}
          keys.forEach((key, index) => {
            newOrder[key] = index
          })
          saveContextMenuOrder(newOrder)

          if (insertBefore) {
            targetItem.parentNode?.insertBefore(draggedItem, targetItem)
          } else {
            targetItem.parentNode?.insertBefore(
              draggedItem,
              targetItem.nextSibling,
            )
          }
        }
      }

      draggedItem.classList.remove('dragging')
      clearDragIndicators()
      dragState = null
    }

    menu.addEventListener('mousedown', (e) => {
      const target = (e.target as HTMLElement).closest(
        '.context-menu-item.draggable-item',
      ) as HTMLElement
      if (!target || e.button !== 0) return

      const key = target.getAttribute('data-drag-key')
      if (!key) return

      dragState = {
        item: target,
        key,
        startY: e.clientY,
        isDragging: false,
      }
    })

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState) return
      if (!dragState.isDragging) {
        if (Math.abs(e.clientY - dragState.startY) > 5) {
          dragState.isDragging = true
          dragState.item.classList.add('dragging')
        } else {
          return
        }
      }

      const targetItem = (e.target as HTMLElement).closest(
        '.context-menu-item.draggable-item',
      ) as HTMLElement

      clearDragIndicators()

      if (targetItem && targetItem !== dragState.item) {
        const rect = targetItem.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (e.clientY < midY) {
          targetItem.classList.add('drag-over-top')
        } else {
          targetItem.classList.add('drag-over-bottom')
        }
      }
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (!dragState) return
      if (dragState.isDragging) {
        const targetItem = (e.target as HTMLElement).closest(
          '.context-menu-item.draggable-item',
        ) as HTMLElement
        finishDrag(targetItem, e.clientY)
      } else {
        dragState = null
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    const cleanupDragListeners = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    const menuObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === menu) {
            cleanupDragListeners()
            menuObserver.disconnect()
            return
          }
        }
      }
    })
    if (menu.parentNode) {
      menuObserver.observe(menu.parentNode, { childList: true })
    }
    // ========== 拖拽排序功能结束 ==========

    menu.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const menuItem = target.closest(
        '.context-menu-item[data-id]',
      ) as HTMLElement
      if (!menuItem) return
      if (menuItem.classList.contains('disabled')) return
      if (menuItem.classList.contains('has-children')) return

      const id = menuItem.getAttribute('data-id')
      if (!id) return
      const callback = callbacks.get(id)
      if (callback) {
        try {
          const result = callback()
          if (result && typeof (result as any).then === 'function') {
            ;(result as Promise<any>).catch((err) => {
              console.error('右键菜单项执行失败:', err)
            })
          }
        } catch (err) {
          console.error('右键菜单项执行失败:', err)
        }
      }
      removeContextMenu()
    })

    const clickOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        removeContextMenu()
        document.removeEventListener('click', clickOutside)
      }
    }
    setTimeout(() => document.addEventListener('click', clickOutside), 0)

    _contextMenuKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        removeContextMenu()
      }
    }
    document.addEventListener('keydown', _contextMenuKeyHandler)
  } catch (err) {
    console.error('显示右键菜单失败:', err)
  }
}
