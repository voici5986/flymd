// 源码 + 阅读模式分屏布局（左侧源码，右侧阅读预览）
// 设计原则：
// - 仅在源码模式（mode === 'edit'）且非所见/非便签模式下启用
// - 不改动 main.ts 现有逻辑，只通过 window.flymd* 包装器交互
// - 默认关闭，支持记忆上次开关状态（localStorage）

type EditorMode = 'edit' | 'preview'

type SplitDeps = {
  container: HTMLDivElement
  editor: HTMLTextAreaElement
  preview: HTMLDivElement
}

let splitPreviewEnabled = false

function getFlymd(): any {
  return (window as any)
}

function isStickyNoteMode(): boolean {
  try {
    return document.body.classList.contains('sticky-note-mode')
  } catch {
    return false
  }
}

// 当前是否处于“允许分屏”的环境：源码模式 + 非所见 + 非便签
function isSupportedContext(): boolean {
  const flymd = getFlymd()
  let mode: EditorMode = 'edit'
  let wysiwyg = false
  try {
    mode = (flymd.flymdGetMode?.() ?? 'edit') as EditorMode
  } catch {}
  try {
    wysiwyg = !!flymd.flymdGetWysiwygEnabled?.()
  } catch {}
  if (isStickyNoteMode()) return false
  return mode === 'edit' && !wysiwyg
}

function setSplitEnabled(enabled: boolean, deps: SplitDeps): void {
  const { container, editor, preview } = deps
  if (enabled === splitPreviewEnabled) return

  if (enabled) {
    // 只允许在源码模式下开启
    if (!isSupportedContext()) {
      const flymd = getFlymd()
      let mode: EditorMode = 'edit'
      let wysiwyg = false
      try { mode = (flymd.flymdGetMode?.() ?? 'edit') as EditorMode } catch {}
      try { wysiwyg = !!flymd.flymdGetWysiwygEnabled?.() } catch {}
      if (mode !== 'edit') {
        alert('仅在源码模式下支持分屏，请先切换到源码模式')
      } else if (wysiwyg) {
        alert('所见模式下暂不支持源码+阅读分屏')
      } else if (isStickyNoteMode()) {
        alert('便签模式下暂不支持源码+阅读分屏')
      } else {
        alert('当前模式不支持分屏')
      }
      return
    }
    // 窗口太窄时禁止开启，避免界面严重拥挤
    if (window.innerWidth < 1100) {
      alert('窗口太窄，无法开启左右分屏，请放大窗口后再试')
      return
    }
  }

  splitPreviewEnabled = enabled

  try {
    container.classList.toggle('split-preview', enabled)
  } catch {}

  const flymd = getFlymd()
  let mode: EditorMode = 'edit'
  let wysiwyg = false
  try { mode = (flymd.flymdGetMode?.() ?? 'edit') as EditorMode } catch {}
  try { wysiwyg = !!flymd.flymdGetWysiwygEnabled?.() } catch {}

  if (enabled) {
    // 启用分屏时：强制显示预览并渲染一次
    try { preview.classList.remove('hidden') } catch {}
    try { flymd.flymdRefreshPreview?.() } catch {}
  } else {
    // 关闭分屏时：如果仍处于“纯源码模式”，恢复为仅编辑器视图
    if (mode === 'edit' && !wysiwyg && !isStickyNoteMode()) {
      try { preview.classList.add('hidden') } catch {}
    }
  }

  try {
    localStorage.setItem('flymd:split-preview', enabled ? 'true' : 'false')
  } catch {}

  // 分屏开关切换后，同步一次滚动位置，尽量保持阅读/编辑位置接近
  try {
    if (enabled) {
      syncPreviewScrollFromEditor(editor, preview)
    }
  } catch {}

  // 显示模式通知：在右下角标记当前为“源码+分屏”或普通源码模式
  try {
    const flymd = getFlymd()
    const NotificationManager = flymd.NotificationManager as {
      show: (type: string, msg: string, ms?: number) => void
    } | undefined
    if (NotificationManager && typeof NotificationManager.show === 'function') {
      if (enabled) {
        NotificationManager.show('mode-split', '源码 + 阅读分屏', 1600)
      } else if (isSupportedContext()) {
        NotificationManager.show('mode-edit', '源码模式', 1200)
      }
    }
  } catch {}
}

function toggleSplit(deps: SplitDeps): void {
  setSplitEnabled(!splitPreviewEnabled, deps)
}

