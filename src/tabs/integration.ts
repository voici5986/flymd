/**
 * 标签系统集成模块
 *
 * 包装器模式：通过 window 暴露的函数与 main.ts 交互
 * 最小侵入：只需在 main.ts 末尾添加一行 import
 */

import { tabManager, TabManagerHooks } from './TabManager'
import { TabBar } from './TabBar'
import { getTabDisplayName, type EditorMode, type TabDocument } from './types'
import { TextareaUndoManager } from './TextareaUndoManager'
import { FLYMD_PATH_DELETED_EVENT, type FlymdPathDeletedDetail } from '../core/pathEvents'

// 全局引用
let tabBar: TabBar | null = null
let initialized = false
const undoManager = new TextareaUndoManager()

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

function pauseDirtySyncFor(duration = 800): void {
  pauseDirtySync = true
  if (pauseDirtySyncTimeout) clearTimeout(pauseDirtySyncTimeout)
  pauseDirtySyncTimeout = setTimeout(() => { pauseDirtySync = false }, duration)
}

// 获取 window 上暴露的 flymd 函数
function getFlymd(): any {
  return (window as any)
}

function syncFileTreeSelectionToActiveTab(): void {
  try {
    const flymd = getFlymd()
    const activeTab = tabManager.getActiveTab()
    const p = activeTab?.filePath ?? null
    const fn = flymd?.flymdRevealInFileTree
    if (typeof fn === 'function') {
      void fn(p)
    }
  } catch {}
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
 * 统一处理标签关闭前的未保存确认逻辑
 */
async function confirmTabClose(tab: TabDocument): Promise<boolean> {
  // 未修改直接允许关闭
  if (!tab.dirty) return true

  // 使用标签显示名（未保存标签也能区分）
  const fileName = getTabDisplayName(tab)

  // 显示三按钮对话框
  const result = await showCloseConfirmDialog(fileName)

  if (result === 'cancel') {
    return false // 取消关闭
  }

  if (result === 'save') {
    // 切换到该标签并保存
    await tabManager.switchToTab(tab.id)
    const flymd = getFlymd()
    if (flymd.flymdSaveFile) {
      await flymd.flymdSaveFile()
    }
  }

  // 'save' 或 'discard' 都允许关闭
  return true
}

/**
 * 初始化标签系统
 * 在 DOM 就绪后调用
 */
export async function initTabSystem(): Promise<void> {
  if (initialized) return

  // 确保 DOM 已就绪（兼容新 tabbar-row 和旧 titlebar 布局）
  const tabbarRow = document.querySelector('.tabbar-row')
  const titlebar = document.querySelector('.titlebar')
  const container = document.querySelector('.container')
  if ((!tabbarRow && !titlebar) || !container) {
    console.warn('[Tabs] DOM not ready, retrying...')
    setTimeout(() => initTabSystem(), 100)
    return
  }

  // 优先使用 tabbar-placeholder，否则创建新容器
  let tabbarContainer = document.getElementById('tabbar-placeholder') as HTMLElement | null
  if (!tabbarContainer) {
    tabbarContainer = document.createElement('div')
    tabbarContainer.id = 'tabbar-container'
    // 插入到 titlebar 之后、focus-trigger-zone 或 container 之前
    const focusTrigger = document.querySelector('.focus-trigger-zone')
    if (focusTrigger) {
      focusTrigger.before(tabbarContainer)
    } else {
      container.before(tabbarContainer)
    }
  }

  // 初始化 TabManager
  const hooks = createHooks()
  tabManager.init(hooks)

  // 初始化撤销管理器：为当前激活标签创建撤销栈
  const editor = document.getElementById('editor') as HTMLTextAreaElement | null
  const activeTab = tabManager.getActiveTab()
  if (editor && activeTab) {
    undoManager.init(activeTab.id, editor)
  }

  // 初始化 TabBar
  tabBar = new TabBar({
    container: tabbarContainer,
    tabManager,
    onBeforeClose: async (tab) => {
      return await confirmTabClose(tab)
    }
  })
  tabBar.init()

  // 监听标签事件，同步撤销栈
  tabManager.addEventListener((event) => {
    if (event.type === 'tab-switched') {
      const ed = document.getElementById('editor') as HTMLTextAreaElement | null
      if (ed) {
        undoManager.switchTab(event.toTabId, ed)
      }
      // 标签切换后同步库侧栏选中态（否则高亮会停留在旧文档）
      syncFileTreeSelectionToActiveTab()
    } else if (event.type === 'tab-closed') {
      undoManager.removeTab(event.tabId)
    }
  })

  // 挂钩关键操作
  hookOpenFile()
  hookNewFile()
  hookSaveFile()
  hookFileSavedEvent()
  hookKeyboardShortcuts()

  // 监听编辑器变化，同步 dirty 状态
  setupDirtySync()

  // 启动文件路径同步监听（处理直接调用 openFile2 的情况）
  startPathSyncWatcher()

  // 监听文件重命名事件（例如从库侧栏重命名文档），同步更新标签中的文件路径
  window.addEventListener('flymd-file-renamed', (ev: Event) => {
    try {
      const detail = (ev as CustomEvent).detail as { src?: string; dst?: string } | undefined
      if (!detail || !detail.src || !detail.dst) return
      const src = String(detail.src)
      const dst = String(detail.dst)
      const normalizedSrc = src.replace(/\\/g, '/')
      const tabs = tabManager.getTabs()
      for (const tab of tabs) {
        const p = tab.filePath
        if (p && p.replace(/\\/g, '/') === normalizedSrc) {
          tabManager.updateTabPath(tab.id, dst)
        }
      }
    } catch (e) {
      console.error('[Tabs] 处理文件重命名事件失败:', e)
    }
  })

  // 监听文件/文件夹删除事件：删除后自动关闭对应标签
  // 约定：不在这里做“删除文件”的文件系统操作，只做 UI/标签状态同步。
  window.addEventListener(FLYMD_PATH_DELETED_EVENT, (ev: Event) => {
    void (async () => {
      try {
        const detail = (ev as CustomEvent).detail as FlymdPathDeletedDetail | undefined
        if (!detail || !detail.path) return
        const deletedPath = String(detail.path)
        const deletedIsDir = !!detail.isDir

        const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
        const delN = norm(deletedPath)
        const isInsideDir = (dirN: string, fileN: string) => fileN === dirN || fileN.startsWith(dirN + '/')

        // 复制一份快照，避免边遍历边修改造成漏关/越界
        const tabs = [...tabManager.getTabs()]
        const targets: TabDocument[] = []
        for (const tab of tabs) {
          if (!tab.filePath) continue
          const tabN = norm(tab.filePath)
          const hit = deletedIsDir ? isInsideDir(delN, tabN) : (tabN === delN)
          if (hit) targets.push(tab)
        }
        if (!targets.length) return

        // 逐个处理：无未保存内容就直接关闭；有未保存内容则解绑为“未命名”避免丢失
        for (const tab of targets) {
          if (tab.dirty) {
            tabManager.detachTabFromFile(tab.id)
            continue
          }
          await tabManager.closeTab(tab.id)
        }
      } catch (e) {
        console.error('[Tabs] 处理删除事件失败:', e)
      }
    })()
  })

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

      // 切换标签 / 打开文件时的程序性更新，不应该写入撤销栈
      undoManager.runWithoutRecording(() => {
        const editor = document.getElementById('editor') as HTMLTextAreaElement
        if (editor) {
          editor.value = content
          // 触发 input 事件以便其他监听器感知
          editor.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })

      // 所见模式下，依赖全局 input 监听中的 scheduleWysiwygRender 进行同步，避免直接跨层调用导致 Milkdown 状态错乱
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
        // 所见 V2：优先使用内部 scrollView，避免出现双滚动容器状态不一致
        const scrollEl = (document.querySelector('#md-wysiwyg-root .scrollView') as HTMLElement | null)
          || (document.getElementById('md-wysiwyg-root') as HTMLElement | null)
        return scrollEl?.scrollTop ?? 0
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
        const scrollEl = (document.querySelector('#md-wysiwyg-root .scrollView') as HTMLElement | null)
          || (document.getElementById('md-wysiwyg-root') as HTMLElement | null)
        if (scrollEl) scrollEl.scrollTop = top
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

    // 当前标签已有内容：直接新建标签，再打开文档，避免覆盖
    const shouldOpenNewTab = !!(currentTab && !isCurrentTabEmpty)
    if (shouldOpenNewTab) {
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

        // 打开新文档后，将当前 textarea 内容作为该标签的撤销基线
        // 避免首次编辑时撤销回到旧文档或空文档
        undoManager.resetCurrentStackBaseline()

        const isPdf = afterPath.toLowerCase().endsWith('.pdf')
        if (isPdf) {
          // 标记为 PDF 标签
          activeTab.isPdf = true

          // 最笨的办法：打开 PDF 后自动模拟“切换一次标签再切回来”
          // 加一个小延时，确保当前标签状态/预览渲染完成再切换
          try {
            const tabs = tabManager.getTabs()
            if (tabs.length > 1) {
              const idx = tabs.findIndex(t => t.id === activeTab.id)
              if (idx !== -1) {
                const otherIdx = (idx + 1) % tabs.length
                const otherId = tabs[otherIdx].id
                if (otherId !== activeTab.id) {
                  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
                  await delay(200)
                  await tabManager.switchToTab(otherId)
                  await delay(200)
                  await tabManager.switchToTab(activeTab.id)
                }
              }
            }
          } catch {}
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
 * 监听文件保存事件
 */
function hookFileSavedEvent(): void {
  window.addEventListener('flymd-file-saved', () => {
    const flymd = getFlymd()
    const tab = tabManager.getActiveTab()
    if (tab) {
      const newPath = flymd.flymdGetCurrentFilePath?.()
      if (newPath && newPath !== tab.filePath) {
        tabManager.updateCurrentTabPath(newPath)
      }
      tabManager.markCurrentTabSaved()
    }
  })
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

    // Alt+W - 关闭当前标签（带未保存确认）
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault()
      const currentTab = tabManager.getActiveTab()
      if (!currentTab) return

      const confirmed = await confirmTabClose(currentTab)
      if (!confirmed) return

      await tabManager.closeTab(currentTab.id)
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

  // 监听源码模式的输入
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

    // 内容是否相对上一次轮询发生变化，用于区分“只是改名/路径变了”与“真正加载了新文档”
    const contentChanged = currentContent !== lastKnownContent

    if (existingTab) {
      // 已有该文件的标签：说明外部（如直接调用 openFile2）切换到了一个已存在的文档
      // 此时编辑器内容已经是目标文件，不能再用 switchToTab → saveCurrentTabState 的顺序，
      // 否则会把新内容写回“旧标签”。改为通过专门的 adoptExternalSwitch 入口，只更新目标标签。
      if (existingTab.id !== currentTab?.id && currentPath) {
        tabManager.adoptExternalSwitchToPath(currentPath, isPdf)
        if (contentChanged) {
          // 外部切换到已存在标签且加载了新内容：以当前内容重置撤销基线
          undoManager.resetCurrentStackBaseline()
        }
      } else if (currentTab && currentTab.id === existingTab.id) {
        // 同一个标签路径变化（极少见），只需同步 PDF 标记
        currentTab.isPdf = isPdf
      }
    } else if (currentPath && currentTab) {
      // 新文件，检查是否按住 Ctrl
      const isCurrentTabEmpty = !currentTab.filePath && !currentTab.dirty && !currentTab.content.trim()

      if (!isCurrentTabEmpty) {
        // 当前标签已有内容：创建新标签，再恢复原标签内容，避免覆盖
        const originalTabId = currentTab.id
        const originalContent = lastKnownContent
        const originalPath = currentTab.filePath

        // 创建新标签并设置为当前文件
        const { tab: newTab } = tabManager.openFile(currentPath, currentContent)
        newTab.isPdf = isPdf

        if (contentChanged) {
          // 新文件 + 新标签：以当前内容重置撤销基线
          undoManager.resetCurrentStackBaseline()
        }

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

         if (contentChanged) {
           // 复用当前空白标签打开新文件：以当前内容重置撤销基线
           undoManager.resetCurrentStackBaseline()
         }
      }
    }

    // 更新路径和内容缓存
    lastKnownPath = currentPath
    lastKnownContent = currentContent
  }, 100)
}

/**
 * 当前策略：始终在新标签中打开（如果当前标签非空）
 */
export function shouldOpenInNewTab(): boolean {
  return true
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
