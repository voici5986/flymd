/**
 * 统一插件菜单与下拉菜单 UI 模块
 * 从 main.ts 拆分：负责
 * - 插件下拉菜单渲染与定位
 * - 顶部菜单栏中的“插件”入口
 */

import { t } from '../i18n'
import { getPluginMenuVisibility } from './pluginMenuConfig'

// 插件菜单项描述
type PluginMenuItem = { pluginId: string; label: string; onClick?: () => void; children?: any[] }

// 下拉菜单 DOM 常量
const PLUGIN_DROPDOWN_OVERLAY_ID = 'plugin-dropdown-overlay'
const PLUGIN_DROPDOWN_PANEL_ID = 'plugin-dropdown-panel'

// 当前“插件”菜单按钮和菜单项集合
const pluginsMenuItems = new Map<string, PluginMenuItem>() // 收纳到"插件"菜单的项目
let _pluginsMenuBtn: HTMLDivElement | null = null // "插件"菜单按钮
let _openPluginsMenuManager: (() => void) | null = null // “菜单管理”弹窗打开回调

let pluginDropdownKeyHandler: ((e: KeyboardEvent) => void) | null = null

// 移除下拉菜单
function removePluginDropdown() {
  try {
    const overlay = document.getElementById(PLUGIN_DROPDOWN_OVERLAY_ID)
    if (overlay) overlay.remove()
    if (pluginDropdownKeyHandler) {
      document.removeEventListener('keydown', pluginDropdownKeyHandler)
      pluginDropdownKeyHandler = null
    }
  } catch {}
}

// 渲染单个菜单项（支持嵌套子菜单）
function renderPluginMenuItem(item: any, callbacks: Map<string, () => void>, idCounter: { value: number }): string {
  if (!item) return ''

  // 分隔线
  if (item.type === 'divider') {
    return '<div class="plugin-menu-divider"></div>'
  }

  // 分组标题
  if (item.type === 'group') {
    return `<div class="plugin-menu-group-title">${item.label || ''}</div>`
  }

  // 子菜单
  if (item.children && item.children.length > 0) {
    const id = `menu-item-${idCounter.value++}`
    const disabled = item.disabled ? ' disabled' : ''
    const note = item.note ? `<span class="plugin-menu-note">${item.note}</span>` : ''

    let childrenHtml = ''
    for (const child of item.children) {
      childrenHtml += renderPluginMenuItem(child, callbacks, idCounter)
    }

    // 如果子菜单为空，显示提示
    if (!childrenHtml.trim()) {
      childrenHtml = '<div class="plugin-menu-item disabled" style="font-style:italic;opacity:0.6;">暂无可用选项</div>'
    }

    return `
      <div class="plugin-menu-item has-children${disabled}" data-id="${id}">
        <span class="plugin-menu-label">${item.label || ''}</span>${note}
        <span class="plugin-menu-arrow">▸</span>
        <div class="plugin-menu-submenu">${childrenHtml}</div>
      </div>
    `
  }

  // 普通菜单项
  const id = `menu-item-${idCounter.value++}`
  const disabled = item.disabled ? ' disabled' : ''
  const note = item.note ? `<span class="plugin-menu-note">${item.note}</span>` : ''

  // 保存回调
  if (item.onClick && typeof item.onClick === 'function') {
    callbacks.set(id, item.onClick)
  }

  return `<button class="plugin-menu-item" data-id="${id}"${disabled}>${item.label || ''}${note}</button>`
}

// 渲染菜单项列表
function renderPluginMenuItems(items: any[], callbacks: Map<string, () => void>): string {
  const idCounter = { value: 0 }
  const html: string[] = []

  for (const item of items) {
    html.push(renderPluginMenuItem(item, callbacks, idCounter))
  }

  return html.join('')
}

