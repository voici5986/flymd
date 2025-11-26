/**
 * 标签管理器 - 包装器模式
 *
 * 设计原则：最小侵入，不修改原有全局变量
 * 通过钩子拦截关键操作，维护标签状态
 */

import {
  TabDocument,
  TabEvent,
  TabEventListener,
  PersistedTabState,
  createEmptyTab,
  createTabFromFile,
  getTabDisplayName,
  EditorMode,
} from './types'

export interface TabManagerHooks {
  // 获取当前编辑器内容
  getEditorContent: () => string
  // 设置编辑器内容
  setEditorContent: (content: string) => void
  // 获取当前文件路径
  getCurrentFilePath: () => string | null
  // 设置当前文件路径（用于内部同步，不触发文件操作）
  setCurrentFilePath: (path: string | null) => void
  // 获取 dirty 状态
  getDirty: () => boolean
  // 设置 dirty 状态
  setDirty: (dirty: boolean) => void
  // 获取编辑模式
  getMode: () => EditorMode
  // 设置编辑模式
  setMode: (mode: EditorMode) => void
  // 获取所见模式状态
  getWysiwygEnabled: () => boolean
  // 设置所见模式
  setWysiwygEnabled: (enabled: boolean) => Promise<void>
  // 获取滚动位置
  getScrollTop: () => number
  // 设置滚动位置
  setScrollTop: (top: number) => void
  // 获取光标位置
  getCursorPos: () => { line: number; col: number }
  // 设置光标位置
  setCursorPos: (line: number, col: number) => void
  // 刷新标题栏
  refreshTitle: () => void
  // 刷新预览（如果在预览模式）
  refreshPreview: () => void
  // 重新加载文件（用于 PDF 等特殊文件）
  reloadFile: (filePath: string) => Promise<void>
}

export class TabManager {
  private tabs: TabDocument[] = []
  private activeTabId: string | null = null
  private hooks: TabManagerHooks | null = null
  private listeners: TabEventListener[] = []
  private initialized = false

  /**
   * 初始化标签管理器
   * 必须在 main.ts 加载完成后调用
   */
  init(hooks: TabManagerHooks): void {
    if (this.initialized) return
    this.hooks = hooks
    this.initialized = true

    // 创建初始标签，同步当前编辑器状态
    this.syncCurrentStateAsTab()
  }

  /**
   * 将当前编辑器状态同步为一个标签
   */
  private syncCurrentStateAsTab(): void {
    if (!this.hooks) return

    const filePath = this.hooks.getCurrentFilePath()
    const content = this.hooks.getEditorContent()
    const dirty = this.hooks.getDirty()
    const mode = this.hooks.getMode()
    const wysiwygEnabled = this.hooks.getWysiwygEnabled()

    const tab: TabDocument = {
      id: `tab_${Date.now()}`,
      filePath,
      content,
      dirty,
      scrollTop: this.hooks.getScrollTop(),
      cursorLine: this.hooks.getCursorPos().line,
      cursorCol: this.hooks.getCursorPos().col,
      mode,
      wysiwygEnabled,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }

    this.tabs = [tab]
    this.activeTabId = tab.id
    this.emit({ type: 'tab-created', tab })
  }

  /**
   * 获取所有标签
   */
  getTabs(): readonly TabDocument[] {
    return this.tabs
  }

  /**
   * 获取当前活跃标签
   */
  getActiveTab(): TabDocument | null {
    if (!this.activeTabId) return null
    return this.tabs.find(t => t.id === this.activeTabId) ?? null
  }

  /**
   * 获取当前活跃标签 ID
   */
  getActiveTabId(): string | null {
    return this.activeTabId
  }

  /**
   * 根据文件路径查找标签
   */
  findTabByPath(filePath: string): TabDocument | null {
    // 规范化路径比较
    const normalizedPath = filePath.replace(/\\/g, '/')
    return this.tabs.find(t =>
      t.filePath && t.filePath.replace(/\\/g, '/') === normalizedPath
    ) ?? null
  }

