/**
 * UI 通知与缩放/宽度气泡模块
 * 从 main.ts 拆分：负责
 * - 缩放气泡（Ctrl/Cmd + 滚轮）
 * - 阅读宽度气泡（Shift + 滚轮）
 * - 通用通知系统（右下角堆叠提示）
 * - 模式切换提示与同步状态通知
 */

import { getUiZoom, zoomReset, getPreviewWidth, resetPreviewWidth } from './uiZoom'

// ===== 缩放气泡（类似 Edge） =====
let _zoomBubbleTimer: number | null = null

function ensureZoomBubble(): HTMLDivElement | null {
  try {
    let el = document.getElementById('zoom-bubble') as HTMLDivElement | null
    if (!el) {
      el = document.createElement('div')
      el.id = 'zoom-bubble'
      el.className = 'zoom-bubble hidden'
      el.innerHTML = `
        <span id="zoom-bubble-label">100%</span>
        <button id="zoom-bubble-reset" class="zoom-reset-btn" title="重置缩放" aria-label="重置缩放">⟲ 重置</button>
      `
      document.body.appendChild(el)
      const btn = el.querySelector('#zoom-bubble-reset') as HTMLButtonElement | null
      if (btn) btn.addEventListener('click', () => { try { zoomReset(); showZoomBubble() } catch {} })
    }
    return el
  } catch {
    return null
  }
}

export function showZoomBubble(): void {
  try {
    const el = ensureZoomBubble(); if (!el) return
    const label = el.querySelector('#zoom-bubble-label') as HTMLSpanElement | null
    if (label) label.textContent = Math.round(getUiZoom() * 100) + '%'
    el.classList.remove('hidden')
    el.classList.add('show')
    if (_zoomBubbleTimer != null) {
      window.clearTimeout(_zoomBubbleTimer)
      _zoomBubbleTimer = null
    }
    _zoomBubbleTimer = window.setTimeout(() => {
      try {
        el!.classList.remove('show')
        el!.classList.add('hidden')
      } catch {}
      _zoomBubbleTimer = null
    }, 1000)
  } catch {}
}

// 阅读宽度气泡：Shift+滚轮调整时提示并提供重置按钮
let _widthBubbleTimer: number | null = null

function ensureWidthBubble(): HTMLDivElement | null {
  try {
    let el = document.getElementById('width-bubble') as HTMLDivElement | null
    if (!el) {
      el = document.createElement('div')
      el.id = 'width-bubble'
      el.className = 'zoom-bubble width-bubble hidden'
      el.innerHTML = `
        <span id="width-bubble-label">860px</span>
        <button id="width-bubble-reset" class="zoom-reset-btn" title="重置阅读宽度" aria-label="重置阅读宽度">重置</button>
      `
      document.body.appendChild(el)
      const btn = el.querySelector('#width-bubble-reset') as HTMLButtonElement | null
      if (btn) btn.addEventListener('click', () => { try { resetPreviewWidth(); showWidthBubble() } catch {} })
    }
    return el
  } catch {
    return null
  }
}

export function showWidthBubble(): void {
  try {
    const el = ensureWidthBubble(); if (!el) return
    const label = el.querySelector('#width-bubble-label') as HTMLSpanElement | null
    if (label) label.textContent = Math.round(getPreviewWidth()) + 'px'
    el.classList.remove('hidden')
    el.classList.add('show')
    if (_widthBubbleTimer != null) {
      window.clearTimeout(_widthBubbleTimer)
      _widthBubbleTimer = null
    }
    _widthBubbleTimer = window.setTimeout(() => {
      try {
        el!.classList.remove('show')
        el!.classList.add('hidden')
      } catch {}
      _widthBubbleTimer = null
    }, 2000)
  } catch {}
}

// ===== 通知系统（支持多消息堆叠显示） =====
export type NotificationType =
  | 'sync'
  | 'extension'
  | 'appUpdate'
  | 'plugin-success'
  | 'plugin-error'
  | 'mode-edit'
  | 'mode-preview'
  | 'mode-wysiwyg'
  | 'mode-split'

interface NotificationConfig {
  icon: string
  bgColor: string
  duration: number
  clickable?: boolean
}

interface NotificationItem {
  id: string
  type: NotificationType
  message: string
  element: HTMLDivElement
  timer: number | null
  onClick?: () => void
}

export class NotificationManager {
  private static container: HTMLDivElement | null = null
  private static notifications: Map<string, NotificationItem> = new Map()
  private static idCounter = 0