// 根据编辑器滚动百分比，将预览滚动到对应位置
function syncPreviewScrollFromEditor(editor: HTMLTextAreaElement, preview: HTMLDivElement): void {
  const er = Math.max(0, editor.scrollHeight - editor.clientHeight)
  const pr = Math.max(0, preview.scrollHeight - preview.clientHeight)
  if (er <= 0 || pr <= 0) return
  const ratio = editor.scrollTop / er
  preview.scrollTop = ratio * pr
}

function bindScrollSync(deps: SplitDeps): void {
  const { editor, preview } = deps
  let syncing: 'none' | 'editor' | 'preview' = 'none'

  const syncFromEditor = () => {
    if (!splitPreviewEnabled || !isSupportedContext()) return
    if (syncing !== 'none') return
    syncing = 'editor'
    try {
      const er = Math.max(0, editor.scrollHeight - editor.clientHeight)
      const pr = Math.max(0, preview.scrollHeight - preview.clientHeight)
      if (er <= 0 || pr <= 0) return
      const ratio = editor.scrollTop / er
      preview.scrollTop = ratio * pr
    } finally {
      syncing = 'none'
    }
  }

  const syncFromPreview = () => {
    if (!splitPreviewEnabled || !isSupportedContext()) return
    if (syncing !== 'none') return
    syncing = 'preview'
    try {
      const er = Math.max(0, editor.scrollHeight - editor.clientHeight)
      const pr = Math.max(0, preview.scrollHeight - preview.clientHeight)
      if (er <= 0 || pr <= 0) return
      const ratio = preview.scrollTop / pr
      editor.scrollTop = ratio * er
    } finally {
      syncing = 'none'
    }
  }

  editor.addEventListener('scroll', () => {
    if (!splitPreviewEnabled) return
    syncFromEditor()
  })
  preview.addEventListener('scroll', () => {
    if (!splitPreviewEnabled) return
    syncFromPreview()
  })
}

// 文本内容变化时的预览同步（仅在分屏 + 源码模式下生效）
function bindContentSync(): void {
  const flymd = getFlymd()
  const editor = document.querySelector('.editor') as HTMLTextAreaElement | null
  if (!editor) return

  let timer: number | null = null

  editor.addEventListener('input', () => {
    if (!splitPreviewEnabled) return
    if (!isSupportedContext()) return
    try {
      if (timer != null) window.clearTimeout(timer)
      // 轻微防抖：避免每个键都触发完整渲染
      timer = window.setTimeout(() => {
        timer = null
        try { flymd.flymdRefreshPreview?.() } catch {}
      }, 240)
    } catch {}
  })
}

function bindAutoClose(deps: SplitDeps): void {
  // 监听模式/所见变更事件：一旦离开源码模式，自动关闭分屏
  window.addEventListener('flymd:mode:changed', () => {
    if (!splitPreviewEnabled) return
    if (!isSupportedContext()) {
      setSplitEnabled(false, deps)
    }
  })

  // 窗口过窄时自动关闭分屏
  window.addEventListener('resize', () => {
    if (!splitPreviewEnabled) return
    if (window.innerWidth < 1100) {
      setSplitEnabled(false, deps)
    }
  })
}

function initSplitPreview(): void {
  try {
    const container = document.querySelector('.container') as HTMLDivElement | null
    const editor = document.querySelector('.editor') as HTMLTextAreaElement | null
    const preview = document.getElementById('preview') as HTMLDivElement | null
    if (!container || !editor || !preview) return

    const deps: SplitDeps = { container, editor, preview }
    const flymd = getFlymd()

    // 防止重复初始化
    if (flymd.__flymdSplitPreviewInit) return
    flymd.__flymdSplitPreviewInit = true

    // 暴露全局控制函数，供 main.ts 快捷键和其他模块使用
    flymd.flymdSetSplitPreviewEnabled = (enabled: boolean) => {
      setSplitEnabled(!!enabled, deps)
    }
    flymd.flymdGetSplitPreviewEnabled = () => splitPreviewEnabled
    flymd.flymdToggleSplitPreview = () => {
      toggleSplit(deps)
    }

    bindScrollSync(deps)
    bindContentSync()
    bindAutoClose(deps)

    // 恢复上次状态（仅在当前已经是源码模式且窗口足够宽时生效）
    try {
      const saved = localStorage.getItem('flymd:split-preview') === 'true'
      if (saved && isSupportedContext() && window.innerWidth >= 1100) {
        setSplitEnabled(true, deps)
      }
    } catch {}
  } catch {}
}

// 延迟初始化，等待 main.ts 完成 DOM 和 window.flymd* 的注入
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initSplitPreview, 800)
  })
} else {
  setTimeout(initSplitPreview, 800)
}