  /**
   * 根据 ID 查找标签
   */
  findTabById(tabId: string): TabDocument | null {
    return this.tabs.find(t => t.id === tabId) ?? null
  }

  /**
   * 保存当前标签的编辑器状态
   */
  private saveCurrentTabState(): void {
    if (!this.hooks || !this.activeTabId) return

    const tab = this.getActiveTab()
    if (!tab) return

    tab.content = this.hooks.getEditorContent()
    tab.dirty = this.hooks.getDirty()
    tab.scrollTop = this.hooks.getScrollTop()
    tab.cursorLine = this.hooks.getCursorPos().line
    tab.cursorCol = this.hooks.getCursorPos().col
    tab.mode = this.hooks.getMode()
    tab.wysiwygEnabled = this.hooks.getWysiwygEnabled()
  }

  /**
   * 恢复标签状态到编辑器
   */
  private async restoreTabState(tab: TabDocument): Promise<void> {
    if (!this.hooks) return

    // PDF 文件需要特殊处理：重新加载
    if (tab.isPdf && tab.filePath) {
      await this.hooks.reloadFile(tab.filePath)
      return
    }

    // 设置内容
    this.hooks.setEditorContent(tab.content)
    this.hooks.setCurrentFilePath(tab.filePath)
    this.hooks.setDirty(tab.dirty)

    // 设置模式
    if (this.hooks.getMode() !== tab.mode) {
      this.hooks.setMode(tab.mode)
    }

    // 设置所见模式
    if (this.hooks.getWysiwygEnabled() !== tab.wysiwygEnabled) {
      await this.hooks.setWysiwygEnabled(tab.wysiwygEnabled)
    }

    // 重要：所见模式切换可能会因内容规范化差异错误触发 dirty = true
    // 在所见模式切换完成后，强制恢复正确的 dirty 状态
    this.hooks.setDirty(tab.dirty)

    // 恢复位置（延迟执行，等待渲染完成）
    const savedDirty = tab.dirty
    const hooks = this.hooks
    requestAnimationFrame(() => {
      if (!hooks) return
      hooks.setScrollTop(tab.scrollTop)
      hooks.setCursorPos(tab.cursorLine, tab.cursorCol)
      // 再次确保 dirty 状态正确（处理异步回调可能导致的状态变化）
      hooks.setDirty(savedDirty)
    })

    // 刷新 UI
    this.hooks.refreshTitle()
    this.hooks.refreshPreview()
  }

  /**
   * 创建新空白标签并激活
   */
  createNewTab(): TabDocument {
    // 保存当前标签状态
    this.saveCurrentTabState()

    const tab = createEmptyTab()
    this.tabs.push(tab)

    const fromTabId = this.activeTabId
    this.activeTabId = tab.id
    tab.lastActiveAt = Date.now()

    // 清空编辑器
    if (this.hooks) {
      this.hooks.setEditorContent('')
      this.hooks.setCurrentFilePath(null)
      this.hooks.setDirty(false)
      this.hooks.setMode('edit')
      this.hooks.refreshTitle()
      this.hooks.refreshPreview()
    }

    this.emit({ type: 'tab-created', tab })
    this.emit({ type: 'tab-switched', fromTabId, toTabId: tab.id })

    return tab
  }

  /**
   * 打开文件为新标签（或激活已有标签）
   * 返回 true 表示需要加载文件，false 表示已有标签被激活
   */
  openFile(filePath: string, content?: string): { needLoad: boolean; tab: TabDocument } {
    // 检查是否已打开
    const existingTab = this.findTabByPath(filePath)
    if (existingTab) {
      // 激活已有标签
      this.switchToTab(existingTab.id)
      return { needLoad: false, tab: existingTab }
    }

    // 保存当前标签状态
    this.saveCurrentTabState()

    // 创建新标签
    const tab = createTabFromFile(filePath, content ?? '')
    this.tabs.push(tab)

    const fromTabId = this.activeTabId
    this.activeTabId = tab.id
    tab.lastActiveAt = Date.now()

    this.emit({ type: 'tab-created', tab })
    this.emit({ type: 'tab-switched', fromTabId, toTabId: tab.id })

    return { needLoad: content === undefined, tab }
  }

