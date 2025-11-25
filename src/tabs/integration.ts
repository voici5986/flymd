/**
 * 标签系统集成模块
 *
 * 包装器模式：通过 window 暴露的函数与 main.ts 交互
 * 最小侵入：只需在 main.ts 末尾添加一行 import
 */

import { tabManager, TabManagerHooks } from './TabManager'
import { TabBar } from './TabBar'
import type { EditorMode } from './types'

// 全局引用
let tabBar: TabBar | null = null
let initialized = false

// 标签切换时暂停轮询检测（避免冲突）
let pauseWatcher = false
let pauseWatcherTimeout: ReturnType<typeof setTimeout> | null = null

// 暂停 dirty 同步（切换标签时避免误触发）
let pauseDirtySync = false
let pauseDirtySyncTimeout: ReturnType<typeof setTimeout> | null = null

function pausePathWatcher(duration = 1000): void {
  pauseWatcher = true
  if (pauseWatcherTimeout) clearTimeout(pauseWatcherTimeout)
  pauseWatcherTimeout = setTimeout(() => { pauseWatcher = false }, duration)
}

function pauseDirtySyncFor(duration = 500): void {
  pauseDirtySync = true
  if (pauseDirtySyncTimeout) clearTimeout(pauseDirtySyncTimeout)
  pauseDirtySyncTimeout = setTimeout(() => { pauseDirtySync = false }, duration)
}

// 获取 window 上暴露的 flymd 函数
function getFlymd(): any {
  return (window as any)
}

/**
 * 显示三按钮关闭确认对话框
 * 返回: 'save' | 'discard' | 'cancel'
 */