// 定位下拉面板
function positionPluginDropdown(panel: HTMLElement, anchor: HTMLElement) {
  try {
    const anchorRect = anchor.getBoundingClientRect()
    const viewportW = window.innerWidth || 1280
    const viewportH = window.innerHeight || 720
    const padding = 12

    panel.style.opacity = '0'
    panel.style.transform = 'translateY(-4px)'

    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect()
      const panelW = panelRect.width || 220
      const panelH = panelRect.height || 180

      let left = anchorRect.left
      let top = anchorRect.bottom

      // 防止溢出视口
      if (left + panelW + padding > viewportW) {
        left = viewportW - panelW - padding
      }
      if (left < padding) left = padding
      if (top + panelH + padding > viewportH) {
        top = anchorRect.top - panelH
      }
      if (top < padding) top = padding

      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
      panel.style.opacity = '1'
      panel.style.transform = 'translateY(0)'
    })
  } catch {}
}

// 显示下拉菜单
function showPluginDropdownInternal(anchor: HTMLElement, items: any[]) {
  try {
    removePluginDropdown()

    const overlay = document.createElement('div')
    overlay.id = PLUGIN_DROPDOWN_OVERLAY_ID

    const callbacks = new Map<string, () => void | Promise<void>>()
    const menuHtml = renderPluginMenuItems(items, callbacks)

    overlay.innerHTML = `<div id="${PLUGIN_DROPDOWN_PANEL_ID}">${menuHtml}</div>`
    document.body.appendChild(overlay)

    const panel = document.getElementById(PLUGIN_DROPDOWN_PANEL_ID)
    if (panel) {
      positionPluginDropdown(panel, anchor)

      // 为每个有子菜单的项目添加 mouseenter 事件，动态调整子菜单位置
      panel.querySelectorAll('.plugin-menu-item.has-children').forEach((item) => {
        item.addEventListener('mouseenter', function (this: HTMLElement) {
          const submenu = this.querySelector('.plugin-menu-submenu') as HTMLElement
          if (!submenu) return

          // 使用 requestAnimationFrame 确保在下一帧计算，此时子菜单已经显示
          requestAnimationFrame(() => {
            const itemRect = this.getBoundingClientRect()
            const submenuRect = submenu.getBoundingClientRect()
            const viewportWidth = window.innerWidth
            const viewportHeight = window.innerHeight

            // 检查子菜单是否会超出右边界
            const wouldOverflowRight = itemRect.right + submenuRect.width > viewportWidth - 10
            if (wouldOverflowRight) {
              submenu.classList.add('expand-left')
            } else {
              submenu.classList.remove('expand-left')
            }

            // 检查子菜单是否会超出下边界
            const wouldOverflowBottom = itemRect.top + submenuRect.height > viewportHeight - 10
            if (wouldOverflowBottom) {
              // 向上调整：让子菜单底部与父菜单项底部对齐
              submenu.style.top = 'auto'
              submenu.style.bottom = '-4px'
            } else {
              submenu.style.top = '-4px'
              submenu.style.bottom = 'auto'
            }
          })
        })
      })
    }

    // 点击外部区域关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) removePluginDropdown()
    })

    // 处理菜单项点击（使用事件委托）
    if (panel) {
      panel.addEventListener('click', (e) => {
        const target = e.target as HTMLElement
        const menuItem = target.closest('[data-id]') as HTMLElement

        if (!menuItem) return
        if (menuItem.classList?.contains('disabled')) return
        if (menuItem.classList?.contains('has-children')) return // 有子菜单的不执行

        const id = menuItem.getAttribute('data-id')
        if (!id) return

        removePluginDropdown()
        const callback = callbacks.get(id)
        if (callback) {
          try { callback() } catch (e2) { console.error(e2) }
        }
      })
    }

    // ESC 键关闭
    pluginDropdownKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') removePluginDropdown()
    }
    document.addEventListener('keydown', pluginDropdownKeyHandler)
  } catch (e) {
    console.error('显示插件下拉菜单失败', e)
    removePluginDropdown()
  }
}

// 为“插件菜单管理”注册打开回调（由宿主 main.ts 注入）
export function setPluginsMenuManagerOpener(fn: (() => void) | null): void {
  _openPluginsMenuManager = fn
}