  /**
   * 文件加载完成后更新标签内容
   */
  updateTabContent(tabId: string, content: string): void {
    const tab = this.findTabById(tabId)
    if (tab) {
      tab.content = content
      tab.dirty = false
      this.emit({ type: 'tab-updated', tab })
    }
  }

  /**
   * 切换到指定标签
   */
  async switchToTab(tabId: string): Promise<boolean> {
    if (tabId === this.activeTabId) return true

    const targetTab = this.findTabById(tabId)
    if (!targetTab) return false

    // 保存当前标签状态
    this.saveCurrentTabState()

    const fromTabId = this.activeTabId
    this.activeTabId = tabId
    targetTab.lastActiveAt = Date.now()

    // 恢复目标标签状态
    await this.restoreTabState(targetTab)

    this.emit({ type: 'tab-switched', fromTabId, toTabId: tabId })
    return true
  }

  /**
   * 关闭标签
   * 返回 true 表示成功关闭，false 表示被取消（如有未保存内容）
   */
  closeTab(tabId: string, confirmUnsaved?: () => Promise<boolean>): Promise<boolean> {
    return this._closeTab(tabId, confirmUnsaved)
  }

  private async _closeTab(tabId: string, confirmUnsaved?: () => Promise<boolean>): Promise<boolean> {
    const tabIndex = this.tabs.findIndex(t => t.id === tabId)
    if (tabIndex === -1) return false

    const tab = this.tabs[tabIndex]

    // 如果有未保存内容，询问用户
    if (tab.dirty && confirmUnsaved) {
      const confirmed = await confirmUnsaved()
      if (!confirmed) return false
    }

    // 如果是当前标签，需要切换到其他标签
    if (tabId === this.activeTabId) {
      // 优先切换到右边的标签，否则切换到左边
      let nextTabId: string | null = null
      if (tabIndex < this.tabs.length - 1) {
        nextTabId = this.tabs[tabIndex + 1].id
      } else if (tabIndex > 0) {
        nextTabId = this.tabs[tabIndex - 1].id
      }

      // 移除标签
      this.tabs.splice(tabIndex, 1)

      if (nextTabId) {
        this.activeTabId = nextTabId
        const nextTab = this.findTabById(nextTabId)
        if (nextTab) {
          await this.restoreTabState(nextTab)
        }
      } else {
        // 没有其他标签了，创建一个新空白标签
        this.activeTabId = null
        const newTab = this.createNewTab()
        this.activeTabId = newTab.id
        await this.restoreTabState(newTab)
      }
    } else {
      // 不是当前标签，直接移除
      this.tabs.splice(tabIndex, 1)
    }

    this.emit({ type: 'tab-closed', tabId })
    return true
  }

  /**
   * 更新当前标签的文件路径（另存为时使用）
   */
  updateCurrentTabPath(newPath: string): void {
    const tab = this.getActiveTab()
    if (tab) {
      tab.filePath = newPath
      tab.dirty = false
      this.emit({ type: 'tab-updated', tab })
    }
  }

  /**
   * 标记当前标签为已保存
   */
  markCurrentTabSaved(): void {
    const tab = this.getActiveTab()
    if (tab) {
      tab.dirty = false
      if (this.hooks) {
        tab.content = this.hooks.getEditorContent()
      }
      this.emit({ type: 'tab-updated', tab })
    }
  }

  /**
   * 标记当前标签为已修改
   */
  markCurrentTabDirty(): void {
    const tab = this.getActiveTab()
    if (tab && !tab.dirty) {
      tab.dirty = true
      this.emit({ type: 'tab-updated', tab })
    }
  }