  private static readonly configs: Record<NotificationType, NotificationConfig> = {
    sync: {
      icon: '🔄',
      bgColor: 'rgba(127,127,127,0.08)',
      duration: 5000
    },
    extension: {
      icon: '🔔',
      bgColor: 'rgba(34,197,94,0.12)',
      duration: 5000
    },
    appUpdate: {
      icon: '⬆️',
      bgColor: 'rgba(59,130,246,0.12)',
      duration: 10000,
      clickable: true
    },
    'plugin-success': {
      icon: '✔',
      bgColor: 'rgba(34,197,94,0.12)', // 浅绿色
      duration: 2000
    },
    'plugin-error': {
      icon: '✖',
      bgColor: 'rgba(239,68,68,0.12)', // 浅红色（red-500）
      duration: 3000
    },
    'mode-edit': {
      icon: '✏️',
      bgColor: 'rgba(59,130,246,0.14)', // 源码模式：偏蓝
      duration: 1600
    },
    'mode-preview': {
      icon: '📖',
      bgColor: 'rgba(245,158,11,0.16)', // 阅读模式：偏暖
      duration: 1600
    },
    'mode-wysiwyg': {
      icon: '📝',
      bgColor: 'rgba(139,92,246,0.16)', // 所见模式：偏紫
      duration: 1600
    },
    'mode-split': {
      icon: '🪟',
      bgColor: 'rgba(59,130,246,0.18)', // 分屏：略偏蓝
      duration: 1600
    }
  }

  private static ensureContainer(): HTMLDivElement {
    if (this.container && document.body.contains(this.container)) {
      return this.container
    }

    // 查找已存在的容器（兼容旧的 sync-status）
    let el = document.getElementById('notification-container') as HTMLDivElement | null
    if (!el) {
      el = document.getElementById('sync-status') as HTMLDivElement | null
      if (el) {
        el.id = 'notification-container'
        el.className = 'notification-container'
        el.innerHTML = ''
      }
    }

    if (!el) {
      el = document.createElement('div')
      el.id = 'notification-container'
      el.className = 'notification-container'
      document.body.appendChild(el)
    }

    this.container = el
    return el
  }

  static show(type: NotificationType, message: string, duration?: number, onClick?: () => void): string {
    try {
      const container = this.ensureContainer()
      const config = this.configs[type]
      const id = `notification-${++this.idCounter}`

      // 创建通知元素
      const item = document.createElement('div')
      item.className = 'notification-item' + (config.clickable ? ' clickable' : '')
      item.style.backgroundColor = config.bgColor
      item.innerHTML = `<span class="notification-icon">${config.icon}</span> <span class="notification-text">${message}</span>`

      // 点击事件
      if (onClick) {
        item.addEventListener('click', () => {
          onClick()
          this.hide(id)
        })
      }

      // 添加到容器
      container.appendChild(item)

      // 设置自动清除定时器
      const finalDuration = duration !== undefined ? duration : config.duration
      const timer = finalDuration > 0 ? window.setTimeout(() => {
        this.hide(id)
      }, finalDuration) : null

      // 保存通知信息
      this.notifications.set(id, {
        id,
        type,
        message,
        element: item,
        timer,
        onClick
      })

      return id
    } catch (e) {
      console.error('[Notification] 显示通知失败', e)
      return ''
    }
  }

  static hide(id: string): void {
    try {
      const notification = this.notifications.get(id)
      if (!notification) return

      // 清除定时器
      if (notification.timer !== null) {
        window.clearTimeout(notification.timer)
      }

      // 淡出动画
      notification.element.style.opacity = '0'
      setTimeout(() => {
        try {
          notification.element.remove()
        } catch {}
      }, 200)

      this.notifications.delete(id)
    } catch (e) {
      console.error('[Notification] 隐藏通知失败', e)
    }
  }

  static hideAll(): void {
    try {
      this.notifications.forEach((_, id) => this.hide(id))
    } catch {}
  }

  static updateMessage(id: string, message: string): void {
    try {
      const notification = this.notifications.get(id)
      if (!notification) return

      const textEl = notification.element.querySelector('.notification-text')
      if (textEl) {
        textEl.textContent = message
        notification.message = message
      }
    } catch {}
  }
}

// 模式切换提示：在右下角通知区域显示当前模式
export function showModeChangeNotification(mode: 'edit' | 'preview', isWysiwyg: boolean): void {
  try {
    let type: NotificationType
    let msg: string
    if (isWysiwyg) {
      type = 'mode-wysiwyg'
      msg = '所见模式'
    } else if (mode === 'preview') {
      type = 'mode-preview'
      msg = '阅读模式'
    } else {
      type = 'mode-edit'
      msg = '源码模式'
    }
    NotificationManager.show(type, msg, 1600)
  } catch {}
}

// 向后兼容：保留旧的 sync-status 接口
export function updateSyncStatus(msg: string): void {
  try {
    NotificationManager.show('sync', msg)
  } catch {}
}

// 暴露通知管理器到全局，供 WebDAV 同步等扩展使用
try {
  ;(window as any).NotificationManager = NotificationManager
} catch {}