function showCloseConfirmDialog(fileName: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    // 创建遮罩层
    const overlay = document.createElement('div')
    overlay.className = 'tab-close-dialog-overlay'
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `

    // 创建对话框
    const dialog = document.createElement('div')
    dialog.className = 'tab-close-dialog'
    dialog.style.cssText = `
      background: var(--bg-color, #fff);
      border-radius: 8px;
      padding: 20px;
      min-width: 360px;
      max-width: 480px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      color: var(--text-color, #333);
    `

    // 标题
    const title = document.createElement('div')
    title.style.cssText = `
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
    `
    title.textContent = '关闭标签'

    // 消息
    const message = document.createElement('div')
    message.style.cssText = `
      font-size: 14px;
      margin-bottom: 20px;
      line-height: 1.5;
    `
    message.textContent = `"${fileName}" 有未保存的更改。`

    // 按钮容器
    const buttons = document.createElement('div')
    buttons.style.cssText = `
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    `

    const buttonStyle = `
      padding: 8px 16px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    `

    // 取消按钮
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = '取消'
    cancelBtn.style.cssText = buttonStyle + `
      background: var(--button-bg, #e0e0e0);
      color: var(--text-color, #333);
    `
    cancelBtn.onmouseenter = () => { cancelBtn.style.background = 'var(--button-hover-bg, #d0d0d0)' }
    cancelBtn.onmouseleave = () => { cancelBtn.style.background = 'var(--button-bg, #e0e0e0)' }

    // 不保存按钮
    const discardBtn = document.createElement('button')
    discardBtn.textContent = '不保存'
    discardBtn.style.cssText = buttonStyle + `
      background: var(--danger-bg, #ff5252);
      color: white;
    `
    discardBtn.onmouseenter = () => { discardBtn.style.background = 'var(--danger-hover-bg, #ff1744)' }
    discardBtn.onmouseleave = () => { discardBtn.style.background = 'var(--danger-bg, #ff5252)' }

    // 保存并关闭按钮
    const saveBtn = document.createElement('button')
    saveBtn.textContent = '保存并关闭'
    saveBtn.style.cssText = buttonStyle + `
      background: var(--primary-color, #1976d2);
      color: white;
    `
    saveBtn.onmouseenter = () => { saveBtn.style.background = 'var(--primary-hover, #1565c0)' }
    saveBtn.onmouseleave = () => { saveBtn.style.background = 'var(--primary-color, #1976d2)' }

    // 关闭对话框
    const closeDialog = (result: 'save' | 'discard' | 'cancel') => {
      overlay.remove()
      resolve(result)
    }

    cancelBtn.onclick = () => closeDialog('cancel')
    discardBtn.onclick = () => closeDialog('discard')
    saveBtn.onclick = () => closeDialog('save')

    // ESC 键取消
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDialog('cancel')
        document.removeEventListener('keydown', handleKeydown)
      }
    }
    document.addEventListener('keydown', handleKeydown)

    buttons.appendChild(cancelBtn)
    buttons.appendChild(discardBtn)
    buttons.appendChild(saveBtn)

    dialog.appendChild(title)
    dialog.appendChild(message)
    dialog.appendChild(buttons)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    // 自动聚焦保存按钮
    saveBtn.focus()
  })
}

/**
 * 初始化标签系统
 * 在 DOM 就绪后调用
 */
export async function initTabSystem(): Promise<void> {
  if (initialized) return

  // 确保 DOM 已就绪
  const titlebar = document.querySelector('.titlebar')
  const container = document.querySelector('.container')
  if (!titlebar || !container) {
    console.warn('[Tabs] DOM not ready, retrying...')
    setTimeout(() => initTabSystem(), 100)
    return
  }

  // 创建标签栏容器
  const tabbarContainer = document.createElement('div')
  tabbarContainer.id = 'tabbar-container'

  // 插入到 titlebar 之后、focus-trigger-zone 或 container 之前
  const focusTrigger = document.querySelector('.focus-trigger-zone')
  if (focusTrigger) {
    focusTrigger.before(tabbarContainer)
  } else {
    container.before(tabbarContainer)
  }

  // 初始化 TabManager
  const hooks = createHooks()
  tabManager.init(hooks)

  // 初始化 TabBar
  tabBar = new TabBar({
    container: tabbarContainer,
    tabManager,
    onBeforeClose: async (tab) => {
      if (!tab.dirty) return true

      // 获取文件名用于显示
      const fileName = tab.filePath
        ? tab.filePath.replace(/\\/g, '/').split('/').pop() || '未命名'
        : '未命名'

      // 显示三按钮对话框
      const result = await showCloseConfirmDialog(fileName)

      if (result === 'cancel') {
        return false // 取消关闭
      }

      if (result === 'save') {
        // 先切换到该标签
        await tabManager.switchToTab(tab.id)
        // 保存文件
        const flymd = getFlymd()
        if (flymd.flymdSaveFile) {
          await flymd.flymdSaveFile()
        }
      }

      // 'save' 或 'discard' 都允许关闭
      return true
    }
  })
  tabBar.init()

  // 挂钩关键操作
  hookOpenFile()
  hookNewFile()
  hookSaveFile()
  hookKeyboardShortcuts()

  // 监听编辑器变化，同步 dirty 状态
  setupDirtySync()

  // 启动文件路径同步监听（处理直接调用 openFile2 的情况）
  startPathSyncWatcher()

  initialized = true
  console.log('[Tabs] Tab system initialized')
}

/**
 * 创建与 main.ts 的连接钩子
 */
function createHooks(): TabManagerHooks {
  const flymd = getFlymd()

  return {
    getEditorContent: () => {
      const editor = document.getElementById('editor') as HTMLTextAreaElement
      return editor?.value ?? ''
    },

    setEditorContent: (content: string) => {
      // 暂停 dirty 同步，避免设置内容时触发 input 事件导致误判为已修改
      pauseDirtySyncFor(500)

      const editor = document.getElementById('editor') as HTMLTextAreaElement
      if (editor) {
        editor.value = content
        // 触发 input 事件以便其他监听器感知
        editor.dispatchEvent(new Event('input', { bubbles: true }))
      }
      // 如果在所见模式，同步内容
      if (flymd.flymdWysiwygV2ReplaceAll) {
        try { flymd.flymdWysiwygV2ReplaceAll(content) } catch {}
      }
    },

    getCurrentFilePath: () => {
      return flymd.flymdGetCurrentFilePath?.() ?? null
    },

    setCurrentFilePath: (path: string | null) => {
      // 通过设置内部变量（需要 main.ts 暴露）
      if (flymd.flymdSetCurrentFilePath) {
        flymd.flymdSetCurrentFilePath(path)
      }
    },

    getDirty: () => {
      return flymd.flymdIsDirty?.() ?? false
    },

    setDirty: (dirty: boolean) => {
      if (flymd.flymdSetDirty) {
        flymd.flymdSetDirty(dirty)
      }
    },

    getMode: (): EditorMode => {
      return flymd.flymdGetMode?.() ?? 'edit'
    },

    setMode: (mode: EditorMode) => {
      if (flymd.flymdSetMode) {
        flymd.flymdSetMode(mode)
      }
    },

    getWysiwygEnabled: () => {
      return flymd.flymdGetWysiwygEnabled?.() ?? false
    },

    setWysiwygEnabled: async (enabled: boolean) => {
      if (flymd.flymdSetWysiwygEnabled) {
        await flymd.flymdSetWysiwygEnabled(enabled)
      }
    },

    getScrollTop: () => {
      // 根据当前模式获取正确的滚动位置
      const mode = flymd.flymdGetMode?.() ?? 'edit'
      const wysiwyg = flymd.flymdGetWysiwygEnabled?.() ?? false

      if (wysiwyg) {
        const wysiwygRoot = document.getElementById('md-wysiwyg-root')
        return wysiwygRoot?.scrollTop ?? 0
      } else if (mode === 'preview') {
        const preview = document.getElementById('preview')
        return preview?.scrollTop ?? 0
      } else {
        const editor = document.getElementById('editor') as HTMLTextAreaElement
        return editor?.scrollTop ?? 0
      }
    },

    setScrollTop: (top: number) => {
      const mode = flymd.flymdGetMode?.() ?? 'edit'
      const wysiwyg = flymd.flymdGetWysiwygEnabled?.() ?? false

      if (wysiwyg) {
        const wysiwygRoot = document.getElementById('md-wysiwyg-root')
        if (wysiwygRoot) wysiwygRoot.scrollTop = top
      } else if (mode === 'preview') {
        const preview = document.getElementById('preview')
        if (preview) preview.scrollTop = top
      } else {
        const editor = document.getElementById('editor') as HTMLTextAreaElement
        if (editor) editor.scrollTop = top
      }
    },

    getCursorPos: () => {
      const editor = document.getElementById('editor') as HTMLTextAreaElement
      if (!editor) return { line: 1, col: 1 }

      const text = editor.value.substring(0, editor.selectionStart)
      const lines = text.split('\n')
      return {
        line: lines.length,
        col: (lines[lines.length - 1]?.length ?? 0) + 1
      }
    },

    setCursorPos: (line: number, col: number) => {
      const editor = document.getElementById('editor') as HTMLTextAreaElement
      if (!editor) return

      const lines = editor.value.split('\n')
      let pos = 0
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        pos += lines[i].length + 1
      }
      pos += Math.min(col - 1, lines[line - 1]?.length ?? 0)

      editor.selectionStart = pos
      editor.selectionEnd = pos
      editor.focus()
    },

    refreshTitle: () => {
      if (flymd.flymdRefreshTitle) {
        flymd.flymdRefreshTitle()
      }
    },

    refreshPreview: () => {
      if (flymd.flymdRefreshPreview) {
        flymd.flymdRefreshPreview()
      }
    },

    reloadFile: async (filePath: string) => {
      // 重新加载文件（用于 PDF 等特殊文件）
      // 暂停轮询检测，避免冲突
      pausePathWatcher(1500)
      // 使用原始的 openFile2，绕过标签系统的钩子
      if (flymd.flymdOpenFileOriginal) {
        await flymd.flymdOpenFileOriginal(filePath)
      } else if (flymd.flymdOpenFile) {
        await flymd.flymdOpenFile(filePath)
      }
    }
  }
}

/**
 * 挂钩文件打开操作
 */
function hookOpenFile(): void {
  const flymd = getFlymd()
  const originalOpenFile = flymd.flymdOpenFile

  if (!originalOpenFile) {
    console.warn('[Tabs] flymdOpenFile not found, open file hook not applied')
    return
  }

  // 保存原始函数，供 reloadFile 使用（绕过钩子）
  flymd.flymdOpenFileOriginal = originalOpenFile

  flymd.flymdOpenFile = async (preset?: unknown) => {
    const currentTab = tabManager.getActiveTab()
    const beforePath = flymd.flymdGetCurrentFilePath?.()

    // 如果是路径字符串，检查是否已打开
    if (typeof preset === 'string') {
      const existingTab = tabManager.findTabByPath(preset)
      if (existingTab) {
        // 已打开，切换到该标签
        await tabManager.switchToTab(existingTab.id)
        return
      }
    }

    // 如果当前标签是空白的（无路径、无内容、未修改），复用它
    const isCurrentTabEmpty = currentTab &&
      !currentTab.filePath &&
      !currentTab.dirty &&
      !currentTab.content.trim()

    // Ctrl+点击：先创建新标签，再打开文档（用户建议的稳定方案）
    // 这样原标签的内容会在创建新标签时被保存
    if (ctrlKeyPressed && currentTab && !isCurrentTabEmpty) {
      // 先创建新空白标签（这会保存当前标签状态）
      tabManager.createNewTab()
      // 暂停轮询检测，避免冲突
      pausePathWatcher(1500)
    }

    // 调用原始打开逻辑
    await originalOpenFile(preset)

    // 获取打开后的文件路径和内容
    const afterPath = flymd.flymdGetCurrentFilePath?.()
    const content = flymd.flymdGetEditorContent?.() ?? ''

    // 如果打开了新文件
    if (afterPath && afterPath !== beforePath) {
      // 更新当前标签（可能是新创建的空白标签，或复用的空白标签）
      const activeTab = tabManager.getActiveTab()
      if (activeTab) {
        tabManager.updateCurrentTabPath(afterPath)
        tabManager.updateTabContent(activeTab.id, content)
        // 检测是否是 PDF
        if (afterPath.toLowerCase().endsWith('.pdf')) {
          activeTab.isPdf = true
        }
      }
    }
  }
}

/**
 * 挂钩新建文件操作
 */
function hookNewFile(): void {
  const flymd = getFlymd()
  const originalNewFile = flymd.flymdNewFile

  if (!originalNewFile) {
    console.warn('[Tabs] flymdNewFile not found, new file hook not applied')
    return
  }

  flymd.flymdNewFile = async () => {
    // 创建新标签
    tabManager.createNewTab()
    // 调用原始新建逻辑
    await originalNewFile()
  }
}

/**
 * 挂钩保存文件操作
 */
function hookSaveFile(): void {
  const flymd = getFlymd()
  const originalSaveFile = flymd.flymdSaveFile

  if (!originalSaveFile) {
    console.warn('[Tabs] flymdSaveFile not found, save file hook not applied')
    return
  }

  flymd.flymdSaveFile = async () => {
    await originalSaveFile()

    // 保存后更新标签状态
    const tab = tabManager.getActiveTab()
    if (tab) {
      // 可能路径变了（另存为）
      const newPath = flymd.flymdGetCurrentFilePath?.()
      if (newPath && newPath !== tab.filePath) {
        tabManager.updateCurrentTabPath(newPath)
      }
      tabManager.markCurrentTabSaved()
    }
  }
}

/**
 * 挂钩键盘快捷键
 */
function hookKeyboardShortcuts(): void {
  document.addEventListener('keydown', async (e) => {
    // Ctrl+Tab / Ctrl+Shift+Tab - 切换标签
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        await tabManager.switchToPrevTab()
      } else {
        await tabManager.switchToNextTab()
      }
      return
    }

    // Ctrl+T - 新建标签
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault()
      const flymd = getFlymd()
      if (flymd.flymdNewFile) {
        await flymd.flymdNewFile()
      } else {
        tabManager.createNewTab()
      }
      return
    }

    // 注意：Ctrl+W 已被用于所见模式切换，标签关闭使用中键点击
  }, true) // 使用捕获阶段，优先处理
}

/**
 * 监听编辑器变化，同步 dirty 状态到标签
 */
function setupDirtySync(): void {
  const flymd = getFlymd()
  let lastMainDirty = false  // 跟踪上次的 dirty 状态

  // 监听编辑模式的输入
  const editor = document.getElementById('editor') as HTMLTextAreaElement
  if (editor) {
    editor.addEventListener('input', () => {
      // 切换标签时暂停 dirty 同步，避免 restoreTabState 触发误判
      if (pauseDirtySync) return
      tabManager.markCurrentTabDirty()
    })
  }

  // 定期同步 main.ts 的 dirty 状态到当前标签（处理所见模式等情况）
  // 只在 dirty 状态从 false 变为 true 时才同步（检测变化而非状态）
  setInterval(() => {
    // 切换标签时暂停 dirty 同步
    if (pauseDirtySync) return

    const mainDirty = flymd.flymdIsDirty?.() ?? false
    const currentTab = tabManager.getActiveTab()

    // 只有当 main.ts 的 dirty 从 false 变为 true 时，才标记标签为 dirty
    if (currentTab && mainDirty && !lastMainDirty && !currentTab.dirty) {
      tabManager.markCurrentTabDirty()
    }

    lastMainDirty = mainDirty
  }, 200)
}

/**
 * 启动文件路径同步监听
 * 处理直接调用 openFile2 而绕过钩子的情况
 */
function startPathSyncWatcher(): void {
  const flymd = getFlymd()
  let lastKnownPath: string | null = null
  let lastKnownContent: string = ''  // 缓存路径变化前的内容

  // 每 100ms 检查一次当前文件路径是否变化
  setInterval(() => {
    // 如果暂停了，直接返回
    if (pauseWatcher) return

    const currentPath = flymd.flymdGetCurrentFilePath?.() ?? null
    const currentContent = flymd.flymdGetEditorContent?.() ?? ''
    const currentTab = tabManager.getActiveTab()

    // 如果路径没有变化，更新缓存的内容
    if (currentPath === lastKnownPath) {
      lastKnownContent = currentContent
      return
    }

    // 路径变化了 - 检测是否是 PDF 文件
    const isPdf = currentPath?.toLowerCase().endsWith('.pdf') ?? false

    // 检查是否已有该路径的标签
    const existingTab = currentPath ? tabManager.findTabByPath(currentPath) : null

    if (existingTab) {
      // 已有该文件的标签，切换过去
      if (existingTab.id !== currentTab?.id) {
        tabManager.switchToTab(existingTab.id)
      }
    } else if (currentPath && currentTab) {
      // 新文件，检查是否按住 Ctrl
      const isCurrentTabEmpty = !currentTab.filePath && !currentTab.dirty && !currentTab.content.trim()

      if (ctrlKeyPressed && !isCurrentTabEmpty) {
        // Ctrl+点击：创建新标签，再恢复原标签内容
        // 问题：openFile 内部会调用 saveCurrentTabState，会用编辑器当前内容（文档2）覆盖原标签
        // 解决：先记录原标签ID和内容，openFile 之后再恢复
        const originalTabId = currentTab.id
        const originalContent = lastKnownContent
        const originalPath = currentTab.filePath

        // 创建新标签并设置为当前文件
        const { tab: newTab } = tabManager.openFile(currentPath, currentContent)
        newTab.isPdf = isPdf

        // 恢复原标签的内容（openFile 内部的 saveCurrentTabState 会覆盖，所以要在之后恢复）
        const originalTab = tabManager.findTabById(originalTabId)
        if (originalTab) {
          originalTab.content = originalContent
          originalTab.filePath = originalPath
          originalTab.dirty = false
        }
      } else {
        // 默认行为：在当前标签打开（覆盖当前文档）
        tabManager.updateCurrentTabPath(currentPath)
        tabManager.updateTabContent(currentTab.id, currentContent)
        currentTab.isPdf = isPdf
      }
    }

    // 更新路径和内容缓存
    lastKnownPath = currentPath
    lastKnownContent = currentContent
  }, 100)
}

// 记录是否按住 Ctrl 键
let ctrlKeyPressed = false
document.addEventListener('keydown', (e) => { if (e.key === 'Control') ctrlKeyPressed = true })
document.addEventListener('keyup', (e) => { if (e.key === 'Control') ctrlKeyPressed = false })
document.addEventListener('blur', () => { ctrlKeyPressed = false })

/**
 * 检查是否应该在新标签打开
 */
export function shouldOpenInNewTab(): boolean {
  return ctrlKeyPressed
}

/**
 * 在新标签中打开文件（供外部调用）
 */
export function openFileInNewTab(filePath: string, content: string): void {
  // 检查是否已打开
  const existingTab = tabManager.findTabByPath(filePath)
  if (existingTab) {
    tabManager.switchToTab(existingTab.id)
    return
  }
  // 创建新标签
  tabManager.openFile(filePath, content)
}

// 自动初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // 延迟初始化，等待 main.ts 完成
    setTimeout(initTabSystem, 500)
  })
} else {
  setTimeout(initTabSystem, 500)
}

// 导出供外部使用
export { tabManager, tabBar }