// 为菜单管理界面提供当前下拉菜单项快照（仅包含 pluginId 和 label）
export function getPluginsMenuItemsSnapshot(): Array<{ pluginId: string; label: string }> {
  const out: Array<{ pluginId: string; label: string }> = []
  try {
    for (const item of pluginsMenuItems.values()) {
      out.push({ pluginId: item.pluginId, label: item.label })
    }
  } catch {}
  return out
}

// 对外暴露的下拉菜单切换函数
export function togglePluginDropdown(anchor: HTMLElement, items: any[]) {
  const overlay = document.getElementById(PLUGIN_DROPDOWN_OVERLAY_ID)
  if (overlay) {
    removePluginDropdown()
  } else {
    showPluginDropdownInternal(anchor, items)
  }
}

// 初始化"插件"菜单按钮
export function initPluginsMenu() {
  try {
    // 如果已存在则不重复创建
    if (_pluginsMenuBtn) return

    // 优先查找 ribbon 中已存在的按钮
    let pluginsBtn = document.getElementById('btn-plugins') as HTMLDivElement | null

    if (!pluginsBtn) {
      // 回退：在 menubar 中创建（兼容旧布局）
      const bar = document.querySelector('.menubar')
      if (!bar) return

      pluginsBtn = document.createElement('div')
      pluginsBtn.className = 'menu-item'
      pluginsBtn.id = 'btn-plugins'
      pluginsBtn.textContent = t('menu.plugins')
      pluginsBtn.title = t('menu.plugins.tooltip')
      pluginsBtn.style.display = 'none' // 默认隐藏，有插件时才显示

      // 插入到扩展按钮之前
      const extBtn = bar.querySelector('#btn-extensions') as HTMLDivElement | null
      if (extBtn) {
        bar.insertBefore(pluginsBtn, extBtn)
      } else {
        bar.appendChild(pluginsBtn)
      }
    }

    // 点击展开下拉菜单
    pluginsBtn.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      try {
        // 构建菜单项列表（按可见性过滤）
        const visibleItems = Array.from(pluginsMenuItems.values()).filter((item) => {
          try {
            const vis = getPluginMenuVisibility(item.pluginId)
            return vis.dropdownMenu !== false
          } catch {
            return true
          }
        })

        const items: any[] = []

        // 第一项：菜单管理
        if (_openPluginsMenuManager) {
          items.push({
            label: t('menu.plugins.manage') || '菜单管理',
            onClick: () => {
              try {
                _openPluginsMenuManager && _openPluginsMenuManager()
              } catch (e) {
                console.error(e)
              }
            },
          })
          if (visibleItems.length > 0) {
            items.push({ type: 'divider' })
          }
        }

        for (const item of visibleItems) {
          items.push({
            label: item.label,
            onClick: item.onClick,
            children: item.children,
          })
        }

        togglePluginDropdown(pluginsBtn!, items)
      } catch (e) { console.error(e) }
    })

    _pluginsMenuBtn = pluginsBtn
    updatePluginsMenuButton()
  } catch (e) {
    console.error('初始化插件菜单失败', e)
  }
}

// 添加到插件菜单
export function addToPluginsMenu(pluginId: string, config: { label: string; onClick?: () => void; children?: any[] }) {
  pluginsMenuItems.set(pluginId, {
    pluginId,
    label: config.label,
    onClick: config.onClick,
    children: config.children
  })
  updatePluginsMenuButton()
}

// 从插件菜单移除
export function removeFromPluginsMenu(pluginId: string) {
  pluginsMenuItems.delete(pluginId)
  updatePluginsMenuButton()
}

// 更新插件菜单按钮显示状态
function updatePluginsMenuButton() {
  if (!_pluginsMenuBtn) return

  // Ribbon 模式下始终显示，仅在旧 menubar 模式下才根据菜单项数量隐藏
  const isRibbonBtn = _pluginsMenuBtn.classList.contains('ribbon-btn')
  if (isRibbonBtn) {
    // Ribbon 按钮始终显示
    _pluginsMenuBtn.style.display = ''
  } else {
    // 旧模式：有菜单项时显示，无菜单项时隐藏
    if (pluginsMenuItems.size > 0) {
      _pluginsMenuBtn.style.display = ''
    } else {
      _pluginsMenuBtn.style.display = 'none'
    }
  }
}