  /**
   * 移动标签位置
   */
  moveTab(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= this.tabs.length) return
    if (toIndex < 0 || toIndex >= this.tabs.length) return

    const [tab] = this.tabs.splice(fromIndex, 1)
    this.tabs.splice(toIndex, 0, tab)

    this.emit({ type: 'tabs-reordered', tabs: this.tabs })
  }

  /**
   * 切换到下一个标签
   */
  async switchToNextTab(): Promise<void> {
    if (this.tabs.length <= 1) return
    const currentIndex = this.tabs.findIndex(t => t.id === this.activeTabId)
    const nextIndex = (currentIndex + 1) % this.tabs.length
    await this.switchToTab(this.tabs[nextIndex].id)
  }

  /**
   * 切换到上一个标签
   */
  async switchToPrevTab(): Promise<void> {
    if (this.tabs.length <= 1) return
    const currentIndex = this.tabs.findIndex(t => t.id === this.activeTabId)
    const prevIndex = (currentIndex - 1 + this.tabs.length) % this.tabs.length
    await this.switchToTab(this.tabs[prevIndex].id)
  }

  /**
   * 添加事件监听器
   */
  addEventListener(listener: TabEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index !== -1) this.listeners.splice(index, 1)
    }
  }

  /**
   * 触发事件
   */
  private emit(event: TabEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (e) {
        console.error('[TabManager] Event listener error:', e)
      }
    }
  }

  /**
   * 导出状态用于持久化
   */
  exportState(): PersistedTabState {
    // 先保存当前状态
    this.saveCurrentTabState()

    return {
      tabs: this.tabs.map(t => ({
        filePath: t.filePath,
        content: t.dirty ? t.content : '', // 只保存未保存的内容
        dirty: t.dirty,
        mode: t.mode,
        wysiwygEnabled: t.wysiwygEnabled,
      })),
      activeTabId: this.activeTabId,
    }
  }

  /**
   * 从持久化状态恢复
   */
  async importState(state: PersistedTabState, loadFileContent: (path: string) => Promise<string>): Promise<void> {
    if (state.tabs.length === 0) return

    this.tabs = []

    for (const saved of state.tabs) {
      let content = saved.content

      // 如果有文件路径且没有未保存内容，从文件加载
      if (saved.filePath && !saved.dirty) {
        try {
          content = await loadFileContent(saved.filePath)
        } catch {
          // 文件可能已删除，跳过
          continue
        }
      }

      const tab = createTabFromFile(saved.filePath ?? '', content)
      tab.filePath = saved.filePath
      tab.dirty = saved.dirty
      tab.mode = saved.mode
      tab.wysiwygEnabled = saved.wysiwygEnabled
      this.tabs.push(tab)
    }

    // 如果没有成功恢复任何标签，创建空白标签
    if (this.tabs.length === 0) {
      this.tabs.push(createEmptyTab())
    }

    // 恢复活跃标签
    const activeTab = state.activeTabId
      ? this.findTabById(state.activeTabId)
      : null

    this.activeTabId = activeTab?.id ?? this.tabs[0].id

    // 恢复到编辑器
    const currentTab = this.getActiveTab()
    if (currentTab) {
      await this.restoreTabState(currentTab)
    }
  }

  /**
   * 获取标签显示名称
   */
  getTabName(tabId: string): string {
    const tab = this.findTabById(tabId)
    return tab ? getTabDisplayName(tab) : '未命名'
  }

  /**
   * 检查是否有未保存的标签
   */
  hasUnsavedTabs(): boolean {
    return this.tabs.some(t => t.dirty)
  }

  /**
   * 获取所有未保存的标签
   */
  getUnsavedTabs(): TabDocument[] {
    return this.tabs.filter(t => t.dirty)
  }
}

// 全局单例
export const tabManager = new TabManager()
